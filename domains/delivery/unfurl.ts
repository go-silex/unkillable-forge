import type { SharedPreviewPlan } from '../catalogue/previews'
import type { PreviewCardPlan } from '../catalogue/preview-cards'
import type { RevisionStore } from '../store/revision-store'
import { securityHeaders, textResponse, UNLISTED_ROBOTS_TAG } from './serve'

const escape = (value: string) => value.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)

export function unfurl(request: Request, plan: SharedPreviewPlan, key: string): Response {
  const headers = securityHeaders()
  headers.set('content-type', 'text/html; charset=utf-8')
  headers.set('x-robots-tag', UNLISTED_ROBOTS_TAG)
  if (request.method === 'HEAD') return new Response(null, { headers })
  let image = ''
  if (plan.image) {
    const base = `/_revisions/${plan.pageId}/${plan.revisionId}/_derived/`
    const url = new URL(plan.image.kind === 'original' ? `${base}original` : `${base}og/${plan.image.descriptor.ref.recipeSha256}/${plan.image.descriptor.ref.inputSha256}/${plan.image.descriptor.ref.contentSha256}.${plan.image.descriptor.ref.extension}`, request.url)
    url.searchParams.set('k', key)
    if (plan.image.kind === 'original') url.searchParams.set('path', plan.image.path)
    image = `<meta property="og:image" content="${escape(url.href)}">`
  }
  const description = plan.description === null ? '' : `<meta property="og:description" content="${escape(plan.description)}">`
  return new Response(`<!doctype html><html><head><meta charset="utf-8"><title>${escape(plan.title)}</title><meta property="og:title" content="${escape(plan.title)}">${description}${image}</head><body></body></html>`, { headers })
}

/** Called only with an exact, freshly authorized Catalogue card plan. */
export async function serveCard(request: Request, plan: PreviewCardPlan, store: RevisionStore): Promise<Response> {
  const image = plan.descriptor
  const ref = image.kind === 'original' ? { kind: 'resource' as const, artifactId: plan.artifactId, revisionId: plan.revisionId, path: image.path } : image.descriptor.ref
  const expected = image.kind === 'original' ? image : image.descriptor
  const info = await store.head(ref)
  if (!info) return textResponse(404, 'Not found', request.method)
  if (info.sha256 !== expected.sha256 || info.size !== expected.size || info.key !== expected.objectKey || info.version !== expected.objectVersion) return textResponse(503, 'Unavailable', request.method)
  const headers = securityHeaders()
  headers.set('x-robots-tag', UNLISTED_ROBOTS_TAG)
  headers.set('content-type', expected.contentType)
  headers.set('accept-ranges', 'bytes')
  const etag = `"${expected.sha256}"`
  headers.set('etag', etag)
  const match = request.headers.get('if-none-match')
  if (match && match.split(',').some(value => value.trim() === '*' || value.trim().replace(/^W\//, '') === etag)) return new Response(null, { status: 304, headers })
  let start = 0, end = info.size - 1, partial = false
  const range = request.method === 'GET' && request.headers.get('range')
  const ifRange = request.headers.get('if-range')
  if (range && (!ifRange || ifRange === etag)) {
    const m = /^bytes=(\d*)-(\d*)$/.exec(range.trim())
    if (m && (m[1] || m[2])) {
      if (!m[1]) start = Math.max(0, info.size - Number(m[2]))
      else { start = Number(m[1]); if (m[2]) end = Math.min(end, Number(m[2])) }
      if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start >= info.size) {
        headers.set('content-range', `bytes */${info.size}`)
        return new Response(null, { status: 416, headers })
      }
      partial = true
    }
  }
  headers.set('content-length', String(partial ? end - start + 1 : info.size))
  if (partial) headers.set('content-range', `bytes ${start}-${end}/${info.size}`)
  if (request.method === 'HEAD') return new Response(null, { headers })
  const object = await store.get(ref, partial ? { range: { offset: start, length: end - start + 1 } } : undefined)
  if (!object || !('body' in object) || !object.body) return textResponse(404, 'Not found', request.method)
  if (object.size !== info.size || object.version !== info.version) { void object.body.cancel(); return textResponse(503, 'Unavailable', request.method) }
  return new Response(object.body, { status: partial ? 206 : 200, headers })
}
