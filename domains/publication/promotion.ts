import { claimPageStatements, retirePageStatements, restorePageStatements } from '../catalogue/commands'
import { executeGuarded, PolicyError, type GuardRequest, type OwnershipEdge } from '../catalogue/guard'
import { newId } from '../catalogue/ids'
import { requireManageActor, type ManageActor } from '../catalogue/principals'
import { assertReplayAuthority } from '../catalogue/read'
import { documentRouteOf } from '../catalogue/revision-paths'
import { canonicalUrl, type SubtreeOrTree } from '../catalogue/routing/grammar'
import type { PublicationDeps, PublicationReceipt, PromotionCommand, RestoreCommand } from './types'

type Page = { page_id: string; disposition: 'new' | 'keep' | 'drop' | 'restore'; document_path: string | null; metadata_json: string | null; expected_policy_epoch: number | null }
type ExistingPage = { page_id: string; document_path: string; policy_epoch: number; tombstoned_at: number | null }
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
  const revision = await deps.db.prepare('SELECT manifest_sha256,manifest_object_key FROM revisions WHERE revision_id = ? AND artifact_id = ? AND NOT EXISTS (SELECT 1 FROM revision_discards WHERE revision_id = ?)').bind(revisionId, artifactId, revisionId).first<{ manifest_sha256: string; manifest_object_key: string }>()
  if (!revision) throw new PolicyError('not_found')
  const manifest = await deps.store.head({ artifactId, revisionId, kind: 'manifest' })
  if (!manifest || manifest.sha256 !== revision.manifest_sha256 || manifest.key !== revision.manifest_object_key) throw new PolicyError('invalid_state')
  const resources = await all<{ path: string; sha256: string; size: number; object_key: string }>(deps.db.prepare('SELECT path,sha256,size,object_key FROM revision_resources WHERE revision_id = ?').bind(revisionId))
  for (const resource of resources) {
    const object = await deps.store.head({ artifactId, revisionId, kind: 'resource', path: resource.path })
    if (!object || object.sha256 !== resource.sha256 || object.size !== resource.size || object.key !== resource.object_key) throw new PolicyError('invalid_state')
  }
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
      WHEN NOT EXISTS (SELECT 1 FROM artifacts WHERE artifact_id=?6 AND content_version=?12 AND (?14=0 OR active_revision_id IS ?13)) THEN 'conflict'
      WHEN ?3 IS NOT NULL AND NOT EXISTS (SELECT 1 FROM publication_sessions s WHERE s.session_id=?3 AND s.instance_id=?4 AND s.actor_principal_id=?8 AND s.actor_authority_epoch=?15 AND s.closed_at IS NULL AND s.expires_at>?10 AND EXISTS (SELECT 1 FROM publication_events e WHERE e.session_id=s.session_id AND e.action='seal')) THEN 'not_sealed'
      WHEN ?3 IS NOT NULL AND EXISTS (SELECT 1 FROM pages p WHERE p.artifact_id=?6 AND p.tombstoned_at IS NULL AND NOT EXISTS (SELECT 1 FROM publication_pages pp WHERE pp.session_id=?3 AND pp.page_id=p.page_id AND pp.disposition IN ('keep','drop'))) THEN 'conflict'
      WHEN ?5 IS NOT NULL AND EXISTS (SELECT 1 FROM publication_sessions WHERE instance_id=?4 AND actor_principal_id=?8 AND idempotency_key=?5) THEN 'conflict'
      WHEN ?7 IS NOT NULL AND EXISTS (SELECT 1 FROM revision_discards WHERE revision_id=?7) THEN 'conflict'
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
  const db = deps.db, at = deps.now()
  if (!Number.isSafeInteger(at) || at < 0 || deps.store.instanceId !== deps.config.instanceId) throw new PolicyError('invalid_state')
  const session = await db.prepare('SELECT * FROM publication_sessions WHERE session_id=? AND instance_id=? AND actor_principal_id=?').bind(sessionId, deps.config.instanceId, actor.principalId).first<Session>()
  if (!session) throw new PolicyError('not_found')
  const pages = await all<Page>(db.prepare('SELECT * FROM publication_pages WHERE session_id=? ORDER BY page_id').bind(sessionId))
  const prior = await db.prepare("SELECT action,request_digest,receipt_json FROM publication_events WHERE session_id=? AND action='commit'").bind(sessionId).first<Event>()
  if (prior) return replay(deps, actor, prior, 'commit', session.request_digest, session.artifact_id)
  if (session.actor_authority_epoch !== actor.authorityEpoch) throw new PolicyError('conflict')
  await verifyRevision(deps, session.artifact_id, session.revision_id)
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
  try {
    await executeGuarded(deps, actor, guards, effects, { revisionId: session.revision_id, edges: ownership }, [activation(deps, session.artifact_id, session.revision_id)])
  } catch (error) {
    const concurrent = await db.prepare("SELECT action,request_digest,receipt_json FROM publication_events WHERE session_id=? AND action='commit'").bind(sessionId).first<Event>()
    if (concurrent) return replay(deps, actor, concurrent, 'commit', session.request_digest, session.artifact_id)
    throw error
  }
  return result
}

async function promote(deps: PublicationDeps, actor: ManageActor, command: PromotionCommand, revisionId: string | null): Promise<PublicationReceipt> {
  requireManageActor(actor, deps)
  validateCommand(command)
  if (revisionId !== null && !/^rv_[a-z2-7]{26}$/.test(revisionId)) throw new PolicyError('invalid_state')
  const db = deps.db, at = deps.now(), action = revisionId === null ? 'unpublish' : 'restore'
  if (!Number.isSafeInteger(at) || at < 0 || deps.store.instanceId !== deps.config.instanceId || !Number.isSafeInteger(command.expectedContentVersion + 1)) throw new PolicyError('invalid_state')
  const requestDigest = await digest({ action, artifactId: command.artifactId, expectedContentVersion: command.expectedContentVersion, ...(revisionId === null ? {} : { revisionId }) })
  const prior = await db.prepare('SELECT action,request_digest,receipt_json FROM publication_events WHERE instance_id=? AND actor_principal_id=? AND idempotency_key=?').bind(deps.config.instanceId, actor.principalId, command.idempotencyKey).first<Event>()
  const current = await all<ExistingPage>(db.prepare('SELECT p.page_id,rp.document_path,p.policy_epoch,p.tombstoned_at FROM pages p JOIN artifacts a ON a.artifact_id=p.artifact_id JOIN revision_pages rp ON rp.revision_id=a.active_revision_id AND rp.page_id=p.page_id WHERE p.artifact_id=? AND p.tombstoned_at IS NULL ORDER BY p.page_id').bind(command.artifactId))
  const target = revisionId === null ? [] : await all<ExistingPage>(db.prepare('SELECT p.page_id,rp.document_path,p.policy_epoch,p.tombstoned_at FROM revision_pages rp JOIN pages p ON p.page_id=rp.page_id WHERE rp.revision_id=? AND p.artifact_id=? ORDER BY p.page_id').bind(revisionId, command.artifactId))
  if (prior) return replay(deps, actor, prior, action, requestDigest, command.artifactId)
  if (revisionId !== null) await verifyRevision(deps, command.artifactId, revisionId)
  const targetIds = new Set(target.map(p => p.page_id))
  const dropped = current.filter(p => !targetIds.has(p.page_id))
  const result = receipt(command.artifactId, revisionId, command.expectedContentVersion + 1, target)
  const guards: GuardRequest[] = [...target.map(p => ({ action: p.tombstoned_at === null ? 'publish' as const : 'restore_page' as const, pageId: p.page_id, artifactId: command.artifactId, revisionId: revisionId!, expectedPolicyEpoch: p.policy_epoch, expectedContentVersion: command.expectedContentVersion, requestDigest, occurredAt: at })), ...dropped.map(p => ({ action: 'unpublish' as const, pageId: p.page_id, artifactId: command.artifactId, revisionId: revisionId ?? undefined, expectedPolicyEpoch: p.policy_epoch, expectedContentVersion: command.expectedContentVersion, requestDigest, occurredAt: at }))]
  if (!guards.length) throw new PolicyError('invalid_state')
  const effects: D1PreparedStatement[] = [eventStatement(deps, actor, { action, sessionId: null, key: command.idempotencyKey, artifactId: command.artifactId, revisionId, digest: requestDigest, at, result, pageIds: guards.map(g => g.pageId!), expectedVersion: command.expectedContentVersion })]
  for (const p of dropped) effects.push(...retirePageStatements(deps, actor, { pageId: p.page_id, at }))
  if (revisionId === null) effects.push(db.prepare('DELETE FROM mounts WHERE artifact_id=?').bind(command.artifactId))
  else {
    effects.push(...mountStatements(deps, command.artifactId, revisionId))
    for (const p of target.filter(p => p.tombstoned_at !== null)) effects.push(...restorePageStatements(db, { pageId: p.page_id, revisionId, at }))
  }
  try {
    await executeGuarded(deps, actor, guards, effects, undefined, [activation(deps, command.artifactId, revisionId)])
  } catch (error) {
    const concurrent = await db.prepare('SELECT action,request_digest,receipt_json FROM publication_events WHERE instance_id=? AND actor_principal_id=? AND idempotency_key=?').bind(deps.config.instanceId, actor.principalId, command.idempotencyKey).first<Event>()
    if (concurrent) return replay(deps, actor, concurrent, action, requestDigest, command.artifactId)
    throw error
  }
  return result
}
export function restore(deps: PublicationDeps, actor: ManageActor, command: RestoreCommand): Promise<PublicationReceipt> {
  return promote(deps, actor, command, command.revisionId)
}
export function unpublish(deps: PublicationDeps, actor: ManageActor, command: PromotionCommand): Promise<PublicationReceipt> {
  return promote(deps, actor, command, null)
}
