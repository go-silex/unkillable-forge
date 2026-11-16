import type { ReadPlan } from '../catalogue/read'
import type { RevisionStore } from '../store/revision-store'
import { rewriteCss, rewriteHtml, transformedContentType } from './rewrite'

export interface PinNamespace { readonly pageId: string; readonly revisionId: string }

export interface ServeOptions {
  readonly manageHost: string
  readonly canonicalHost: string
  readonly aliasHosts: readonly string[]
  readonly shellPaths: readonly string[]
  readonly shareContext: { readonly canonicalPrefix: string; readonly sharePrefix: string } | null
  readonly unlisted: boolean
}

export function pinPath(pin: PinNamespace): string {
  return `/_revisions/${pin.pageId}/${pin.revisionId}/`
}

export function securityHeaders(): Headers {
  return new Headers({ 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer', 'x-frame-options': 'SAMEORIGIN' })
}

export function textResponse(status: number, body: string, method = 'GET'): Response {
  const headers = securityHeaders()
  headers.set('content-type', 'text/plain; charset=utf-8')
  if (status === 404) headers.set('x-robots-tag', 'noindex, nofollow')
  if (status === 405) headers.set('allow', 'GET, HEAD')
  return new Response(method === 'HEAD' ? null : body, { status, headers })
}

/** Called only after Catalogue has authorized the selected object. */
export async function serve(request: Request, plan: ReadPlan, store: RevisionStore, pin: PinNamespace | null, options: ServeOptions): Promise<Response> {
  const ref = { kind: 'resource' as const, artifactId: plan.artifactId, revisionId: plan.revisionId, path: plan.resource.path }
  const info = await store.head(ref)
  if (!info) return textResponse(404, 'Not found', request.method)
  if (info.size !== plan.resource.size || info.sha256 !== plan.resource.sha256) return textResponse(503, 'Unavailable', request.method)
  const type = plan.resource.contentType.split(';', 1)[0].trim().toLowerCase()
  const transformed = !!pin && (type === 'text/html' || type === 'text/css')
  const headers = securityHeaders()
  if (options.unlisted) headers.set('x-robots-tag', 'noindex, nofollow, noarchive')
  headers.set('content-type', plan.resource.contentType)
  if (plan.pinnedProof && pin) headers.append('set-cookie', `forge_pin=${plan.pinnedProof}; Path=${pinPath(pin)}; Max-Age=900; HttpOnly; Secure; SameSite=Lax`)
  const etag = `"${plan.resource.sha256}"`
  if (!transformed) {
    headers.set('etag', etag)
    headers.set('accept-ranges', 'bytes')
    const match = request.headers.get('if-none-match')
    if (match && match.split(',').some(value => value.trim() === '*' || value.trim().replace(/^W\//, '') === etag)) return new Response(null, { status: 304, headers })
  }
  let start = 0, end = info.size - 1, partial = false
  const range = request.method === 'GET' && !transformed && request.headers.get('range')
  const ifRange = request.headers.get('if-range')
  if (range && (!ifRange || ifRange === etag)) {
    const m = /^bytes=(\d*)-(\d*)$/.exec(range.trim())
    if (m && (m[1] || m[2])) {
      if (!m[1]) { const suffix = Number(m[2]); start = Math.max(0, info.size - suffix) }
      else { start = Number(m[1]); if (m[2]) end = Math.min(end, Number(m[2])) }
      if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start >= info.size) {
        headers.set('content-range', `bytes */${info.size}`)
        return new Response(null, { status: 416, headers })
      }
      partial = true
    }
  }
  if (!transformed) {
    headers.set('content-length', String(partial ? end - start + 1 : info.size))
    if (partial) headers.set('content-range', `bytes ${start}-${end}/${info.size}`)
  }
  if (request.method === 'HEAD') {
    if (transformed) headers.set('content-type', transformedContentType(plan.resource.contentType))
    return new Response(null, { status: partial ? 206 : 200, headers })
  }
  const object = await store.get(ref, partial ? { range: { offset: start, length: end - start + 1 } } : undefined)
  if (!object || !('body' in object) || !object.body) return textResponse(404, 'Not found', request.method)
  if (object.size !== info.size || object.version !== info.version) { void object.body.cancel(); return textResponse(503, 'Unavailable', request.method) }
  let response = new Response(object.body, { status: partial ? 206 : 200, headers })
  if (transformed && pin) {
    const encodedPath = plan.resource.path.split('/').map(encodeURIComponent).join('/')
    const original = new URL(encodedPath, request.url).href
    if (type === 'text/html') {
      const navigable = plan.resource.kind === 'document' || plan.resource.kind === 'subdocument'
      const managementUrl = navigable ? `https://${options.manageHost}/manage?pageId=${encodeURIComponent(pin.pageId)}` : null
      response = await rewriteHtml(response, { documentUrl: original, managementUrl, ...pin, ...options })
    }
    else response = await rewriteCss(response, { resourceUrl: original, ...pin, ...options })
  }
  return response
}
