import { describe, expect, it } from 'vitest'
import { handleMcp } from '../../adapters/mcp/handler'
import { runtimeFor } from '../../adapters/http/manage-config'
import { assignRole } from '../../domains/catalogue/commands'
import { actor, artifactId, authenticatedActor, configs, jwks, pageFixture, pageId } from './fixtures/catalogue'
import { documentCommand } from './fixtures/publication'
import { env, request, setupHttp, signed } from './fixtures/manage-http'

setupHttp()

async function call(body: unknown, assertion: string | null, extra: HeadersInit = {}) {
  const runtime = await runtimeFor(env as unknown as Record<string, unknown>)
  if (!runtime) throw new Error('test runtime unavailable')
  const headers = new Headers(extra)
  headers.set('Content-Type', 'application/json')
  headers.set('Accept', 'application/json, text/event-stream')
  return handleMcp(request('/mcp', 'POST', assertion, JSON.stringify(body), headers), runtime)
}
const rpc = (method: string, params: unknown, id = 1) => ({ jsonrpc: '2.0', id, method, params })
async function tool(token: string, name: string, args: unknown) {
  const response = await call(rpc('tools/call', { name, arguments: args }), token)
  expect(response.status).toBe(200)
  const envelope = await response.json() as { result: { isError?: boolean; content: { text: string }[] } }
  return { isError: !!envelope.result.isError, value: JSON.parse(envelope.result.content[0].text) }
}

describe('remote MCP', () => {
  it('negotiates initialize and lists the actual tools', async () => {
    const token = await signed()
    const init = await call(rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } }), token)
    expect(init.status).toBe(200)
    const initialized = await init.json() as { result: { protocolVersion: string } }
    expect(initialized.result.protocolVersion).toBe('2025-06-18')
    const list = await call(rpc('tools/list', {}), token)
    const result = await list.json() as { result: { tools: { name: string }[] } }
    expect(result.result.tools.map(t => t.name)).toEqual(expect.arrayContaining(['forge_catalogue', 'forge_manifest', 'forge_begin', 'forge_share']))
  })

  it('rejects unauthenticated and cross-origin requests before tool execution', async () => {
    const body = rpc('tools/list', {})
    expect((await call(body, null)).status).toBe(401)
    expect((await call(body, await signed(), { Origin: 'https://evil.example' })).status).toBe(403)
  })

  it('returns safe typed domain failures and rejects extra arguments', async () => {
    const token = await signed()
    const denied = await call(rpc('tools/call', { name: 'forge_status', arguments: { sessionId: 'not-a-session' } }), token)
    const result = await denied.json() as { result: { isError: boolean; content: { text: string }[] } }
    expect(result.result.isError).toBe(true)
    expect(JSON.parse(result.result.content[0].text)).toEqual({ ok: false, error: { code: 'not_found' } })
    const invalid = await call(rpc('tools/call', { name: 'forge_status', arguments: { sessionId: 'x', extra: true } }), token)
    const invalidResult = await invalid.json() as { result: { isError: boolean } }
    expect(invalidResult.result.isError).toBe(true)
  })
  it('changes visibility and rejects a stale policy epoch without changing it again', async () => {
    await pageFixture()
    const token = await signed()
    const target = { pageId, artifactId, expectedPolicyEpoch: 0 }
    const changed = await tool(token, 'forge_visibility', { ...target, visibility: 'public' })
    expect(changed).toEqual({ isError: false, value: { ok: true, result: { policyEpoch: 1 } } })
    const stale = await tool(token, 'forge_visibility', { ...target, visibility: 'private' })
    expect(stale).toEqual({ isError: true, value: { ok: false, error: { code: 'conflict' } } })
    const policy = await tool(token, 'forge_page_policy', { pageId })
    expect(policy.value.result).toMatchObject({ pageId, artifactId, visibility: 'public', policyEpoch: 1 })
  })

  it('does not let another authenticated publisher access an actor-bound session', async () => {
    const other = await authenticatedActor('other-publisher')
    const deps = { db: env.DB, config: (await configs()).manage, jwks, now: Date.now }
    await assignRole(deps, actor, { targetPrincipalId: other.principalId, expectedTargetAuthorityEpoch: 0, role: 'publisher', scope: { kind: 'installation' } })
    const admin = await signed()
    const otherToken = await signed('other-publisher')
    const doc = await documentCommand('mcp-isolated-session', '/a/mcp-isolation/index.html', 'isolation')
    const begun = await tool(admin, 'forge_begin', { command: doc.command })
    expect(begun.isError).toBe(false)
    const sessionId = begun.value.result.sessionId as string
    const foreign = await tool(otherToken, 'forge_status', { sessionId })
    expect(foreign).toEqual({ isError: true, value: { ok: false, error: { code: 'not_found' } } })
    const own = await tool(admin, 'forge_status', { sessionId })
    expect(own.value.result).toMatchObject({ sessionId, state: 'open' })
  })

  it('rejects invalid media type and oversized declared framing before native dispatch', async () => {
    const runtime = await runtimeFor(env as unknown as Record<string, unknown>)
    if (!runtime) throw new Error('test runtime unavailable')
    const token = await signed()
    const payload = JSON.stringify(rpc('tools/list', {}))
    const badType = request('/mcp', 'POST', token, payload, { 'Content-Type': 'text/plain', Accept: 'application/json, text/event-stream' })
    const typeResponse = await handleMcp(badType, runtime)
    expect(typeResponse.status).toBe(415)
    expect(await typeResponse.json()).toEqual({ ok: false, error: { code: 'unsupported_media_type' } })
    const tooLarge = request('/mcp', 'POST', token, payload, { 'Content-Type': 'application/json', 'Content-Length': String(runtime.transport.maxCommandBytes + 1), Accept: 'application/json, text/event-stream' })
    const largeResponse = await handleMcp(tooLarge, runtime)
    expect(largeResponse.status).toBe(413)
    expect(await largeResponse.json()).toEqual({ ok: false, error: { code: 'payload_too_large' } })
  })
})
