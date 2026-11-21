import { env } from 'cloudflare:workers'
import { beforeEach, describe, expect, it } from 'vitest'
import { createReadWorker, handleRead } from '../../adapters/http/readWorker'
import { unkillableShellAssets } from '../../adapters/web/unkillable-shell'
import type { FixedShellAssets } from '../../domains/delivery/shell'
import { RevisionStore } from '../../domains/store/revision-store'
import { bootstrap, configs, instanceId, jwks, manageRequest, pageFixture } from './fixtures/catalogue'

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
    expect(root.headers.get('x-robots-tag')).toBe('noindex, nofollow, noarchive')
    for (const path of ['/login', '/login.html']) {
      const get = await request(worker, path)
      expect(get.status).toBe(200)
      expect(get.headers.get('x-robots-tag')).toBe('noindex, nofollow, noarchive')
      const head = await request(worker, path, { method: 'HEAD' })
      expect(head.status).toBe(200)
      expect(head.headers.get('x-robots-tag')).toBe('noindex, nofollow, noarchive')
      expect(await head.text()).toBe('')
    }
  })

  it('marks fixed shell assets unlisted with the shared robots tag', async () => {
    const worker = createReadWorker(fixed)
    const robots = await request(worker, '/robots.txt')
    expect(robots.status).toBe(200)
    expect(robots.headers.get('x-robots-tag')).toBe('noindex, nofollow, noarchive')
  })

  it.each([
    ['generic', () => createReadWorker(fixed)],
    ['unkillable', () => createReadWorker(unkillableShellAssets)],
  ] as const)('marks shell-path Access redirects and method denials unlisted for %s worker', async (_label, makeWorker) => {
    const worker = makeWorker()
    const accessLocation = 'https://team.cloudflareaccess.com/cdn-cgi/access/login/forge.example.test?redirect_url=' + encodeURIComponent('https://forge.example.test/a/private/')
    for (const path of ['/login', '/login.html']) {
      const anonymous = await request(worker, `${path}?next=/a/private/`, { bindings: bindings({ login: 'redirect-access-login' }) })
      expect(anonymous.status).toBe(302)
      expect(anonymous.headers.get('location')).toBe(accessLocation)
      expect(anonymous.headers.get('x-robots-tag')).toBe('noindex, nofollow, noarchive')
      const denied = await request(worker, path, { method: 'POST' })
      expect(denied.status).toBe(405)
      expect(denied.headers.get('allow')).toBe('GET, HEAD')
      expect(denied.headers.get('x-robots-tag')).toBe('noindex, nofollow, noarchive')
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
      expect(response.headers.get('x-robots-tag')).toBe('noindex, nofollow, noarchive')
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
    await pageFixture({ route: { kind: 'subtree', slug: 'private' }, visibility: 'private' })
    const response = await request(createReadWorker(fixed), '/a/private/')
    expect(response.status).not.toBe(200)
    expect(await response.text()).not.toContain('User-agent: *')
  })

  it('rejects missing, extra and dynamic entries at composition rather than returning a shell 404', async () => {
    const { '/favicon.ico': _missing, ...incomplete } = fixed
    for (const bundle of [incomplete, { ...fixed, '/unconfigured': { body: 'x', contentType: 'text/plain' } }, { ...fixed, '/': { body: 'override', contentType: 'text/html' } }, { ...fixed, '/index.html': { body: 'override', contentType: 'text/html' } }, { ...fixed, '/login': { body: 'override', contentType: 'text/html' } }, { ...fixed, '/login.html': { body: 'override', contentType: 'text/html' } }]) {
      const unavailable = await request(createReadWorker(bundle), '/robots.txt')
      expect(unavailable.status).toBe(503)
      expect(unavailable.headers.get('x-robots-tag')).toBe('noindex, nofollow, noarchive')
    }
  })

  it('marks percent-encoded login and revision-prefix paths with the shared robots tag', async () => {
    const worker = createReadWorker(fixed)
    const encodedLogin = await request(worker, '/%6Cogin')
    expect(encodedLogin.status).toBe(200)
    expect(await encodedLogin.text()).toContain('Sign in')
    expect(encodedLogin.headers.get('x-robots-tag')).toBe('noindex, nofollow, noarchive')
    const accessLocation = 'https://team.cloudflareaccess.com/cdn-cgi/access/login/forge.example.test?redirect_url=' + encodeURIComponent('https://forge.example.test/a/private/')
    const encodedRedirect = await request(worker, '/%6Cogin?next=/a/private/', { bindings: bindings({ login: 'redirect-access-login' }) })
    expect(encodedRedirect.status).toBe(302)
    expect(encodedRedirect.headers.get('location')).toBe(accessLocation)
    expect(encodedRedirect.headers.get('x-robots-tag')).toBe('noindex, nofollow, noarchive')
    const encodedPin = await request(worker, '/%5Frevisions/not-a-page/not-a-rev/index.html')
    expect(encodedPin.status).toBe(404)
    expect(encodedPin.headers.get('x-robots-tag')).toBe('noindex, nofollow, noarchive')
  })

  it('rejects a public bundle for the larger private instance contract', async () => {
    const privatePaths = ['/', '/index.html', '/login', '/login.html', '/robots.txt', '/favicon.ico', '/favicon.svg', '/favicon-32.png', '/apple-touch-icon.png', '/_shared/hero-base.css', '/_shared/hero-base.js', '/_shared/gallery-base.css', '/_shared/gallery-base.js', '/_shared/fgraph-base.css', '/_shared/explainer-base.css']
    const roxabiSubset = { '/robots.txt': fixed['/robots.txt'], '/favicon.ico': fixed['/favicon.ico'], '/apple-touch-icon.png': fixed['/apple-touch-icon.png'] }
    expect((await request(createReadWorker(roxabiSubset), '/robots.txt', { bindings: bindings({ shellPaths: privatePaths }) })).status).toBe(503)
  })
})
