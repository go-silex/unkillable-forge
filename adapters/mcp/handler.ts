import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js'
import { authenticateManage } from '../../domains/catalogue/principals'
import type { Runtime } from '../http/manage-config'
import { admitManageRequest, publicError } from '../http/manage-edge'
import { cancelBody, checkFraming, InputError } from '../http/publication-input'
import { readMcpJson } from './input'
import { registerTools } from './tools'

const headers = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'", 'Content-Type': 'application/json; charset=utf-8' }
function failure(status: number, code: string): Response {
  return new Response(JSON.stringify({ ok: false, error: { code } }), { status, headers })
}

export async function handleMcp(request: Request, runtime: Runtime): Promise<Response> {
  try {
    const url = new URL(request.url)
    const admission = admitManageRequest(request, url, runtime.deps.config.manageHost)
    if (admission) return failure(admission.status, admission.code)
    if (url.search) throw new InputError('invalid_request')
    if (request.method === 'POST') checkFraming(request, false, runtime.transport.maxCommandBytes)
    const actor = await authenticateManage(request, runtime.deps)
    if (!actor) return failure(401, 'unauthenticated')
    const parsedBody = request.method === 'POST' ? await readMcpJson(request, runtime.transport) : undefined
    const server = new McpServer({ name: 'unkillable-forge', version: '1.0.0' })
    registerTools(server, runtime, actor)
    const transport = new WebStandardStreamableHTTPServerTransport({ enableJsonResponse: true })
    await server.connect(transport)
    try {
      const response = await transport.handleRequest(request, parsedBody === undefined ? undefined : { parsedBody })
      const outputHeaders = new Headers(response.headers)
      outputHeaders.set('Cache-Control', 'no-store')
      outputHeaders.set('X-Content-Type-Options', 'nosniff')
      outputHeaders.set('Referrer-Policy', 'no-referrer')
      outputHeaders.set('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'")
      return new Response(response.body, { status: response.status, statusText: response.statusText, headers: outputHeaders })
    } finally {
      await server.close()
    }
  } catch (error) {
    const fault = publicError(error)
    return failure(fault.status, fault.code)
  } finally {
    cancelBody(request)
  }
}
