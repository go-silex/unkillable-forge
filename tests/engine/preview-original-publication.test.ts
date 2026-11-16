import { env } from 'cloudflare:workers'
import { beforeEach, describe, expect, it } from 'vitest'
import { handleRead } from '../../adapters/http/readWorker'
import { importShare, setVisibility } from '../../domains/catalogue/commands'
import { PublicationService } from '../../domains/publication'
import { RevisionStore } from '../../domains/store/revision-store'
import { actor, bootstrap, configs, instanceId, jwks } from './fixtures/catalogue'
import { body, content, documentCommand, publishDocument } from './fixtures/publication'

beforeEach(async () => { await bootstrap() })

describe('published original preview images', () => {
  it.each([
    ['/a/original/index.html', '/a/original/og.jpg', '/s/original/original_key123/'],
    ['/docs/original.html', '/docs/original.og.jpg', '/s/docs/original.html/original_key123'],
  ])('serves the original published with %s', async (documentPath, imagePath, sharePath) => {
    const config = await configs()
    const store = new RevisionStore(env.REVISION_BYTES, instanceId)
    const publication = new PublicationService({ db: env.DB, config: config.manage, jwks, now: () => 10_000, store, publication: { sessionTtlMs: 60_000, maxUploadTimeoutMs: 1000, retainMs: 900_000, marginMs: 1000, manageClockSkewMs: 0, readClockSkewMs: 0 } })
    const page = await documentCommand(`original-${documentPath}`, documentPath, '<p>page</p>')
    const image = await content('original image bytes')
    const command = { ...page.command, files: [...page.command.files, { path: imagePath, kind: 'asset' as const, sha256: image.sha256, size: image.size, contentType: 'image/jpeg', source: 'client' as const }], edges: [{ ownerPageId: page.pageId, path: imagePath, providerArtifactId: null }] }
    const session = await publication.begin(actor, command)
    await publication.upload(actor, session.sessionId, documentPath, body(page.bytes))
    await publication.upload(actor, session.sessionId, imagePath, body(image.bytes))
    await publication.seal(actor, session.sessionId)
    const receipt = await publication.commit(actor, session.sessionId)
    await importShare({ db: env.DB, config: config.manage, jwks, now: () => 10_000 }, actor, { pageId: page.pageId, artifactId: receipt.artifactId, expectedPolicyEpoch: 0, key: 'original_key123', mode: 'follow_active' })
    const deps = { db: env.DB, config: config.read, jwks, nowSeconds: () => 100, store }
    const preview = await handleRead(new Request(`https://forge.example.test${sharePath}`, { headers: { 'User-Agent': 'Slackbot' } }), deps)
    const html = await preview.text()
    const url = /<meta property="og:image" content="([^"]+)"/.exec(html)?.[1].replaceAll('&amp;', '&')
    expect(url).toBeDefined()
    const card = await handleRead(new Request(url!), deps)
    expect(card.status).toBe(200)
    expect(new Uint8Array(await card.arrayBuffer())).toEqual(image.bytes)
    if (documentPath.startsWith('/docs/')) {
      const historical = await handleRead(new Request('https://forge.example.test/s/docs/original.og.jpg/original_key123'), deps)
      expect(historical.status).toBe(200)
      expect(new Uint8Array(await historical.arrayBuffer())).toEqual(image.bytes)
    }
    expect((await handleRead(new Request(url!.replace('original_key123', 'wrong_key123')), deps)).status).toBe(404)
  })

  it('preserves the canonical tree URL /_derived', async () => {
    const config = await configs()
    const store = new RevisionStore(env.REVISION_BYTES, instanceId)
    const publication = new PublicationService({ db: env.DB, config: config.manage, jwks, now: () => 10_000, store, publication: { sessionTtlMs: 60_000, maxUploadTimeoutMs: 1000, retainMs: 900_000, marginMs: 1000, manageClockSkewMs: 0, readClockSkewMs: 0 } })
    const page = await documentCommand('derived-tree', '/_derived.html', 'tree page')
    const { receipt } = await publishDocument(publication, actor, page.command, page.bytes)
    await setVisibility({ db: env.DB, config: config.manage, jwks, now: () => 10_000 }, actor, { pageId: page.pageId, artifactId: receipt.artifactId, expectedPolicyEpoch: 0, visibility: 'public' })
    const deps = { db: env.DB, config: config.read, jwks, nowSeconds: () => 100, store }
    const response = await handleRead(new Request('https://forge.example.test/_derived'), deps)
    expect(response.status).toBe(200)
    expect(await response.text()).toContain('tree page')
    expect((await handleRead(new Request('https://forge.example.test/_derived/anything'), deps)).status).toBe(404)
  })
})
