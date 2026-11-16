import { authenticateManage } from '../../domains/catalogue/principals'
import { StoreError } from '../../domains/store/revision-store'
import type { PublicationReceipt, PublicationStatus, PublicationUploadStatus } from '../../domains/publication'
import { runtimeFor } from './manage-config'
import { cancelBody, checkFraming, InputError, readCommand, uploadStream } from './publication-input'
import { admitManageRequest, publicError } from './manage-edge'
import { handleManageWeb } from '../web/manage'

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
function uploadDTO(s: PublicationUploadStatus) {
  return { sessionId: s.sessionId, path: s.path, stored: s.stored, state: s.state }
}
function receiptDTO(r: PublicationReceipt) {
  return { artifactId: r.artifactId, revisionId: r.revisionId, contentVersion: r.contentVersion, pages: r.pages.map(p => ({ pageId: p.pageId, url: p.url })) }
}

async function fetchManage(request: Request, env: Record<string, unknown>): Promise<Response> {
  let upload: ReturnType<typeof uploadStream> | undefined
  try {
    const runtime = await runtimeFor(env)
    if (!runtime) return errorResponse(request, 503, 'configuration_error')
    const web = await handleManageWeb(request, runtime)
    if (web) return web
    const { deps, service, transport } = runtime
    const url = new URL(request.url)
    const admission = admitManageRequest(request, url, deps.config.manageHost)
    if (admission) return errorResponse(request, admission.status, admission.code)
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
    const actor = await authenticateManage(request, deps)
    if (!actor) return errorResponse(request, 401, 'unauthenticated')
    if (isUpload) {
      upload = uploadStream(request, transport.maxUploadBytes)
      const result = await service.upload(actor, sessionId, path, upload.body)
      return response(request, 200, { ok: true, result: uploadDTO(result) })
    }
    const command = await readCommand(request, transport)
    let result: ReturnType<typeof statusDTO> | ReturnType<typeof uploadDTO> | ReturnType<typeof receiptDTO> | null
    switch (command.op) {
      case 'begin': result = statusDTO(await service.begin(actor, command.command)); break
      case 'materialize': result = uploadDTO(await service.materialize(actor, command.sessionId, command.path)); break
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
    const fault = publicError(failure && error instanceof StoreError && error.code === 'unavailable' ? failure : error)
    return errorResponse(request, fault.status, fault.code)
  } finally {
    upload?.cleanup()
    cancelBody(request)
  }
}

export default { fetch: fetchManage } satisfies ExportedHandler<Record<string, unknown>>
