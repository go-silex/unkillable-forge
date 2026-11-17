import { executeGuarded, PolicyError } from '../catalogue/guard'
import { inspectImportConflicts, inspectImportTarget, type AdmittedImportSelection, type ImportMappingSummary } from '../catalogue/import'
import type { ManageActor } from '../catalogue/principals'
import { StoreError } from '../store/revision-store'
import type { PublicationDeps, PublicationReceipt, PublicationStatus } from './types'
import { beginImport, inspectBeginCommand, materializeImport, seal, status, uploadImport } from './staging'
import { commitImport } from './promotion'

export interface ImportSourceReader {
  read(ref: { readonly key: string; readonly version: string }): Promise<ReadableStream<Uint8Array>>
}
export type ImportIssue = { readonly code: string; readonly path?: string; readonly pageId?: string }
export type ImportResult =
  | { readonly state: 'checking'; readonly planDigest: string; readonly nextCursor: string }
  | { readonly state: 'blocked'; readonly planDigest: string; readonly issues: readonly ImportIssue[] }
  | { readonly state: 'ready'; readonly planDigest: string; readonly sourceDigest: string; readonly targetDigest: string; readonly warnings: readonly ImportIssue[] }
  | { readonly state: 'staging'; readonly session: PublicationStatus }
  | { readonly state: 'committed'; readonly publication: PublicationReceipt; readonly mappingSummary: ImportMappingSummary }

const MAX_FILES = 8
const MAX_BYTES = 32 * 1024 * 1024
const encoder = new TextEncoder()
type DigestStream = WritableStream<ArrayBuffer | ArrayBufferView> & { readonly digest: Promise<ArrayBuffer> }
type WorkersCrypto = Crypto & { readonly DigestStream: new (algorithm: string) => DigestStream }
const hex = (value: ArrayBuffer) => Array.from(new Uint8Array(value), b => b.toString(16).padStart(2, '0')).join('')

async function cursorMac(deps: PublicationDeps, payload: string): Promise<string> {
  const key = deps.config.shareVerifierKeys[0]?.key
  if (!key) throw new PolicyError('invalid_state')
  return hex(await crypto.subtle.sign('HMAC', key, encoder.encode(`forge.import.cursor.v1\0${deps.config.instanceId}\0${payload}`)))
}
async function makeCursor(deps: PublicationDeps, plan: string, target: string, offset: number): Promise<string> {
  const payload = `${plan}.${target}.${offset}`
  return `${payload}.${await cursorMac(deps, payload)}`
}
async function parseCursor(deps: PublicationDeps, cursor: string, plan: string, target: string, count: number): Promise<number> {
  if (typeof cursor !== 'string' || cursor.length > 256) throw new PolicyError('invalid_state')
  const parts = cursor.split('.')
  if (parts.length !== 4 || parts[0] !== plan || parts[1] !== target || !/^(0|[1-9][0-9]*)$/.test(parts[2])) throw new PolicyError('conflict')
  const offset = Number(parts[2]), expected = await cursorMac(deps, parts.slice(0, 3).join('.'))
  if (!Number.isSafeInteger(offset) || offset < 1 || offset >= count || parts[3] !== expected) throw new PolicyError('conflict')
  return offset
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
async function verifyFile(source: ImportSourceReader, file: AdmittedImportSelection['inventory']['files'][number], deadline: number): Promise<boolean> {
  const stream = await readWithDeadline(source, { key: file.sourceRef, version: file.sourceVersion }, deadline)
  const reader = stream.getReader()
  const digest = new (crypto as WorkersCrypto).DigestStream('SHA-256')
  const writer = digest.getWriter()
  let size = 0, timer: ReturnType<typeof setTimeout> | undefined
  try {
    const remaining = deadline - performance.now()
    if (remaining <= 0) throw new PolicyError('unavailable', 'import_timeout')
    const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => { void reader.cancel().catch(() => {}); reject(new PolicyError('unavailable', 'import_timeout')) }, remaining) })
    while (true) {
      const part = await Promise.race([reader.read(), timeout])
      if (part.done) break
      size += part.value.byteLength
      if (size > file.size || size > MAX_BYTES) return false
      await Promise.race([writer.write(part.value), timeout])
    }
    await Promise.race([writer.close(), timeout])
    return size === file.size && hex(await Promise.race([digest.digest, timeout])) === file.sha256
  } finally {
    clearTimeout(timer)
    void reader.cancel().catch(() => {})
    writer.releaseLock()
    reader.releaseLock()
  }
}

export async function planPublicationImport(deps: PublicationDeps, admitted: AdmittedImportSelection, cursor: string | null, source: ImportSourceReader): Promise<ImportResult> {
  const targetDigest = await inspectImportTarget(deps, admitted)
  const { planDigest, sourceDigest, inventory, selection } = admitted
  try { await inspectBeginCommand(deps, selection.command) }
  catch (error) {
    if (error instanceof PolicyError && ['conflict', 'not_found', 'invalid_state'].includes(error.code)) return { state: 'blocked', planDigest, issues: [{ code: error.detail ?? error.code }] }
    throw error
  }
  const issues = await inspectImportConflicts(deps, admitted)
  if (issues.length) return { state: 'blocked', planDigest, issues }
  for (const file of selection.command.files) if (file.size > MAX_BYTES) return { state: 'blocked', planDigest, issues: [{ code: 'import_file_too_large', path: file.path }] }
  let offset = cursor === null ? 0 : await parseCursor(deps, cursor, planDigest, targetDigest, inventory.files.length)
  const deadline = performance.now() + deps.publication.maxUploadTimeoutMs
  let files = 0, bytes = 0
  while (offset < inventory.files.length && files < MAX_FILES) {
    const file = inventory.files[offset]
    if (file.size > MAX_BYTES) return { state: 'blocked', planDigest, issues: [{ code: 'import_file_too_large', path: file.path }] }
    if (files && bytes + file.size > MAX_BYTES) break
    try {
      if (!await verifyFile(source, file, deadline)) return { state: 'blocked', planDigest, issues: [{ code: 'source_integrity', path: file.path }] }
    } catch (error) {
      if (error instanceof StoreError && error.code === 'integrity_error') return { state: 'blocked', planDigest, issues: [{ code: 'source_integrity', path: file.path }] }
      throw error
    }
    files++; bytes += file.size; offset++
  }
  if (await inspectImportTarget(deps, admitted) !== targetDigest) throw new PolicyError('conflict')
  if (offset < inventory.files.length) return { state: 'checking', planDigest, nextCursor: await makeCursor(deps, planDigest, targetDigest, offset) }
  const warnings: ImportIssue[] = inventory.operations.flatMap(op =>
    op.kind === 'page_policy' && op.policy.visibility.value !== null && !['private', 'public', 'shared'].includes(op.policy.visibility.value)
      ? [{ code: 'unknown_visibility_private', pageId: op.policy.pageId }] : [])
  return { state: 'ready', planDigest, sourceDigest, targetDigest, warnings }
}

export async function applyPublicationImport(deps: PublicationDeps, actor: ManageActor, admitted: AdmittedImportSelection, source: ImportSourceReader): Promise<ImportResult> {
  await inspectImportTarget(deps, admitted)
  const { selection, planDigest, inventory } = admitted
  const at = deps.now()
  await executeGuarded(deps, actor, [{ action: 'import_state', requestDigest: planDigest, occurredAt: at }], [])
  for (const file of selection.command.files) if (file.size > MAX_BYTES) return { state: 'blocked', planDigest, issues: [{ code: 'import_file_too_large', path: file.path }] }
  const command = { ...selection.command, idempotencyKey: `import:${planDigest}` }
  let session = await beginImport(deps, actor, command, { planId: selection.planId, planDigest })
  if (session.state === 'closed') throw new PolicyError('invalid_state', 'import_session_closed')
  if (session.state === 'committed') return { state: 'committed', ...await commitImport(deps, actor, session.sessionId, admitted, selection.planId, planDigest) }
  const deadline = performance.now() + deps.publication.maxUploadTimeoutMs
  if (session.state === 'open') {
    let files = 0, bytes = 0
    const descriptors = new Map(selection.command.files.map(f => [f.path, f]))
    const sources = new Map(inventory.files.map(f => [f.path, f]))
    for (const pending of session.files) {
      if (pending.stored) continue
      const file = descriptors.get(pending.path)
      if (!file) throw new PolicyError('conflict')
      if (files >= MAX_FILES || (files > 0 && bytes + file.size > MAX_BYTES) || performance.now() >= deadline) break
      if (pending.source === 'base') await materializeImport(deps, actor, session.sessionId, pending.path, deadline - performance.now())
      else {
        const sourceFile = sources.get(pending.path)
        if (!sourceFile) throw new PolicyError('conflict')
        const body = await readWithDeadline(source, { key: sourceFile.sourceRef, version: sourceFile.sourceVersion }, deadline)
        await uploadImport(deps, actor, session.sessionId, pending.path, body, deadline - performance.now())
      }
      files++; bytes += file.size
    }
    session = await status(deps, actor, session.sessionId)
    if (session.files.some(f => !f.stored)) return { state: 'staging', session }
    session = await seal(deps, actor, session.sessionId)
  }
  if (session.state !== 'sealed' && session.state !== 'committed') throw new PolicyError('conflict')
  return { state: 'committed', ...await commitImport(deps, actor, session.sessionId, admitted, selection.planId, planDigest) }
}
