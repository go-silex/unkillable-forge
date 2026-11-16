import { readPagePolicy, revealShare, revokeShare, rotateShare, setVisibility, share, type PagePolicyView } from '../../domains/catalogue/commands'
import { authenticateManage } from '../../domains/catalogue/principals'
import { admitManageRequest, publicError } from '../http/manage-edge'
import type { Runtime } from '../http/manage-config'
import { cancelBody, InputError } from '../http/publication-input'

const headers = {
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Content-Security-Policy': "default-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
  'Content-Type': 'text/html; charset=utf-8',
}
const escape = (value: string) => value.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)
function response(request: Request, status: number, body: string, allow?: string): Response {
  return new Response(request.method === 'HEAD' ? null : `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Forge management</title></head><body><main>${body}</main></body></html>`, { status, headers: allow ? { ...headers, Allow: allow } : headers })
}
function errorResponse(request: Request, status: number, code: string, allow?: string): Response {
  return response(request, status, `<h1>Management unavailable</h1><p>${escape(code)}</p>`, allow)
}

// A top-level browser navigation is not the native API's origin-less mode.
function admitNavigation(request: Request, url: URL, host: string) {
  const origin = `https://${host}`
  const literalHost = request.headers.get('host')
  if (url.origin !== origin || url.username || url.password || url.hash || (literalHost !== null && literalHost !== host)) return { status: 403, code: 'forbidden' }
  if (request.headers.has('origin') || request.headers.get('sec-fetch-mode') !== 'navigate' || request.headers.get('sec-fetch-dest') !== 'document' || !['none', 'same-origin', 'cross-site', 'same-site'].includes(request.headers.get('sec-fetch-site') ?? '')) return admitManageRequest(request, url, host)
  if (request.headers.has('cf-access-jwt-assertion') && !request.headers.get('cf-access-jwt-assertion')?.trim()) return { status: 401, code: 'unauthenticated' }
  return null
}

async function formBody(request: Request, runtime: Runtime): Promise<URLSearchParams> {
  if (!/^application\/x-www-form-urlencoded(?:\s*;\s*charset\s*=\s*utf-8)?$/i.test(request.headers.get('content-type') ?? '')) throw new InputError('unsupported_media_type')
  const encoding = request.headers.get('content-encoding')
  if (encoding !== null && !/^identity$/i.test(encoding)) throw new InputError('unsupported_media_type')
  const length = request.headers.get('content-length')
  if (length !== null && (!/^\d+$/.test(length) || !Number.isSafeInteger(Number(length)))) throw new InputError('invalid_request')
  if (length !== null && Number(length) > runtime.transport.maxCommandBytes) throw new InputError('payload_too_large')
  if (!request.body) throw new InputError('invalid_request')
  const reader = request.body.getReader()
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new InputError('request_timeout')), runtime.transport.commandReadTimeoutMs) })
  let size = 0, text = ''
  const decoder = new TextDecoder('utf-8', { fatal: true })
  try {
    for (;;) {
      const part = await Promise.race([reader.read().catch(() => { throw new InputError('request_timeout') }), timeout])
      if (part.done) break
      size += part.value.byteLength
      if (size > runtime.transport.maxCommandBytes) throw new InputError('payload_too_large')
      text += decoder.decode(part.value, { stream: true })
    }
    text += decoder.decode()
    return new URLSearchParams(text)
  } catch (error) {
    if (error instanceof InputError) throw error
    throw new InputError('invalid_request')
  } finally {
    clearTimeout(timer)
    void reader.cancel().catch(() => {})
    try { reader.releaseLock() } catch { /* pending read settles independently */ }
  }
}
function one(form: URLSearchParams, name: string): string {
  const values = form.getAll(name)
  if (values.length !== 1 || !values[0]) throw new InputError('invalid_request')
  return values[0]
}
function exact(form: URLSearchParams, names: readonly string[]): void {
  let count = 0
  form.forEach((_, key) => { count++; if (!names.includes(key)) throw new InputError('invalid_request') })
  if (count !== names.length || names.some(name => form.getAll(name).length !== 1)) throw new InputError('invalid_request')
}
function render(view: PagePolicyView | null, key?: string | null): string {
  const select = '<h1>Forge management</h1><form method="get" action="/manage"><label>Page ID <input name="pageId" required></label> <button>Select page</button></form>'
  if (!view) return select
  const hidden = `<input type="hidden" name="pageId" value="${escape(view.pageId)}"><input type="hidden" name="artifactId" value="${escape(view.artifactId)}"><input type="hidden" name="epoch" value="${view.policyEpoch}">`
  const action = (op: string, label: string, extra = '') => `<form method="post" action="/manage">${hidden}${extra}<button name="op" value="${op}">${label}</button></form>`
  const grant = view.grant ? `<input type="hidden" name="grantId" value="${escape(view.grant.grantId)}">` : ''
  const secret = key ? view.shareUrlPrefix ? `<p>Share link: <a href="${escape(view.shareUrlPrefix + encodeURIComponent(key) + '/')}">${escape(view.shareUrlPrefix + encodeURIComponent(key) + '/')}</a></p>` : `<p>Share key: <code>${escape(key)}</code> (no share URL is configured for this route)</p>` : ''
  return `${select}<h2>Page ${escape(view.pageId)}</h2><p>Visibility: ${escape(view.visibility)} · Policy epoch: ${view.policyEpoch}</p>${view.canonicalUrl ? `<p><a href="${escape(view.canonicalUrl)}">Open page</a></p>` : ''}${secret}${action('private', 'Make private')}${action('public', 'Make public')}${action('share', 'Share (follow active revision)')}${view.grant ? `${action('rotate', 'Rotate share link', grant)}${action('revoke', 'Revoke share link', grant)}${view.grant.revealable ? action('reveal', 'Reveal share link', grant) : '<p>This share key cannot be revealed; rotate it to get a new link.</p>'}` : ''}`
}

/** Handle the browser management page, or return null for another route. */
export async function handleManageWeb(request: Request, runtime: Runtime): Promise<Response | null> {
  const url = new URL(request.url)
  if (url.pathname !== '/manage') return null
  try {
    if (!['GET', 'HEAD', 'POST'].includes(request.method)) return errorResponse(request, 405, 'method_not_allowed', 'GET, HEAD, POST')
    const admission = request.method === 'POST' ? admitManageRequest(request, url, runtime.deps.config.manageHost) : admitNavigation(request, url, runtime.deps.config.manageHost)
    if (admission) return errorResponse(request, admission.status, admission.code)
    if (request.method === 'POST' && request.headers.get('origin') !== `https://${runtime.deps.config.manageHost}`) return errorResponse(request, 403, 'forbidden')
    if (request.method === 'POST' && url.search) throw new InputError('invalid_request')
    if (request.method !== 'POST') {
      let count = 0
      url.searchParams.forEach((_, key) => { count++; if (key !== 'pageId') throw new InputError('invalid_request') })
      if (count > 1 || (count === 1 && !url.searchParams.get('pageId'))) throw new InputError('invalid_request')
    }
    const actor = await authenticateManage(request, runtime.deps)
    if (!actor) return errorResponse(request, 401, 'unauthenticated')
    if (request.method !== 'POST') {
      const pageId = url.searchParams.get('pageId')
      const view = pageId ? await readPagePolicy(runtime.deps, actor, pageId) : null
      if (pageId && !view) return errorResponse(request, 404, 'not_found')
      return response(request, 200, render(view))
    }
    const form = await formBody(request, runtime)
    const op = one(form, 'op')
    const grantOp = op === 'rotate' || op === 'revoke' || op === 'reveal'
    exact(form, grantOp ? ['op', 'pageId', 'artifactId', 'epoch', 'grantId'] : ['op', 'pageId', 'artifactId', 'epoch'])
    const epoch = one(form, 'epoch')
    if (!/^(0|[1-9]\d*)$/.test(epoch) || !Number.isSafeInteger(Number(epoch))) throw new InputError('invalid_request')
    const target = { pageId: one(form, 'pageId'), artifactId: one(form, 'artifactId'), expectedPolicyEpoch: Number(epoch) }
    let key: string | null = null
    switch (op) {
      case 'private': case 'public': await setVisibility(runtime.deps, actor, { ...target, visibility: op }); break
      case 'share': key = (await share(runtime.deps, actor, { ...target, mode: 'follow_active' })).key; break
      case 'rotate': key = (await rotateShare(runtime.deps, actor, { ...target, grantId: one(form, 'grantId') })).key; break
      case 'revoke': await revokeShare(runtime.deps, actor, { ...target, grantId: one(form, 'grantId') }); break
      case 'reveal': key = (await revealShare(runtime.deps, actor, { ...target, grantId: one(form, 'grantId') })).key; break
      default: throw new InputError('invalid_request')
    }
    const view = await readPagePolicy(runtime.deps, actor, target.pageId)
    if (!view) return errorResponse(request, 404, 'not_found')
    return response(request, 200, render(view, key))
  } catch (error) {
    const fault = publicError(error)
    return errorResponse(request, fault.status, fault.code)
  } finally { cancelBody(request) }
}
