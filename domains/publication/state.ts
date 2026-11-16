import { PolicyError } from '../catalogue/guard'
import { requireManageActor, type ManageActor } from '../catalogue/principals'
import { managedAuthorityStatements, assertManagedAuthority, managedInventoryPrincipalStatements, assertManagedInventoryPrincipal, managedRevisionAuthorityStatement, decodeManagedRevisionAuthority, managedRevisionInventorySql } from '../catalogue/managed-state'
import type { ManagedPage } from '../catalogue/managed-state'
import type { PublicationDeps, ResourceKind } from './types'

export type ManifestSection = 'files' | 'pages' | 'edges'
export interface ArtifactTarget { readonly artifactId: string }
export interface StatePaging { readonly cursor?: string | null; readonly limit?: number }
export interface ManifestInput extends ArtifactTarget, StatePaging { readonly revisionId?: string | null; readonly section: ManifestSection }
export interface RevisionView { readonly revisionId: string; readonly manifestSha256: string; readonly sealedAt: number; readonly previouslyActivated: boolean; readonly retention: 'retained' | 'discarded' | 'purged'; readonly discardedAt: number | null; readonly purgedAt: number | null }
export interface ArtifactState { readonly artifactId: string; readonly activeRevisionId: string | null; readonly contentVersion: number; readonly pages: readonly ManagedPage[] }
export type ManifestItem = { readonly path: string; readonly kind: ResourceKind; readonly sha256: string; readonly size: number; readonly contentType: string } | { readonly pageId: string; readonly documentPath: string; readonly metadata: unknown } | { readonly ownerPageId: string; readonly path: string; readonly providerArtifactId: string }
export interface ManifestState { readonly artifactId: string; readonly activeRevisionId: string | null; readonly contentVersion: number; readonly revision: RevisionView; readonly section: ManifestSection; readonly items: readonly ManifestItem[]; readonly nextCursor: string | null }
export interface RevisionInventory { readonly artifactId: string; readonly activeRevisionId: string | null; readonly contentVersion: number; readonly revisions: readonly RevisionView[]; readonly nextCursor: string | null }
type ArtifactRow = { active_revision_id: string | null; content_version: number }
type RevisionRow = { revision_id: string; manifest_sha256: string; sealed_at: number; discarded_at: number | null; purged_at: number | null; committed: number }
type InventoryRow = { revisions: number; discarded: number; purged: number }
type Cursor = { v: 1; instance: string; principal: string; epoch: number; artifact: string; kind: string; selected: string | null; active: string | null; version: number; identity: string | null; policy: string; inventory: string; key: string[] }

function validateTarget(artifactId: string): void {
  if (typeof artifactId !== 'string' || !/^ar_[a-z2-7]{26}$/.test(artifactId)) throw new PolicyError('invalid_state')
}
function limitOf(limit: number | undefined): number {
  if (limit === undefined) return 50
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new PolicyError('invalid_state')
  return limit
}
function parseCursor(value: string | null | undefined): Cursor | null {
  if (value == null) return null
  if (typeof value !== 'string' || value.length > 16384) throw new PolicyError('invalid_state')
  try {
    const c = JSON.parse(value) as Cursor
    if (!c || typeof c !== 'object' || Array.isArray(c) || Object.keys(c).sort().join(',') !== 'active,artifact,epoch,identity,instance,inventory,key,kind,policy,principal,selected,v,version' || c.v !== 1 || typeof c.instance !== 'string' || typeof c.principal !== 'string' || !Number.isSafeInteger(c.epoch) || typeof c.artifact !== 'string' || typeof c.kind !== 'string' || (c.selected !== null && typeof c.selected !== 'string') || (c.active !== null && typeof c.active !== 'string') || !Number.isSafeInteger(c.version) || (c.identity !== null && typeof c.identity !== 'string') || typeof c.policy !== 'string' || typeof c.inventory !== 'string' || !Array.isArray(c.key) || c.key.length < 1 || c.key.length > 2 || c.key.some(k => typeof k !== 'string' || k.length > 1024)) throw new Error('cursor')
    return c
  } catch { throw new PolicyError('invalid_state') }
}
async function fingerprint(value: unknown): Promise<string> {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(value)))
  return Array.from(new Uint8Array(bytes), b => b.toString(16).padStart(2, '0')).join('')
}
function context(deps: PublicationDeps, actor: ManageActor, artifactId: string, kind: string, selected: string | null, artifact: ArtifactRow, identity: string | null, policy: string, inventory: string, key: string[]): Cursor {
  return { v: 1, instance: deps.config.instanceId, principal: actor.principalId, epoch: actor.authorityEpoch, artifact: artifactId, kind, selected, active: artifact.active_revision_id, version: artifact.content_version, identity, policy, inventory, key }
}
function checkCursor(cursor: Cursor | null, current: Cursor, keyLength: number): void {
  if (!cursor) return
  if (cursor.key.length !== keyLength || JSON.stringify({ ...cursor, key: [] }) !== JSON.stringify({ ...current, key: [] })) throw new PolicyError('conflict')
}
function artifactStatement(deps: PublicationDeps, artifactId: string): D1PreparedStatement {
  return deps.db.prepare('SELECT active_revision_id,content_version FROM artifacts WHERE artifact_id=?').bind(artifactId)
}
function revisionStatement(deps: PublicationDeps, artifactId: string, revisionId: string | null): D1PreparedStatement {
  return deps.db.prepare(`SELECT r.revision_id,r.manifest_sha256,r.sealed_at,d.discarded_at,d.purged_at,
    EXISTS(SELECT 1 FROM publication_events e WHERE e.action='commit' AND e.instance_id=?3 AND e.artifact_id=r.artifact_id AND e.revision_id=r.revision_id) AS committed
    FROM revisions r LEFT JOIN revision_discards d ON d.revision_id=r.revision_id
    WHERE r.artifact_id=?1 AND r.revision_id=COALESCE(?2,(SELECT active_revision_id FROM artifacts WHERE artifact_id=?1))`).bind(artifactId, revisionId, deps.config.instanceId)
}
function revisionView(row: RevisionRow): RevisionView {
  return { revisionId: row.revision_id, manifestSha256: row.manifest_sha256, sealedAt: row.sealed_at,
    previouslyActivated: !!row.committed, retention: row.purged_at !== null ? 'purged' as const : row.discarded_at !== null ? 'discarded' as const : 'retained' as const,
    discardedAt: row.discarded_at, purgedAt: row.purged_at }
}
function artifactFrom(result: D1Result): ArtifactRow {
  const row = result.results[0] as ArtifactRow | undefined
  if (!row) throw new PolicyError('not_found')
  return row
}
function wrap(error: unknown): never { if (error instanceof PolicyError) throw error; throw new PolicyError('unavailable') }

/** A primary batch authorizes and observes the active artefact in the same snapshot. */
export async function readArtifactState(deps: PublicationDeps, actor: ManageActor, input: ArtifactTarget): Promise<ArtifactState> {
  validateTarget(input.artifactId); requireManageActor(actor, deps)
  try {
    const results = await deps.db.batch([...managedAuthorityStatements(deps, actor, input.artifactId, null), artifactStatement(deps, input.artifactId)])
    const authority = assertManagedAuthority(results, deps, actor)
    const artifact = artifactFrom(results[3])
    return { artifactId: input.artifactId, activeRevisionId: artifact.active_revision_id, contentVersion: artifact.content_version, pages: authority.pages }
  } catch (error) { return wrap(error) }
}

/** Deterministic keyset pagination over immutable revision metadata, with current policy rechecked on each page. */
export async function readManifest(deps: PublicationDeps, actor: ManageActor, input: ManifestInput): Promise<ManifestState> {
  validateTarget(input.artifactId); requireManageActor(actor, deps)
  if (input.revisionId != null && !/^rv_[a-z2-7]{26}$/.test(input.revisionId)) throw new PolicyError('invalid_state')
  if (!['files', 'pages', 'edges'].includes(input.section)) throw new PolicyError('invalid_state')
  const limit = limitOf(input.limit), cursor = parseCursor(input.cursor), key = cursor?.key ?? []
  const selected = input.revisionId ?? null
  const revisionExpr = 'COALESCE(?2,(SELECT active_revision_id FROM artifacts WHERE artifact_id=?1))'
  const statements: Record<ManifestSection, string> = {
    files: `SELECT path,kind,sha256,size,content_type FROM revision_resources WHERE revision_id=${revisionExpr} AND path>?3 ORDER BY path LIMIT ?4`,
    pages: `SELECT page_id,document_path,metadata_json FROM revision_pages WHERE revision_id=${revisionExpr} AND page_id>?3 ORDER BY page_id LIMIT ?4`,
    edges: `SELECT owner_page_id,path,provider_artifact_id FROM resource_owners WHERE owner_revision_id=${revisionExpr} AND (owner_page_id>?3 OR (owner_page_id=?3 AND path>?4)) ORDER BY owner_page_id,path LIMIT ?5`,
  }
  const query = deps.db.prepare(statements[input.section])
  const entries = input.section === 'edges' ? query.bind(input.artifactId, selected, key[0] ?? '', key[1] ?? '', limit + 1) : query.bind(input.artifactId, selected, key[0] ?? '', limit + 1)
  try {
    const results = await deps.db.batch([...managedAuthorityStatements(deps, actor, input.artifactId, selected), artifactStatement(deps, input.artifactId), revisionStatement(deps, input.artifactId, selected), entries])
    const authority = assertManagedAuthority(results, deps, actor), artifact = artifactFrom(results[3])
    const revision = results[4].results[0] as RevisionRow | undefined
    if (!revision) throw new PolicyError('not_found')
    const policy = await fingerprint(authority.policyFingerprint)
    const inventory = await fingerprint([revision.discarded_at, revision.purged_at])
    const base = context(deps, actor, input.artifactId, input.section, revision.revision_id, artifact, revision.manifest_sha256, policy, inventory, [])
    checkCursor(cursor, base, input.section === 'edges' ? 2 : 1)
    if (revision.discarded_at !== null) throw new PolicyError('not_found')
    const rows = results[5].results as Record<string, unknown>[]
    const slice = rows.slice(0, limit), last = slice[slice.length - 1]
    const nextKey = last ? input.section === 'files' ? [String(last.path)] : input.section === 'pages' ? [String(last.page_id)] : [String(last.owner_page_id), String(last.path)] : []
    const items = slice.map(row => input.section === 'files' ? { path: row.path as string, kind: row.kind as ResourceKind, sha256: row.sha256 as string, size: row.size as number, contentType: row.content_type as string } : input.section === 'pages' ? { pageId: row.page_id as string, documentPath: row.document_path as string, metadata: JSON.parse(row.metadata_json as string) as unknown } : { ownerPageId: row.owner_page_id as string, path: row.path as string, providerArtifactId: row.provider_artifact_id as string })
    return { artifactId: input.artifactId, activeRevisionId: artifact.active_revision_id, contentVersion: artifact.content_version, revision: revisionView(revision), section: input.section, items, nextCursor: rows.length > limit ? JSON.stringify({ ...base, key: nextKey }) : null }
  } catch (error) { return wrap(error) }
}

/** Revision inventory never reveals a revision whose page scope is not currently authorized. */
export async function readRevisions(deps: PublicationDeps, actor: ManageActor, input: ArtifactTarget & StatePaging): Promise<RevisionInventory> {
  validateTarget(input.artifactId); requireManageActor(actor, deps)
  const limit = limitOf(input.limit), cursor = parseCursor(input.cursor)
  try {
    const results = await deps.db.batch([
      ...managedInventoryPrincipalStatements(deps, actor, input.artifactId), artifactStatement(deps, input.artifactId),
      managedRevisionAuthorityStatement(deps, actor, input.artifactId),
      deps.db.prepare(`WITH authorized AS (${managedRevisionInventorySql(deps, actor)}) SELECT count(*) AS revisions, count(d.discarded_at) AS discarded, count(d.purged_at) AS purged FROM authorized LEFT JOIN revision_discards d ON d.revision_id=authorized.revision_id`).bind(actor.principalId, null, input.artifactId),
      deps.db.prepare(`WITH authorized AS (${managedRevisionInventorySql(deps, actor)}) SELECT r.revision_id,r.manifest_sha256,r.sealed_at,d.discarded_at,d.purged_at, EXISTS(SELECT 1 FROM publication_events e WHERE e.action='commit' AND e.instance_id=?6 AND e.artifact_id=r.artifact_id AND e.revision_id=r.revision_id) AS committed FROM authorized JOIN revisions r ON r.revision_id=authorized.revision_id LEFT JOIN revision_discards d ON d.revision_id=r.revision_id WHERE r.revision_id>?4 ORDER BY r.revision_id LIMIT ?5`).bind(actor.principalId, null, input.artifactId, cursor?.key[0] ?? '', limit + 1, deps.config.instanceId),
    ])
    assertManagedInventoryPrincipal(results, deps, actor)
    const artifact = artifactFrom(results[3])
    const allowed = decodeManagedRevisionAuthority(results[4])
    const counts = results[5].results[0] as InventoryRow
    const policy = await fingerprint(allowed)
    const inventory = await fingerprint(counts)
    const base = context(deps, actor, input.artifactId, 'revisions', null, artifact, null, policy, inventory, [])
    checkCursor(cursor, base, 1)
    const rows = results[6].results as RevisionRow[], slice = rows.slice(0, limit), last = slice[slice.length - 1]
    return { artifactId: input.artifactId, activeRevisionId: artifact.active_revision_id, contentVersion: artifact.content_version, revisions: slice.map(revisionView), nextCursor: rows.length > limit && last ? JSON.stringify({ ...base, key: [last.revision_id] }) : null }
  } catch (error) { return wrap(error) }
}
