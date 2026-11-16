import { parseReadConfig } from '../../domains/catalogue/instance-config'
import { accessJwksSource, type JwksSource } from '../../domains/catalogue/identity'
import { resolveRead } from '../../domains/catalogue/resolve'
import { accessLoginLocation, parseRequest } from '../../domains/catalogue/routing/grammar'
import { listCatalogue } from '../../domains/catalogue/catalogue-list'
import type { ReadInstanceConfig } from '../../domains/catalogue/instance-config'
import { RevisionStore } from '../../domains/store/revision-store'
import { securityHeaders, serve, textResponse, type PinNamespace } from '../../domains/delivery/serve'
import { serveShellAsset, validateShellAssets, type FixedShellAssets } from '../../domains/delivery/shell'

export interface ReadRuntime { db: D1Database; config: ReadInstanceConfig; jwks: JwksSource; nowSeconds: () => number; store: RevisionStore; readonly shellAssets?: FixedShellAssets }
const EMPTY_SHELL_ASSETS: FixedShellAssets = Object.freeze({})
const escape = (s: string) => s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)
function html(body: string, method: string): Response {
  const headers = securityHeaders(); headers.set('content-type', 'text/html; charset=utf-8')
  return new Response(method === 'HEAD' ? null : `<!doctype html><html lang="en"><meta charset="utf-8"><title>Forge</title><body>${body}</body></html>`, { headers })
}
function redirect(location: string, status: number, cookie?: string, unlisted = false): Response {
  const headers = securityHeaders(); headers.set('location', location)
  if (cookie) headers.append('set-cookie', cookie)
  if (unlisted) headers.set('x-robots-tag', 'noindex, nofollow, noarchive')
  return new Response(null, { status, headers })
}
function pinCookie(request: Request): string | null {
  for (const part of (request.headers.get('cookie') ?? '').split(';')) {
    const trimmed = part.trim()
    if (trimmed.startsWith('forge_pin=')) return trimmed.slice('forge_pin='.length)
  }
  return null
}

export async function handleRead(request: Request, deps: ReadRuntime): Promise<Response> {
  try {
    const parsed = parseRequest(request, deps.config).parsed
    const pin: PinNamespace | null = parsed.kind === 'pinned' ? { pageId: parsed.pageId, revisionId: parsed.revisionId } : null
    const outcome = await resolveRead(request, { ...deps, pinnedProof: pin ? pinCookie(request) : null })
    switch (outcome.kind) {
      case 'deny': return textResponse(outcome.status, outcome.status === 404 ? 'Not found' : outcome.status === 503 ? 'Unavailable' : 'Forbidden', request.method)
      case 'login': return redirect(outcome.location, 302)
      case 'redirect': return redirect(outcome.location, outcome.status)
      case 'shell': {
        if (!['/', '/index.html', '/login', '/login.html'].includes(outcome.path)) {
          const asset = deps.shellAssets?.[outcome.path]
          return asset ? serveShellAsset(request, asset) : textResponse(503, 'Unavailable', request.method)
        }
        const manage = `https://${deps.config.manageHost}/manage`
        const login = parsed.kind === 'shell' && parsed.login ? accessLoginLocation(deps.config, parsed.login.next, parsed.login.host) : '/'
        return html(outcome.path !== '/' && outcome.path !== '/index.html' ? `<h1>Sign in</h1><a href="${escape(login)}">Sign in with Access</a>` : `<h1>Forge</h1><p><a href="${escape(manage)}">Manage publications</a></p><main id="catalogue"></main><script>async function load(){const m=document.getElementById('catalogue');let after='';do{const r=await fetch('/api/catalogue'+(after?'?after='+encodeURIComponent(after):''));if(!r.ok)throw Error('Catalogue unavailable');const rows=await r.json();for(const row of rows){const a=document.createElement('a');a.href=row.url;a.textContent=typeof row.metadata?.title==='string'?row.metadata.title:row.url;const p=document.createElement('p');p.append(a);const manage=document.createElement('a');manage.href='https://${deps.config.manageHost}/manage?pageId='+encodeURIComponent(row.pageId);manage.textContent=' Manage';p.append(manage);m.append(p)}after=rows.length===50?rows[rows.length-1].pageId:''}while(after)}load().catch(()=>{document.getElementById('catalogue').textContent='Catalogue unavailable'})</script>`, request.method)
      }
      case 'catalogue': {
        const entries = await listCatalogue(deps.db, deps.config, outcome.viewer, { after: new URL(request.url).searchParams.get('after') })
        const headers = securityHeaders(); headers.set('content-type', 'application/json; charset=utf-8')
        return new Response(request.method === 'HEAD' ? null : JSON.stringify(entries), { headers })
      }
      case 'share_exchange': {
        const p = outcome.plan
        const object = await deps.store.head({ kind: 'resource', artifactId: p.artifactId, revisionId: p.revisionId, path: p.resource.path })
        if (!object) return textResponse(404, 'Not found', request.method)
        if (object.sha256 !== p.resource.sha256 || object.size !== p.resource.size) return textResponse(503, 'Unavailable', request.method)
        return redirect(outcome.location, 302, `forge_share=${encodeURIComponent(`${outcome.cookie.pageRef}|${outcome.cookie.key}`)}; HttpOnly; Secure; SameSite=Lax; Path=/`, true)
      }
      case 'serve': case 'share_unfurl': case 'share_card': {
        const plan = outcome.plan
        const namespace = pin ?? (plan.pinnedProof && plan.authority.pageId ? { pageId: plan.authority.pageId, revisionId: plan.revisionId } : null)
        return await serve(request, plan, deps.store, namespace, {
          manageHost: deps.config.manageHost,
          canonicalHost: deps.config.canonicalHost,
          aliasHosts: deps.config.aliasHosts,
          shellPaths: deps.config.shellPaths,
          shareContext: outcome.kind === 'serve' ? outcome.shareContext : null,
          unlisted: outcome.unlisted,
        })
      }
    }
  } catch { return textResponse(503, 'Unavailable', request.method) }
}

async function runtimeFor(env: Record<string, unknown>, shellAssets: FixedShellAssets): Promise<ReadRuntime | null> {
  const config = await parseReadConfig(env)
  const bucket = env.REVISION_BYTES as R2Bucket | undefined
  if (!config.ok || !validateShellAssets(config.config.shellPaths, shellAssets) || !bucket || typeof bucket.head !== 'function' || typeof bucket.get !== 'function') return null
  return { db: env.DB as D1Database, config: config.config, jwks: accessJwksSource(), nowSeconds: () => Date.now() / 1000, store: new RevisionStore(bucket, config.config.instanceId), shellAssets }
}
export function createReadWorker(shellAssets: FixedShellAssets = EMPTY_SHELL_ASSETS) {
  const runtimes = new WeakMap<object, Promise<ReadRuntime | null>>()
  return { async fetch(request: Request, env: Record<string, unknown>): Promise<Response> {
    let runtime = runtimes.get(env)
    if (!runtime) { runtime = runtimeFor(env, shellAssets).catch(() => null); runtimes.set(env, runtime) }
    const deps = await runtime
    return deps ? handleRead(request, deps) : textResponse(503, 'Unavailable', request.method)
  } }
}
export default createReadWorker()
