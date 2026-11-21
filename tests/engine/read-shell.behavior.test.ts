import { env } from 'cloudflare:workers'
import { beforeEach, describe, expect, it } from 'vitest'
import { createReadWorker, handleRead } from '../../adapters/http/readWorker'
import { unkillableShellAssets } from '../../adapters/web/unkillable-shell'
import { setVisibility } from '../../domains/catalogue/commands'
import type { FixedShellAssets } from '../../domains/delivery/shell'
import { UNLISTED_ROBOTS_TAG } from '../../domains/delivery/serve'
import { PublicationService } from '../../domains/publication'
import { RevisionStore } from '../../domains/store/revision-store'
import { actor, bootstrap, configs, instanceId, jwks, manageRequest, pageFixture } from './fixtures/catalogue'
import { documentCommand, publishDocument } from './fixtures/publication'

const fixed: FixedShellAssets = {
  '/favicon.ico': { body: new Uint8Array([0, 1, 255, 42]).buffer, contentType: 'image/x-icon' },
  '/apple-touch-icon.png': { body: new Uint8Array([137, 80, 78, 71]).buffer, contentType: 'image/png' },
  '/images/favicon.png': { body: new Uint8Array([137, 80, 78, 71, 1]).buffer, contentType: 'image/png' },
  '/robots.txt': { body: 'User-agent: *\nDisallow: /\n', contentType: 'text/plain; charset=utf-8' },
}
const paths = ['/', '/index.html', '/login', '/login.html', '/robots.txt', '/favicon.ico', '/apple-touch-icon.png', '/images/favicon.png']
const instance = {
  instanceId: 'test-forge', canonicalHost: 'forge.example.test', aliasHosts: ['alias.example.test'], manageHost: 'manage.example.test',
  accessTeamDomain: 'team.cloudflareaccess.com', readAudiences: ['read'], manageAudiences: ['manage'], login: 'serve-shell',
  routeGrammars: ['tree', 'subtree'], shareGrammars: ['page', 'card', 'slug'], shareCookie: true, shellPaths: paths,
}
const key = btoa(String.fromCharCode(...new Uint8Array(32).fill(4))).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_')
function bindings(overrides: object = {}) {
  return { DB: env.DB, REVISION_BYTES: env.REVISION_BYTES, FORGE_INSTANCE: JSON.stringify({ ...instance, ...overrides }), FORGE_SHARE_VERIFIER_KEYS: JSON.stringify([{ kid: 'current', key }]) }
}
function request(worker: { fetch(request: Request, bindings: Record<string, unknown>): Promise<Response> }, path: string, options: { method?: string; host?: string; bindings?: Record<string, unknown> } = {}) {
  return worker.fetch(new Request(`https://${options.host ?? 'forge.example.test'}${path}`, { method: options.method ?? 'GET' }), options.bindings ?? bindings())
}

beforeEach(async () => { await bootstrap() })

describe('fixed shell through the read worker', () => {
  it.each(Object.entries(fixed))('serves configured %s bytes and headers on both allowed hosts', async (path, file) => {
    const worker = createReadWorker(fixed)
    for (const host of ['forge.example.test', 'alias.example.test']) {
      const get = await request(worker, path, { host })
      expect(get.status).toBe(200)
      expect(get.headers.get('content-type')).toBe(file.contentType)
      expect(get.headers.get('cache-control')).toBe('no-store')
      expect(get.headers.get('x-content-type-options')).toBe('nosniff')
      const expected = typeof file.body === 'string' ? new TextEncoder().encode(file.body) : new Uint8Array(file.body)
      expect(new Uint8Array(await get.arrayBuffer())).toEqual(expected)
      const head = await request(worker, path, { host, method: 'HEAD' })
      expect(head.status).toBe(200)
      expect(head.headers.get('content-type')).toBe(file.contentType)
      expect((await head.arrayBuffer()).byteLength).toBe(0)
    }
  })

  it('serves the dynamic index alias and login without overriding the fixed map', async () => {
    const worker = createReadWorker(fixed)
    const root = await request(worker, '/')
    const index = await request(worker, '/index.html')
    expect(root.status).toBe(200)
    expect(index.status).toBe(200)
    expect(await index.text()).toBe(await root.text())
    for (const path of ['/login', '/login.html']) {
      expect((await request(worker, path)).status).toBe(200)
      const head = await request(worker, path, { method: 'HEAD' })
      expect(head.status).toBe(200)
      expect(await head.text()).toBe('')
    }
  })

  it('marks authenticated login redirects unlisted with unchanged Location on both aliases', async () => {
    const config = await configs()
    const store = new RevisionStore(env.REVISION_BYTES, instanceId)
    const jwt = (await manageRequest('reader', 'reader')).headers.get('Cf-Access-Jwt-Assertion')!
    for (const path of ['/login', '/login.html']) {
      const response = await handleRead(new Request(`https://forge.example.test${path}?next=/a/private/`, {
        headers: { 'Cf-Access-Jwt-Assertion': jwt },
      }), { db: env.DB, config: config.read, jwks, nowSeconds: () => 100, store, shellAssets: fixed })
      expect(response.status).toBe(302)
      expect(response.headers.get('location')).toBe('/a/private/')
      expect(response.headers.get('x-robots-tag')).toBe(UNLISTED_ROBOTS_TAG)
    }
  })

  it('keeps host, method, malformed path and instance gates ahead of shell bytes', async () => {
    const worker = createReadWorker(fixed)
    expect((await request(worker, '/robots.txt', { host: 'evil.example.test' })).status).toBe(403)
    expect((await request(worker, '/robots.txt', { method: 'POST' })).status).toBe(405)
    expect((await request(worker, '/%2frobots.txt')).status).toBe(404)
    expect((await request(worker, '/robots.txt', { bindings: bindings({ instanceId: 'other-forge' }) })).status).toBe(503)
    expect((await request(worker, '/robots.txt', { bindings: { ...bindings(), DB: env.EMPTY_DB } })).status).toBe(503)
    expect((await request(worker, '/manifest.json')).status).toBe(404)
    expect((await request(worker, '/not-configured.txt')).status).not.toBe(200)
  })

  it('does not serve a private artefact through the shell', async () => {
    await pageFixture({ route: { kind: 'subtree', slug: 'private' }, visibility: 'private', page: `pg_${'c'.repeat(26)}`, artifact: `ar_${'c'.repeat(26)}`, revision: `rv_${'c'.repeat(26)}` })
    const response = await request(createReadWorker(fixed), '/a/private/')
    expect(response.status).not.toBe(200)
    expect(await response.text()).not.toContain('User-agent: *')
  })

  it('rejects missing, extra and dynamic entries at composition rather than returning a shell 404', async () => {
    const { '/favicon.ico': _missing, ...incomplete } = fixed
    for (const bundle of [incomplete, { ...fixed, '/unconfigured': { body: 'x', contentType: 'text/plain' } }, { ...fixed, '/': { body: 'override', contentType: 'text/html' } }, { ...fixed, '/index.html': { body: 'override', contentType: 'text/html' } }, { ...fixed, '/login': { body: 'override', contentType: 'text/html' } }, { ...fixed, '/login.html': { body: 'override', contentType: 'text/html' } }]) {
      expect((await request(createReadWorker(bundle), '/robots.txt')).status).toBe(503)
    }
  })

  it('rejects a public bundle for the larger private instance contract', async () => {
    const privatePaths = ['/', '/index.html', '/login', '/login.html', '/robots.txt', '/favicon.ico', '/favicon.svg', '/favicon-32.png', '/apple-touch-icon.png', '/_shared/hero-base.css', '/_shared/hero-base.js', '/_shared/gallery-base.css', '/_shared/gallery-base.js', '/_shared/fgraph-base.css', '/_shared/explainer-base.css']
    const roxabiSubset = { '/robots.txt': fixed['/robots.txt'], '/favicon.ico': fixed['/favicon.ico'], '/apple-touch-icon.png': fixed['/apple-touch-icon.png'] }
    expect((await request(createReadWorker(roxabiSubset), '/robots.txt', { bindings: bindings({ shellPaths: privatePaths }) })).status).toBe(503)
  })
})

describe('unlisted robots path class matrix', () => {
  const { '/favicon.ico': _drop, ...incompleteBundle } = fixed
  const unkillableIncomplete: FixedShellAssets = {
    '/apple-touch-icon.png': unkillableShellAssets['/apple-touch-icon.png'],
    '/images/favicon.png': unkillableShellAssets['/images/favicon.png'],
    '/robots.txt': unkillableShellAssets['/robots.txt'],
  }

  beforeEach(async () => {
    const config = await configs()
    const store = new RevisionStore(env.REVISION_BYTES, instanceId)
    const publication = new PublicationService({
      db: env.DB, config: config.manage, jwks, now: () => 10_000, store,
      publication: { sessionTtlMs: 60_000, maxUploadTimeoutMs: 1000, retainMs: 900_000, marginMs: 1000, manageClockSkewMs: 0, readClockSkewMs: 0 },
    })
    const page = await documentCommand('shell-canonical', '/a/canonical-robots/index.html', '<p>canonical</p>')
    const published = await publishDocument(publication, actor, page.command, page.bytes)
    await setVisibility({ db: env.DB, config: config.manage, jwks, now: () => 10_000 }, actor, {
      pageId: page.pageId, artifactId: published.receipt.artifactId, expectedPolicyEpoch: 0, visibility: 'public',
    })
  })

  const variantWorkers = [
    { label: 'generic', complete: () => createReadWorker(fixed), incomplete: () => createReadWorker(incompleteBundle) },
    { label: 'unkillable', complete: () => createReadWorker(unkillableShellAssets), incomplete: () => createReadWorker(unkillableIncomplete) },
  ] as const

  const states = [
    { label: 'valid', env: () => bindings(), worker: 'complete' as const, available: true },
    { label: 'DB missing', env: () => { const b = bindings(); const { DB: _db, ...rest } = b; return rest }, worker: 'complete' as const, available: false },
    { label: 'R2 missing', env: () => { const b = bindings(); const { REVISION_BYTES: _r2, ...rest } = b; return rest }, worker: 'complete' as const, available: false },
    { label: 'bundle incomplete', env: () => bindings(), worker: 'incomplete' as const, available: false },
  ] as const

  const requests = [
    { path: '/login', method: 'GET' as const, kind: 'shell' as const, validStatus: 200 },
    { path: '/%6Cogin', method: 'GET' as const, kind: 'shell' as const, validStatus: 200 },
    { path: '/login.html', method: 'GET' as const, kind: 'shell' as const, validStatus: 200 },
    { path: '/_revisions/not-a-page/not-a-rev/index.html', method: 'GET' as const, kind: 'revision' as const, validStatus: 404 },
    { path: '/%5Frevisions/a//b', method: 'GET' as const, kind: 'revision' as const, validStatus: 404 },
    { path: '/_revisions/a//b', method: 'GET' as const, kind: 'revision' as const, validStatus: 404 },
    { path: '/login', method: 'POST' as const, kind: 'shell' as const, validStatus: 405 },
    { path: '/a/canonical-robots/', method: 'GET' as const, kind: 'canonical' as const, validStatus: 200 },
  ] as const

  const cases = variantWorkers.flatMap(variant => states.flatMap(state => requests.map(req => ({
    name: `${variant.label} × ${state.label} × ${req.method} ${req.path}`,
    variant, state, req,
  }))))

  it.each(cases)('$name', async ({ variant, state, req }) => {
    const worker = state.worker === 'complete' ? variant.complete() : variant.incomplete()
    const response = await worker.fetch(
      new Request(`https://forge.example.test${req.path}`, { method: req.method }),
      state.env() as Record<string, unknown>,
    )
    const expectStatus = state.available ? req.validStatus : 503
    expect(response.status).toBe(expectStatus)
    expect(response.headers.get('location')).toBeNull()
    if (req.kind === 'canonical') expect(response.headers.get('x-robots-tag')).toBeNull()
    else expect(response.headers.get('x-robots-tag')).toBe(UNLISTED_ROBOTS_TAG)
  })
})
