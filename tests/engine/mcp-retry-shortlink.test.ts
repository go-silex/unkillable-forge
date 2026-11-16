import { expect, it, vi } from 'vitest'
import { handleMcp } from '../../adapters/mcp/handler'
import { runtimeFor, type Runtime } from '../../adapters/http/manage-config'
import { shortlinkDestinationDigest } from '../../domains/catalogue/shortlinks'
import { claimEnrichment, enqueueEnrichment, failEnrichment } from '../../domains/delivery/enrichments'
import { actor, artifactId, configs, instanceId, jwks, pageFixture, pageId, revisionId } from './fixtures/catalogue'
import { env, request, setupHttp, signed } from './fixtures/manage-http'
import { manageHttpBindings } from './fixtures/manage-http-bindings'

setupHttp()

const otherArtifact = `ar_${'b'.repeat(26)}`
const otherRevision = `rv_${'b'.repeat(26)}`
const otherPage = `pg_${'b'.repeat(26)}`
const destination = 'https://forge.example.test/a/sample/'
const secret = 'shlink-private-api-key'
const args = { artifactId, revisionId, pageId, expectedContentVersion: 0, expectedPolicyEpoch: 1, kinds: ['shortlink'] }

async function setupJobs() {
  await pageFixture({ visibility: 'public' })
  await pageFixture({ artifact: otherArtifact, revision: otherRevision, page: otherPage, route: { kind: 'subtree', slug: 'other' }, visibility: 'public' })
  // Policy-only page fixtures have no publication seal evidence; imported revisions
  // are authorized from their revision pages instead.
  await env.DB.prepare("UPDATE revisions SET origin='imported' WHERE revision_id IN (?,?)").bind(revisionId, otherRevision).run()
  const deps = { db: env.DB, config: (await configs()).manage, jwks, now: () => 10 }
  const jobInput = { expectedContentVersion: 0, expectedPolicyEpoch: 1, kind: 'shortlink' as const, inputSha256: 'a'.repeat(64), desiredGrantId: null, providerOrigin: 'https://short.example', shortDomain: 'short.example' }
  const otherJob = await enqueueEnrichment(deps, actor, { ...jobInput, artifactId: otherArtifact, revisionId: otherRevision, pageId: otherPage, mappingId: 'other-mapping', shortCode: 'other-code', destinationSha256: await shortlinkDestinationDigest('https://forge.example.test/a/other/') })
  const job = await enqueueEnrichment(deps, actor, { ...jobInput, artifactId, revisionId, pageId, mappingId: 'target-mapping', shortCode: 'target-code', destinationSha256: await shortlinkDestinationDigest(destination) })
  const attempt = await claimEnrichment(env.DB, instanceId, job, 20, 100)
  await failEnrichment(env.DB, instanceId, attempt, 21, 'shortlink_unavailable', true)
  return { job, otherJob }
}

async function callRetry(shlink?: Runtime['shlink']) {
  const base = await runtimeFor({ ...manageHttpBindings, DB: env.DB, REVISION_BYTES: env.REVISION_BYTES })
  if (!base) throw new Error('test runtime unavailable')
  const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'forge_retry_enrichments', arguments: args } })
  const response = await handleMcp(request('/mcp', 'POST', await signed(), body, { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' }), { ...base, shlink })
  expect(response.status).toBe(200)
  const envelope = await response.json() as { result: { isError?: boolean; content: { text: string }[] } }
  return { isError: !!envelope.result.isError, text: envelope.result.content[0].text, value: JSON.parse(envelope.result.content[0].text) }
}

it('retries and drains only the requested page, returning its authorized observation without secrets', async () => {
  const { job, otherJob } = await setupJobs()
  const fetcher = vi.fn().mockResolvedValue(Response.json({ shortCode: 'target-code', shortUrl: 'https://short.example/target-code', longUrl: destination }))
  const result = await callRetry({ collectionUrl: 'https://short.example/rest/v3/short-urls', apiKey: secret, fetch: fetcher as typeof fetch })
  expect(result.value).toEqual({ ok: true, result: { pageId, revisionId, og: { state: 'disabled', reason: 'not_requested' }, shortlink: { state: 'ready', source: 'created' } } })
  expect(result.isError).toBe(false)
  expect(result.text).not.toContain(secret)
  expect(result.text).not.toContain('target-code')
  expect(fetcher).toHaveBeenCalledTimes(1)
  const [url, init] = fetcher.mock.calls[0]
  expect(url).toBe('https://short.example/rest/v3/short-urls')
  expect(init.method).toBe('POST')
  expect(new Headers(init.headers).get('X-Api-Key')).toBe(secret)
  expect(JSON.parse(init.body)).toEqual({ longUrl: destination, customSlug: 'target-code', domain: 'short.example', findIfExists: false })
  expect(await env.DB.prepare('SELECT state,attempt FROM enrichment_jobs WHERE job_id=?').bind(job).first()).toEqual({ state: 'ready', attempt: 2 })
  expect(await env.DB.prepare('SELECT state,attempt FROM enrichment_jobs WHERE job_id=?').bind(otherJob).first()).toEqual({ state: 'pending', attempt: 0 })
})

it('reports unavailable without changing the failed job when Shlink is not configured', async () => {
  const { job, otherJob } = await setupJobs()
  const result = await callRetry()
  expect(result.isError).toBe(true)
  expect(result.value).toEqual({ ok: false, error: { code: 'unavailable' } })
  expect(await env.DB.prepare('SELECT state,attempt,error_code,retryable FROM enrichment_jobs WHERE job_id=?').bind(job).first()).toEqual({ state: 'failed', attempt: 1, error_code: 'shortlink_unavailable', retryable: 1 })
  expect(await env.DB.prepare('SELECT state,attempt FROM enrichment_jobs WHERE job_id=?').bind(otherJob).first()).toEqual({ state: 'pending', attempt: 0 })
})

it('reauthorizes the observation after provider execution', async () => {
  await setupJobs()
  const fetcher = vi.fn(async () => {
    await env.DB.prepare('UPDATE role_grants SET revoked_at=?,revoked_by=? WHERE principal_id=?').bind(Date.now(), actor.principalId, actor.principalId).run()
    return Response.json({ shortCode: 'target-code', shortUrl: 'https://short.example/target-code', longUrl: destination })
  })
  const result = await callRetry({ collectionUrl: 'https://short.example/rest/v3/short-urls', apiKey: secret, fetch: fetcher as typeof fetch })
  expect(fetcher).toHaveBeenCalledTimes(1)
  expect(result.isError).toBe(true)
  expect(result.value).toEqual({ ok: false, error: { code: 'forbidden' } })
  expect(result.text).not.toContain(secret)
})
