import { executeGuarded, PolicyError, type GuardRequest, type OwnershipEdge } from '../catalogue/guard'
import { requireManageActor, type ManageActor } from '../catalogue/principals'
import { newId } from '../catalogue/ids'
import { documentRouteOf, validateRevisionPaths } from '../catalogue/revision-paths'
import { assertReplayAuthority } from '../catalogue/read'
import type { BeginCommand, PublicationDeps, PublicationFile, PublicationPage, PublicationStatus } from './types'

type Session = { session_id: string; instance_id: string; actor_principal_id: string; actor_authority_epoch: number; request_digest: string; artifact_id: string; artifact_is_new: number; revision_id: string; base_revision_id: string | null; base_content_version: number; expires_at: number; closed_at: number | null }
type FileRow = { path: string; kind: PublicationFile['kind']; sha256: string; size: number; content_type: string; source: PublicationFile['source']; object_key: string | null; stored_at: number | null }
type PageRow = { page_id: string; disposition: PublicationPage['disposition']; document_path: string | null; metadata_json: string | null; expected_policy_epoch: number | null }
type EdgeRow = { owner_page_id: string; path: string; provider_artifact_id: string }
const id = (s: unknown, prefix: string): s is string => typeof s === 'string' && new RegExp(`^${prefix}_[a-z2-7]{26}$`).test(s)
const fail = (): never => { throw new PolicyError('invalid_state') }
function canonical(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value)
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (typeof value === 'object' && value !== null && Object.getPrototypeOf(value) === Object.prototype) {
    const o = value as Record<string, unknown>
    return `{${Object.keys(o).sort().map(k => `${JSON.stringify(k)}:${canonical(o[k])}`).join(',')}}`
  }
  return fail()
}
async function hash(text: string): Promise<string> {
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))), b => b.toString(16).padStart(2, '0')).join('')
}
function clock(deps: PublicationDeps): number {
  const n = deps.now(), p = deps.publication
  if (!Number.isSafeInteger(n) || n < 0 || !Number.isSafeInteger(p.sessionTtlMs) || p.sessionTtlMs <= 0 || !Number.isSafeInteger(p.maxUploadTimeoutMs) || p.maxUploadTimeoutMs <= 0 || !Number.isSafeInteger(n + p.sessionTtlMs) || deps.store.instanceId !== deps.config.instanceId) return fail()
  return n
}
function validPath(p: unknown): p is string {
  return typeof p === 'string' && p.length >= 2 && p.length <= 1024 && p.startsWith('/') && !p.endsWith('/') && !p.includes('\\') && !p.includes('//') && !p.split('/').some(x => x === '.' || x === '..') && !/[\u0000-\u001f\u007f?#]/.test(p) && !/%(?:2f|2e|5c|25|0[0-9a-f]|1[0-9a-f]|7f)/i.test(p) && !/^\/(?:s|_revisions|api|registry)(?:\/|$)/.test(p) && p !== '/manifest.json' && p !== '/asset-owners.json'
}
function validate(command: BeginCommand): void {
  if (!command || typeof command.idempotencyKey !== 'string' || !/^[!-~]{1,128}$/.test(command.idempotencyKey) || !(command.artifactId === null || id(command.artifactId, 'ar')) || !(command.expectedRevisionId === null || id(command.expectedRevisionId, 'rv')) || !Number.isSafeInteger(command.expectedContentVersion) || command.expectedContentVersion < 0 || !Array.isArray(command.files) || !Array.isArray(command.pages) || !Array.isArray(command.edges) || command.files.length > 10000 || command.pages.length > 1000 || command.edges.length > 20000 || command.pages.length === 0 || (command.artifactId === null && (command.expectedRevisionId !== null || command.expectedContentVersion !== 0))) fail()
  const files = new Map<string, PublicationFile>(), pages = new Map<string, PublicationPage>(), docs = new Set<string>(), edges = new Set<string>()
  for (const f of command.files) {
    if (!f || !validPath(f.path) || files.has(f.path) || !['document','subdocument','fragment','asset'].includes(f.kind) || !/^[0-9a-f]{64}$/.test(f.sha256) || !Number.isSafeInteger(f.size) || f.size < 0 || typeof f.contentType !== 'string' || f.contentType.length < 1 || f.contentType.length > 255 || /[\r\n\0]/.test(f.contentType) || !['client','base'].includes(f.source) || (f.kind === 'asset' && f.path.endsWith('.html')) || (f.source === 'base' && command.expectedRevisionId === null)) fail()
    files.set(f.path, f)
  }
  for (const p of command.pages) {
    if (!p || !id(p.pageId, 'pg') || pages.has(p.pageId) || !['new','keep','drop','restore'].includes(p.disposition) || (p.disposition === 'new' ? p.expectedPolicyEpoch !== null : !Number.isSafeInteger(p.expectedPolicyEpoch) || (p.expectedPolicyEpoch as number) < 0)) fail()
    if (p.disposition === 'drop') { if (p.documentPath !== null || p.metadata !== null) fail() }
    else {
      const documentPath = p.documentPath
      if (typeof documentPath !== 'string') throw new PolicyError('invalid_state')
      if (!validPath(documentPath) || docs.has(documentPath) || files.get(documentPath)?.kind !== 'document' || p.metadata === null || canonical(p.metadata).length > 8192) fail()
      if (!documentRouteOf(documentPath)) fail()
      docs.add(documentPath)
    }
    pages.set(p.pageId, p)
  }
  for (const f of files.values()) if (f.kind === 'document' && !docs.has(f.path)) fail()
  for (const e of command.edges) {
    const key = `${e?.ownerPageId}\0${e?.path}`
    if (!e || !pages.has(e.ownerPageId) || pages.get(e.ownerPageId)?.disposition === 'drop' || !validPath(e.path) || (e.providerArtifactId !== null && !id(e.providerArtifactId, 'ar')) || edges.has(key)) fail()
    if ((e.providerArtifactId === null || e.providerArtifactId === command.artifactId) && !['fragment','asset'].includes(files.get(e.path)?.kind ?? '')) fail()
    edges.add(key)
  }
}
async function load(deps: PublicationDeps, actor: ManageActor, sessionId: string): Promise<Session> {
  requireManageActor(actor, deps); clock(deps)
  if (!id(sessionId, 'ps')) throw new PolicyError('not_found')
  const s = await deps.db.prepare('SELECT * FROM publication_sessions WHERE session_id = ?').bind(sessionId).first<Session>()
  if (!s || s.instance_id !== deps.config.instanceId || s.actor_principal_id !== actor.principalId) throw new PolicyError('not_found')
  if (s.actor_authority_epoch !== actor.authorityEpoch) throw new PolicyError('conflict')
  return s
}
async function rows(deps: PublicationDeps, s: Session): Promise<{ files: FileRow[]; pages: PageRow[]; edges: EdgeRow[] }> {
  const [f,p,e] = await deps.db.batch([deps.db.prepare('SELECT * FROM publication_files WHERE session_id = ? ORDER BY path').bind(s.session_id), deps.db.prepare('SELECT * FROM publication_pages WHERE session_id = ? ORDER BY page_id').bind(s.session_id), deps.db.prepare('SELECT * FROM publication_edges WHERE session_id = ? ORDER BY owner_page_id,path').bind(s.session_id)])
  return { files: f.results as FileRow[], pages: p.results as PageRow[], edges: e.results as EdgeRow[] }
}
function guards(s: Session, pages: PageRow[], now: number): GuardRequest[] {
  const existing = pages.filter(p => p.disposition !== 'new')
  const result: GuardRequest[] = existing.map(p => ({ action: 'stage', pageId: p.page_id, artifactId: s.artifact_id, expectedPolicyEpoch: p.expected_policy_epoch!, revisionId: s.revision_id, requestDigest: s.request_digest, occurredAt: now }))
  if (!existing.length || pages.some(p => p.disposition === 'new')) result.push({ action: 'stage', artifactId: s.artifact_id, requestDigest: s.request_digest, occurredAt: now })
  return result
}
function assertion(deps: PublicationDeps, s: Session, now: number, allowSealed = false): D1PreparedStatement {
  return deps.db.prepare(`INSERT INTO publication_assertions (assertion_id, verdict)
    SELECT ?7, CASE
    WHEN NOT EXISTS (SELECT 1 FROM publication_sessions WHERE session_id = ?1 AND instance_id = ?8 AND actor_principal_id = ?3) THEN 'not_found'
    WHEN EXISTS (SELECT 1 FROM publication_sessions WHERE session_id = ?1 AND closed_at IS NOT NULL) THEN 'closed'
    WHEN EXISTS (SELECT 1 FROM publication_sessions WHERE session_id = ?1 AND expires_at <= ?2) THEN 'expired'
    WHEN NOT EXISTS (SELECT 1 FROM publication_sessions s WHERE s.session_id = ?1 AND s.actor_authority_epoch = ?4
      AND NOT EXISTS (SELECT 1 FROM publication_pages pp LEFT JOIN pages p ON p.page_id = pp.page_id WHERE pp.session_id = ?1 AND pp.disposition <> 'new' AND (p.artifact_id IS NOT ?5 OR p.policy_epoch IS NOT pp.expected_policy_epoch OR (pp.disposition = 'restore') IS NOT (p.tombstoned_at IS NOT NULL)))
      AND NOT EXISTS (SELECT 1 FROM publication_pages pp WHERE pp.session_id = ?1 AND pp.disposition = 'keep' AND NOT EXISTS (SELECT 1 FROM routes r WHERE r.page_id = pp.page_id AND r.artifact_id = ?5 AND r.document_path = pp.document_path))
      AND (?6 = 1 OR NOT EXISTS (SELECT 1 FROM publication_events WHERE session_id = ?1 AND action = 'seal'))
      AND (s.base_revision_id IS NULL OR NOT EXISTS (SELECT 1 FROM revision_discards WHERE revision_id = s.base_revision_id))
      AND NOT EXISTS (SELECT 1 FROM pages p WHERE p.artifact_id = ?5 AND p.tombstoned_at IS NULL AND NOT EXISTS (SELECT 1 FROM publication_pages pp WHERE pp.session_id = ?1 AND pp.page_id = p.page_id AND pp.disposition IN ('keep','drop')))
      AND (s.artifact_is_new = 1 OR EXISTS (SELECT 1 FROM artifacts a WHERE a.artifact_id = ?5 AND a.content_version = s.base_content_version AND a.active_revision_id IS s.base_revision_id))) THEN 'conflict'
    ELSE 'ok' END`).bind(s.session_id, now, s.actor_principal_id, s.actor_authority_epoch, s.artifact_id, allowSealed ? 1 : 0, newId('pe'), s.instance_id)
}
async function guarded(deps: PublicationDeps, actor: ManageActor, s: Session, pages: PageRow[], effects: D1PreparedStatement[], allowSealed = false, ownership?: { revisionId: string; edges: OwnershipEdge[] }): Promise<void> {
  const now = clock(deps)
  await executeGuarded(deps, actor, guards(s, pages, now), [assertion(deps, s, now, allowSealed), ...effects], ownership)
}
export async function status(deps: PublicationDeps, actor: ManageActor, sessionId: string): Promise<PublicationStatus> {
  const s = await load(deps, actor, sessionId), r = await rows(deps, s)
  const events = await deps.db.prepare("SELECT action FROM publication_events WHERE session_id = ? AND action IN ('seal','commit')").bind(sessionId).all<{ action: string }>()
  const actions = new Set(events.results.map(e => e.action))
  const existingPageIds = r.pages.filter(p => p.disposition !== 'new').map(p => p.page_id)
  if (existingPageIds.length > 0) {
    await assertReplayAuthority(deps, actor, { artifactId: s.artifact_id, pageIds: existingPageIds, expectedActorAuthorityEpoch: s.actor_authority_epoch })
  }
  if (existingPageIds.length === 0 || r.pages.some(p => p.disposition === 'new')) {
    await assertReplayAuthority(deps, actor, { artifactId: s.artifact_id, pageIds: [], expectedActorAuthorityEpoch: s.actor_authority_epoch })
  }
  return { sessionId, artifactId: s.artifact_id, revisionId: s.revision_id, baseRevisionId: s.base_revision_id, expiresAt: s.expires_at, state: actions.has('commit') ? 'committed' : s.closed_at !== null || s.expires_at <= clock(deps) ? 'closed' : actions.has('seal') ? 'sealed' : 'open', files: r.files.map(f => ({ path: f.path, source: f.source, stored: f.stored_at !== null })) }
}
export async function begin(deps: PublicationDeps, actor: ManageActor, command: BeginCommand): Promise<PublicationStatus> {
  requireManageActor(actor, deps); const now = clock(deps); validate(command)
  const digest = await hash(canonical(command))
  const prior = await deps.db.prepare('SELECT * FROM publication_sessions WHERE instance_id = ? AND actor_principal_id = ? AND idempotency_key = ?').bind(deps.config.instanceId, actor.principalId, command.idempotencyKey).first<Session>()
  if (prior) {
    if (prior.request_digest !== digest) throw new PolicyError('conflict')
    return status(deps, actor, prior.session_id)
  }
  const artifactId = command.artifactId ?? newId('ar'), sessionId = newId('ps'), revisionId = newId('rv')
  const s: Session = { session_id: sessionId, instance_id: deps.config.instanceId, actor_principal_id: actor.principalId, actor_authority_epoch: actor.authorityEpoch, request_digest: digest, artifact_id: artifactId, artifact_is_new: command.artifactId === null ? 1 : 0, revision_id: revisionId, base_revision_id: command.expectedRevisionId, base_content_version: command.expectedContentVersion, expires_at: now + deps.publication.sessionTtlMs, closed_at: null }
  const pageRows: PageRow[] = command.pages.map(p => ({ page_id: p.pageId, disposition: p.disposition, document_path: p.documentPath, metadata_json: p.metadata === null ? null : canonical(p.metadata), expected_policy_epoch: p.expectedPolicyEpoch }))
  const slugs = command.pages.filter(p => p.disposition === 'new' || p.disposition === 'restore').flatMap(p => {
    const route = p.documentPath === null ? null : documentRouteOf(p.documentPath)
    return route?.kind === 'subtree' ? [route.slug] : []
  })
  if ((await validateRevisionPaths(deps, { artifactId, paths: command.files.map(f => f.path), newSubtreeSlugs: slugs })).length) throw new PolicyError('conflict')
  for (const edge of command.edges.filter(e => e.providerArtifactId !== null && e.providerArtifactId !== artifactId)) {
    const provider = await deps.db.prepare("SELECT 1 AS found FROM mounts WHERE path = ? AND artifact_id = ? AND kind IN ('fragment','asset')").bind(edge.path, edge.providerArtifactId).first()
    if (!provider) throw new PolicyError('conflict')
  }
  if (command.artifactId !== null) {
    const a = await deps.db.prepare('SELECT active_revision_id,content_version FROM artifacts WHERE artifact_id = ?').bind(artifactId).first<{active_revision_id:string|null;content_version:number}>()
    if (!a || a.active_revision_id !== command.expectedRevisionId || a.content_version !== command.expectedContentVersion) throw new PolicyError('conflict')
    const existing = await deps.db.prepare('SELECT page_id FROM pages WHERE artifact_id = ? AND tombstoned_at IS NULL').bind(artifactId).all<{page_id:string}>()
    if (existing.results.some(p => !command.pages.some(x => x.pageId === p.page_id && (x.disposition === 'keep' || x.disposition === 'drop')))) throw new PolicyError('conflict')
  }
  for (const f of command.files.filter(f => f.source === 'base')) {
    const b = await deps.db.prepare('SELECT sha256,size,kind,content_type FROM revision_resources WHERE revision_id = ? AND path = ?').bind(command.expectedRevisionId, f.path).first<{sha256:string;size:number;kind:string;content_type:string}>()
    if (!b || b.sha256 !== f.sha256 || b.size !== f.size || b.kind !== f.kind || b.content_type !== f.contentType) throw new PolicyError('conflict')
  }
  const db = deps.db
  const effects: D1PreparedStatement[] = [
    db.prepare(`INSERT INTO publication_assertions (assertion_id, verdict) SELECT ?, CASE WHEN EXISTS (SELECT 1 FROM publication_events WHERE instance_id = ? AND actor_principal_id = ? AND idempotency_key = ?) THEN 'conflict' ELSE 'ok' END`).bind(newId('pe'), s.instance_id, actor.principalId, command.idempotencyKey),
    db.prepare('INSERT INTO publication_sessions (session_id,instance_id,actor_principal_id,actor_authority_epoch,idempotency_key,request_digest,artifact_id,artifact_is_new,revision_id,base_revision_id,base_content_version,created_at,expires_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)').bind(sessionId, s.instance_id, actor.principalId, actor.authorityEpoch, command.idempotencyKey, digest, artifactId, s.artifact_is_new, revisionId, s.base_revision_id, s.base_content_version, now, s.expires_at),
  ]
  for (const f of command.files) effects.push(db.prepare('INSERT INTO publication_files (session_id,path,kind,sha256,size,content_type,source) VALUES (?,?,?,?,?,?,?)').bind(sessionId,f.path,f.kind,f.sha256,f.size,f.contentType,f.source))
  for (const p of pageRows) effects.push(db.prepare('INSERT INTO publication_pages (session_id,page_id,disposition,document_path,metadata_json,expected_policy_epoch) VALUES (?,?,?,?,?,?)').bind(sessionId,p.page_id,p.disposition,p.document_path,p.metadata_json,p.expected_policy_epoch))
  for (const e of command.edges) effects.push(db.prepare('INSERT INTO publication_edges (session_id,owner_page_id,path,provider_artifact_id) VALUES (?,?,?,?)').bind(sessionId,e.ownerPageId,e.path,e.providerArtifactId ?? artifactId))
  effects.push(assertion(deps,s,now))
  try {
    await executeGuarded(deps,actor,guards(s,pageRows,now),effects)
  } catch (error) {
    const winner = await db.prepare('SELECT request_digest FROM publication_sessions WHERE instance_id = ? AND actor_principal_id = ? AND idempotency_key = ?').bind(s.instance_id, actor.principalId, command.idempotencyKey).first<{request_digest:string}>()
    if (!winner) throw error
    if (winner.request_digest !== digest) throw new PolicyError('conflict')
    return begin(deps,actor,command)
  }
  return status(deps,actor,sessionId)
}
async function transfer(deps: PublicationDeps, actor: ManageActor, sessionId: string, path: string, source: 'client'|'base', body?: ReadableStream<Uint8Array>): Promise<PublicationStatus> {
  requireManageActor(actor, deps)
  const deadline = performance.now() + deps.publication.maxUploadTimeoutMs
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), deps.publication.maxUploadTimeoutMs)
  try {
    const s = await load(deps,actor,sessionId), r = await rows(deps,s), f = r.files.find(x => x.path === path)
    if (!f || f.source !== source) throw new PolicyError('not_found')
    await guarded(deps,actor,s,r.pages,[])
    if (f.stored_at !== null) return status(deps,actor,sessionId)
    if (controller.signal.aborted || performance.now() >= deadline) throw new PolicyError('unavailable')
    if (source === 'base') {
      if (!s.base_revision_id) fail()
      const pending = deps.store.get({ artifactId:s.artifact_id, revisionId:s.base_revision_id!, kind:'resource', path })
      const obj = await Promise.race([
        pending.then(value => {
          if (controller.signal.aborted && value && 'body' in value && value.body) void value.body.cancel().catch(() => {})
          return value
        }),
        new Promise<never>((_, reject) => controller.signal.addEventListener('abort', () => reject(new PolicyError('unavailable')), { once:true })),
      ])
      if (!obj || !('body' in obj) || !obj.body) throw new PolicyError('not_found')
      body = obj.body
    }
    if (!body) fail()
    if (controller.signal.aborted || performance.now() >= deadline) { void body!.cancel().catch(() => {}); throw new PolicyError('unavailable') }
    const stored = await deps.store.put({ artifactId:s.artifact_id, revisionId:s.revision_id, kind:'resource', path }, { size:f.size, sha256:f.sha256 }, body!, controller.signal)
    await guarded(deps,actor,s,r.pages,[deps.db.prepare('UPDATE publication_files SET object_key = ?, stored_at = ? WHERE session_id = ? AND path = ?').bind(stored.key,clock(deps),sessionId,path)])
  } finally { clearTimeout(timer) }
  return status(deps,actor,sessionId)
}
export function upload(deps: PublicationDeps, actor: ManageActor, sessionId: string, path: string, body: ReadableStream<Uint8Array>): Promise<PublicationStatus> { return transfer(deps,actor,sessionId,path,'client',body) }
export function materialize(deps: PublicationDeps, actor: ManageActor, sessionId: string, path: string): Promise<PublicationStatus> { return transfer(deps,actor,sessionId,path,'base') }
export async function seal(deps: PublicationDeps, actor: ManageActor, sessionId: string): Promise<PublicationStatus> {
  requireManageActor(actor, deps)
  const deadline = performance.now() + deps.publication.maxUploadTimeoutMs
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), deps.publication.maxUploadTimeoutMs)
  try {
  const s = await load(deps,actor,sessionId), r = await rows(deps,s)
  const existing = await deps.db.prepare("SELECT 1 AS found FROM publication_events WHERE session_id = ? AND action = 'seal'").bind(sessionId).first()
  if (existing) { await guarded(deps,actor,s,r.pages,[],true); return status(deps,actor,sessionId) }
  await guarded(deps,actor,s,r.pages,[])
  if (r.files.some(f => f.stored_at === null || f.object_key === null)) throw new PolicyError('invalid_state','incomplete')
  const manifest = canonical({ files:r.files.map(f => ({path:f.path,kind:f.kind,sha256:f.sha256,size:f.size,contentType:f.content_type})), pages:r.pages.map(p => ({pageId:p.page_id,disposition:p.disposition,documentPath:p.document_path,metadata:p.metadata_json === null ? null : JSON.parse(p.metadata_json),expectedPolicyEpoch:p.expected_policy_epoch})), edges:r.edges.map(e => ({ownerPageId:e.owner_page_id,path:e.path,providerArtifactId:e.provider_artifact_id})) })
  const bytes = new TextEncoder().encode(manifest), digest = await hash(manifest)
  if (controller.signal.aborted || performance.now() >= deadline) throw new PolicyError('unavailable')
  let key: string
  key = (await deps.store.put({artifactId:s.artifact_id,revisionId:s.revision_id,kind:'manifest'},{size:bytes.length,sha256:digest},new Blob([bytes]).stream(),controller.signal)).key
  const db = deps.db, now = clock(deps), effects: D1PreparedStatement[] = []
  if (s.artifact_is_new) effects.push(db.prepare("INSERT INTO artifacts (artifact_id,origin,created_at,created_by) VALUES (?,'published',?,?)").bind(s.artifact_id,now,actor.principalId))
  effects.push(db.prepare("INSERT INTO revisions (revision_id,artifact_id,origin,manifest_sha256,manifest_object_key,sealed_at,sealed_by) VALUES (?,?,'published',?,?,?,?)").bind(s.revision_id,s.artifact_id,digest,key,now,actor.principalId))
  for (const f of r.files) effects.push(db.prepare('INSERT INTO revision_resources (revision_id,path,kind,object_key,sha256,size,content_type) VALUES (?,?,?,?,?,?,?)').bind(s.revision_id,f.path,f.kind,f.object_key,f.sha256,f.size,f.content_type))
  for (const p of r.pages.filter(p => p.disposition === 'keep' || p.disposition === 'restore')) effects.push(db.prepare('INSERT INTO revision_pages (revision_id,page_id,document_path,metadata_json) VALUES (?,?,?,?)').bind(s.revision_id,p.page_id,p.document_path,p.metadata_json))
  effects.push(db.prepare("INSERT INTO publication_events (event_id,action,session_id,instance_id,artifact_id,revision_id,actor_principal_id,request_digest,occurred_at,verdict) VALUES (?,'seal',?,?,?,?,?,?,?,'ok')").bind(newId('pe'),sessionId,s.instance_id,s.artifact_id,s.revision_id,actor.principalId,s.request_digest,now))
  const edges = r.edges.filter(e => r.pages.some(p => p.page_id === e.owner_page_id && (p.disposition === 'keep' || p.disposition === 'restore'))).map(e => ({ownerPageId:e.owner_page_id,path:e.path,providerArtifactId:e.provider_artifact_id}))
  await guarded(deps,actor,s,r.pages,effects,false,{revisionId:s.revision_id,edges})
  return status(deps,actor,sessionId)
  } finally { clearTimeout(timer) }
}
export async function abort(deps: PublicationDeps, actor: ManageActor, sessionId: string): Promise<void> {
  requireManageActor(actor, deps)
  const now = clock(deps)
  const instance = await deps.db.prepare('SELECT instance_id FROM instance_meta WHERE singleton = 1').first<{ instance_id: string }>()
  if (instance?.instance_id !== deps.config.instanceId) throw new PolicyError('instance_mismatch')
  await deps.db.prepare(`UPDATE publication_sessions SET closed_at = ?, closed_by = ?
    WHERE session_id = ? AND instance_id = ? AND actor_principal_id = ? AND closed_at IS NULL
      AND EXISTS (SELECT 1 FROM instance_meta WHERE singleton = 1 AND instance_id = ?)`)
    .bind(now, actor.principalId, sessionId, deps.config.instanceId, actor.principalId, deps.config.instanceId).run()
}
