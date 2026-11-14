import { authenticateManage } from '../../domains/catalogue/principals'
import { PolicyError } from '../../domains/catalogue/guard'
import { StoreError } from '../../domains/store/revision-store'
import type { PublicationReceipt, PublicationStatus } from '../../domains/publication'
import { runtimeFor } from './manage-config'
import { cancelBody, checkFraming, InputError, readCommand, uploadStream } from './publication-input'

const headers = {
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'",
  'Content-Type': 'application/json; charset=utf-8',
}
function response(request: Request, status: number, value: unknown, allow?: string): Response {
  return new Response(request.method === 'HEAD' ? null : JSON.stringify(value), { status, headers: allow ? { ...headers, Allow: allow } : headers })
}
function errorResponse(request: Request, status: number, code: string, allow?: string): Response {
  return response(request, status, { ok: false, error: { code } }, allow)
}
function statusDTO(s: PublicationStatus) {
  return { sessionId: s.sessionId, artifactId: s.artifactId, revisionId: s.revisionId, baseRevisionId: s.baseRevisionId, expiresAt: s.expiresAt, state: s.state, files: s.files.map(f => ({ path: f.path, source: f.source, stored: f.stored })) }
}
function receiptDTO(r: PublicationReceipt) {
  return { artifactId: r.artifactId, revisionId: r.revisionId, contentVersion: r.contentVersion, pages: r.pages.map(p => ({ pageId: p.pageId, url: p.url })) }
}
function mapError(request: Request, error: unknown): Response {
  if (error instanceof InputError) return errorResponse(request, error.code === 'payload_too_large' ? 413 : error.code === 'request_timeout' ? 408 : error.code === 'unsupported_media_type' ? 415 : 400, error.code)
  if (error instanceof PolicyError) {
    switch (error.code) {
      case 'instance_mismatch': return errorResponse(request, 503, 'configuration_error')
      case 'unauthenticated': return errorResponse(request, 401, 'unauthenticated')
      case 'forbidden': case 'last_admin': return errorResponse(request, 403, 'forbidden')
      case 'not_found': return errorResponse(request, 404, 'not_found')
      case 'conflict': return errorResponse(request, 409, 'conflict')
      case 'invariant_violation': return errorResponse(request, 500, 'internal_error')
      case 'invalid_state':
        if (error.detail === 'incomplete' || error.detail === 'publication_incomplete') return errorResponse(request, 409, 'upload_incomplete')
        if (error.detail === 'publication_not_sealed') return errorResponse(request, 409, 'not_sealed')
        if (error.detail === 'publication_closed') return errorResponse(request, 409, 'session_closed')
        if (error.detail === 'publication_expired') return errorResponse(request, 410, 'session_expired')
        return errorResponse(request, 422, 'invalid_state')
    }
  }
  if (error instanceof StoreError) {
    if (error.code === 'conflict') return errorResponse(request, 409, 'conflict')
    if (error.code === 'invalid_input') return errorResponse(request, 422, 'invalid_state')
    if (error.code === 'integrity_error') return errorResponse(request, 422, 'integrity_error')
  }
  return errorResponse(request, 503, 'unavailable')
}

async function fetchManage(request: Request, env: Record<string, unknown>): Promise<Response> {
  let upload: ReturnType<typeof uploadStream> | undefined
  try {
    const runtime = await runtimeFor(env)
    if (!runtime) return errorResponse(request, 503, 'configuration_error')
    const { deps, service, transport } = runtime
    const url = new URL(request.url)
    const expectedOrigin = `https://${deps.config.manageHost}`
    const host = request.headers.get('host')
    if (url.origin !== expectedOrigin || url.username || url.password || url.hash || (host !== null && host !== deps.config.manageHost)) return errorResponse(request, 403, 'forbidden')
    const origin = request.headers.get('origin')
    if (origin !== null) {
      if (origin !== expectedOrigin) return errorResponse(request, 403, 'forbidden')
    } else {
      if (request.headers.has('cookie')) return errorResponse(request, 403, 'forbidden')
      const site = request.headers.get('sec-fetch-site')
      if (site !== null && site !== 'none') return errorResponse(request, 403, 'forbidden')
      if (!request.headers.get('cf-access-jwt-assertion')?.trim()) return errorResponse(request, 401, 'unauthenticated')
    }
    const isCommand = url.pathname === '/api/publication'
    const isUpload = url.pathname === '/api/publication/upload'
    if (!isCommand && !isUpload) return errorResponse(request, 404, 'not_found')
    const method = isCommand ? 'POST' : 'PUT'
    if (request.method !== method) return errorResponse(request, 405, 'method_not_allowed', method)
    let sessionId = ''
    let path = ''
    if (isCommand) {
      if (url.search) throw new InputError('invalid_request')
    } else {
      let count = 0
      url.searchParams.forEach(() => { count++ })
      if (count !== 2 || url.searchParams.getAll('sessionId').length !== 1 || url.searchParams.getAll('path').length !== 1) throw new InputError('invalid_request')
      sessionId = url.searchParams.get('sessionId')!
      path = url.searchParams.get('path')!
    }
    checkFraming(request, isUpload, isUpload ? transport.maxUploadBytes : transport.maxCommandBytes)
    if (request.headers.has('cf-access-jwt-assertion') && !request.headers.get('cf-access-jwt-assertion')?.trim()) return errorResponse(request, 401, 'unauthenticated')
    const actor = await authenticateManage(request, deps)
    if (!actor) return errorResponse(request, 401, 'unauthenticated')
    if (isUpload) {
      upload = uploadStream(request, transport.maxUploadBytes)
      const result = await service.upload(actor, sessionId, path, upload.body)
      return response(request, 200, { ok: true, result: statusDTO(result) })
    }
    const command = await readCommand(request, transport)
    let result: ReturnType<typeof statusDTO> | ReturnType<typeof receiptDTO> | null
    switch (command.op) {
      case 'begin': result = statusDTO(await service.begin(actor, command.command)); break
      case 'materialize': result = statusDTO(await service.materialize(actor, command.sessionId, command.path)); break
      case 'seal': result = statusDTO(await service.seal(actor, command.sessionId)); break
      case 'status': result = statusDTO(await service.status(actor, command.sessionId)); break
      case 'commit': result = receiptDTO(await service.commit(actor, command.sessionId)); break
      case 'restore': result = receiptDTO(await service.restore(actor, command.command)); break
      case 'unpublish': result = receiptDTO(await service.unpublish(actor, command.command)); break
      case 'abort': await service.abort(actor, command.sessionId); result = null; break
    }
    return response(request, 200, { ok: true, result })
  } catch (error) {
    // Store deliberately wraps producer failures; preserve only an observed local stream error.
    const failure = upload?.failure()
    return mapError(request, failure && error instanceof StoreError && error.code === 'unavailable' ? failure : error)
  } finally {
    upload?.cleanup()
    cancelBody(request)
  }
}

export default { fetch: fetchManage } satisfies ExportedHandler<Record<string, unknown>>
