import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { z } from 'zod'
import type { Tool } from '@modelcontextprotocol/sdk/types.js'
import type { ForgeAuth } from './auth.js'
import type { InstanceProfile } from './profile.js'

const envelopeSchema = z.union([
  z.object({ ok: z.literal(true), result: z.unknown() }),
  z.object({ ok: z.literal(false), error: z.object({ code: z.string().regex(/^[a-z_]{1,64}$/) }) }),
])
const descriptorSchema = z.strictObject({ method: z.literal('PUT'), url: z.string(), contentType: z.literal('application/octet-stream') })
function envelope(value: unknown) {
  const parsed = envelopeSchema.safeParse(value)
  if (!parsed.success) throw new Error('invalid_remote_response')
  if (!parsed.data.ok) {
    const error = new Error(parsed.data.error.code) as Error & { code: string }
    error.code = parsed.data.error.code
    throw error
  }
  return parsed.data.result
}

export class Remote {
  private client = new Client({ name: 'unkillable-forge', version: '1.0.0' })
  private tools: Tool[] = []
  constructor(private profile: InstanceProfile, private auth: ForgeAuth) {}

  async connect() {
    const transport = new StreamableHTTPClientTransport(new URL(this.profile.mcpResource), {
      fetch: async (input, init) => {
        const token = await this.auth.accessToken()
        const headers = new Headers(init?.headers)
        headers.set('Authorization', `Bearer ${token}`)
        const response = await fetch(input, { ...init, headers, redirect: 'error' })
        if (response.status !== 401) return response
        await response.body?.cancel()
        headers.set('Authorization', `Bearer ${await this.auth.refresh()}`)
        return fetch(input, { ...init, headers, redirect: 'error' })
      },
    })
    await this.client.connect(transport)
    let cursor: string | undefined
    const seen = new Set<string>()
    do {
      const page = await this.client.listTools(cursor ? { cursor } : {})
      this.tools.push(...page.tools)
      cursor = page.nextCursor
      if (cursor && seen.has(cursor)) throw new Error('invalid_tool_pagination')
      if (cursor) seen.add(cursor)
    } while (cursor)
  }

  listTools() { return this.tools }
  async supports(tool: string) { return this.tools.some(t => t.name === tool) }
  async call(tool: string, args: Record<string, unknown>): Promise<unknown> {
    if (!await this.supports(tool)) throw new Error('unsupported_tool')
    const result = await this.client.callTool({ name: tool, arguments: args })
    const content = result.content
    if (!Array.isArray(content) || content.length !== 1 || content[0].type !== 'text' || typeof content[0].text !== 'string') throw new Error('invalid_remote_response')
    let data: unknown
    try { data = JSON.parse(content[0].text) } catch { throw new Error('invalid_remote_response') }
    if (result.isError) {
      envelope(data)
      throw new Error('remote_error')
    }
    return envelope(data)
  }

  async upload(sessionId: string, path: string, body: ReadableStream<Uint8Array>, size: number): Promise<unknown> {
    const parsed = descriptorSchema.safeParse(await this.call('forge_upload_descriptor', { sessionId, path }))
    if (!parsed.success) throw new Error('invalid_upload_destination')
    const descriptor = parsed.data
    const url = new URL(descriptor.url)
    if (url.origin !== this.profile.manageOrigin || url.pathname !== '/api/publication/upload' || url.username || url.password || url.hash || [...url.searchParams.keys()].length !== 2 || url.searchParams.getAll('sessionId').length !== 1 || url.searchParams.getAll('path').length !== 1 || url.searchParams.get('sessionId') !== sessionId || url.searchParams.get('path') !== path) throw new Error('invalid_upload_destination')
    const token = await this.auth.accessToken()
    const response = await fetch(url, { method: 'PUT', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/octet-stream', 'Content-Length': String(size) }, body, redirect: 'error', duplex: 'half' } as RequestInit & { duplex: 'half' })
    if (response.status === 401) {
      await response.body?.cancel()
      await this.auth.refresh()
      throw new Error('upload_retry_required')
    }
    let data: unknown
    try { data = await response.json() } catch { throw new Error('invalid_remote_response') }
    if (!response.ok) {
      envelope(data)
      throw new Error('remote_error')
    }
    return envelope(data)
  }
}
