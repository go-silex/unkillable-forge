import { bindPrivateRoot, withPrivateLock, type PrivateDirectory } from './filesystem.js'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { Readable } from 'node:stream'
import { isAbsolute } from 'node:path'
import { artifactStateSchema, manifestSchema, statusSchema, uploadSchema, receiptSchema, enrichmentSchema, type EnrichmentPage, type ManifestPage } from './publisher-wire.js'
import { bindSourceRoot, type SourceRoot } from './files.js'

export interface AuthenticatedTransport {
  call(tool: string, args: Record<string, unknown>): Promise<unknown>
  upload(sessionId: string, path: string, body: ReadableStream<Uint8Array>, size: number): Promise<unknown>
  supports(tool: string): Promise<boolean>
}
export interface LocalSource { rootId: string; relativePath: string }
export interface ExpectedContent { artifactId: string; expectedRevisionId: string | null; expectedContentVersion: number }
export type ResourceKind = 'document' | 'subdocument' | 'fragment' | 'asset'
export interface LocalResourceMapping { source: LocalSource; path: string; kind: ResourceKind; contentType: string }
export interface ExplicitPageChange { pageId: string; disposition: 'new' | 'keep' | 'drop' | 'restore'; documentPath: string | null; metadata: unknown | null }
export interface ExplicitOwnershipChange { action: 'add' | 'remove'; ownerPageId: string; path: string; providerArtifactId: string | null }
export interface PublicationChanges { upserts: readonly LocalResourceMapping[]; pageChanges: readonly ExplicitPageChange[]; removeResourcePaths: readonly string[]; ownershipChanges: readonly ExplicitOwnershipChange[] }
export type UpdateBaseline = { kind: 'explicit'; expected: ExpectedContent } | { kind: 'checkpoint'; checkpointId: string }
export type PublishTarget = { kind: 'new'; route: { kind: 'subtree'; slug: string } | { kind: 'tree_page'; pageRef: string } } | { kind: 'existing'; baseline: UpdateBaseline; changes: PublicationChanges }
export interface PublishInput { source: LocalSource; target: PublishTarget; metadata: Readonly<Record<string, unknown>>; manifestPath?: LocalSource }
type File = { path: string; kind: ResourceKind; sha256: string; size: number; contentType: string; source: 'base' | 'client' }
type Page = ExplicitPageChange & { expectedPolicyEpoch: number | null }
type Edge = { ownerPageId: string; path: string; providerArtifactId: string | null }
type Command = { idempotencyKey: string; artifactId: string | null; expectedRevisionId: string | null; expectedContentVersion: number; files: File[]; pages: Page[]; edges: Edge[] }
type Receipt = { artifactId: string; revisionId: string | null; contentVersion: number; pages: { pageId: string; url: string }[] }
type Operation = { version: 1; operationId: string; profileFingerprint: string; commandDigest: string; command: Command; spool: Record<string, string>; sessionId: string | null; receipt: Receipt | null; aborted: boolean }
export type LocalOperationState = { operationId: string; sessionId: string | null; stage: string }
export type LocalPublishResult = { publication: Receipt; enrichments: { availability: 'unsupported' } | { availability: 'unavailable'; code: 'unavailable' | 'forbidden' } | { availability: 'available'; result: EnrichmentPage } }
const fail = (message: string): never => { throw new Error(message) }
const digest = (s: string) => createHash('sha256').update(s).digest('hex')
const ident = (prefix: string) => { const b = randomBytes(26); return prefix + '_' + Array.from(b, x => 'abcdefghijklmnopqrstuvwxyz234567'[x & 31]).join('') }
const key = (e: Pick<Edge, 'ownerPageId' | 'path'>) => `${e.ownerPageId}\0${e.path}`

export class LocalPublisher {
  private readonly roots: Map<string, string>
  constructor(private readonly options: { transport: AuthenticatedTransport; roots: readonly { id: string; absolutePath: string }[]; stateDir: string; profileFingerprint: string; readOrigin: string }) {
    if (!isAbsolute(options.stateDir) || !options.profileFingerprint || new URL(options.readOrigin).origin !== options.readOrigin) fail('invalid_configuration')
    this.roots = new Map(options.roots.map(r => [r.id, r.absolutePath]))
    if (this.roots.size !== options.roots.length || options.roots.some(r => !isAbsolute(r.absolutePath))) fail('invalid_roots')
  }
  private async withOperation<T>(id: string, create: boolean, action: (dir: PrivateDirectory, discard: () => void) => Promise<T>): Promise<T> {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id)) fail('invalid_operation')
    const root = await bindPrivateRoot(this.options.stateDir, true)
    try {
      const locks = await root.child('locks', true)
      try {
        return await withPrivateLock(locks, `operation-${id}.lock`, { deadlineMs: Date.now() + 30_000 }, async () => {
          const operation = await root.child(id, create)
          let remove = false
          try {
            return await action(operation, () => { remove = true })
          } finally {
            try {
              if (remove) {
                for (const name of await operation.names()) {
                  if (!/^(?:spool--?\d+|record-[0-9a-f-]+|record\.json|\.tmp-[0-9a-f]{48})$/.test(name)) fail('unsafe_operation_directory')
                  await operation.unlink(name)
                }
                await root.removeEmptyChild(id)
              }
            } finally { await operation.close() }
          }
        })
      } finally { await locks.close() }
    } finally { await root.close() }
  }
  private async save(op: Operation, dir: PrivateDirectory): Promise<void> {
    await dir.replace('record.json', Buffer.from(JSON.stringify(op)))
  }
  private async load(id: string, dir: PrivateDirectory): Promise<Operation> {
    const file = await dir.open('record.json', 'read')
    let text: string
    try { text = await file.readFile('utf8') } finally { await file.close() }
    const op = JSON.parse(text) as Operation
    if (op.version !== 1 || op.operationId !== id || op.profileFingerprint !== this.options.profileFingerprint || op.commandDigest !== digest(JSON.stringify(op.command))) fail('invalid_operation')
    return op
  }
  private async removeSpool(dir: PrivateDirectory, name: string): Promise<void> {
    if (!/^spool-\d+$/.test(name)) fail('invalid_operation')
    try { await dir.unlink(name) } catch (error) {
      if (!(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')) throw error
    }
  }
  private async spool(source: LocalSource, dir: PrivateDirectory, index: number, roots: Map<string, SourceRoot>): Promise<{ sha256: string; size: number; name: string }> {
    const root = this.roots.get(source.rootId); if (!root) return fail('unknown_root')
    let bound = roots.get(source.rootId)
    if (!bound) { bound = await bindSourceRoot(root); roots.set(source.rootId, bound) }
    const input = await bound.open(source.relativePath)
      try {
        const original = await input.stat()
        if (!original.isFile() || !Number.isSafeInteger(original.size) || original.size < 0) fail('invalid_source')
        if (BigInt(original.size) > await dir.availableBytes()) fail('insufficient_spool_space')
        const name = `spool-${index}`, output = await dir.open(name, 'exclusive'), hash = createHash('sha256')
        let size = 0
        try {
          const buffer = Buffer.allocUnsafe(64 * 1024)
          for (;;) {
            const { bytesRead } = await input.read(buffer, 0, buffer.length, null)
            if (!bytesRead) break
            size += bytesRead
            if (size > original.size) fail('source_changed')
            const chunk = buffer.subarray(0, bytesRead)
            hash.update(chunk)
            let offset = 0
            while (offset < bytesRead) offset += (await output.write(chunk, offset, bytesRead - offset)).bytesWritten
          }
          if (size !== original.size) fail('source_changed')
          await output.sync()
        } finally { await output.close() }
        return { sha256: hash.digest('hex'), size, name }
      } finally { await input.close() }
  }
  private async baseline(b: UpdateBaseline): Promise<ExpectedContent> {
    if (!b) return fail('baseline_required')
    if (b.kind === 'explicit') return b.expected
    if (b.kind !== 'checkpoint' || !/^[0-9a-f-]{36}$/.test(b.checkpointId)) return fail('invalid_baseline')
    const op = await this.withOperation(b.checkpointId, false, dir => this.load(b.checkpointId, dir))
    if (!op.receipt) return fail('baseline_required')
    return { artifactId: op.receipt.artifactId, expectedRevisionId: op.receipt.revisionId, expectedContentVersion: op.receipt.contentVersion }
  }
  private async observe(expected: ExpectedContent, retries = 1): Promise<{ files: File[]; pages: Page[]; edges: Edge[]; epochs: Map<string, { policyEpoch: number; tombstoned: boolean }> }> {
    const t = this.options.transport
    const state = artifactStateSchema.parse(await t.call('forge_artifact_state', { artifactId: expected.artifactId }))
    if (!state || state.artifactId !== expected.artifactId || state.activeRevisionId !== expected.expectedRevisionId || state.contentVersion !== expected.expectedContentVersion) fail('conflict')
    const sections: Record<string, unknown[]> = { files: [], pages: [], edges: [] }
    let revisionFingerprint: string | null = null
    if (expected.expectedRevisionId) for (const section of ['files', 'pages', 'edges']) {
      let cursor: string | null = null; const seen = new Set<string>()
      do {
        let result: ManifestPage
        try { result = manifestSchema.parse(await t.call('forge_manifest', { artifactId: expected.artifactId, revisionId: expected.expectedRevisionId, section, cursor, limit: 100 })) }
        catch (error) {
          if (cursor !== null && retries > 0 && error && typeof error === 'object' && 'code' in error && error.code === 'conflict') return this.observe(expected, retries - 1)
          throw error
        }
        if (!result || result.artifactId !== expected.artifactId || result.activeRevisionId !== expected.expectedRevisionId || result.contentVersion !== expected.expectedContentVersion || result.revision?.revisionId !== expected.expectedRevisionId || result.section !== section || !Array.isArray(result.items) || !(result.nextCursor === null || typeof result.nextCursor === 'string')) fail('conflict')
        const fingerprint = JSON.stringify(result.revision)
        if (revisionFingerprint !== null && revisionFingerprint !== fingerprint) fail('conflict')
        revisionFingerprint = fingerprint
        sections[section].push(...result.items); cursor = result.nextCursor
        if (cursor !== null) { if (seen.has(cursor)) fail('invalid_cursor'); seen.add(cursor) }
      } while (cursor !== null)
    }
    const epochs = new Map(state.pages.map(p => [p.pageId, p]))
    if (epochs.size !== state.pages.length || state.pages.some(p => p.artifactId !== expected.artifactId)) fail('invalid_server_response')
    const pages = (sections.pages as { pageId: string; documentPath: string; metadata: unknown }[]).map(p => { const live = epochs.get(p.pageId); if (!live || live.tombstoned) return fail('conflict'); return { ...p, disposition: 'keep' as const, expectedPolicyEpoch: live.policyEpoch } })
    if (state.pages.some(p => !p.tombstoned && !pages.some(q => q.pageId === p.pageId))) fail('conflict')
    const files = (sections.files as Omit<File, 'source'>[]).map(f => ({ ...f, source: 'base' as const })), edges = sections.edges as Edge[]
    if (new Set(files.map(f => f.path)).size !== files.length || new Set(pages.map(p => p.pageId)).size !== pages.length || new Set(edges.map(key)).size !== edges.length) fail('invalid_server_response')
    return { files, pages, edges, epochs }
  }
  async publish(input: PublishInput): Promise<LocalPublishResult> {
    const baseline = input.target.kind === 'existing' ? await this.baseline(input.target.baseline) : null
    if (baseline && (!baseline.artifactId || !Number.isSafeInteger(baseline.expectedContentVersion) || baseline.expectedContentVersion < 0 || !(baseline.expectedRevisionId === null || typeof baseline.expectedRevisionId === 'string'))) fail('baseline_required')
    const current = baseline ? await this.observe(baseline) : { files: [], pages: [], edges: [], epochs: new Map<string, { policyEpoch: number; tombstoned: boolean }>() }
    const operationId = randomUUID()
    return this.withOperation(operationId, true, async (dir, discard) => {
    let saved = false
    const boundRoots = new Map<string, SourceRoot>()
    try {
      let changes: PublicationChanges
      if (input.manifestPath) {
        const descriptor = await this.spool(input.manifestPath, dir, -1, boundRoots)
        if (descriptor.size > 1024 * 1024) fail('descriptor_too_large')
        const descriptorFile = await dir.open(descriptor.name, 'read')
        let parsed: PublicationChanges
        try { parsed = JSON.parse(await descriptorFile.readFile('utf8')) as PublicationChanges } finally { await descriptorFile.close() }
        if (!parsed || !Array.isArray(parsed.upserts) || !Array.isArray(parsed.pageChanges) || !Array.isArray(parsed.removeResourcePaths) || !Array.isArray(parsed.ownershipChanges)) fail('invalid_descriptor')
        changes = parsed
        await dir.unlink(descriptor.name)
      } else if (input.target.kind === 'new') {
        const path = input.target.route.kind === 'subtree' ? `/a/${input.target.route.slug}/index.html` : `/${input.target.route.pageRef}`
        const pageId = ident('pg')
        changes = { upserts: [{ source: input.source, path, kind: 'document', contentType: 'text/html' }], pageChanges: [{ pageId, disposition: 'new', documentPath: path, metadata: input.metadata }], removeResourcePaths: [], ownershipChanges: [] }
      } else changes = input.target.changes
      const files = new Map(current.files.map(f => [f.path, f])), pages = new Map(current.pages.map(p => [p.pageId, p])), edges = new Map(current.edges.map(e => [key(e), e])), spool: Record<string, string> = {}
      const touched = new Set<string>()
      for (const path of changes.removeResourcePaths) { if (touched.has(path) || !files.delete(path)) fail('invalid_removal'); touched.add(path) }
      for (const mapping of changes.upserts) {
        if (touched.has(mapping.path)) fail('duplicate_mapping'); touched.add(mapping.path)
        const s = await this.spool(mapping.source, dir, Object.keys(spool).length, boundRoots)
        files.set(mapping.path, { path: mapping.path, kind: mapping.kind, contentType: mapping.contentType, sha256: s.sha256, size: s.size, source: 'client' }); spool[mapping.path] = s.name
      }
      const pageTouched = new Set<string>()
      for (const p of changes.pageChanges) {
        if (pageTouched.has(p.pageId)) fail('duplicate_page'); pageTouched.add(p.pageId)
        const existing = pages.get(p.pageId)
        if ((p.disposition === 'keep' || p.disposition === 'drop') && !existing) fail('unknown_page')
        if ((p.disposition === 'new' || p.disposition === 'restore') && existing) fail('duplicate_page')
        const restored = current.epochs.get(p.pageId)
        if (p.disposition === 'restore' && (!restored || !restored.tombstoned)) fail('unknown_policy_epoch')
        pages.set(p.pageId, { ...p, expectedPolicyEpoch: p.disposition === 'new' ? null : existing?.expectedPolicyEpoch ?? restored?.policyEpoch ?? fail('unknown_policy_epoch') })
      }
      const edgeTouched = new Set<string>()
      for (const e of changes.ownershipChanges) { const k = key(e); if (edgeTouched.has(k)) fail('duplicate_edge'); edgeTouched.add(k); if (e.action === 'remove') { if (edges.get(k)?.providerArtifactId !== e.providerArtifactId || !edges.delete(k)) fail('unknown_edge') } else { if (edges.has(k)) fail('duplicate_edge'); edges.set(k, { ownerPageId: e.ownerPageId, path: e.path, providerArtifactId: e.providerArtifactId }) } }
      const command: Command = { idempotencyKey: randomUUID(), artifactId: baseline?.artifactId ?? null, expectedRevisionId: baseline?.expectedRevisionId ?? null, expectedContentVersion: baseline?.expectedContentVersion ?? 0, files: [...files.values()], pages: [...pages.values()], edges: [...edges.values()] }
      const docs = new Set<string>()
      for (const p of command.pages) {
        if (p.disposition === 'drop') {
          if (p.documentPath !== null || p.metadata !== null) fail('invalid_graph')
        } else {
          const path = p.documentPath
          if (typeof path !== 'string' || !path) throw new Error('invalid_graph')
          if (files.get(path)?.kind !== 'document' || docs.has(path) || p.metadata === null) fail('invalid_graph')
          docs.add(path)
        }
      }
      if (!docs.size || command.files.some(f => f.kind === 'document' && !docs.has(f.path)) || command.edges.some(e => !pages.has(e.ownerPageId) || pages.get(e.ownerPageId)?.disposition === 'drop' || ((e.providerArtifactId === null || e.providerArtifactId === command.artifactId) && !['asset', 'fragment'].includes(files.get(e.path)?.kind ?? '')))) fail('invalid_graph')
      const op: Operation = { version: 1, operationId, profileFingerprint: this.options.profileFingerprint, commandDigest: digest(JSON.stringify(command)), command, spool, sessionId: null, receipt: null, aborted: false }
      await this.save(op, dir); saved = true
      return await this.run(op, dir)
    } catch (error) {
      if (saved) {
        const known = error && typeof error === 'object' && 'code' in error && typeof error.code === 'string' && ['conflict', 'forbidden', 'unauthenticated', 'invalid_state', 'invalid_request', 'not_found', 'session_closed', 'session_expired', 'upload_incomplete', 'not_sealed', 'integrity_error', 'payload_too_large', 'unsupported_media_type'].includes(error.code) ? error.code : 'publication_outcome_unknown'
        const resumable = new Error(known) as Error & { operationId: string; cause: unknown }
        resumable.operationId = operationId; resumable.cause = error
        throw resumable
      }
      throw error
    } finally { for (const root of boundRoots.values()) await root.close(); if (!saved) discard() }
    })
  }
  async status(operationId: string): Promise<LocalOperationState> { return this.withOperation(operationId, false, async dir => { const op = await this.load(operationId, dir); if (op.receipt) return { operationId, sessionId: op.sessionId, stage: 'committed' }; if (op.aborted) return { operationId, sessionId: op.sessionId, stage: 'aborted' }; const state = op.sessionId ? statusSchema.parse(await this.options.transport.call('forge_status', { sessionId: op.sessionId })) : null; if (state && state.sessionId !== op.sessionId) fail('invalid_server_response'); return { operationId, sessionId: op.sessionId, stage: state?.state ?? 'prepared' } }) }
  async abort(operationId: string): Promise<void> {
    return this.withOperation(operationId, false, async dir => {
    const op = await this.load(operationId, dir)
    if (op.receipt) fail('already_committed')
    if (op.aborted) return
    if (!op.sessionId) {
      const state = statusSchema.parse(await this.options.transport.call('forge_begin', { command: op.command }))
      if (!state || typeof state.sessionId !== 'string') fail('invalid_server_response')
      op.sessionId = state.sessionId
      await this.save(op, dir)
    }
    if (await this.options.transport.call('forge_abort', { sessionId: op.sessionId }) !== null) fail('invalid_server_response')
    op.aborted = true
    await this.save(op, dir)
    for (const name of Object.values(op.spool)) await this.removeSpool(dir, name)
    })
  }
  async resume(operationId: string): Promise<LocalPublishResult> { return this.withOperation(operationId, false, async dir => this.run(await this.load(operationId, dir), dir)) }
  private async run(op: Operation, dir: PrivateDirectory): Promise<LocalPublishResult> {
    if (op.aborted) fail('operation_aborted')
    const t = this.options.transport
    if (!op.receipt) {
      let state = statusSchema.parse(op.sessionId ? await t.call('forge_status', { sessionId: op.sessionId }) : await t.call('forge_begin', { command: op.command }))
      if ((op.sessionId !== null && state.sessionId !== op.sessionId) || state.baseRevisionId !== op.command.expectedRevisionId || (op.command.artifactId !== null && state.artifactId !== op.command.artifactId)) fail('invalid_server_response')
      if (!op.sessionId) { op.sessionId = state.sessionId; await this.save(op, dir) }
      if (state.state === 'closed') fail('session_closed')
      if (state.state === 'open') {
        if (state.files.length !== op.command.files.length || new Set(state.files.map(f => f.path)).size !== state.files.length || state.files.some(f => !op.command.files.some(c => c.path === f.path && c.source === f.source))) fail('invalid_server_response')
        for (const f of state.files) if (!f.stored) {
          if (f.source === 'base') { const result = uploadSchema.parse(await t.call('forge_materialize', { sessionId: op.sessionId, path: f.path })); if (result.sessionId !== op.sessionId || result.path !== f.path) fail('invalid_server_response') }
          else {
            const desc = op.command.files.find(x => x.path === f.path)!, name = op.spool[f.path]
            if (!name || !/^spool-\d+$/.test(name)) fail('invalid_operation')
            const handle = await dir.open(name, 'read')
            try {
              const info = await handle.stat()
              if (!info.isFile() || info.uid !== process.getuid?.() || (info.mode & 0o077) || info.size !== desc.size) fail('invalid_spool')
              const stream = Readable.toWeb(handle.createReadStream({ autoClose: false })) as ReadableStream<Uint8Array>
              const result = uploadSchema.parse(await t.upload(op.sessionId!, f.path, stream, desc.size))
              if (result.sessionId !== op.sessionId || result.path !== f.path) fail('invalid_server_response')
            } finally { await handle.close() }
          }
        }
        state = statusSchema.parse(await t.call('forge_seal', { sessionId: op.sessionId }))
        if (state.sessionId !== op.sessionId || !['sealed', 'committed'].includes(state.state)) fail('invalid_server_response')
      }
      const receipt = receiptSchema.parse(await t.call('forge_commit', { sessionId: op.sessionId }))
      if (receipt.artifactId !== state.artifactId || receipt.revisionId !== state.revisionId || receipt.contentVersion !== op.command.expectedContentVersion + 1 || receipt.pages.length !== op.command.pages.filter(p => p.disposition !== 'drop').length || new Set(receipt.pages.map(p => p.pageId)).size !== receipt.pages.length || receipt.pages.some(p => !op.command.pages.some(c => c.pageId === p.pageId && c.disposition !== 'drop'))) fail('invalid_server_response')
      for (const page of receipt.pages) { if (typeof page.pageId !== 'string' || typeof page.url !== 'string' || !page.url.startsWith('/') || page.url.startsWith('//') || new URL(page.url, this.options.readOrigin).origin !== this.options.readOrigin) fail('invalid_server_response') }
      op.receipt = receipt; await this.save(op, dir)
      for (const name of Object.values(op.spool)) await this.removeSpool(dir, name)
    }
    let enrichments: LocalPublishResult['enrichments']
    try {
      if (!await t.supports('forge_enrichments')) enrichments = { availability: 'unsupported' }
      else if (op.receipt.revisionId === null) enrichments = { availability: 'unavailable', code: 'unavailable' }
      else {
        const result = enrichmentSchema.parse(await t.call('forge_enrichments', { artifactId: op.receipt.artifactId, revisionId: op.receipt.revisionId }))
        if (result.artifactId !== op.receipt.artifactId || result.revisionId !== op.receipt.revisionId || result.items.some(item => item.revisionId !== result.revisionId)) fail('invalid_server_response')
        enrichments = { availability: 'available', result }
      }
    } catch (error) { enrichments = { availability: 'unavailable', code: error && typeof error === 'object' && 'code' in error && error.code === 'forbidden' ? 'forbidden' : 'unavailable' } }
    return { publication: op.receipt, enrichments }
  }
}
