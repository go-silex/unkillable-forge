import { describe, expect, it, vi } from 'vitest'
import { handleManageWeb } from '../../adapters/web/manage'
import { runtimeFor } from '../../adapters/http/manage-config'
import { handleRead } from '../../adapters/http/readWorker'
import { PublicationService } from '../../domains/publication'
import { RevisionStore } from '../../domains/store/revision-store'
import { assignRole, readPagePolicy } from '../../domains/catalogue/commands'
import { readActivePageRevision } from '../../domains/catalogue/read'
import { actor, artifactId, authenticatedActor, configs, instanceId, jwks, pageFixture, pageId, revisionId } from './fixtures/catalogue'
import { manageHttpBindings } from './fixtures/manage-http-bindings'
import { env, request, setupHttp, signed } from './fixtures/manage-http'
import { documentCommand, publishDocument } from './fixtures/publication'

setupHttp()
const origin = 'https://manage.example.test'
const deps = async () => ({ db: env.DB, config: (await configs()).manage, jwks, now: Date.now })
async function runtime() {
  const result = await runtimeFor({ ...manageHttpBindings, DB: env.DB, REVISION_BYTES: env.REVISION_BYTES, FORGE_SHARE_SEAL_KEY: JSON.stringify({ kid: 'seal', key: 'BQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQU' }) })
  if (!result) throw new Error('Invalid test runtime')
  return result
}
async function web(req: Request) {
  const result = await handleManageWeb(req, await runtime())
  if (!result) throw new Error('Expected management route')
  return result
}
function form(jwt: string, op: string, epoch: number, grantId?: string, originHeader: string | null = origin) {
  const body = new URLSearchParams({ op, pageId, artifactId, epoch: String(epoch) })
  if (grantId) body.set('grantId', grantId)
  const headers = new Headers({ 'Content-Type': 'application/x-www-form-urlencoded' })
  if (originHeader !== null) headers.set('Origin', originHeader)
  return request('/manage', 'POST', jwt, body.toString(), headers)
}

describe('management web', () => {
  it('creates a shortlink for the exact newly minted share without retargeting', async () => {
    await pageFixture()
    const jwt = await signed()
    const fetcher = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { longUrl: string; customSlug: string; domain: string }
      return Response.json({ shortCode: body.customSlug, shortUrl: `https://${body.domain}/${body.customSlug}`, longUrl: body.longUrl })
    })
    const base = await runtime()
    const result = await handleManageWeb(form(jwt, 'share', 0), { ...base, shlink: { collectionUrl: 'https://provider.example/rest/v3/short-urls', apiKey: 'test', fetch: fetcher as typeof fetch } }, 'short.example')
    expect(result?.status).toBe(200)
    const html = await result!.text()
    const sent = JSON.parse(String(fetcher.mock.calls[0][1]?.body))
    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(fetcher.mock.calls[0][1]?.method).toBe('POST')
    expect(html).toContain(sent.longUrl)
    const job = await env.DB.prepare('SELECT j.state,j.desired_grant_id,j.revision_id,j.expected_policy_epoch,j.requested_short_domain,j.requested_short_code,m.destination FROM enrichment_jobs j JOIN shortlink_mappings m ON m.mapping_id=j.desired_mapping_id WHERE j.page_id=?').bind(pageId).first<{ desired_grant_id: string }>()
    expect(job).toMatchObject({ state: 'ready', revision_id: revisionId, expected_policy_epoch: 1, requested_short_domain: 'short.example', requested_short_code: sent.customSlug, destination: sent.longUrl })
    expect(job?.desired_grant_id).toBe((await readPagePolicy(await deps(), actor, pageId))?.grant?.grantId)
    expect(await readActivePageRevision(await deps(), actor, { pageId, artifactId, expectedPolicyEpoch: 0, expectedContentVersion: 0 })).toBeNull()
  })

  it('reports no shortlink admission without a seal while retaining a usable primary share', async () => {
    const config = await configs()
    const store = new RevisionStore(env.REVISION_BYTES, instanceId)
    const publication = new PublicationService({ db: env.DB, config: config.manage, jwks, now: () => 10_000, store, publication: { sessionTtlMs: 60_000, maxUploadTimeoutMs: 1000, retainMs: 900_000, marginMs: 1000, manageClockSkewMs: 0, readClockSkewMs: 0 } })
    const page = await documentCommand('web-unsealed', '/a/web-unsealed/index.html', '<p>shared document</p>')
    const published = await publishDocument(publication, actor, page.command, page.bytes)
    const base = await runtimeFor({ ...manageHttpBindings, DB: env.DB, REVISION_BYTES: env.REVISION_BYTES })
    if (!base) throw new Error('Invalid test runtime')
    const fetcher = vi.fn()
    const body = new URLSearchParams({ op: 'share', pageId: page.pageId, artifactId: published.receipt.artifactId, epoch: '0' })
    const req = request('/manage', 'POST', await signed(), body.toString(), { 'Content-Type': 'application/x-www-form-urlencoded', Origin: origin })
    const result = await handleManageWeb(req, { ...base, shlink: { collectionUrl: 'https://provider.example/rest/v3/short-urls', apiKey: 'test', fetch: fetcher as typeof fetch } }, 'short.example')
    expect(result?.status).toBe(200)
    const html = await result!.text()
    expect(html).toContain('Shortlink enrichment was not requested')
    expect(html).not.toContain('Shortlink enrichment was requested')
    expect(html).toContain('This share key cannot be revealed')
    const link = html.match(/https:\/\/forge\.example\.test\/s\/web-unsealed\/[A-Za-z0-9_-]{24}\//)?.[0]
    expect(link).toBeTruthy()
    expect(fetcher).not.toHaveBeenCalled()
    expect(await env.DB.prepare("SELECT count(*) AS n FROM enrichment_jobs WHERE kind='shortlink'").first()).toEqual({ n: 0 })
    const shared = await handleRead(new Request(link!), { db: env.DB, config: config.read, jwks, nowSeconds: () => 100, store })
    expect(shared.status).toBe(200)
    expect(await shared.text()).toContain('shared document')
  })

  it('preserves a created share when shortlink configuration is invalid', async () => {
    await pageFixture()
    const jwt = await signed()
    const fetcher = vi.fn()
    const base = await runtime()
    const result = await handleManageWeb(form(jwt, 'share', 0), { ...base, shlink: { collectionUrl: 'https://provider.example/rest/v3/short-urls', apiKey: 'test', fetch: fetcher as typeof fetch } }, 'bad/domain')
    expect(result?.status).toBe(200)
    expect(await result!.text()).toContain('Share created, but shortlink enrichment')
    expect(fetcher).not.toHaveBeenCalled()
    expect(await readPagePolicy(await deps(), actor, pageId)).toMatchObject({ visibility: 'shared', policyEpoch: 1 })
  })

  it('admits signed top-level navigation with a cookie without broadening native or mutation admission', async () => {
    await pageFixture()
    const jwt = await signed()
    const nav = new Headers({ Cookie: `CF_Authorization=${jwt}`, 'Sec-Fetch-Site': 'cross-site', 'Sec-Fetch-Mode': 'navigate', 'Sec-Fetch-Dest': 'document' })
    const selected = await web(request(`/manage?pageId=${pageId}`, 'GET', null, null, nav))
    expect(selected.status).toBe(200)
    expect(selected.headers.get('cache-control')).toBe('no-store')
    expect(selected.headers.get('referrer-policy')).toBe('same-origin')
    expect(selected.headers.get('content-security-policy')).toContain("frame-ancestors 'none'")
    expect(await selected.text()).toContain('https://forge.example.test/a/sample/')
    expect((await web(request('/manage', 'GET', null, null, { Cookie: `CF_Authorization=${jwt}` }))).status).toBe(403)
    expect((await web(form(jwt, 'public', 0, undefined, null))).status).toBe(403)
    expect((await web(form(jwt, 'public', 0, undefined, 'https://forge.example.test'))).status).toBe(403)
    expect(await readPagePolicy(await deps(), actor, pageId)).toMatchObject({ visibility: 'private', policyEpoch: 0 })
    expect((await web(request('/manage', 'GET', null, null, { Cookie: 'forge_share=sample|invalidkey', 'Sec-Fetch-Site': 'cross-site', 'Sec-Fetch-Mode': 'navigate', 'Sec-Fetch-Dest': 'document' }))).status).toBe(401)
  })
  it('permits a same-origin browser form while denying an opaque Origin', async () => {
    await pageFixture()
    const jwt = await signed()
    const nav = new Headers({ Cookie: `CF_Authorization=${jwt}`, 'Sec-Fetch-Site': 'cross-site', 'Sec-Fetch-Mode': 'navigate', 'Sec-Fetch-Dest': 'document' })
    const selected = await web(request(`/manage?pageId=${pageId}`, 'GET', null, null, nav))
    expect(selected.status).toBe(200)
    const html = await selected.text()
    const publicForm = html.match(/<form method="post" action="([^"]+)">((?:(?!<\/form>)[\s\S])*?<button name="op" value="public">(?:(?!<\/form>)[\s\S])*?)<\/form>/)
    expect(publicForm).toBeTruthy()
    const fields = new URLSearchParams()
    for (const match of publicForm![2].matchAll(/<input type="hidden" name="([^"]+)" value="([^"]*)">/g)) fields.set(match[1], match[2])
    fields.set('op', 'public')
    expect(Object.fromEntries(fields)).toEqual({ pageId, artifactId, epoch: '0', op: 'public' })
    const submit = (requestOrigin: string) => web(request(publicForm![1], 'POST', null, fields.toString(), {
      Cookie: `CF_Authorization=${jwt}`,
      'Content-Type': 'application/x-www-form-urlencoded',
      Origin: requestOrigin,
    }))

    // Chromium was observed sending Origin: null for this form under no-referrer.
    expect((await submit('null')).status).toBe(403)
    expect(await readPagePolicy(await deps(), actor, pageId)).toMatchObject({ visibility: 'private', policyEpoch: 0 })
    const policy = selected.headers.get('referrer-policy')
    const browserOrigin = policy === 'same-origin' ? origin : 'null'
    expect((await submit(browserOrigin)).status).toBe(200)
    expect(await readPagePolicy(await deps(), actor, pageId)).toMatchObject({ visibility: 'public', policyEpoch: 1 })
    expect(policy).toBe('same-origin')
  })

  it('keeps the submitted epoch, and mints, reveals, rotates and revokes only the selected grant', async () => {
    await pageFixture()
    const jwt = await signed()
    const minted = await web(form(jwt, 'share', 0))
    expect(minted.status).toBe(200)
    const body = await minted.text()
    const link = body.match(/https:\/\/forge\.example\.test\/s\/sample\/[A-Za-z0-9_-]+\//)?.[0]
    expect(link).toBeTruthy()
    const first = await readPagePolicy(await deps(), actor, pageId)
    expect(first).toMatchObject({ visibility: 'shared', policyEpoch: 1, canonicalUrl: 'https://forge.example.test/a/sample/', shareUrlPrefix: 'https://forge.example.test/s/sample/' })
    const grant = first!.grant!.grantId
    expect((await web(form(jwt, 'public', 0))).status).toBe(409)
    expect((await web(form(jwt, 'reveal', 1, grant, null))).status).toBe(403)
    const revealed = await web(form(jwt, 'reveal', 1, grant))
    expect(revealed.status).toBe(200)
    expect(await revealed.text()).toContain(link)
    const rotated = await web(form(jwt, 'rotate', 1, grant))
    expect(rotated.status).toBe(200)
    expect(await rotated.text()).not.toContain(link)
    const second = await readPagePolicy(await deps(), actor, pageId)
    expect(second).toMatchObject({ visibility: 'shared', policyEpoch: 2 })
    expect(second!.grant!.grantId).not.toBe(grant)
    expect((await web(form(jwt, 'reveal', 2, grant))).status).not.toBe(200)
    expect((await web(form(jwt, 'revoke', 2, second!.grant!.grantId))).status).toBe(200)
    expect(await readPagePolicy(await deps(), actor, pageId)).toMatchObject({ visibility: 'private', policyEpoch: 3, grant: null })
  })

  it('limits a page-scoped publisher to their page', async () => {
    await pageFixture()
    const publisher = await authenticatedActor('scoped-web')
    await assignRole(await deps(), actor, { targetPrincipalId: publisher.principalId, expectedTargetAuthorityEpoch: publisher.authorityEpoch, role: 'publisher', scope: { kind: 'page', pageId } })
    const jwt = await signed('scoped-web')
    expect((await web(request(`/manage?pageId=${pageId}`, 'GET', jwt))).status).toBe(200)
    expect((await web(form(jwt, 'public', 0))).status).toBe(200)
    expect((await web(request(`/manage?pageId=pg_${'b'.repeat(26)}`, 'GET', jwt))).status).toBe(403)
  })

  it('rejects unprivileged identities and duplicate selectors without disclosing policy', async () => {
    await pageFixture()
    const jwt = await signed('unprivileged')
    expect((await web(request(`/manage?pageId=${pageId}`, 'GET', jwt))).status).toBe(403)
    expect((await web(form(jwt, 'share', 0))).status).toBe(403)
    expect((await web(request(`/manage?pageId=${pageId}&pageId=${pageId}`, 'GET', await signed()))).status).toBe(400)
    expect(await readPagePolicy(await deps(), actor, pageId)).toMatchObject({ visibility: 'private', policyEpoch: 0 })
  })
})
