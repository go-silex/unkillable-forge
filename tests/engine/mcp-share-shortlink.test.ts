import { expect, it, vi } from 'vitest'
import { handleMcp } from '../../adapters/mcp/handler'
import { runtimeFor, type Runtime } from '../../adapters/http/manage-config'
import { artifactId, pageFixture, pageId, revisionId } from './fixtures/catalogue'
import { env, request, setupHttp, signed } from './fixtures/manage-http'
import { manageHttpBindings } from './fixtures/manage-http-bindings'

setupHttp()

const collectionUrl = 'https://short.example/rest/v3/short-urls'
const apiKey = 'test-shlink-key'

async function runtime(fetcher: typeof fetch): Promise<Runtime> {
  const base = await runtimeFor({ ...manageHttpBindings, DB: env.DB, REVISION_BYTES: env.REVISION_BYTES, FORGE_SHARE_SEAL_KEY: JSON.stringify({ kid: 'seal', key: 'BQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQU' }) })
  if (!base) throw new Error('test runtime unavailable')
  return { ...base, shlink: { collectionUrl, apiKey, fetch: fetcher }, shortDomain: 'short.example' }
}

async function tool(rt: Runtime, name: string, args: unknown) {
  const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } })
  const response = await handleMcp(request('/mcp', 'POST', await signed(), body, { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' }), rt)
  expect(response.status).toBe(200)
  const envelope = await response.json() as { result: { isError?: boolean; content: { text: string }[] } }
  expect(envelope.result.isError).not.toBe(true)
  return JSON.parse(envelope.result.content[0].text)
}

const target = { pageId, artifactId, expectedPolicyEpoch: 0, grant: { mode: 'follow_active' } }

it('creates a guarded shortlink for a newly minted share and does not call the provider on replay', async () => {
  await pageFixture()
  const fetcher = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
    const body = JSON.parse(init!.body as string) as { longUrl: string; customSlug: string }
    return Response.json({ shortCode: body.customSlug, shortUrl: `https://short.example/${body.customSlug}`, longUrl: body.longUrl })
  })
  const rt = await runtime(fetcher as typeof fetch)
  const minted = await tool(rt, 'forge_share', target)
  expect(minted).toMatchObject({ ok: true, result: { mode: 'follow_active', revealable: true, policyEpoch: 1 } })
  expect(minted.result.key).toMatch(/^[A-Za-z0-9_-]{24}$/)
  const destination = `https://forge.example.test/s/sample/${minted.result.key}/`
  expect(fetcher).toHaveBeenCalledTimes(1)
  const [url, init] = fetcher.mock.calls[0]
  expect(url).toBe(collectionUrl)
  expect(init!.method).toBe('POST')
  expect(new Headers(init!.headers).get('X-Api-Key')).toBe(apiKey)
  const sent = JSON.parse(init!.body as string)
  expect(sent).toEqual({ longUrl: destination, customSlug: expect.stringMatching(/^f-/), domain: 'short.example', findIfExists: false })
  const job = await env.DB.prepare('SELECT artifact_id,revision_id,page_id,desired_grant_id,desired_mapping_id,requested_short_code,expected_content_version,expected_policy_epoch,state,attempt,result_source FROM enrichment_jobs').first<{ desired_mapping_id: string }>()
  expect(job).toMatchObject({ artifact_id: artifactId, revision_id: revisionId, page_id: pageId, desired_grant_id: minted.result.grantId, requested_short_code: sent.customSlug, expected_content_version: 0, expected_policy_epoch: 1, state: 'ready', attempt: 1, result_source: 'created' })
  expect(await env.DB.prepare('SELECT provider_origin,short_domain,short_code,short_url,page_id,grant_id,destination,source FROM shortlink_mappings WHERE mapping_id=?').bind(job!.desired_mapping_id).first()).toEqual({ provider_origin: 'https://short.example', short_domain: 'short.example', short_code: sent.customSlug, short_url: `https://short.example/${sent.customSlug}`, page_id: pageId, grant_id: minted.result.grantId, destination, source: 'created' })
  const replay = await tool(rt, 'forge_share', { ...target, expectedPolicyEpoch: 1 })
  expect(replay).toEqual({ ok: true, result: { grantId: minted.result.grantId, key: null, mode: 'follow_active', revealable: true, policyEpoch: 1 } })
  expect(fetcher).toHaveBeenCalledTimes(1)
  expect(await env.DB.prepare('SELECT count(*) AS n FROM enrichment_jobs').first()).toEqual({ n: 1 })
})

it('keeps the share active when the shortlink provider fails', async () => {
  await pageFixture()
  const fetcher = vi.fn().mockRejectedValue(new Error('provider unavailable'))
  const rt = await runtime(fetcher as typeof fetch)
  const minted = await tool(rt, 'forge_share', target)
  expect(minted).toMatchObject({ ok: true, result: { mode: 'follow_active', revealable: true, policyEpoch: 1 } })
  expect(minted.result.key).toMatch(/^[A-Za-z0-9_-]{24}$/)
  expect(fetcher.mock.calls.map(call => call[1].method)).toEqual(['POST', 'GET'])
  expect(await env.DB.prepare('SELECT state,error_code,retryable,desired_grant_id FROM enrichment_jobs').first()).toEqual({ state: 'failed', error_code: 'shortlink_unavailable', retryable: 1, desired_grant_id: minted.result.grantId })
  expect(await env.DB.prepare('SELECT count(*) AS n FROM shortlink_mappings').first()).toEqual({ n: 0 })
  const policy = await tool(rt, 'forge_page_policy', { pageId })
  expect(policy.result).toMatchObject({ visibility: 'shared', policyEpoch: 1, grant: { grantId: minted.result.grantId } })
  const revealed = await tool(rt, 'forge_reveal_share', { pageId, artifactId, expectedPolicyEpoch: 1, grantId: minted.result.grantId })
  expect(revealed).toEqual({ ok: true, result: { key: minted.result.key } })
})
