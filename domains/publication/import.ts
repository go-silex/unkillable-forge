import { executeGuarded, PolicyError } from '../catalogue/guard'
import { importCursorIdentity, inspectImportChunk, type AdmittedImportSelection, type ImportMappingSummary } from '../catalogue/import'
import type { ManageActor } from '../catalogue/principals'
import { SourceIntegrityError, StoreError, verifyRevisionBytes } from '../store/revision-store'
import type { PublicationDeps, PublicationReceipt, PublicationStatus } from './types'
import { beginImport, inspectBeginCommandChunk, materializeImport, seal, status, uploadImport } from './staging'
import { commitImport } from './promotion'

export interface ImportSourceReader {
  read(ref: { readonly key: string; readonly version: string }): Promise<ReadableStream<Uint8Array>>
}
export type ImportIssue = { readonly code: string; readonly path?: string; readonly pageId?: string }
export type ImportResult =
  | { readonly state: 'checking'; readonly planDigest: string; readonly nextCursor: string }
  | { readonly state: 'blocked'; readonly planDigest: string; readonly issues: readonly ImportIssue[] }
  | { readonly state: 'ready'; readonly planDigest: string; readonly sourceDigest: string; readonly targetDigest: string; readonly warnings: readonly ImportIssue[]; readonly nextCursor?: string }
  | { readonly state: 'staging'; readonly session: PublicationStatus; readonly nextCursor: string | null }
  | { readonly state: 'committed'; readonly publication: PublicationReceipt; readonly mappingSummary: ImportMappingSummary }

const MAX_FILES = 8
const MAX_BYTES = 32 * 1024 * 1024
const encoder = new TextEncoder()
const hex = (value: ArrayBuffer) => Array.from(new Uint8Array(value), b => b.toString(16).padStart(2, '0')).join('')

const cursorMessage = (instanceId: string, kid: string, payload: string) =>
  encoder.encode(`forge.import.cursor.v1\0${instanceId}\0${kid}\0${payload}`)
type PlanCursor = {
  plan: string
  inventoryVersion: string
  inventoryHash: string
  mode: 'dry_run' | 'apply'
  principal: string
  epoch: number
  expiresAt: number
  phase: 'preflight' | 'target' | 'source' | 'recheck' | 'apply'
  preflight: { phase: 'files' | 'pages' | 'edges' | 'membership'; index: number } | null
  position: string | null
  offset: number
  digest: string
  target: string
}
async function makeCursor(deps: PublicationDeps, state: PlanCursor): Promise<string> {
  let binary = ''
  for (const byte of encoder.encode(JSON.stringify(state))) binary += String.fromCharCode(byte)
  const payload = btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
  const key = deps.config.shareVerifierKeys[0]
  if (!key) throw new PolicyError('invalid_state')
  const signature = hex(await crypto.subtle.sign('HMAC', key.key, cursorMessage(deps.config.instanceId, key.kid, payload)))
  return `${payload}.${key.kid}.${signature}`
}
async function parseCursor(deps: PublicationDeps, cursor: string, admitted: AdmittedImportSelection, mode: PlanCursor['mode'], principal: string, epoch: number, allowExpired = false): Promise<PlanCursor> {
  if (typeof cursor !== 'string' || cursor.length > 16384) throw new PolicyError('invalid_state')
  const parts = cursor.split('.')
  if (parts.length !== 3 || !/^[A-Za-z0-9_-]+$/.test(parts[0]) || !/^[a-z0-9]{1,16}$/.test(parts[1]) || !/^[a-f0-9]{64}$/.test(parts[2])) throw new PolicyError('conflict')
  const key = deps.config.shareVerifierKeys.find(candidate => candidate.kid === parts[1])
  if (!key) throw new PolicyError('conflict')
  const signature = Uint8Array.from(parts[2].match(/../g)!, byte => parseInt(byte, 16))
  if (!await crypto.subtle.verify('HMAC', key.key, signature, cursorMessage(deps.config.instanceId, parts[1], parts[0]))) throw new PolicyError('conflict')
  try {
    const binary = atob(parts[0].replace(/-/g, '+').replace(/_/g, '/'))
    const value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(binary, c => c.charCodeAt(0)))) as PlanCursor
    if (value.plan !== admitted.planDigest || value.inventoryVersion !== admitted.approval.objectVersion || value.inventoryHash !== admitted.approval.sha256 || value.mode !== mode || value.principal !== principal || value.epoch !== epoch || !Number.isSafeInteger(value.expiresAt) || (!allowExpired && value.expiresAt <= deps.now()) || !['preflight', 'target', 'source', 'recheck', 'apply'].includes(value.phase) ||
        !Number.isSafeInteger(value.offset) || value.offset < 0 || (value.position !== null && typeof value.position !== 'string') ||
        !/^(|[a-f0-9]{64})$/.test(value.digest) || !/^(|[a-f0-9]{64})$/.test(value.target)) throw new Error()
    return value
  } catch { throw new PolicyError('conflict') }
}
async function chainDigest(previous: string, chunk: string): Promise<string> {
  return hex(await crypto.subtle.digest('SHA-256', encoder.encode(`forge.import.target.chunk.v1\0${previous}\0${chunk}`)))
}

async function readWithDeadline(source: ImportSourceReader, ref: { key: string; version: string }, deadline: number): Promise<ReadableStream<Uint8Array>> {
  const remaining = deadline - performance.now()
  if (remaining <= 0) throw new PolicyError('unavailable', 'import_timeout')
  let expired = false
  let timer: ReturnType<typeof setTimeout> | undefined
  const pending = source.read(ref).then(stream => { if (expired) void stream.cancel().catch(() => {}); return stream })
  const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => { expired = true; reject(new PolicyError('unavailable', 'import_timeout')) }, remaining) })
  try { return await Promise.race([pending, timeout]) }
  finally { clearTimeout(timer) }
}
function remaining(deadline: number): number {
  const ms = deadline - performance.now()
  if (ms <= 0) throw new PolicyError('unavailable', 'import_timeout')
  return ms
}

async function withinDeadline<T>(deadline: number, work: () => Promise<T>): Promise<T> {
  const ms = remaining(deadline)
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new PolicyError('unavailable', 'import_timeout')), ms) })
  try {
    const value = await Promise.race([work(), timeout])
    remaining(deadline)
    return value
  } finally { clearTimeout(timer) }
}

async function verifyFile(source: ImportSourceReader, file: AdmittedImportSelection['inventory']['files'][number], deadline: number): Promise<void> {
  const stream = await readWithDeadline(source, { key: file.sourceRef, version: file.sourceVersion }, deadline)
  const controller = new AbortController()
  const timeout = new PolicyError('unavailable', 'import_timeout')
  let ms: number
  try { ms = remaining(deadline) } catch (error) { void stream.cancel().catch(() => {}); throw error }
  const timer = setTimeout(() => controller.abort(timeout), ms)
  try {
    await verifyRevisionBytes(file, stream, controller.signal)
    remaining(deadline)
  } catch (error) {
    if (controller.signal.aborted) throw timeout
    throw error
  } finally { clearTimeout(timer) }
}

async function planImportStep(deps: PublicationDeps, admitted: AdmittedImportSelection, cursor: string | null, source: ImportSourceReader, deadline: number, mode: PlanCursor['mode']): Promise<ImportResult> {
  const { planDigest, sourceDigest, inventory, selection } = admitted
  const identity = await withinDeadline(deadline, () => importCursorIdentity(admitted, deps))
  const state: PlanCursor = cursor === null
    ? { plan: planDigest, inventoryVersion: admitted.approval.objectVersion, inventoryHash: admitted.approval.sha256, mode, principal: identity.principalId, epoch: identity.authorityEpoch, expiresAt: Math.min(identity.expiresAt * 1000, deps.now() + deps.publication.sessionTtlMs), phase: 'preflight', preflight: { phase: 'files', index: 0 }, position: null, offset: 0, digest: '', target: '' }
    : await withinDeadline(deadline, () => parseCursor(deps, cursor!, admitted, mode, identity.principalId, identity.authorityEpoch))
  const checking = async (): Promise<ImportResult> => ({ state: 'checking', planDigest, nextCursor: await withinDeadline(deadline, () => makeCursor(deps, state)) })
  if (state.phase === 'apply') {
    if (mode !== 'apply') throw new PolicyError('conflict')
    return { state: 'ready', planDigest, sourceDigest, targetDigest: state.target, warnings: [], nextCursor: cursor! }
  }
  if (state.phase === 'preflight') {
    try {
      const next = await withinDeadline(deadline, () => inspectBeginCommandChunk(deps, selection.command, state.preflight!))
      if (next) state.preflight = next
      else { state.phase = 'target'; state.preflight = null }
    } catch (error) {
      if (error instanceof PolicyError && ['conflict', 'not_found', 'invalid_state'].includes(error.code)) return { state: 'blocked', planDigest, issues: [{ code: error.detail ?? error.code }] }
      throw error
    }
    return checking()
  }
  if (state.phase === 'target' || state.phase === 'recheck') {
    const chunk = await withinDeadline(deadline, () => inspectImportChunk(deps, admitted, state.position))
    if (chunk.issues.length) return { state: 'blocked', planDigest, issues: chunk.issues }
    state.digest = await withinDeadline(deadline, () => chainDigest(state.digest, chunk.targetDigest))
    state.position = chunk.nextPosition
    if (state.position !== null) return checking()
    if (state.phase === 'target') {
      state.target = state.digest
      state.digest = ''
      // Apply verifies every transferred source through Revision Store; only
      // the read-only plan needs a separate source-verification pass.
      state.phase = mode === 'apply' ? 'recheck' : 'source'
      return checking()
    }
    if (state.digest !== state.target) throw new PolicyError('conflict')
    const warnings: ImportIssue[] = inventory.operations.flatMap(op =>
      op.kind === 'page_policy' && op.policy.visibility.value !== null && !['private', 'public', 'shared'].includes(op.policy.visibility.value)
        ? [{ code: 'unknown_visibility_private', pageId: op.policy.pageId }] : [])
    if (mode === 'apply') {
      state.phase = 'apply'
      return { state: 'ready', planDigest, sourceDigest, targetDigest: state.target, warnings, nextCursor: await withinDeadline(deadline, () => makeCursor(deps, state)) }
    }
    return { state: 'ready', planDigest, sourceDigest, targetDigest: state.target, warnings }
  }
  for (const file of selection.command.files) if (file.size > MAX_BYTES) return { state: 'blocked', planDigest, issues: [{ code: 'import_file_too_large', path: file.path }] }
  let offset = state.offset
  let files = 0, bytes = 0
  while (offset < inventory.files.length && files < MAX_FILES) {
    const file = inventory.files[offset]
    if (file.size > MAX_BYTES) return { state: 'blocked', planDigest, issues: [{ code: 'import_file_too_large', path: file.path }] }
    if (files && bytes + file.size > MAX_BYTES) break
    try {
      await verifyFile(source, file, deadline)
    } catch (error) {
      if (error instanceof StoreError && error.code === 'integrity_error') return { state: 'blocked', planDigest, issues: [{ code: 'source_integrity', path: file.path }] }
      throw error
    }
    files++; bytes += file.size; offset++
  }
  state.offset = offset
  if (offset === inventory.files.length) state.phase = 'recheck'
  return checking()
}

export function planPublicationImport(deps: PublicationDeps, admitted: AdmittedImportSelection, cursor: string | null, source: ImportSourceReader, deadline = performance.now() + deps.publication.maxUploadTimeoutMs): Promise<ImportResult> {
  return planImportStep(deps, admitted, cursor, source, deadline, 'dry_run')
}

export async function applyPublicationImport(deps: PublicationDeps, actor: ManageActor, admitted: AdmittedImportSelection, source: ImportSourceReader, deadline = performance.now() + deps.publication.maxUploadTimeoutMs, cursor: string | null = null): Promise<ImportResult> {
  const { selection, planDigest, inventory } = admitted
  const existing = await withinDeadline(deadline, () => deps.db.prepare('SELECT session_id FROM publication_sessions WHERE instance_id=? AND import_plan_id=?').bind(deps.config.instanceId, selection.planId).first())
  let continuation: string | null = null
  if (!existing) {
    const planned = await planImportStep(deps, admitted, cursor, source, deadline, 'apply')
    if (planned.state === 'blocked' && planned.issues.some(issue => issue.code === 'source_integrity')) throw new PolicyError('conflict', 'source_integrity')
    if (planned.state !== 'ready') return planned
    continuation = planned.nextCursor!
  }
  const command = { ...selection.command, idempotencyKey: `import:${planDigest}` }
  let session!: PublicationStatus
  let expiredCursor = false
  if (existing && cursor !== null) {
    const identity = await importCursorIdentity(admitted, deps)
    const parsed = await parseCursor(deps, cursor, admitted, 'apply', identity.principalId, identity.authorityEpoch, true)
    expiredCursor = parsed.expiresAt <= deps.now()
  }
  if (existing) {
    session = await beginImport(deps, actor, command, { planId: selection.planId, planDigest }, deadline)
    if (session.state === 'committed') {
      const result = await commitImport(deps, actor, session.sessionId, admitted, selection.planId, planDigest, deadline)
      return { state: 'committed', ...result }
    }
    if (expiredCursor) throw new PolicyError('conflict')
    remaining(deadline)
  }
  remaining(deadline)
  await executeGuarded(deps, actor, [{ action: 'import_state', requestDigest: planDigest, occurredAt: deps.now() }], [], undefined, [], deadline)
  remaining(deadline)
  for (const file of selection.command.files) if (file.size > MAX_BYTES) return { state: 'blocked', planDigest, issues: [{ code: 'import_file_too_large', path: file.path }] }
  if (!existing) {
    session = await beginImport(deps, actor, command, { planId: selection.planId, planDigest }, deadline)
    if (session.state === 'committed') {
      const result = await commitImport(deps, actor, session.sessionId, admitted, selection.planId, planDigest, deadline)
      return { state: 'committed', ...result }
    }
    remaining(deadline)
  }
  if (session.state === 'closed') throw new PolicyError('invalid_state', 'import_session_closed')
  if (session.state === 'open') {
    let files = 0, bytes = 0
    const descriptors = new Map(selection.command.files.map(f => [f.path, f]))
    const sources = new Map(inventory.files.map(f => [f.path, f]))
    for (const pending of session.files) {
      if (pending.stored) continue
      const file = descriptors.get(pending.path)
      if (!file) throw new PolicyError('conflict')
      if (files >= MAX_FILES || (files > 0 && bytes + file.size > MAX_BYTES)) break
      remaining(deadline)
      try {
        if (pending.source === 'base') await materializeImport(deps, actor, session.sessionId, pending.path, remaining(deadline))
        else {
          const sourceFile = sources.get(pending.path)
          if (!sourceFile) throw new PolicyError('conflict')
          let body: ReadableStream<Uint8Array>
          try { body = await readWithDeadline(source, { key: sourceFile.sourceRef, version: sourceFile.sourceVersion }, deadline) }
          catch (error) {
            if (error instanceof StoreError && error.code === 'integrity_error') return { state: 'blocked', planDigest, issues: [{ code: 'source_integrity', path: pending.path }] }
            throw error
          }
          let budget: number
          try { budget = remaining(deadline) } catch (error) { void body.cancel().catch(() => {}); throw error }
          await uploadImport(deps, actor, session.sessionId, pending.path, body, budget)
        }
      } catch (error) {
        if (pending.source !== 'base' && error instanceof SourceIntegrityError) return { state: 'blocked', planDigest, issues: [{ code: 'source_integrity', path: pending.path }] }
        if (error instanceof PolicyError && error.detail === 'publication_upload_timeout') throw new PolicyError('unavailable', 'import_timeout')
        throw error
      }
      files++; bytes += file.size
    }
    remaining(deadline)
    session = await status(deps, actor, session.sessionId)
    remaining(deadline)
    if (session.files.some(f => !f.stored)) return { state: 'staging', session, nextCursor: continuation }
    session = await seal(deps, actor, session.sessionId, deadline)
    remaining(deadline)
  }
  if (session.state !== 'sealed' && session.state !== 'committed') throw new PolicyError('conflict')
  remaining(deadline)
  const committed = await commitImport(deps, actor, session.sessionId, admitted, selection.planId, planDigest, deadline)
  return { state: 'committed', ...committed }
}
