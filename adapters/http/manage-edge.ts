import { PolicyError } from '../../domains/catalogue/guard'
import { StoreError } from '../../domains/store/revision-store'
import { InputError } from './publication-input'

export type PublicErrorCode =
  | 'invalid_request' | 'payload_too_large' | 'request_timeout' | 'unsupported_media_type'
  | 'unauthenticated' | 'forbidden' | 'not_found' | 'method_not_allowed' | 'conflict' | 'last_admin'
  | 'upload_incomplete' | 'not_sealed' | 'session_closed' | 'session_expired'
  | 'invalid_state' | 'integrity_error' | 'internal_error' | 'configuration_error' | 'unavailable'

export interface ManageFault {
  readonly status: number
  readonly code: PublicErrorCode
}

export function admitManageRequest(request: Request, url: URL, manageHost: string): ManageFault | null {
  const expectedOrigin = `https://${manageHost}`
  const host = request.headers.get('host')
  if (url.origin !== expectedOrigin || url.username || url.password || url.hash || (host !== null && host !== manageHost)) return { status: 403, code: 'forbidden' }
  const origin = request.headers.get('origin')
  if (origin !== null) {
    if (origin !== expectedOrigin) return { status: 403, code: 'forbidden' }
  } else {
    if (request.headers.has('cookie')) return { status: 403, code: 'forbidden' }
    const site = request.headers.get('sec-fetch-site')
    if (site !== null && site !== 'none') return { status: 403, code: 'forbidden' }
    if (!request.headers.get('cf-access-jwt-assertion')?.trim()) return { status: 401, code: 'unauthenticated' }
  }
  if (request.headers.has('cf-access-jwt-assertion') && !request.headers.get('cf-access-jwt-assertion')?.trim()) return { status: 401, code: 'unauthenticated' }
  return null
}

export function publicError(error: unknown): ManageFault {
  if (error instanceof InputError) return { status: error.code === 'payload_too_large' ? 413 : error.code === 'request_timeout' ? 408 : error.code === 'unsupported_media_type' ? 415 : 400, code: error.code }
  if (error instanceof PolicyError) {
    switch (error.code) {
      case 'instance_mismatch': return { status: 503, code: 'configuration_error' }
      case 'unauthenticated': return { status: 401, code: 'unauthenticated' }
      case 'forbidden': return { status: 403, code: 'forbidden' }
      case 'last_admin': return { status: 409, code: 'last_admin' }
      case 'not_found': return { status: 404, code: 'not_found' }
      case 'conflict': return { status: 409, code: 'conflict' }
      case 'invariant_violation': return { status: 500, code: 'internal_error' }
      case 'invalid_state':
        if (error.detail === 'incomplete' || error.detail === 'publication_incomplete') return { status: 409, code: 'upload_incomplete' }
        if (error.detail === 'publication_not_sealed') return { status: 409, code: 'not_sealed' }
        if (error.detail === 'publication_closed') return { status: 409, code: 'session_closed' }
        if (error.detail === 'publication_expired') return { status: 410, code: 'session_expired' }
        return { status: 422, code: 'invalid_state' }
      case 'unavailable':
        if (error.detail === 'publication_upload_timeout') return { status: 408, code: 'request_timeout' }
        break
    }
  }
  if (error instanceof StoreError) {
    if (error.code === 'conflict') return { status: 409, code: 'conflict' }
    if (error.code === 'invalid_input') return { status: 422, code: 'invalid_state' }
    if (error.code === 'integrity_error') return { status: 422, code: 'integrity_error' }
  }
  return { status: 503, code: 'unavailable' }
}
