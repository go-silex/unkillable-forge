import { expect, it, vi } from 'vitest'
import { handleMcp } from '../../adapters/mcp/handler'
import { runtimeFor, type Runtime } from '../../adapters/http/manage-config'
import type { PublicationReceipt, PublicationStatus } from '../../domains/publication/types'
import { DerivedStore } from '../../domains/store/derived-store'
import { actor } from './fixtures/catalogue'
import { command, env, receipt, request, setupHttp, signed, status, upload, uploaded } from './fixtures/manage-http'
import { manageHttpBindings } from './fixtures/manage-http-bindings'
import { documentCommand } from './fixtures/publication'

setupHttp()

// Baseline JPEG frame: 1200 x 630, matching the Browser Run response contract.
const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00, 0xff, 0xc0, 0x00, 0x0b, 0x08, 0x02, 0x76, 0x04, 0xb0, 0x01, 0x01, 0x11, 0x00, 0xff, 0xd9])
const accountId = '0123456789abcdef0123456789abcdef'
const credential = 'browser-control-credential'
const html = '<!doctype html><head></head><body><script>window.authorCode = true</script><h1>Published from R2</h1></body>'

async function published() {
  const jwt = await signed()
  const path = '/a/og-consumer/index.html'
  const document = await documentCommand('og-consumer', path, html)
  const session = await status(await command(jwt, { op: 'begin', command: document.command }))
  await uploaded(await upload(jwt, session.sessionId, path, document.bytes), session.sessionId, path)
  await status(await command(jwt, { op: 'seal', sessionId: session.sessionId }))
  const committed = await receipt(await command(jwt, { op: 'commit', sessionId: session.sessionId }))
  const job = await env.DB.prepare("SELECT job_id,state,attempt,input_sha256,recipe_sha256 FROM enrichment_jobs WHERE revision_id=? AND kind='og'").bind(committed.revisionId).first<{ job_id: string; state: string; attempt: number; input_sha256: string | null; recipe_sha256: string | null }>()
  expect(job).toMatchObject({ state: 'pending', attempt: 0, input_sha256: null, recipe_sha256: null })
  return { jwt, session, committed, pageId: document.pageId, jobId: job!.job_id }
}

type Published = { jwt: string; session: PublicationStatus; committed: PublicationReceipt; pageId: string; jobId: string }
async function retry(p: Published, og?: Runtime['og'], assertion = p.jwt) {
  const base = await runtimeFor({ ...manageHttpBindings, DB: env.DB, REVISION_BYTES: env.REVISION_BYTES })
  if (!base) throw new Error('test runtime unavailable')
  const args = { artifactId: p.committed.artifactId, revisionId: p.committed.revisionId, pageId: p.pageId, expectedContentVersion: p.committed.contentVersion, expectedPolicyEpoch: 0, kinds: ['og'] }
  const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'forge_retry_enrichments', arguments: args } })
  const response = await handleMcp(request('/mcp', 'POST', assertion, body, { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' }), { ...base, og })
  expect(response.status).toBe(200)
  const envelope = await response.json() as { result: { isError?: boolean; content: { text: string }[] } }
  const text = envelope.result.content[0].text
  return { isError: !!envelope.result.isError, text, value: JSON.parse(text), store: base.deps.store }
}

it('renders a published page through a native workerd Request', async () => {
  const p = await published()
  const requests: Request[] = []
  const fetcher: typeof fetch = async (url, init) => {
    const outbound = new Request(url, init)
    requests.push(outbound)
    return new Response(jpeg, { headers: { 'content-type': 'image/jpeg' } })
  }
  const result = await retry(p, { accountId, apiToken: credential, fetch: fetcher })
  expect(result.isError).toBe(false)
  expect(result.value.result.og).toEqual({ state: 'ready', source: 'generated' })
  expect(requests).toHaveLength(1)
  expect(requests[0].url).toBe(`https://api.cloudflare.com/client/v4/accounts/${accountId}/browser-rendering/screenshot?cacheTTL=0`)
  expect(requests[0].method).toBe('POST')
  expect(requests[0].redirect).toBe('manual')
})

it('prepares the pending graph, reads the committed document and selects immutable derived bytes', async () => {
  const p = await published()
  const fetcher = vi.fn(async () => new Response(jpeg))
  const result = await retry(p, { accountId, apiToken: credential, fetch: fetcher as typeof fetch })
  expect(result.isError).toBe(false)
  expect(result.value).toEqual({ ok: true, result: { pageId: p.pageId, revisionId: p.committed.revisionId, og: { state: 'ready', source: 'generated' }, shortlink: { state: 'disabled', reason: 'not_requested' } } })
  expect(result.text).not.toContain(credential)
  expect(fetcher).toHaveBeenCalledTimes(1)
  const [url, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit]
  expect(url).toBe(`https://api.cloudflare.com/client/v4/accounts/${accountId}/browser-rendering/screenshot?cacheTTL=0`)
  expect(init.redirect).toBe('manual')
  const payload = JSON.parse(init.body as string)
  expect(payload.html).toContain('Published from R2')
  expect(payload.html.indexOf('Content-Security-Policy')).toBeLessThan(payload.html.indexOf('<script>'))
  expect(payload.rejectRequestPattern).toEqual(['^https?://', '^wss?://'])
  expect(payload.rejectResourceTypes).toEqual(['xhr', 'fetch', 'websocket', 'eventsource'])
  expect(payload.screenshotOptions.clip).toEqual({ x: 0, y: 36, width: 1920, height: 1008, scale: 0.625 })
  const job = await env.DB.prepare('SELECT state,attempt,input_sha256,recipe_sha256 FROM enrichment_jobs WHERE job_id=?').bind(p.jobId).first<{ state: string; attempt: number; input_sha256: string; recipe_sha256: string }>()
  expect(job).toMatchObject({ state: 'ready', attempt: 1 })
  expect(job!.input_sha256).toMatch(/^[a-f0-9]{64}$/)
  expect(job!.recipe_sha256).toMatch(/^[a-f0-9]{64}$/)
  expect(await env.DB.prepare('SELECT count(*) AS n FROM enrichment_graph_chunks WHERE job_id=?').bind(p.jobId).first()).toEqual({ n: 1 })
  const selected = await env.DB.prepare('SELECT recipe_sha256,input_sha256,content_sha256,extension FROM preview_selections WHERE page_id=? AND revision_id=?').bind(p.pageId, p.committed.revisionId).first<{ recipe_sha256: string; input_sha256: string; content_sha256: string; extension: 'jpg' }>()
  expect(selected).toMatchObject({ recipe_sha256: job!.recipe_sha256, input_sha256: job!.input_sha256, extension: 'jpg' })
  if (p.committed.revisionId === null) throw new Error('Committed publication must have a revision')
  const derived = new DerivedStore(result.store)
  const ref = { kind: 'og' as const, artifactId: p.committed.artifactId, revisionId: p.committed.revisionId, pageId: p.pageId, recipeSha256: selected!.recipe_sha256, inputSha256: selected!.input_sha256, contentSha256: selected!.content_sha256, extension: selected!.extension }
  const descriptor = await derived.head(ref)
  expect(descriptor).toMatchObject({ size: jpeg.length, contentType: 'image/jpeg' })
  const object = await derived.get(ref)
  expect(object).not.toBeNull()
  expect(new Uint8Array(await object!.arrayBuffer())).toEqual(jpeg)
  expect(await env.DB.prepare('SELECT size,object_version FROM preview_objects WHERE page_id=? AND revision_id=?').bind(p.pageId, p.committed.revisionId).first()).toEqual({ size: jpeg.length, object_version: descriptor!.objectVersion })
})

it('records provider failure without reversing the committed publication receipt', async () => {
  const p = await published()
  const fetcher = vi.fn(async () => new Response(null, { status: 503 }))
  const result = await retry(p, { accountId, apiToken: credential, fetch: fetcher as typeof fetch })
  expect(fetcher).toHaveBeenCalledTimes(1)
  expect(result.value).toEqual({ ok: true, result: { pageId: p.pageId, revisionId: p.committed.revisionId, og: { state: 'failed', code: 'render_unavailable', retryable: true }, shortlink: { state: 'disabled', reason: 'not_requested' } } })
  expect(await env.DB.prepare('SELECT state,attempt,error_code,retryable FROM enrichment_jobs WHERE job_id=?').bind(p.jobId).first()).toEqual({ state: 'failed', attempt: 1, error_code: 'render_unavailable', retryable: 1 })
  expect(await env.DB.prepare('SELECT count(*) AS n FROM preview_selections WHERE page_id=?').bind(p.pageId).first()).toEqual({ n: 0 })
  expect(await receipt(await command(p.jwt, { op: 'commit', sessionId: p.session.sessionId }))).toEqual(p.committed)
  expect(await env.DB.prepare('SELECT active_revision_id,content_version FROM artifacts WHERE artifact_id=?').bind(p.committed.artifactId).first()).toEqual({ active_revision_id: p.committed.revisionId, content_version: p.committed.contentVersion })
})

it('leaves the pending intent untouched when OG is not configured', async () => {
  const p = await published()
  const result = await retry(p)
  expect(result.isError).toBe(true)
  expect(result.value).toEqual({ ok: false, error: { code: 'unavailable' } })
  expect(await env.DB.prepare('SELECT state,attempt,input_sha256,recipe_sha256 FROM enrichment_jobs WHERE job_id=?').bind(p.jobId).first()).toEqual({ state: 'pending', attempt: 0, input_sha256: null, recipe_sha256: null })
  expect(await env.DB.prepare('SELECT count(*) AS n FROM enrichment_graph_chunks WHERE job_id=?').bind(p.jobId).first()).toEqual({ n: 0 })
})

it('repairs a missing committed OG intent only with current authority', async () => {
  const p = await published()
  await env.DB.prepare('DELETE FROM enrichment_jobs WHERE job_id=?').bind(p.jobId).run()
  const fetcher = vi.fn(async () => new Response(jpeg))
  const og = { accountId, apiToken: credential, fetch: fetcher as typeof fetch }
  await env.DB.prepare('UPDATE role_grants SET revoked_at=?,revoked_by=? WHERE principal_id=?').bind(Date.now(), actor.principalId, actor.principalId).run()
  const refused = await retry(p, og)
  expect(refused.value).toEqual({ ok: false, error: { code: 'forbidden' } })
  expect(fetcher).not.toHaveBeenCalled()
  expect(await env.DB.prepare("SELECT count(*) AS n FROM enrichment_jobs WHERE page_id=? AND kind='og'").bind(p.pageId).first()).toEqual({ n: 0 })
  await env.DB.prepare('UPDATE role_grants SET revoked_at=NULL,revoked_by=NULL WHERE principal_id=?').bind(actor.principalId).run()
  const repaired = await retry(p, og)
  expect(repaired.value).toEqual({ ok: true, result: { pageId: p.pageId, revisionId: p.committed.revisionId, og: { state: 'ready', source: 'generated' }, shortlink: { state: 'disabled', reason: 'not_requested' } } })
  expect(fetcher).toHaveBeenCalledTimes(1)
  expect(await env.DB.prepare("SELECT count(*) AS n FROM enrichment_jobs WHERE page_id=? AND kind='og' AND state='ready'").bind(p.pageId).first()).toEqual({ n: 1 })
})

it('reauthorizes the observation after authority is revoked during provider execution', async () => {
  const p = await published()
  const fetcher = vi.fn(async () => {
    await env.DB.prepare('UPDATE role_grants SET revoked_at=?,revoked_by=? WHERE principal_id=?').bind(Date.now(), actor.principalId, actor.principalId).run()
    return new Response(jpeg)
  })
  const result = await retry(p, { accountId, apiToken: credential, fetch: fetcher as typeof fetch })
  expect(fetcher).toHaveBeenCalledTimes(1)
  expect(result.isError).toBe(true)
  expect(result.value).toEqual({ ok: false, error: { code: 'forbidden' } })
})

it('does not select a render when the target changes during provider execution', async () => {
  const p = await published()
  const fetcher = vi.fn(async () => {
    await env.DB.prepare('UPDATE artifacts SET content_version=content_version+1 WHERE artifact_id=?').bind(p.committed.artifactId).run()
    return new Response(jpeg)
  })
  await retry(p, { accountId, apiToken: credential, fetch: fetcher as typeof fetch })
  expect(fetcher).toHaveBeenCalledTimes(1)
  expect(await env.DB.prepare('SELECT count(*) AS n FROM preview_selections WHERE page_id=?').bind(p.pageId).first()).toEqual({ n: 0 })
  expect(await env.DB.prepare('SELECT state FROM enrichment_jobs WHERE job_id=?').bind(p.jobId).first()).not.toEqual({ state: 'ready' })
})
