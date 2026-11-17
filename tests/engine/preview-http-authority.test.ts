import { env } from 'cloudflare:workers'
import { beforeEach, describe, expect, it } from 'vitest'
import { handleRead } from '../../adapters/http/readWorker'
import { importShare, rotateShare, setVisibility } from '../../domains/catalogue/commands'
import { RevisionStore } from '../../domains/store/revision-store'
import { actor, artifactId, bootstrap, configs, instanceId, jwks, manageRequest, pageFixture, pageId, revisionId } from './fixtures/catalogue'

beforeEach(async () => { await bootstrap(); await pageFixture() })

describe('preview HTTP authorization', () => {
  it('serves the exact generated card to public and authenticated team readers, without rescuing a wrong key', async () => {
    const config = await configs()
    const store = new RevisionStore(env.REVISION_BYTES, instanceId)
    const bytes = new TextEncoder().encode('card bytes')
    const sha = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), b => b.toString(16).padStart(2, '0')).join('')
    const recipe = 'b'.repeat(64), input = 'c'.repeat(64)
    const ref = { kind: 'og' as const, artifactId, revisionId, pageId, recipeSha256: recipe, inputSha256: input, contentSha256: sha, extension: 'jpg' as const }
    const info = await store.put(ref, { size: bytes.length, sha256: sha }, new ReadableStream({ start(c) { c.enqueue(bytes); c.close() } }))
    await env.DB.batch([
      env.DB.prepare('INSERT INTO preview_objects (page_id,revision_id,artifact_id,recipe_sha256,input_sha256,content_sha256,extension,size,object_version) VALUES (?,?,?,?,?,?,?,?,?)').bind(pageId, revisionId, artifactId, recipe, input, sha, 'jpg', bytes.length, info.version),
      env.DB.prepare('INSERT INTO preview_selections (page_id,revision_id,recipe_sha256,input_sha256,content_sha256,extension) VALUES (?,?,?,?,?,?)').bind(pageId, revisionId, recipe, input, sha, 'jpg'),
    ])
    const runtime = { db: env.DB, config: config.read, jwks, nowSeconds: () => 10, store }
    const url = `https://forge.example.test/_revisions/${pageId}/${revisionId}/_derived/og/${recipe}/${input}/${sha}.jpg`
    const teamHeaders = (await manageRequest('reader', 'reader')).headers
    expect((await handleRead(new Request(url), runtime)).status).toBe(404)
    expect((await handleRead(new Request(url, { headers: teamHeaders }), runtime)).status).toBe(200)
    expect((await handleRead(new Request(`${url}?k=wrong_key`, { headers: teamHeaders }), runtime)).status).toBe(404)
    expect((await handleRead(new Request(url.replace(revisionId, `rv_${'b'.repeat(26)}`), { headers: teamHeaders }), runtime)).status).toBe(404)
    await setVisibility({ db: env.DB, config: config.manage, jwks, now: () => 10 }, actor, { pageId, artifactId, expectedPolicyEpoch: 0, visibility: 'public' })
    expect((await handleRead(new Request(url, { method: 'HEAD' }), runtime)).status).toBe(200)
    expect((await handleRead(new Request(url, { headers: { 'if-none-match': `\"${sha}\"` } }), runtime)).status).toBe(304)
    expect((await handleRead(new Request(url, { headers: { range: 'bytes=0-2' } }), runtime)).status).toBe(206)
    expect((await handleRead(new Request(`${url}?k=wrong_key`), runtime)).status).toBe(404)
  })
  it('does not answer HEAD, conditional, or range requests after share rotation', async () => {
    const config = await configs()
    const management = { db: env.DB, config: config.manage, jwks, now: () => 10 }
    const target = { pageId, artifactId, expectedPolicyEpoch: 0 }
    const grant = await importShare(management, actor, { ...target, key: 'historical_123', mode: 'follow_active' })
    const runtime = { db: env.DB, config: config.read, jwks, nowSeconds: () => 10, store: new RevisionStore(env.REVISION_BYTES, instanceId) }
    const path = `https://forge.example.test/_revisions/${pageId}/${revisionId}/_derived/og/${'a'.repeat(64)}/${'b'.repeat(64)}/${'c'.repeat(64)}.jpg?k=historical_123`
    await rotateShare(management, actor, { ...target, expectedPolicyEpoch: 1, grantId: grant.grantId })
    const requests: RequestInit[] = [{ method: 'HEAD' }, { headers: { 'if-none-match': '*' } }, { headers: { range: 'bytes=0-1' } }]
    for (const init of requests) {
      const response = await handleRead(new Request(path, init), runtime)
      expect(response.status).toBe(404)
    }
  })
})
