import type { ManageInstanceConfig } from './instance-config'
import { executeGuarded, PolicyError, type GuardAction, type GuardRequest } from './guard'
import { requireManageActor, type ManageActor } from './principals'
import type { JwksSource } from './identity'
import { newId } from './ids'
import { isShareKey, mintShareKey, sealShareKey, shareKeyDigests, unsealShareKey } from './share-secrets'
import { isValidAliasDestination, isValidAliasPath } from './alias-validation'
export { readPagePolicy } from './read'

export interface ManageDeps { readonly db: D1Database; readonly config: ManageInstanceConfig; readonly jwks: JwksSource; readonly now: () => number }
export interface PageTarget { readonly pageId: string; readonly artifactId: string; readonly expectedPolicyEpoch: number }
export type GrantMode = { readonly mode: 'follow_active' } | { readonly mode: 'pinned'; readonly revisionId: string }
export interface ShareResult { readonly grantId: string; readonly key: string | null; readonly mode: 'follow_active' | 'pinned'; readonly revealable: boolean; readonly policyEpoch: number }
export interface PagePolicyView {
  readonly pageId: string; readonly artifactId: string
  readonly visibility: 'private' | 'shared' | 'public'; readonly policyEpoch: number; readonly contentVersion: number
  readonly grant: { readonly grantId: string; readonly mode: 'follow_active' | 'pinned'; readonly revisionId: string | null; readonly revealable: boolean } | null
}

type ExistingGrant = { grant_id: string; mode: 'follow_active' | 'pinned'; pinned_revision_id: string | null; sealed_key: string | null; seal_kid: string | null }

// Stable serialization excludes the share secret rather than hashing a guessable legacy key.
function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null'
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  const obj = value as Record<string, unknown>
  return `{${Object.keys(obj).filter(k => obj[k] !== undefined).sort().map(k => `${JSON.stringify(k)}:${canonical(obj[k])}`).join(',')}}`
}
async function digest(value: unknown): Promise<string> {
  const bytes = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical(value))))
  return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('')
}
async function input(deps: ManageDeps, action: GuardAction, cmd: object, extra: Partial<GuardRequest> = {}): Promise<GuardRequest> {
  const digestCommand = action === 'import_share' ? Object.fromEntries(Object.entries(cmd).filter(([key]) => key !== 'key')) : cmd
  return { action, requestDigest: await digest({ action, ...digestCommand }), occurredAt: deps.now(), ...extra }
}
function target(p: PageTarget): Partial<GuardRequest> { return { pageId: p.pageId, artifactId: p.artifactId, expectedPolicyEpoch: p.expectedPolicyEpoch } }
async function run(deps: ManageDeps, actor: ManageActor, guard: GuardRequest, effects: readonly D1PreparedStatement[]): Promise<readonly D1Result[]> {
  return executeGuarded(deps, actor, [guard], effects)
}
function revoke(db: D1Database, pageId: string, at: number, by: string, reason: string): D1PreparedStatement {
  return db.prepare('UPDATE share_grants SET revoked_at = ?, revoked_by = ?, revoked_reason = ?, sealed_key = NULL, seal_kid = NULL WHERE page_id = ? AND revoked_at IS NULL').bind(at, by, reason, pageId)
}
function updatePage(db: D1Database, pageId: string, visibility: string): D1PreparedStatement {
  return db.prepare('UPDATE pages SET visibility = ?, policy_epoch = policy_epoch + 1 WHERE page_id = ?').bind(visibility, pageId)
}
async function currentGrant(deps: ManageDeps, pageId: string): Promise<ExistingGrant | null> {
  try { return await deps.db.prepare('SELECT grant_id, mode, pinned_revision_id, sealed_key, seal_kid FROM share_grants WHERE page_id = ? AND revoked_at IS NULL').bind(pageId).first<ExistingGrant>() }
  catch { throw new PolicyError('unavailable') }
}
async function newGrant(deps: ManageDeps, pageId: string, key: string, mode: GrantMode, at: number, actor: string, origin: 'minted' | 'imported') {
  const grantId = newId('gr')
  const [digest] = await shareKeyDigests(deps.config.shareVerifierKeys.slice(0, 1), deps.config.instanceId, key)
  const seal = deps.config.shareSealKey
  const sealed = seal ? await sealShareKey(seal, deps.config.instanceId, pageId, grantId, key) : null
  const statement = deps.db.prepare(`INSERT INTO share_grants (grant_id,page_id,key_kid,key_hmac,mode,pinned_revision_id,origin,sealed_key,seal_kid,created_at,created_by) VALUES (?,?,?,?,?,?,?,?,?,?,?)`).bind(grantId, pageId, digest.kid, digest.hmac, mode.mode, mode.mode === 'pinned' ? mode.revisionId : null, origin, sealed, seal?.kid ?? null, at, actor)
  return { grantId, statement, revealable: sealed !== null }
}

export async function setVisibility(deps: ManageDeps, actor: ManageActor, cmd: PageTarget & { readonly visibility: 'private' | 'public' }): Promise<{ readonly policyEpoch: number }> {
  requireManageActor(actor, deps)
  const g = await input(deps, 'set_visibility', cmd, target(cmd))
  await run(deps, actor, g, [revoke(deps.db, cmd.pageId, g.occurredAt, actor.principalId, 'visibility'), updatePage(deps.db, cmd.pageId, cmd.visibility)])
  return { policyEpoch: cmd.expectedPolicyEpoch + 1 }
}
export async function share(deps: ManageDeps, actor: ManageActor, cmd: PageTarget & GrantMode): Promise<ShareResult> {
  requireManageActor(actor, deps)
  const existing = await currentGrant(deps, cmd.pageId)
  const g = await input(deps, 'share', cmd, { ...target(cmd), revisionId: !existing && cmd.mode === 'pinned' ? cmd.revisionId : undefined })
  if (existing) {
    await run(deps, actor, g, [])
    return { grantId: existing.grant_id, key: null, mode: existing.mode, revealable: existing.sealed_key !== null, policyEpoch: cmd.expectedPolicyEpoch }
  }
  const key = mintShareKey()
  const created = await newGrant(deps, cmd.pageId, key, cmd, g.occurredAt, actor.principalId, 'minted')
  await run(deps, actor, g, [created.statement, updatePage(deps.db, cmd.pageId, 'shared')])
  return { grantId: created.grantId, key, mode: cmd.mode, revealable: created.revealable, policyEpoch: cmd.expectedPolicyEpoch + 1 }
}
export async function rotateShare(deps: ManageDeps, actor: ManageActor, cmd: PageTarget & { readonly grantId: string; readonly next?: GrantMode }): Promise<ShareResult> {
  requireManageActor(actor, deps)
  const existing = await currentGrant(deps, cmd.pageId)
  const mode: GrantMode = cmd.next ?? (existing?.mode === 'pinned' && existing.pinned_revision_id ? { mode: 'pinned', revisionId: existing.pinned_revision_id } : { mode: 'follow_active' })
  const g = await input(deps, 'rotate_share', cmd, { ...target(cmd), grantId: cmd.grantId, revisionId: mode.mode === 'pinned' ? mode.revisionId : undefined })
  const key = mintShareKey()
  const created = await newGrant(deps, cmd.pageId, key, mode, g.occurredAt, actor.principalId, 'minted')
  await run(deps, actor, g, [revoke(deps.db, cmd.pageId, g.occurredAt, actor.principalId, 'rotated'), created.statement, updatePage(deps.db, cmd.pageId, 'shared')])
  return { grantId: created.grantId, key, mode: mode.mode, revealable: created.revealable, policyEpoch: cmd.expectedPolicyEpoch + 1 }
}
export async function revokeShare(deps: ManageDeps, actor: ManageActor, cmd: PageTarget & { readonly grantId: string }): Promise<{ readonly policyEpoch: number }> {
  requireManageActor(actor, deps)
  const g = await input(deps, 'revoke_share', cmd, { ...target(cmd), grantId: cmd.grantId })
  await run(deps, actor, g, [revoke(deps.db, cmd.pageId, g.occurredAt, actor.principalId, 'revoked'), updatePage(deps.db, cmd.pageId, 'private')])
  return { policyEpoch: cmd.expectedPolicyEpoch + 1 }
}
export async function revealShare(deps: ManageDeps, actor: ManageActor, cmd: PageTarget & { readonly grantId: string }): Promise<{ readonly key: string }> {
  requireManageActor(actor, deps)
  const g = await input(deps, 'reveal_share', cmd, { ...target(cmd), grantId: cmd.grantId })
  const results = await run(deps, actor, g, [deps.db.prepare('SELECT sealed_key, seal_kid FROM share_grants WHERE grant_id = ? AND page_id = ? AND revoked_at IS NULL').bind(cmd.grantId, cmd.pageId)])
  const row = results[1]?.results?.[0] as { sealed_key: string | null; seal_kid: string | null } | undefined
  const seal = deps.config.shareSealKey
  if (!row?.sealed_key || !seal || row.seal_kid !== seal.kid) throw new PolicyError('invalid_state')
  try { return { key: await unsealShareKey(seal, deps.config.instanceId, cmd.pageId, cmd.grantId, row.sealed_key) } }
  catch { throw new PolicyError('invalid_state') }
}
export async function importShare(deps: ManageDeps, actor: ManageActor, cmd: PageTarget & { readonly key: string; readonly mode: 'follow_active' }): Promise<{ readonly grantId: string; readonly policyEpoch: number }> {
  requireManageActor(actor, deps)
  if (!isShareKey(cmd.key)) throw new PolicyError('invalid_state')
  const g = await input(deps, 'import_share', cmd, target(cmd))
  const created = await newGrant(deps, cmd.pageId, cmd.key, cmd, g.occurredAt, actor.principalId, 'imported')
  await run(deps, actor, g, [created.statement, updatePage(deps.db, cmd.pageId, 'shared')])
  return { grantId: created.grantId, policyEpoch: cmd.expectedPolicyEpoch + 1 }
}
export async function setAlias(deps: ManageDeps, actor: ManageActor, cmd: { readonly op: 'put'; readonly kind: 'redirect_exact' | 'redirect_prefix'; readonly key: string; readonly to: string; readonly status: 301 | 302 | 307 | 308; readonly targetPageId: string | null } | { readonly op: 'remove'; readonly kind: 'redirect_exact' | 'redirect_prefix'; readonly key: string }): Promise<void> {
  requireManageActor(actor, deps)
  if ((cmd.op !== 'put' && cmd.op !== 'remove') || (cmd.kind !== 'redirect_exact' && cmd.kind !== 'redirect_prefix') || !isValidAliasPath(cmd.key) || (cmd.kind === 'redirect_prefix' && !cmd.key.endsWith('/'))) throw new PolicyError('invalid_state')
  if (cmd.op === 'put' && (!isValidAliasDestination(cmd.to) || ![301, 302, 307, 308].includes(cmd.status))) throw new PolicyError('invalid_state')
  const g = await input(deps, 'set_alias', cmd, { pageId: cmd.op === 'put' ? cmd.targetPageId ?? undefined : undefined })
  const effect = cmd.op === 'put' ? deps.db.prepare('INSERT INTO routes (kind,route_key,redirect_to,redirect_status,target_page_id,created_at) VALUES (?,?,?,?,?,?)').bind(cmd.kind, cmd.key, cmd.to, cmd.status, cmd.targetPageId, g.occurredAt) : deps.db.prepare("DELETE FROM routes WHERE kind = ? AND route_key = ? AND kind IN ('redirect_exact', 'redirect_prefix')").bind(cmd.kind, cmd.key)
  await run(deps, actor, g, [effect])
}
export async function assignRole(deps: ManageDeps, actor: ManageActor, cmd: { readonly targetPrincipalId: string; readonly expectedTargetAuthorityEpoch: number; readonly role: 'publisher' | 'admin'; readonly scope: { readonly kind: 'installation' } | { readonly kind: 'page'; readonly pageId: string } }): Promise<{ readonly roleGrantId: string }> {
  requireManageActor(actor, deps)
  if (!cmd.scope || (cmd.role !== 'admin' && cmd.role !== 'publisher') || (cmd.scope.kind !== 'installation' && cmd.scope.kind !== 'page') || (cmd.scope.kind === 'page' && (cmd.role === 'admin' || typeof cmd.scope.pageId !== 'string' || cmd.scope.pageId.length > 128))) throw new PolicyError('invalid_state')
  const g = await input(deps, 'assign_role', cmd, { targetPrincipalId: cmd.targetPrincipalId, expectedTargetAuthorityEpoch: cmd.expectedTargetAuthorityEpoch, pageId: cmd.scope.kind === 'page' ? cmd.scope.pageId : undefined })
  const roleGrantId = newId('rg')
  await run(deps, actor, g, [deps.db.prepare('INSERT INTO role_grants (role_grant_id,principal_id,role,scope_kind,scope_page_id,origin,granted_at,granted_by) VALUES (?,?,?,?,?,\'granted\',?,?)').bind(roleGrantId, cmd.targetPrincipalId, cmd.role, cmd.scope.kind, cmd.scope.kind === 'page' ? cmd.scope.pageId : null, g.occurredAt, actor.principalId), deps.db.prepare('UPDATE principals SET authority_epoch = authority_epoch + 1 WHERE principal_id = ?').bind(cmd.targetPrincipalId)])
  return { roleGrantId }
}
export async function revokeRole(deps: ManageDeps, actor: ManageActor, cmd: { readonly targetPrincipalId: string; readonly expectedTargetAuthorityEpoch: number; readonly roleGrantId: string }): Promise<void> {
  requireManageActor(actor, deps)
  const g = await input(deps, 'revoke_role', cmd, { targetPrincipalId: cmd.targetPrincipalId, expectedTargetAuthorityEpoch: cmd.expectedTargetAuthorityEpoch, roleGrantId: cmd.roleGrantId })
  await run(deps, actor, g, [deps.db.prepare('UPDATE role_grants SET revoked_at = ?, revoked_by = ? WHERE role_grant_id = ?').bind(g.occurredAt, actor.principalId, cmd.roleGrantId), deps.db.prepare('UPDATE principals SET authority_epoch = authority_epoch + 1 WHERE principal_id = ?').bind(cmd.targetPrincipalId)])
}
export async function disablePrincipal(deps: ManageDeps, actor: ManageActor, cmd: { readonly targetPrincipalId: string; readonly expectedTargetAuthorityEpoch: number }): Promise<void> {
  requireManageActor(actor, deps)
  const g = await input(deps, 'disable_principal', cmd, { targetPrincipalId: cmd.targetPrincipalId, expectedTargetAuthorityEpoch: cmd.expectedTargetAuthorityEpoch })
  await run(deps, actor, g, [deps.db.prepare("UPDATE principals SET status = 'disabled', disabled_at = ?, authority_epoch = authority_epoch + 1 WHERE principal_id = ?").bind(g.occurredAt, cmd.targetPrincipalId)])
}
export function claimPageStatements(db: D1Database, p: { readonly pageId: string; readonly artifactId: string; readonly route: { readonly kind: 'subtree'; readonly slug: string } | { readonly kind: 'tree_page'; readonly pageRef: string }; readonly actorPrincipalId: string | null; readonly at: number }): readonly D1PreparedStatement[] {
  const key = p.route.kind === 'subtree' ? p.route.slug : p.route.pageRef
  const documentPath = p.route.kind === 'subtree' ? `/a/${key}/index.html` : `/${key}`
  return [db.prepare('INSERT INTO pages (page_id,artifact_id,created_at,created_by) VALUES (?,?,?,?)').bind(p.pageId, p.artifactId, p.at, p.actorPrincipalId), db.prepare("INSERT INTO routes (kind,route_key,page_id,artifact_id,document_path,document_kind,created_at) VALUES (?,?,?,?,?,'document',?)").bind(p.route.kind, key, p.pageId, p.artifactId, documentPath, p.at)]
}
export function retirePageStatements(db: D1Database, p: { readonly pageId: string; readonly actorPrincipalId: string; readonly at: number }): readonly D1PreparedStatement[] {
  return [db.prepare('UPDATE pages SET tombstoned_at = ?, tombstoned_by = ?, policy_epoch = policy_epoch + 1 WHERE page_id = ?').bind(p.at, p.actorPrincipalId, p.pageId), revoke(db, p.pageId, p.at, p.actorPrincipalId, 'unpublished'), db.prepare("DELETE FROM routes WHERE page_id = ? AND kind IN ('subtree','tree_page')").bind(p.pageId)]
}
export function restorePageStatements(db: D1Database, p: { readonly pageId: string; readonly revisionId: string; readonly at: number }): readonly D1PreparedStatement[] {
  return [
    db.prepare("UPDATE pages SET tombstoned_at = NULL, tombstoned_by = NULL, visibility = 'private', policy_epoch = policy_epoch + 1 WHERE page_id = ?").bind(p.pageId),
    db.prepare(`INSERT INTO routes (kind, route_key, page_id, artifact_id, document_path, document_kind, created_at)
      SELECT CASE WHEN rp.document_path GLOB '/a/*' THEN 'subtree' ELSE 'tree_page' END,
        CASE WHEN rp.document_path GLOB '/a/*' THEN substr(rp.document_path, 4, length(rp.document_path) - 14) ELSE substr(rp.document_path, 2) END,
        p.page_id, p.artifact_id, rp.document_path, 'document', ?3
      FROM revision_pages rp JOIN pages p ON p.page_id = rp.page_id
      WHERE rp.revision_id = ?2 AND rp.page_id = ?1`).bind(p.pageId, p.revisionId, p.at),
  ]
}
