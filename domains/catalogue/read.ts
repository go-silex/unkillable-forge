import type { ReadInstanceConfig, ShareVerifierKey } from './instance-config'
import { isVerifiedIdentity, type VerifiedIdentity } from './identity'
import type { SubtreeOrTree } from './routing/grammar'
import { isShareKey, shareKeyDigests } from './share-secrets'
import type { ManageDeps, PagePolicyView } from './commands'
import { PolicyError } from './guard'
import { requireManageActor, type ManageActor } from './principals'
interface PinnedReadProof {
  readonly instanceId: string; readonly pageId: string; readonly revisionId: string; readonly policyEpoch: number
  readonly basis: { readonly kind: 'public' } | { readonly kind: 'team' } | { readonly kind: 'grant'; readonly grantId: string }
}

const encoder = new TextEncoder()
const decoder = new TextDecoder('utf-8', { fatal: true })

function encode(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function decode(value: string): Uint8Array<ArrayBuffer> {
  if (!/^[A-Za-z0-9_-]+$/.test(value) || value.length % 4 === 1) throw new Error('Invalid proof')
  const binary = atob(value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - value.length % 4) % 4))
  const bytes = Uint8Array.from(binary, c => c.charCodeAt(0))
  if (encode(bytes) !== value) throw new Error('Invalid proof')
  return bytes
}

async function proofKey(key: ShareVerifierKey): Promise<CryptoKey> {
  const derived = await crypto.subtle.sign('HMAC', key.key, encoder.encode('forge.pinned.key.v1'))
  return crypto.subtle.importKey('raw', derived, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify'])
}

function message(payload: Uint8Array): Uint8Array<ArrayBuffer> {
  const prefix = encoder.encode('forge.pinned.v1\0')
  const result = new Uint8Array(prefix.length + payload.length)
  result.set(prefix)
  result.set(payload, prefix.length)
  return result
}

async function mintPinnedProof(config: ReadInstanceConfig, plan: ReadPlan, nowSeconds: number): Promise<string | null> {
  const { pageId, policyEpoch, basis, grantId } = plan.authority
  if (!Number.isFinite(nowSeconds) || !Number.isFinite(nowSeconds + 900) || plan.instanceId !== config.instanceId || !pageId || policyEpoch === null || !Number.isSafeInteger(policyEpoch) || policyEpoch < 0 ||
      (plan.resource.kind !== 'document' && plan.resource.kind !== 'subdocument')) return null
  const b = basis === 'public' || basis === 'team' ? basis : basis === 'share_key' || basis === 'share_cookie' ? 'grant' : null
  if (!b || (b === 'grant' && !grantId) || !config.shareVerifierKeys[0]) return null
  const key = config.shareVerifierKeys[0]
  const payload = encoder.encode(JSON.stringify({ v: 1, i: config.instanceId, p: pageId, r: plan.revisionId, e: policyEpoch, b, g: b === 'grant' ? grantId : null, x: nowSeconds + 900 }))
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', await proofKey(key), message(payload)))
  const token = `v1.${key.kid}.${encode(payload)}.${encode(mac)}`
  return token.length <= 1024 ? token : null
}

async function verifyPinnedProof(config: ReadInstanceConfig, token: string, nowSeconds: number): Promise<PinnedReadProof | null> {
  try {
    if (typeof token !== 'string' || token.length > 1024) return null
    const parts = token.split('.')
    if (parts.length !== 4 || parts[0] !== 'v1' || !/^[a-z0-9]{1,16}$/.test(parts[1])) return null
    const key = config.shareVerifierKeys.find(candidate => candidate.kid === parts[1])
    if (!key) return null
    const payload = decode(parts[2]), mac = decode(parts[3])
    if (mac.length !== 32 || !await crypto.subtle.verify('HMAC', await proofKey(key), mac, message(payload))) return null
    const text = decoder.decode(payload)
    const value: unknown = JSON.parse(text)
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null
    const p = value as Record<string, unknown>
    if (p.v !== 1 || typeof p.i !== 'string' || !p.i || typeof p.p !== 'string' || !p.p ||
        typeof p.r !== 'string' || !p.r || !Number.isSafeInteger(p.e) || (p.e as number) < 0 ||
        (p.b !== 'public' && p.b !== 'team' && p.b !== 'grant') ||
        (p.b === 'grant' ? typeof p.g !== 'string' || !p.g : p.g !== null) ||
        typeof p.x !== 'number' || !Number.isFinite(p.x) || !Number.isFinite(nowSeconds) || nowSeconds >= p.x ||
        text !== JSON.stringify({ v: p.v, i: p.i, p: p.p, r: p.r, e: p.e, b: p.b, g: p.g, x: p.x })) return null
    return { instanceId: p.i, pageId: p.p, revisionId: p.r, policyEpoch: p.e as number,
      basis: p.b === 'grant' ? { kind: 'grant', grantId: p.g as string } : { kind: p.b } }
  } catch { return null }
}

export type ReadSubject =
  | { readonly kind: 'page'; readonly route: SubtreeOrTree; readonly candidates: readonly string[]; readonly fragmentPath: string | null }
  | { readonly kind: 'resource'; readonly path: string }
  | { readonly kind: 'share'; readonly route: SubtreeOrTree; readonly candidates: readonly string[] }
  | { readonly kind: 'card'; readonly targets: readonly { readonly route: SubtreeOrTree; readonly path: string }[] }
  | { readonly kind: 'pinned'; readonly pageId: string; readonly revisionId: string; readonly path: string }
export interface ReadCredentials {
  readonly team: VerifiedIdentity | null
  readonly shareKey: string | null
  readonly shareCookie: { readonly pageRef: string; readonly key: string } | null
  readonly pinnedProof: string | null
  readonly nowSeconds: number
}
type ResourceKind = 'document' | 'subdocument' | 'fragment' | 'asset'
export interface ReadPlan {
  readonly instanceId: string; readonly artifactId: string; readonly revisionId: string
  readonly resource: { readonly path: string; readonly kind: ResourceKind; readonly objectKey: string; readonly sha256: string; readonly size: number; readonly contentType: string }
  readonly requestedPath: string | null
  readonly authority: { readonly basis: 'team' | 'public' | 'public_owner' | 'share_key' | 'share_cookie' | 'pinned'; readonly pageId: string | null; readonly grantId: string | null; readonly policyEpoch: number | null }
  readonly pinnedProof: string | null
  readonly cache: 'no-store'
}
export type ReadDecision =
  | { readonly kind: 'allow'; readonly plan: ReadPlan }
  | { readonly kind: 'deny'; readonly reason: 'not_found' | 'login_required' | 'instance_mismatch' | 'unavailable' }
  | { readonly kind: 'alias'; readonly status: 301 | 302 | 307 | 308; readonly location: string }

type Row = Record<string, any>
const deny = (reason: 'not_found' | 'login_required' | 'instance_mismatch' | 'unavailable'): ReadDecision => ({ kind: 'deny', reason })
const instanceStatement = (db: D1Database) => db.prepare('SELECT instance_id FROM instance_meta WHERE singleton = 1')
const instanceMatches = (results: D1Result[], instanceId: string) => (results[0].results[0] as Row | undefined)?.instance_id === instanceId

export async function checkReadInstance(db: D1Database, config: ReadInstanceConfig): Promise<ReadDecision | null> {
  try {
    const results = await db.batch([instanceStatement(db)])
    return instanceMatches(results, config.instanceId) ? null : deny('instance_mismatch')
  } catch { return deny('unavailable') }
}

const R1 = `SELECT p.page_id, p.artifact_id, p.visibility, p.policy_epoch, a.active_revision_id,
 gk.grant_id AS key_grant_id, gk.mode AS key_grant_mode, gk.pinned_revision_id AS key_grant_revision_id,
 gc.grant_id AS cookie_grant_id, rr.revision_id AS resource_revision_id, rr.path, rr.kind, rr.object_key, rr.sha256, rr.size, rr.content_type
 FROM routes r JOIN pages p ON p.page_id = r.page_id AND p.tombstoned_at IS NULL
 JOIN artifacts a ON a.artifact_id = p.artifact_id AND a.active_revision_id IS NOT NULL
 LEFT JOIN share_grants gk ON gk.page_id = p.page_id AND gk.revoked_at IS NULL
 AND ((gk.key_kid = ?3 AND gk.key_hmac = ?4) OR (gk.key_kid = ?5 AND gk.key_hmac = ?6))
 LEFT JOIN share_grants gc ON gc.page_id = p.page_id AND gc.revoked_at IS NULL AND gc.mode = 'follow_active'
 AND r.kind = 'tree_page' AND r.route_key = ?7
 AND ((gc.key_kid = ?8 AND gc.key_hmac = ?9) OR (gc.key_kid = ?10 AND gc.key_hmac = ?11))
 LEFT JOIN revision_resources rr ON rr.revision_id IN (a.active_revision_id, gk.pinned_revision_id) AND rr.path IN (?12, ?13, ?14)
 AND (rr.revision_id <> a.active_revision_id OR EXISTS (SELECT 1 FROM mounts m WHERE m.path = rr.path AND m.artifact_id = p.artifact_id AND m.revision_id = rr.revision_id AND m.kind = rr.kind))
 AND EXISTS (SELECT 1 FROM revision_pages rp WHERE rp.revision_id = rr.revision_id AND rp.page_id = p.page_id)
 AND (
   (rr.kind = 'document' AND EXISTS (SELECT 1 FROM revision_pages rp WHERE rp.revision_id = rr.revision_id AND rp.page_id = p.page_id AND rp.document_path = rr.path))
   OR (rr.kind <> 'document' AND r.kind = 'subtree' AND substr(rr.path, 1, length('/a/' || r.route_key || '/')) = '/a/' || r.route_key || '/')
   OR (r.kind = 'tree_page' AND rr.kind IN ('fragment', 'asset') AND EXISTS (SELECT 1 FROM resource_owners o WHERE o.owner_revision_id = rr.revision_id AND o.owner_page_id = p.page_id AND o.path = rr.path AND o.provider_artifact_id = p.artifact_id))
 )
 WHERE r.kind = ?1 AND r.route_key = ?2`
const R2 = `SELECT m.path, m.kind, m.artifact_id, m.revision_id, rr.object_key, rr.sha256, rr.size, rr.content_type,
 (SELECT o.owner_page_id FROM resource_owners o JOIN pages op ON op.page_id = o.owner_page_id AND op.tombstoned_at IS NULL AND op.visibility = 'public'
 JOIN artifacts oa ON oa.artifact_id = op.artifact_id AND oa.active_revision_id = o.owner_revision_id WHERE o.path = m.path AND o.provider_artifact_id = m.artifact_id LIMIT 1) AS public_owner_page_id,
 (SELECT g.grant_id FROM resource_owners o JOIN pages op ON op.page_id = o.owner_page_id AND op.tombstoned_at IS NULL AND op.visibility = 'shared'
 JOIN artifacts oa ON oa.artifact_id = op.artifact_id AND oa.active_revision_id = o.owner_revision_id
 JOIN routes cr ON cr.page_id = op.page_id AND cr.kind = 'tree_page' AND cr.route_key = ?2
 JOIN share_grants g ON g.page_id = op.page_id AND g.revoked_at IS NULL AND g.mode = 'follow_active'
 AND ((g.key_kid = ?3 AND g.key_hmac = ?4) OR (g.key_kid = ?5 AND g.key_hmac = ?6)) WHERE o.path = m.path AND o.provider_artifact_id = m.artifact_id LIMIT 1) AS cookie_grant_id
 FROM mounts m JOIN artifacts a ON a.artifact_id = m.artifact_id AND a.active_revision_id = m.revision_id
 JOIN revision_resources rr ON rr.revision_id = m.revision_id AND rr.path = m.path AND rr.kind = m.kind
 WHERE m.path = ?1 AND m.kind IN ('fragment', 'asset')`
const R3 = `SELECT r.kind, r.route_key, r.redirect_to, r.redirect_status, r.target_page_id,
 (tp.page_id IS NOT NULL AND tp.tombstoned_at IS NULL) AS target_live FROM routes r LEFT JOIN pages tp ON tp.page_id = r.target_page_id
 WHERE (r.kind = 'redirect_exact' AND r.route_key = ?1) OR (r.kind = 'redirect_prefix' AND substr(?1, 1, length(r.route_key)) = r.route_key)
 ORDER BY (r.kind = 'redirect_exact') DESC, length(r.route_key) DESC LIMIT 1`
const R4 = `SELECT p.page_id, p.artifact_id, p.visibility, p.policy_epoch, a.active_revision_id, r.kind AS route_kind, r.route_key, r.document_path,
 EXISTS (SELECT 1 FROM revision_pages rp WHERE rp.revision_id = ?2 AND rp.page_id = p.page_id) AS page_in_revision,
 EXISTS (SELECT 1 FROM revision_pages rp WHERE rp.revision_id = ?2 AND rp.page_id = p.page_id AND rp.document_path = ?3) AS own_document,
 EXISTS (SELECT 1 FROM resource_owners o WHERE o.owner_revision_id = ?2 AND o.owner_page_id = p.page_id AND o.path = ?3 AND o.provider_artifact_id = coalesce(m.artifact_id, p.artifact_id)) AS owned,
 rr.path, rr.kind, rr.object_key, rr.sha256, rr.size, rr.content_type, coalesce(m.artifact_id, p.artifact_id) AS resource_artifact_id, rr.revision_id AS resource_revision_id, g.grant_id, g.mode, g.pinned_revision_id
 FROM pages p JOIN artifacts a ON a.artifact_id = p.artifact_id JOIN routes r ON r.page_id = p.page_id AND r.kind IN ('subtree', 'tree_page')
 JOIN revisions rv ON rv.revision_id = ?2 AND rv.artifact_id = p.artifact_id
 LEFT JOIN mounts m ON m.path = ?3 AND m.artifact_id <> p.artifact_id AND m.kind IN ('fragment', 'asset')
   AND EXISTS (SELECT 1 FROM artifacts ma WHERE ma.artifact_id = m.artifact_id AND ma.active_revision_id = m.revision_id)
   AND NOT EXISTS (SELECT 1 FROM revision_resources local WHERE local.revision_id = rv.revision_id AND local.path = ?3)
   AND EXISTS (SELECT 1 FROM resource_owners o WHERE o.owner_revision_id = ?2 AND o.owner_page_id = p.page_id AND o.path = ?3 AND o.provider_artifact_id = m.artifact_id)
 LEFT JOIN revision_resources rr ON rr.revision_id = coalesce(m.revision_id, rv.revision_id) AND rr.path = ?3 AND (m.path IS NULL OR rr.kind = m.kind)
 LEFT JOIN share_grants g ON g.grant_id = ?4 AND g.page_id = p.page_id AND g.revoked_at IS NULL
 WHERE p.page_id = ?1 AND p.tombstoned_at IS NULL`

function makePlan(config: ReadInstanceConfig, row: Row, revisionId: string, basis: ReadPlan['authority']['basis'], pageId: string | null, grantId: string | null, epoch: number | null, requestedPath: string | null): ReadDecision {
  return { kind: 'allow', plan: { instanceId: config.instanceId, artifactId: row.artifact_id, revisionId,
    resource: { path: row.path, kind: row.kind, objectKey: row.object_key, sha256: row.sha256, size: row.size, contentType: row.content_type },
    requestedPath, authority: { basis, pageId, grantId, policyEpoch: epoch }, pinnedProof: null, cache: 'no-store' } }
}

async function decideReadAuthorized(db: D1Database, config: ReadInstanceConfig, subject: ReadSubject, credentials: ReadCredentials, aliasPath: string | null): Promise<ReadDecision> {
  try {
    const digest = async (key: string | null) => key && isShareKey(key) ? shareKeyDigests(config.shareVerifierKeys, config.instanceId, key) : []
    const proof = subject.kind === 'pinned' && credentials.pinnedProof ? await verifyPinnedProof(config, credentials.pinnedProof, credentials.nowSeconds) : null
    const [key, cookie] = await Promise.all([digest(credentials.shareKey), digest(config.shareCookie ? credentials.shareCookie?.key ?? null : null)])
    const pairs = (d: readonly { readonly kid: string; readonly hmac: string }[]) => [d[0]?.kid ?? null, d[0]?.hmac ?? null, d[1]?.kid ?? null, d[1]?.hmac ?? null]
    const kp = pairs(key), cp = pairs(cookie), cookieRef = credentials.shareCookie?.pageRef ?? null
    const statements: D1PreparedStatement[] = [instanceStatement(db)]
    const add = (statement: D1PreparedStatement) => { statements.push(statement); return statements.length - 1 }
    const pageStatement = (route: SubtreeOrTree, candidates: readonly string[]) => db.prepare(R1).bind(route.kind, route.kind === 'subtree' ? route.slug : route.pageRef, ...kp, cookieRef, ...cp, candidates[0] ?? null, candidates[1] ?? null, candidates[2] ?? null)
    const resourceStatement = (path: string) => db.prepare(R2).bind(path, cookieRef, ...cp)
    let primary = -1, fragment = -1, alias = -1
    const cards: number[] = []
    if (subject.kind === 'page' || subject.kind === 'share') primary = add(pageStatement(subject.route, subject.candidates))
    if (subject.kind === 'page' && subject.fragmentPath && subject.route.kind === 'tree_page') fragment = add(resourceStatement(subject.fragmentPath))
    if (subject.kind === 'resource') primary = add(resourceStatement(subject.path))
    if (subject.kind === 'card') for (const target of subject.targets) cards.push(add(pageStatement(target.route, [target.path])))
    if (subject.kind === 'pinned') primary = add(db.prepare(R4).bind(subject.pageId, subject.revisionId, subject.path, proof?.basis.kind === 'grant' ? proof.basis.grantId : null))
    if (aliasPath !== null && (subject.kind === 'page' || subject.kind === 'resource')) alias = add(db.prepare(R3).bind(aliasPath))
    const results = await db.batch(statements)
    if (!instanceMatches(results, config.instanceId)) return deny('instance_mismatch')
    const rows = (index: number): Row[] => index < 0 ? [] : results[index].results as Row[]
    const team = isVerifiedIdentity(credentials.team) && credentials.team.surface === 'read' && credentials.team.issuer === `https://${config.accessTeamDomain}` && config.readAudiences.includes(credentials.team.audience) && Number.isFinite(credentials.nowSeconds) && credentials.nowSeconds < credentials.team.expiresAt
    const aliasDecision = (): ReadDecision | null => {
      const row = rows(alias)[0]
      if (!row || !team || (row.target_page_id !== null && !row.target_live)) return null
      return { kind: 'alias', status: row.redirect_status, location: row.redirect_to + (row.kind === 'redirect_prefix' ? aliasPath!.slice(row.route_key.length) : '') }
    }
    const mounted = (row: Row | undefined): ReadDecision | null => {
      if (!row) return null
      if (team) return makePlan(config, row, row.revision_id, 'team', null, null, null, null)
      if (row.cookie_grant_id) return makePlan(config, row, row.revision_id, 'share_cookie', null, row.cookie_grant_id, null, null)
      if (row.public_owner_page_id) return makePlan(config, row, row.revision_id, 'public_owner', row.public_owner_page_id, null, null, null)
      return deny('not_found')
    }
    const shared = (rs: Row[], candidates: readonly string[], image: boolean): ReadDecision | null => {
      const first = rs[0]
      if (!first || first.visibility !== 'shared' || !first.key_grant_id) return null
      const revision = first.key_grant_mode === 'pinned' ? first.key_grant_revision_id : first.active_revision_id
      for (const path of candidates) {
        const row = rs.find(r => r.path === path && r.resource_revision_id === revision && (!image || r.content_type.startsWith('image/')))
        if (row) return makePlan(config, row, revision, 'share_key', row.page_id, row.key_grant_id, row.policy_epoch, path)
      }
      return null
    }
    if (subject.kind === 'card') {
      for (let i = 0; i < cards.length; i++) { const decision = shared(rows(cards[i]), [subject.targets[i].path], true); if (decision) return decision }
      return deny('not_found')
    }
    if (subject.kind === 'share') return shared(rows(primary), subject.candidates, false) ?? deny('not_found')
    if (subject.kind === 'resource') return mounted(rows(primary)[0]) ?? aliasDecision() ?? deny('not_found')
    if (subject.kind === 'page') {
      const rs = rows(primary), first = rs[0]
      if (!first) return mounted(rows(fragment)[0]) ?? aliasDecision() ?? deny(team ? 'not_found' : 'login_required')
      let basis: ReadPlan['authority']['basis'], grant: string | null = null
      if (team) basis = 'team'
      else if (first.visibility === 'shared' && first.cookie_grant_id && subject.route.kind === 'tree_page') { basis = 'share_cookie'; grant = first.cookie_grant_id }
      else if (first.visibility === 'public') basis = 'public'
      else return deny(first.visibility === 'shared' && subject.route.kind === 'subtree' ? 'not_found' : 'login_required')
      for (const path of subject.candidates) {
        const row = rs.find(r => r.path === path && r.resource_revision_id === first.active_revision_id)
        if (row) return makePlan(config, row, first.active_revision_id, basis, first.page_id, grant, first.policy_epoch, path)
      }
      return deny('not_found')
    }
    const row = rows(primary)[0]
    if (!row || !row.page_in_revision || !row.path) return deny('not_found')
    const pathAllowed = row.kind === 'document'
      ? row.resource_artifact_id === row.artifact_id && !!row.own_document
      : row.route_kind === 'subtree'
        ? subject.path.startsWith(`/a/${row.route_key}/`) && row.resource_artifact_id === row.artifact_id
        : row.owned && (row.kind === 'fragment' || row.kind === 'asset')
    const matchingProof = proof && proof.instanceId === config.instanceId && proof.pageId === subject.pageId && proof.revisionId === subject.revisionId && proof.policyEpoch === row.policy_epoch ? proof : null
    const grantHolds = matchingProof?.basis.kind === 'grant' && !!row.grant_id && row.visibility === 'shared' && (row.mode === 'follow_active' || row.pinned_revision_id === subject.revisionId)
    const usableProof = matchingProof && (matchingProof.basis.kind === 'team' ? team : matchingProof.basis.kind === 'public' ? row.visibility === 'public' : grantHolds) ? matchingProof : null
    const grantValid = usableProof?.basis.kind === 'grant'
    const basisValid = !!usableProof || team || row.visibility === 'public'
    if (!pathAllowed || !basisValid || !(row.active_revision_id === subject.revisionId || usableProof)) return deny('not_found')
    return makePlan(config, { ...row, artifact_id: row.resource_artifact_id }, row.resource_revision_id, 'pinned', row.page_id, grantValid ? row.grant_id : null, row.policy_epoch, null)
  } catch { return deny('unavailable') }
}

export async function decideRead(db: D1Database, config: ReadInstanceConfig, subject: ReadSubject, credentials: ReadCredentials, aliasPath: string | null): Promise<ReadDecision> {
  try {
    const decision = await decideReadAuthorized(db, config, subject, credentials, aliasPath)
    if (decision.kind !== 'allow') return decision
    return { kind: 'allow', plan: { ...decision.plan, pinnedProof: await mintPinnedProof(config, decision.plan, credentials.nowSeconds) } }
  } catch { return deny('unavailable') }
}

function policyPrincipalStatement(db: D1Database, actor: ManageActor, pageIds: readonly string[]): D1PreparedStatement {
  return db.prepare(`SELECT p.status, p.authority_epoch,
    EXISTS (SELECT 1 FROM role_grants g WHERE g.principal_id = p.principal_id AND g.revoked_at IS NULL AND (g.role = 'admin' OR (g.role = 'publisher' AND g.scope_kind = 'installation'))) AS global_authority,
    NOT EXISTS (SELECT 1 FROM json_each(?2) j WHERE NOT EXISTS
      (SELECT 1 FROM role_grants g WHERE g.principal_id = p.principal_id AND g.revoked_at IS NULL
        AND (g.role = 'admin' OR (g.role = 'publisher' AND (g.scope_kind = 'installation' OR (g.scope_kind = 'page' AND g.scope_page_id = j.value)))))) AS page_authority
    FROM principals p WHERE p.principal_id = ?1`).bind(actor.principalId, JSON.stringify(pageIds))
}

function assertPolicyPrincipal(results: D1Result[], deps: ManageDeps, actor: ManageActor, pageCount: number): void {
  if (!instanceMatches(results, deps.config.instanceId)) throw new PolicyError('instance_mismatch')
  const principal = results[1].results[0] as Row | undefined
  if (!principal || principal.status !== 'active') throw new PolicyError('unauthenticated')
  if (principal.authority_epoch !== actor.authorityEpoch) throw new PolicyError('conflict')
  if (pageCount === 0 ? !principal.global_authority : !principal.page_authority) throw new PolicyError('forbidden')
}

export async function readPagePolicy(deps: ManageDeps, actor: ManageActor, pageId: string): Promise<PagePolicyView | null> {
  try {
    requireManageActor(actor, deps)
    const results = await deps.db.batch([
      instanceStatement(deps.db),
      policyPrincipalStatement(deps.db, actor, [pageId]),
      deps.db.prepare(`SELECT p.page_id, p.artifact_id, p.visibility, p.policy_epoch, a.content_version, g.grant_id, g.mode, g.pinned_revision_id, (g.sealed_key IS NOT NULL) AS revealable FROM pages p JOIN artifacts a ON a.artifact_id = p.artifact_id LEFT JOIN share_grants g ON g.page_id = p.page_id AND g.revoked_at IS NULL WHERE p.page_id = ?1 AND p.tombstoned_at IS NULL`).bind(pageId),
    ])
    assertPolicyPrincipal(results, deps, actor, 1)
    const row = results[2].results[0] as Row | undefined
    if (!row) return null
    return { pageId: row.page_id, artifactId: row.artifact_id, visibility: row.visibility, policyEpoch: row.policy_epoch, contentVersion: row.content_version,
      grant: row.grant_id ? { grantId: row.grant_id, mode: row.mode, revisionId: row.pinned_revision_id, revealable: !!row.revealable } : null }
  } catch (error) { if (error instanceof PolicyError) throw error; throw new PolicyError('unavailable') }
}

/** Authorize receipt reads on the primary, including pages retired by the original command. */
export async function assertReplayAuthority(deps: ManageDeps, actor: ManageActor, input: { readonly artifactId: string; readonly pageIds: readonly string[]; readonly expectedActorAuthorityEpoch: number }): Promise<void> {
  requireManageActor(actor, deps)
  if (input.expectedActorAuthorityEpoch !== actor.authorityEpoch) throw new PolicyError('conflict')
  try {
    const pages = JSON.stringify(input.pageIds)
    const results = await deps.db.batch([
      instanceStatement(deps.db),
      policyPrincipalStatement(deps.db, actor, input.pageIds),
      deps.db.prepare(`SELECT NOT EXISTS (SELECT 1 FROM json_each(?2) j WHERE NOT EXISTS
          (SELECT 1 FROM pages WHERE page_id = j.value AND artifact_id = ?1)) AS pages_exist`).bind(input.artifactId, pages),
    ])
    assertPolicyPrincipal(results, deps, actor, input.pageIds.length)
    const target = results[2].results[0] as Row | undefined
    if (!target?.pages_exist) throw new PolicyError('not_found')
  } catch (error) { if (error instanceof PolicyError) throw error; throw new PolicyError('unavailable') }
}
