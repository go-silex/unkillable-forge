import { describe, expect, it } from 'vitest'
import { env } from 'cloudflare:workers'
import { handleRead } from '../../adapters/http/readWorker'
import { importShare, rotateShare } from '../../domains/catalogue/commands'
import { PublicationService } from '../../domains/publication'
import { RevisionStore as Store } from '../../domains/store/revision-store'
import { actor, bootstrap, configs, instanceId, jwks } from './fixtures/catalogue'
import { documentCommand, publishDocument } from './fixtures/publication'
import { unfurl, serveCard } from '../../domains/delivery/unfurl'
import type { SharedPreviewPlan } from '../../domains/catalogue/previews'
import type { PreviewCardPlan } from '../../domains/catalogue/preview-cards'
import type { RevisionStore } from '../../domains/store/revision-store'

const hash = 'a'.repeat(64)
const preview = { kind: 'unfurl', instanceId: 'i', artifactId: 'a', pageId: 'pg_aaaaaaaaaaaaaaaaaaaaaaaaaa', revisionId: 'rv_aaaaaaaaaaaaaaaaaaaaaaaaaa', title: '<script>"', description: "x' & y", image: null, authority: { pageId: 'p', grantId: 'g', policyEpoch: 1, basis: 'share_key' }, cache: 'no-store' } as SharedPreviewPlan
const card = { kind: 'card', instanceId: 'i', artifactId: 'a', pageId: 'p', revisionId: 'r', authority: preview.authority, cache: 'no-store', descriptor: { kind: 'original', path: '/og.png', sha256: hash, size: 4, contentType: 'image/png', objectKey: 'object', objectVersion: 'v' } } as PreviewCardPlan
const info = { key: 'object', sha256: hash, size: 4, version: 'v' }
const store = { head: async () => info, get: async () => ({ ...info, body: new ReadableStream({ start(c) { c.enqueue(new Uint8Array([1, 2, 3, 4])); c.close() } }) }) } as unknown as RevisionStore

describe('preview presentation', () => {
  it('escapes metadata and does not reuse original validators for HEAD', async () => {
    const response = unfurl(new Request('https://forge.example/s/a/key'), preview, 'abcdefgh')
    expect(await response.text()).toContain('&lt;script&gt;&quot;')
    expect(response.headers.get('cache-control')).toBe('no-store')
    const head = unfurl(new Request('https://forge.example/s/a/key', { method: 'HEAD', headers: { 'if-none-match': `"${hash}"` } }), preview, 'abcdefgh')
    expect(head.status).toBe(200)
    expect(head.headers.get('etag')).toBeNull()
    expect(await head.text()).toBe('')
  })
  it('binds card metadata before conditional and range handling', async () => {
    const notModified = await serveCard(new Request('https://forge.example/card', { headers: { 'if-none-match': `W/"${hash}"` } }), card, store)
    expect(notModified.status).toBe(304)
    const invalid = await serveCard(new Request('https://forge.example/card', { headers: { range: 'bytes=10-20' } }), card, store)
    expect(invalid.status).toBe(416)
    expect(invalid.headers.get('content-range')).toBe('bytes */4')
    const bad = { head: async () => ({ ...info, version: 'wrong' }) } as unknown as RevisionStore
    expect((await serveCard(new Request('https://forge.example/card', { method: 'HEAD', headers: { 'if-none-match': `"${hash}"` } }), card, bad)).status).toBe(503)
  })
})

describe('shared HTTP representations', () => {
  it('serves navigable documents by default and authorizes crawler previews on every request', async () => {
    await bootstrap()
    const config = await configs()
    const store = new Store(env.REVISION_BYTES, instanceId)
    const publication = new PublicationService({ db: env.DB, config: config.manage, jwks, now: () => 10_000, store, publication: { sessionTtlMs: 60_000, maxUploadTimeoutMs: 1000, retainMs: 900_000, marginMs: 1000, manageClockSkewMs: 0, readClockSkewMs: 0 } })
    const management = { db: env.DB, config: config.manage, jwks, now: () => 10_000 }
    const page = await documentCommand('preview-representation', '/a/preview-representation/index.html', '<p>actual shared document</p>')
    const published = await publishDocument(publication, actor, page.command, page.bytes)
    const target = { pageId: page.pageId, artifactId: published.receipt.artifactId }
    const grant = await importShare(management, actor, { ...target, expectedPolicyEpoch: 0, key: 'historical_123', mode: 'follow_active' })
    const request = (key: string, headers: Record<string, string> = {}, method = 'GET') => handleRead(new Request(`https://forge.example.test/s/preview-representation/${key}/`, { headers, method }), { db: env.DB, config: config.read, jwks, nowSeconds: () => 100, store })
    const ordinary = await request('historical_123')
    expect(await ordinary.text()).toContain('actual shared document')
    expect(ordinary.headers.get('set-cookie')).toContain('forge_pin=')
    expect(ordinary.headers.get('vary')).toMatch(/user-agent/i)
    expect(ordinary.headers.get('vary')).toMatch(/sec-fetch-dest/i)
    expect(ordinary.headers.get('cache-control')).toBe('no-store')
    const crawler = { 'User-Agent': 'Slackbot-LinkExpanding 1.0' }
    const previewResponse = await request('historical_123', crawler)
    const previewBody = await previewResponse.text()
    expect(previewResponse.status).toBe(200)
    expect(previewBody).toContain('og:title')
    expect(previewBody).not.toContain('actual shared document')
    expect(previewResponse.headers.get('vary')).toMatch(/user-agent/i)
    expect(previewResponse.headers.get('vary')).toMatch(/sec-fetch-dest/i)
    expect(previewResponse.headers.get('cache-control')).toBe('no-store')
    expect(previewResponse.headers.get('x-robots-tag')).toMatch(/noindex/i)
    const head = await request('historical_123', crawler, 'HEAD')
    expect(head.status).toBe(200)
    expect(await head.text()).toBe('')
    const browser = await request('historical_123', { ...crawler, 'Sec-Fetch-Dest': 'document' })
    expect(await browser.text()).toContain('actual shared document')
    expect((await request('incorrect_key', crawler)).status).toBe(404)
    await rotateShare(management, actor, { ...target, expectedPolicyEpoch: 1, grantId: grant.grantId })
    expect((await request('historical_123')).status).toBe(404)
    expect((await request('historical_123', crawler)).status).toBe(404)
    const treePage = await documentCommand('preview-tree-representation', '/docs/preview.html', '<p>actual tree document</p>')
    const treePublished = await publishDocument(publication, actor, treePage.command, treePage.bytes)
    const treeTarget = { pageId: treePage.pageId, artifactId: treePublished.receipt.artifactId }
    const treeGrant = await importShare(management, actor, { ...treeTarget, expectedPolicyEpoch: 0, key: 'tree_share_123', mode: 'follow_active' })
    const treeRequest = (headers: Record<string, string> = {}) => handleRead(new Request('https://forge.example.test/s/docs/preview.html/tree_share_123', { headers }), { db: env.DB, config: config.read, jwks, nowSeconds: () => 100, store })
    expect(await (await treeRequest()).text()).toContain('actual tree document')
    const treePreview = await treeRequest(crawler)
    expect(await treePreview.text()).toContain('og:title')
    const exchange = await treeRequest({ 'Sec-Fetch-Dest': 'document' })
    expect(exchange.status).toBe(302)
    expect(exchange.headers.get('set-cookie')).toContain('forge_share=')
    await rotateShare(management, actor, { ...treeTarget, expectedPolicyEpoch: 1, grantId: treeGrant.grantId })
    expect((await treeRequest()).status).toBe(404)
    expect((await treeRequest(crawler)).status).toBe(404)
  })
})
