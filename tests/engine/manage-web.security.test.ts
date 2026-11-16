import { describe, expect, it } from 'vitest'
import { handleManageWeb } from '../../adapters/web/manage'
import { runtimeFor } from '../../adapters/http/manage-config'
import { assignRole, readPagePolicy } from '../../domains/catalogue/commands'
import { actor, artifactId, authenticatedActor, configs, jwks, pageFixture, pageId } from './fixtures/catalogue'
import { manageHttpBindings } from './fixtures/manage-http-bindings'
import { env, request, setupHttp, signed } from './fixtures/manage-http'

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
