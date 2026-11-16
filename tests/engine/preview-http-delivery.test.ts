import { describe, expect, it } from 'vitest'
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
