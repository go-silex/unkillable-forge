import { claimPageStatements, retirePageStatements, restorePageStatements } from '../catalogue/commands'
import { executeGuarded, PolicyError, type GuardRequest, type OwnershipEdge } from '../catalogue/guard'
import { newId } from '../catalogue/ids'
import { requireManageActor, type ManageActor } from '../catalogue/principals'
import { assertPrepareAuthority, assertReplayAuthority } from '../catalogue/read'
import { livePagesFrom, livePagesStatement } from '../catalogue/artifact-pages'
import { documentRouteOf } from '../catalogue/revision-paths'
import { canonicalUrl, type SubtreeOrTree } from '../catalogue/routing/grammar'
import type { PublicationDeps, PublicationReceipt, PromotionCommand, RestoreCommand } from './types'

type Page = { page_id: string; disposition: 'new' | 'keep' | 'drop' | 'restore'; document_path: string | null; metadata_json: string | null; expected_policy_epoch: number | null }
type ExistingPage = { page_id: string; document_path: string; policy_epoch: number }
type Session = { session_id: string; instance_id: string; actor_principal_id: string; actor_authority_epoch: number; artifact_id: string; revision_id: string; base_revision_id: string | null; base_content_version: number; expires_at: number; closed_at: number | null; request_digest: string }
type Event = { action: string; request_digest: string; receipt_json: string | null }

function route(path: string): SubtreeOrTree {
  const result = documentRouteOf(path)
  if (!result) throw new PolicyError('invalid_state')
  return result
}
function receipt(artifactId: string, revisionId: string | null, version: number, pages: readonly { page_id: string; document_path: string | null }[]): PublicationReceipt {
  return { artifactId, revisionId, contentVersion: version, pages: pages.map(p => {
    if (!p.document_path) throw new PolicyError('invalid_state')
    return { pageId: p.page_id, url: canonicalUrl(route(p.document_path)) }
  }) }
}
async function digest(value: unknown): Promise<string> {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(value)))
  return Array.from(new Uint8Array(bytes), b => b.toString(16).padStart(2, '0')).join('')
}
function validateCommand(command: PromotionCommand): void {
  if (!command || typeof command.idempotencyKey !== 'string' || !/^[!-~]{1,128}$/.test(command.idempotencyKey) || typeof command.artifactId !== 'string' || !/^ar_[a-z2-7]{26}$/.test(command.artifactId) || !Number.isSafeInteger(command.expectedContentVersion) || command.expectedContentVersion < 0) throw new PolicyError('invalid_state')
}
async function all<T>(query: D1PreparedStatement): Promise<T[]> { return (await query.all<T>()).results }
async function verifyRevision(deps: PublicationDeps, artifactId: string, revisionId: string): Promise<void> {
  type Descriptor = { object_key: string; size: number; sha256: string; object_version: string | null }
  const [revisions, resources] = await deps.db.batch([
    deps.db.prepare('SELECT manifest_object_key AS object_key,manifest_size AS size,manifest_sha256 AS sha256,manifest_object_version AS object_version FROM revisions WHERE revision_id=? AND artifact_id=? AND NOT EXISTS (SELECT 1 FROM revision_discards WHERE revision_id=?)').bind(revisionId, artifactId, revisionId),
    deps.db.prepare('SELECT object_key,size,sha256,object_version FROM revision_resources WHERE revision_id=?').bind(revisionId),
  ])
  const revision = revisions.results[0] as Descriptor | undefined
  if (!revision) throw new PolicyError('not_found')
  const expected = new Map<string, Descriptor>()
  for (const object of [revision, ...resources.results as Descriptor[]]) {
    if (typeof object.object_key !== 'string' || !object.object_key || typeof object.object_version !== 'string' || !object.object_version || !Number.isSafeInteger(object.size) || object.size < 0 || typeof object.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(object.sha256) || expected.has(object.object_key)) throw new PolicyError('invalid_state')
    expected.set(object.object_key, object)
  }
  let cursor: string | null = null
  const cursors = new Set<string>()
  do {
    const page = await deps.store.listRevision({ artifactId, revisionId }, cursor)
    for (const object of page.objects) {
      const descriptor = expected.get(object.key)
      if (!descriptor) continue
      if (object.size !== descriptor.size || object.version !== descriptor.object_version || (object.sha256 !== null && object.sha256 !== descriptor.sha256)) throw new PolicyError('invalid_state')
      expected.delete(object.key)
    }
    cursor = page.cursor
    if (cursor !== null) {
      if (typeof cursor !== 'string' || !cursor || cursors.has(cursor)) throw new PolicyError('invalid_state')
      cursors.add(cursor)
    }
  } while (cursor !== null)
  if (expected.size) throw new PolicyError('invalid_state')
}
async function replay(deps: PublicationDeps, actor: ManageActor, event: Event, action: string, requestDigest: string, artifactId: string): Promise<PublicationReceipt> {
  if (event.action !== action || event.request_digest !== requestDigest || !event.receipt_json) throw new PolicyError('conflict')
  const saved = JSON.parse(event.receipt_json) as { receipt: PublicationReceipt; pageIds: string[]; actorAuthorityEpoch: number }
  if (!saved || !saved.receipt || saved.receipt.artifactId !== artifactId || !Array.isArray(saved.pageIds) || saved.pageIds.some(id => typeof id !== 'string') || !Number.isSafeInteger(saved.actorAuthorityEpoch)) throw new PolicyError('invalid_state')
  await assertReplayAuthority(deps, actor, { artifactId, pageIds: saved.pageIds, expectedActorAuthorityEpoch: saved.actorAuthorityEpoch })
  return saved.receipt
}
function eventStatement(deps: PublicationDeps, actor: ManageActor, p: { action: 'commit' | 'restore' | 'unpublish'; sessionId: string | null; key: string | null; artifactId: string; revisionId: string | null; digest: string; at: number; result: PublicationReceipt; pageIds: readonly string[]; expectedVersion: number; baseRevision?: string | null }): D1PreparedStatement {
  return deps.db.prepare(`INSERT INTO publication_events (event_id,action,session_id,instance_id,idempotency_key,artifact_id,revision_id,actor_principal_id,request_digest,occurred_at,receipt_json,verdict)
    SELECT ?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,CASE
      WHEN ?3 IS NOT NULL AND NOT EXISTS (SELECT 1 FROM publication_sessions s WHERE s.session_id=?3 AND s.instance_id=?4 AND s.actor_principal_id=?8) THEN 'not_found'
      WHEN ?3 IS NOT NULL AND EXISTS (SELECT 1 FROM publication_sessions s WHERE s.session_id=?3 AND s.closed_at IS NOT NULL) THEN 'closed'
      WHEN ?3 IS NOT NULL AND EXISTS (SELECT 1 FROM publication_sessions s WHERE s.session_id=?3 AND s.expires_at<=?10) THEN 'expired'
      WHEN ?3 IS NOT NULL AND EXISTS (SELECT 1 FROM publication_sessions s WHERE s.session_id=?3 AND s.actor_authority_epoch IS NOT ?15) THEN 'conflict'
      WHEN ?3 IS NOT NULL AND NOT EXISTS (SELECT 1 FROM publication_events e WHERE e.session_id=?3 AND e.action='seal') THEN 'not_sealed'
      WHEN NOT EXISTS (SELECT 1 FROM artifacts WHERE artifact_id=?6 AND content_version=?12 AND (?14=0 OR active_revision_id IS ?13)) THEN 'conflict'
      WHEN ?14=1 AND ?13 IS NOT NULL AND EXISTS (SELECT 1 FROM revision_discards WHERE revision_id=?13) THEN 'conflict'
      WHEN ?5 IS NOT NULL AND EXISTS (SELECT 1 FROM publication_sessions WHERE instance_id=?4 AND actor_principal_id=?8 AND idempotency_key=?5) THEN 'conflict'
      WHEN ?7 IS NOT NULL AND EXISTS (SELECT 1 FROM revision_discards WHERE revision_id=?7) THEN 'conflict'
      WHEN ?2='restore' AND NOT EXISTS (SELECT 1 FROM publication_events e WHERE e.action='commit' AND e.instance_id=?4 AND e.artifact_id=?6 AND e.revision_id=?7) THEN 'never_committed'
      ELSE 'ok' END`).bind(newId('pe'), p.action, p.sessionId, deps.config.instanceId, p.key, p.artifactId, p.revisionId, actor.principalId, p.digest, p.at, JSON.stringify({ receipt: p.result, pageIds: p.pageIds, actorAuthorityEpoch: actor.authorityEpoch }), p.expectedVersion, p.baseRevision ?? null, p.baseRevision === undefined ? 0 : 1, actor.authorityEpoch)
}
function mountStatements(deps: PublicationDeps, artifactId: string, revisionId: string): D1PreparedStatement[] {
  return [
    deps.db.prepare('DELETE FROM mounts WHERE artifact_id = ? AND path NOT IN (SELECT path FROM revision_resources WHERE revision_id = ?)').bind(artifactId, revisionId),
    deps.db.prepare(`INSERT INTO mounts (path,artifact_id,revision_id,kind) SELECT path,?,revision_id,kind FROM revision_resources WHERE revision_id=? AND true ON CONFLICT(path) DO UPDATE SET revision_id=excluded.revision_id,kind=excluded.kind`).bind(artifactId, revisionId),
  ]
}
function activation(deps: PublicationDeps, artifactId: string, revisionId: string | null): D1PreparedStatement {
  return deps.db.prepare('UPDATE artifacts SET active_revision_id=?,content_version=content_version+1 WHERE artifact_id=?').bind(revisionId, artifactId)
}

export async function commit(deps: PublicationDeps, actor: ManageActor, sessionId: string): Promise<PublicationReceipt> {
  requireManageActor(actor, deps)
  if (typeof sessionId !== 'string' || !/^ps_[a-z2-7]{26}$/.test(sessionId)) throw new PolicyError('invalid_state')
  const db = deps.db
  let at = deps.now()
  if (!Number.isSafeInteger(at) || at < 0 || deps.store.instanceId !== deps.config.instanceId) throw new PolicyError('invalid_state')
  const session = await db.prepare('SELECT * FROM publication_sessions WHERE session_id=? AND instance_id=? AND actor_principal_id=?').bind(sessionId, deps.config.instanceId, actor.principalId).first<Session>()
  const pages = session ? await all<Page>(db.prepare('SELECT * FROM publication_pages WHERE session_id=? ORDER BY page_id').bind(sessionId)) : []
  const existingPageIds = pages.filter(p => p.disposition !== 'new').map(p => p.page_id)
  await assertPrepareAuthority(deps, actor, { artifactId: session?.artifact_id ?? null, pageIds: existingPageIds, requireGlobal: !session || pages.length === 0 || pages.some(p => p.disposition === 'new' || p.disposition === 'restore') })
  if (!session) throw new PolicyError('not_found')
  const prior = await db.prepare("SELECT action,request_digest,receipt_json FROM publication_events WHERE session_id=? AND action='commit'").bind(sessionId).first<Event>()
  if (prior) return replay(deps, actor, prior, 'commit', session.request_digest, session.artifact_id)
  try {
  if (session.closed_at !== null) throw new PolicyError('invalid_state', 'publication_closed')
  if (session.expires_at <= at) throw new PolicyError('invalid_state', 'publication_expired')
  if (session.actor_authority_epoch !== actor.authorityEpoch) throw new PolicyError('conflict')
  const seal = await db.prepare("SELECT 1 AS present FROM publication_events WHERE session_id=? AND action='seal'").bind(sessionId).first<{ present: number }>()
  if (!seal) throw new PolicyError('invalid_state', 'publication_not_sealed')
  await verifyRevision(deps, session.artifact_id, session.revision_id)
  at = deps.now()
  if (!Number.isSafeInteger(at) || at < 0) throw new PolicyError('invalid_state')
  const result = receipt(session.artifact_id, session.revision_id, session.base_content_version + 1, pages.filter(p => p.disposition !== 'drop'))
  const guards: GuardRequest[] = pages.map(p => ({ action: p.disposition === 'new' ? 'create_page' : p.disposition === 'keep' ? 'publish' : p.disposition === 'restore' ? 'restore_page' : 'unpublish', pageId: p.page_id, artifactId: session.artifact_id, revisionId: session.revision_id, expectedPolicyEpoch: p.expected_policy_epoch ?? undefined, expectedContentVersion: session.base_content_version, requestDigest: session.request_digest, occurredAt: at }))
  const effects: D1PreparedStatement[] = [eventStatement(deps, actor, { action: 'commit', sessionId, key: null, artifactId: session.artifact_id, revisionId: session.revision_id, digest: session.request_digest, at, result, pageIds: pages.map(p => p.page_id), expectedVersion: session.base_content_version, baseRevision: session.base_revision_id })]
  for (const p of pages.filter(p => p.disposition === 'drop')) effects.push(...retirePageStatements(deps, actor, { pageId: p.page_id, at }))
  effects.push(...mountStatements(deps, session.artifact_id, session.revision_id))
  for (const p of pages.filter(p => p.disposition === 'new')) {
    if (!p.document_path || !p.metadata_json) throw new PolicyError('invalid_state')
    effects.push(...claimPageStatements(deps, actor, { pageId: p.page_id, artifactId: session.artifact_id, route: route(p.document_path), at }))
    effects.push(db.prepare('INSERT INTO revision_pages(revision_id,page_id,document_path,metadata_json) VALUES(?,?,?,?)').bind(session.revision_id, p.page_id, p.document_path, p.metadata_json))
  }
  for (const p of pages.filter(p => p.disposition === 'restore')) effects.push(...restorePageStatements(db, { pageId: p.page_id, revisionId: session.revision_id, at }))
  const edges = await all<{ owner_page_id: string; path: string; provider_artifact_id: string }>(db.prepare("SELECT e.owner_page_id,e.path,e.provider_artifact_id FROM publication_edges e JOIN publication_pages p ON p.session_id=e.session_id AND p.page_id=e.owner_page_id WHERE e.session_id=? AND p.disposition='new' ORDER BY e.owner_page_id,e.path").bind(sessionId))
  const ownership: OwnershipEdge[] = edges.map(e => ({ ownerPageId: e.owner_page_id, path: e.path, providerArtifactId: e.provider_artifact_id }))
    await executeGuarded(deps, actor, guards, effects, { revisionId: session.revision_id, edges: ownership }, [activation(deps, session.artifact_id, session.revision_id)])
    return result
  } catch (error) {
    const concurrent = await db.prepare("SELECT action,request_digest,receipt_json FROM publication_events WHERE session_id=? AND action='commit'").bind(sessionId).first<Event>()
    if (concurrent) return replay(deps, actor, concurrent, 'commit', session.request_digest, session.artifact_id)
    throw error
  }
}

async function promote(deps: PublicationDeps, actor: ManageActor, command: PromotionCommand, revisionId: string | null): Promise<PublicationReceipt> {
  requireManageActor(actor, deps)
  validateCommand(command)
  if (revisionId !== null && !/^rv_[a-z2-7]{26}$/.test(revisionId)) throw new PolicyError('invalid_state')
  const db = deps.db, at = deps.now(), action = revisionId === null ? 'unpublish' : 'restore'
  if (!Number.isSafeInteger(at) || at < 0 || deps.store.instanceId !== deps.config.instanceId || !Number.isSafeInteger(command.expectedContentVersion + 1)) throw new PolicyError('invalid_state')
  const requestDigest = await digest({ action, artifactId: command.artifactId, expectedContentVersion: command.expectedContentVersion, ...(revisionId === null ? {} : { revisionId }) })
  const prior = await db.prepare('SELECT action,request_digest,receipt_json FROM publication_events WHERE instance_id=? AND actor_principal_id=? AND idempotency_key=?').bind(deps.config.instanceId, actor.principalId, command.idempotencyKey).first<Event>()
  if (prior) return replay(deps, actor, prior, action, requestDigest, command.artifactId)
  try {
  const liveResult = await livePagesStatement(db, command.artifactId).all()
  const target = revisionId === null ? [] : await all<{ page_id: string; document_path: string }>(db.prepare('SELECT rp.page_id,rp.document_path FROM revision_pages rp JOIN revisions r ON r.revision_id=rp.revision_id WHERE rp.revision_id=? AND r.artifact_id=? ORDER BY rp.page_id').bind(revisionId, command.artifactId))
  const liveIds = (liveResult.results as { page_id: string }[]).map(p => p.page_id)
  const liveIdSet = new Set(liveIds)
  const pageIds = [...new Set([...liveIds, ...target.map(p => p.page_id)])]
  await assertPrepareAuthority(deps, actor, { artifactId: command.artifactId, pageIds, requireGlobal: pageIds.length === 0 || target.some(p => !liveIdSet.has(p.page_id)) })
  if (revisionId !== null) {
    const revision = await db.prepare('SELECT 1 AS present FROM revisions WHERE revision_id=? AND artifact_id=? AND NOT EXISTS (SELECT 1 FROM revision_discards WHERE revision_id=?)').bind(revisionId, command.artifactId, revisionId).first<{ present: number }>()
    if (!revision) throw new PolicyError('not_found')
    if (target.length === 0) throw new PolicyError('invalid_state', 'revision_without_page')
    const committed = await db.prepare("SELECT 1 AS present FROM publication_events WHERE action='commit' AND instance_id=? AND artifact_id=? AND revision_id=? LIMIT 1").bind(deps.config.instanceId, command.artifactId, revisionId).first<{ present: number }>()
    if (!committed) throw new PolicyError('invalid_state', 'publication_never_committed')
  }
  const current: ExistingPage[] = livePagesFrom(liveResult).map(p => ({ page_id: p.pageId, document_path: p.documentPath, policy_epoch: p.policyEpoch }))
  const liveById = new Map(current.map(p => [p.page_id, p]))
  if (target.some(p => liveById.has(p.page_id) && liveById.get(p.page_id)!.document_path !== p.document_path)) {
    throw new PolicyError('invalid_state', 'restore_path_changed')
  }
  if (revisionId !== null) await verifyRevision(deps, command.artifactId, revisionId)
  const targetIds = new Set(target.map(p => p.page_id))
  const dropped = current.filter(p => !targetIds.has(p.page_id))
  const result = receipt(command.artifactId, revisionId, command.expectedContentVersion + 1, target)
  const guards: GuardRequest[] = [...target.map(p => ({ action: liveById.has(p.page_id) ? 'publish' as const : 'restore_page' as const, pageId: p.page_id, artifactId: command.artifactId, revisionId: revisionId!, expectedPolicyEpoch: liveById.get(p.page_id)?.policy_epoch, expectedContentVersion: command.expectedContentVersion, requestDigest, occurredAt: at })), ...dropped.map(p => ({ action: 'unpublish' as const, pageId: p.page_id, artifactId: command.artifactId, revisionId: revisionId ?? undefined, expectedPolicyEpoch: p.policy_epoch, expectedContentVersion: command.expectedContentVersion, requestDigest, occurredAt: at }))]
  if (!guards.length) throw new PolicyError('invalid_state')
  const effects: D1PreparedStatement[] = [eventStatement(deps, actor, { action, sessionId: null, key: command.idempotencyKey, artifactId: command.artifactId, revisionId, digest: requestDigest, at, result, pageIds: guards.map(g => g.pageId!), expectedVersion: command.expectedContentVersion })]
  for (const p of dropped) effects.push(...retirePageStatements(deps, actor, { pageId: p.page_id, at }))
  if (revisionId === null) effects.push(db.prepare('DELETE FROM mounts WHERE artifact_id=?').bind(command.artifactId))
  else {
    effects.push(...mountStatements(deps, command.artifactId, revisionId))
    for (const p of target.filter(p => !liveById.has(p.page_id))) effects.push(...restorePageStatements(db, { pageId: p.page_id, revisionId, at }))
  }
    await executeGuarded(deps, actor, guards, effects, undefined, [activation(deps, command.artifactId, revisionId)])
    return result
  } catch (error) {
    const concurrent = await db.prepare('SELECT action,request_digest,receipt_json FROM publication_events WHERE instance_id=? AND actor_principal_id=? AND idempotency_key=?').bind(deps.config.instanceId, actor.principalId, command.idempotencyKey).first<Event>()
    if (concurrent) return replay(deps, actor, concurrent, action, requestDigest, command.artifactId)
    throw error
  }
}
export function restore(deps: PublicationDeps, actor: ManageActor, command: RestoreCommand): Promise<PublicationReceipt> {
  return promote(deps, actor, command, command.revisionId)
}
export function unpublish(deps: PublicationDeps, actor: ManageActor, command: PromotionCommand): Promise<PublicationReceipt> {
  return promote(deps, actor, command, null)
}
