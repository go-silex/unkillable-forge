import { expect, it, vi } from 'vitest'
import { handleMcp } from '../../adapters/mcp/handler'
import { runtimeFor } from '../../adapters/http/manage-config'
import { artifactId, pageFixture, pageId } from './fixtures/catalogue'
import { env, request, setupHttp, signed } from './fixtures/manage-http'
import { manageHttpBindings } from './fixtures/manage-http-bindings'

setupHttp()

it('returns the minted share without attempting or queuing a shortlink when no seal is configured', async () => {
  await pageFixture()
  const base = await runtimeFor({ ...manageHttpBindings, DB: env.DB, REVISION_BYTES: env.REVISION_BYTES })
  if (!base) throw new Error('test runtime unavailable')
  const fetcher = vi.fn()
  const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'forge_share', arguments: { pageId, artifactId, expectedPolicyEpoch: 0, grant: { mode: 'follow_active' } } } })
  const response = await handleMcp(request('/mcp', 'POST', await signed(), body, { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' }), {
    ...base, shlink: { collectionUrl: 'https://short.example/rest/v3/short-urls', apiKey: 'test-key', fetch: fetcher }, shortDomain: 'short.example',
  })
  const envelope = await response.json() as { result: { isError?: boolean; content: { text: string }[] } }
  expect(envelope.result.isError).not.toBe(true)
  const result = JSON.parse(envelope.result.content[0].text)
  expect(result).toMatchObject({ ok: true, result: { revealable: false, policyEpoch: 1 } })
  expect(result.result.key).toMatch(/^[A-Za-z0-9_-]{24}$/)
  expect(fetcher).not.toHaveBeenCalled()
  expect(await env.DB.prepare("SELECT count(*) AS n FROM enrichment_jobs WHERE kind='shortlink'").first()).toEqual({ n: 0 })
})
