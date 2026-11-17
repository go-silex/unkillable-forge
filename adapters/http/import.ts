import { authenticateImportRead, authenticateManage, type ManageActor } from '../../domains/catalogue/principals'
import { PolicyError } from '../../domains/catalogue/guard'
import { admitImportSelection, type ImportSelection } from '../../domains/catalogue/import'
import { planPublicationImport, applyPublicationImport, type ImportSourceReader } from '../../domains/publication/import'
import { StoreError } from '../../domains/store/revision-store'
import type { Runtime, TransportOptions } from './manage-config'
import { InputError, readCommand } from './publication-input'

const exact = (value: unknown, keys: readonly string[]): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value) &&
  Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key))

async function readRequest(request: Request, options: TransportOptions): Promise<{ op: 'dry_run' | 'apply'; selection: ImportSelection; cursor: string | null }> {
  if (!request.body) throw new InputError('invalid_request')
  const reader = request.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new InputError('request_timeout')), options.commandReadTimeoutMs) })
  try {
    for (;;) {
      const part = await Promise.race([reader.read(), timeout])
      if (part.done) break
      if (!(part.value instanceof Uint8Array)) throw new InputError('invalid_request')
      size += part.value.byteLength
      if (size > options.maxCommandBytes) throw new InputError('payload_too_large')
      chunks.push(part.value)
    }
    const decoder = new TextDecoder('utf-8', { fatal: true })
    let text = ''
    for (const chunk of chunks) text += decoder.decode(chunk, { stream: true })
    text += decoder.decode()
    const value: unknown = JSON.parse(text)
    const stack: [unknown, number][] = [[value, 1]]
    while (stack.length) {
      const [item, depth] = stack.pop()!
      if (typeof item === 'number' && !Number.isFinite(item)) throw new InputError('invalid_request')
      if (item !== null && typeof item === 'object') {
        if (depth > options.maxJsonDepth) throw new InputError('invalid_request')
        for (const child of Object.values(item)) stack.push([child, depth + (child !== null && typeof child === 'object' ? 1 : 0)])
      }
    }
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new InputError('invalid_request')
    const obj = value as Record<string, unknown>
    const validCursor = obj.cursor === null || typeof obj.cursor === 'string' && obj.cursor.length <= 16384
    if (!(obj.op === 'dry_run' ? exact(obj, ['op', 'selection', 'cursor']) && validCursor :
      obj.op === 'apply' && (exact(obj, ['op', 'selection']) || exact(obj, ['op', 'selection', 'cursor']) && validCursor))) throw new InputError('invalid_request')
    const selection = obj.selection
    if (!exact(selection, ['version', 'inventoryId', 'selectionId', 'planId', 'command']) || selection.version !== 1 ||
        !['inventoryId', 'selectionId', 'planId'].every(k => typeof selection[k] === 'string' && (selection[k] as string).length > 0 && (selection[k] as string).length <= 128)) throw new InputError('invalid_request')
    // Reuse Publication's exact BeginCommand validation and upload size limit.
    const commandRequest = new Request('https://localhost/', { method: 'POST', body: JSON.stringify({ op: 'begin', command: selection.command }) })
    const command = await readCommand(commandRequest, options)
    if (command.op !== 'begin') throw new InputError('invalid_request')
    return { op: obj.op as 'dry_run' | 'apply', selection: { ...selection, command: command.command } as ImportSelection, cursor: (obj.cursor ?? null) as string | null }
  } catch (error) {
    if (error instanceof InputError) throw error
    throw new InputError('invalid_request')
  } finally {
    clearTimeout(timer)
    void reader.cancel().catch(() => {})
    try { reader.releaseLock() } catch { /* pending read settles independently */ }
  }
}


class InventoryLimitError extends Error {}
function importRemaining(deadline: number): number {
  const remaining = deadline - performance.now()
  if (remaining <= 0) throw new PolicyError('unavailable', 'import_timeout')
  return remaining
}

async function withinImportDeadline<T>(deadline: number, work: () => Promise<T>): Promise<T> {
  const remaining = importRemaining(deadline)
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new PolicyError('unavailable', 'import_timeout')), remaining) })
  try {
    const result = await Promise.race([work(), timeout])
    importRemaining(deadline)
    return result
  } finally { clearTimeout(timer) }
}


async function loadInventory(bucket: R2Bucket, key: string, version: string, expectedDigest: string, timeoutMs: number, max: number, deadline: number): Promise<unknown> {
  let timer: ReturnType<typeof setTimeout> | undefined
  let expired = false
  const remaining = importRemaining(deadline)
  const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => {
    expired = true
    reject(remaining <= timeoutMs ? new PolicyError('unavailable', 'import_timeout') : new InputError('request_timeout'))
  }, Math.min(timeoutMs, remaining)) })
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
  try {
    const pending = bucket.get(key).then(object => { if (expired && object) void object.body.cancel().catch(() => {}); return object })
    const object = await Promise.race([pending, timeout])
    if (!object) throw new StoreError('integrity_error')
    if (object.version !== version || object.size > max) {
      void object.body.cancel().catch(() => {})
      if (object.size > max) throw new InventoryLimitError()
      throw new StoreError('integrity_error')
    }
    reader = object.body.getReader()
    const chunks: Uint8Array[] = []
    let size = 0
    for (;;) {
      const part = await Promise.race([reader.read(), timeout])
      if (part.done) break
      size += part.value.byteLength
      if (size > max) throw new InventoryLimitError()
      if (size > object.size) throw new StoreError('integrity_error')
      chunks.push(part.value)
    }
    if (size !== object.size) throw new StoreError('integrity_error')
    const bytes = new Uint8Array(size)
    let offset = 0
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength }
    const hash = Array.from(new Uint8Array(await Promise.race([crypto.subtle.digest('SHA-256', bytes), timeout])), b => b.toString(16).padStart(2, '0')).join('')
    if (hash !== expectedDigest) throw new StoreError('integrity_error')
    importRemaining(deadline)
    try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) } catch { throw new StoreError('integrity_error') }
  } finally {
    clearTimeout(timer)
    if (reader) { void reader.cancel().catch(() => {}); try { reader.releaseLock() } catch { /* pending read */ } }
  }
}

export async function handleImport(request: Request, runtime: Runtime): Promise<unknown> {
  const deadline = performance.now() + runtime.deps.publication.maxUploadTimeoutMs
  const input = await readRequest(request, runtime.transport)
  let actor: ManageActor | null = null
  const context = await authenticateImportRead(request, runtime.deps)
  if (input.op === 'apply') {
    actor = await authenticateManage(request, runtime.deps)
    if (!actor) throw new PolicyError('unauthenticated')
  }
  const configured = runtime.importSource
  if (!configured) throw new PolicyError('unavailable')
  const approval = configured.approvals.find(p => p.inventoryId === input.selection.inventoryId && p.selectionId === input.selection.selectionId)
  if (!approval) throw new PolicyError('forbidden')
  let admitted
  try {
    const inventory = await loadInventory(configured.bucket, approval.objectKey, approval.objectVersion, approval.sha256, runtime.transport.commandReadTimeoutMs, approval.maxInventoryBytes, deadline)
    admitted = await withinImportDeadline(deadline, () => admitImportSelection(input.selection, inventory, approval, runtime.deps, context))
  } catch (error) {
    const admissionIssues = ['g1b_evidence_required', 'selection_graph_mismatch', 'expiring_policy_unsupported', 'missing_policy_evidence', 'import_metadata_limit']
    const code = error instanceof InventoryLimitError ? 'inventory_size_exceeds_approved_limit' :
      error instanceof PolicyError && error.detail && admissionIssues.includes(error.detail) ? error.detail : null
    if (input.op === 'apply' && code === 'selection_graph_mismatch') throw new PolicyError('conflict', code)
    if (!code) throw error
    const key = runtime.deps.config.shareVerifierKeys[0]?.key
    if (!key) throw new PolicyError('invalid_state')
    const payload = new TextEncoder().encode(`forge.import.blocked.v1\0${runtime.deps.config.instanceId}\0${JSON.stringify(input.selection)}\0${approval.sha256}`)
    const digest = await crypto.subtle.sign('HMAC', key, payload)
    const planDigest = Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('')
    return { state: 'blocked', planDigest, issues: [{ code }] }
  }
  const source: ImportSourceReader = {
    async read(ref) {
      if (!admitted.inventory.files.some(file => file.sourceRef === ref.key && file.sourceVersion === ref.version)) throw new PolicyError('forbidden')
      const object = await configured.bucket.get(ref.key)
      if (!object) throw new StoreError('integrity_error')
      if (object.version !== ref.version) {
        void object.body.cancel().catch(() => {})
        throw new StoreError('integrity_error')
      }
      return object.body
    },
  }
  if (input.op === 'dry_run') return planPublicationImport(runtime.deps, admitted, input.cursor, source, deadline)
  try {
    return await applyPublicationImport(runtime.deps, actor!, admitted, source, deadline, input.cursor)
  } catch (error) {
    if (error instanceof StoreError && error.code === 'integrity_error') throw new PolicyError('conflict', 'source_integrity')
    throw error
  }
}
