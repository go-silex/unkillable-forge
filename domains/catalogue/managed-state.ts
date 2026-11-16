import type { ManageDeps } from './commands'
import { PolicyError } from './guard'
import { requireManageActor, type ManageActor } from './principals'
import { assertPolicyPrincipal, policyPrincipalSql, policyPrincipalStatement } from './read'
import type { SubtreeOrTree } from './routing/grammar'

export interface ManagedPage {
  readonly pageId: string
  readonly artifactId: string
  readonly visibility: 'private' | 'shared' | 'public'
  readonly policyEpoch: number
  readonly tombstoned: boolean
  readonly route: SubtreeOrTree | null
}

type PageRow = { page_id: string; artifact_id: string; visibility: ManagedPage['visibility']; policy_epoch: number; tombstoned_at: number | null; route_kind: 'subtree' | 'tree_page' | null; route_key: string | null }
const pageColumns = `page.page_id, page.artifact_id, page.visibility, page.policy_epoch, page.tombstoned_at,
  CASE WHEN page.tombstoned_at IS NULL THEN route.kind END AS route_kind,
  CASE WHEN page.tombstoned_at IS NULL THEN route.route_key END AS route_key`
const pageJoin = `FROM pages page LEFT JOIN routes route ON route.page_id = page.page_id AND route.kind IN ('subtree', 'tree_page')`
function decodePage(row: PageRow): ManagedPage {
  const route = row.route_kind === 'subtree' && row.route_key !== null ? { kind: 'subtree' as const, slug: row.route_key }
    : row.route_kind === 'tree_page' && row.route_key !== null ? { kind: 'tree_page' as const, pageRef: row.route_key } : null
  return { pageId: row.page_id, artifactId: row.artifact_id, visibility: row.visibility, policyEpoch: row.policy_epoch, tombstoned: row.tombstoned_at !== null, route }
}
// Selectors are domain-owned SQL; request values remain bound parameters.
const principalSql = (selector: string) => policyPrincipalSql(`(${selector})`)
const unionSelector = (revision: string) => `SELECT COALESCE(json_group_array(page_id), '[]') FROM (
  SELECT page_id FROM pages WHERE artifact_id = ?3 AND tombstoned_at IS NULL
  UNION SELECT rp.page_id FROM revision_pages rp JOIN revisions rev ON rev.revision_id = rp.revision_id
    WHERE rev.artifact_id = ?3 AND rev.revision_id = ${revision}
)`
const instanceStatement = (db: D1Database) => db.prepare('SELECT instance_id FROM instance_meta WHERE singleton = 1')
const projection = (selector: string) => `SELECT ${pageColumns} ${pageJoin} WHERE page.page_id IN (SELECT value FROM json_each((${selector}))) ORDER BY page.page_id`

/** First three results of the same batch as Publication's projection. */
export function managedAuthorityStatements(deps: ManageDeps, actor: ManageActor, artifactId: string, revisionId: string | null): D1PreparedStatement[] {
  requireManageActor(actor, deps)
  const selector = unionSelector('COALESCE(?4, (SELECT active_revision_id FROM artifacts WHERE artifact_id = ?3))')
  return [instanceStatement(deps.db),
    deps.db.prepare(principalSql(selector)).bind(actor.principalId, null, artifactId, revisionId),
    deps.db.prepare(projection(selector)).bind(null, null, artifactId, revisionId)]
}
export function assertManagedAuthority(results: D1Result[], deps: ManageDeps, actor: ManageActor): { pages: ManagedPage[]; policyFingerprint: string } {
  requireManageActor(actor, deps)
  const pages = (results[2].results as PageRow[]).map(decodePage)
  assertPolicyPrincipal(results, deps, actor, pages.length)
  return { pages, policyFingerprint: JSON.stringify(pages) }
}
/** SQL for an authorized revision inventory, to be joined before keyset pagination.
 * Bind ?1 principal ID, ?2 unused, and ?3 artifact ID. */
export function managedRevisionInventorySql(deps: ManageDeps, actor: ManageActor): string {
  requireManageActor(actor, deps)
  const selector = unionSelector('inventory.revision_id')
  const policy = principalSql(selector)
  return `SELECT revision_id, policy_fingerprint FROM (SELECT inventory.revision_id,
    (SELECT CASE WHEN json_array_length((${selector})) = 0 THEN authority.global_authority ELSE authority.page_authority END FROM (${policy}) authority) AS allowed,
    (SELECT json_group_array(json_object('pageId', selected.page_id, 'artifactId', selected.artifact_id, 'visibility', selected.visibility,
      'policyEpoch', selected.policy_epoch, 'tombstonedAt', selected.tombstoned_at, 'routeKind', selected.route_kind, 'routeKey', selected.route_key))
      FROM (${projection(selector)}) selected) AS policy_fingerprint
    FROM revisions inventory WHERE inventory.artifact_id = ?3) WHERE allowed = 1`
}
/** Validate an inventory principal without requiring a live active revision. */
export function managedInventoryPrincipalStatements(deps: ManageDeps, actor: ManageActor, artifactId: string): D1PreparedStatement[] {
  requireManageActor(actor, deps)
  return [instanceStatement(deps.db), policyPrincipalStatement(deps.db, actor, []),
    deps.db.prepare(`SELECT revision_id FROM (${managedRevisionInventorySql(deps, actor)}) LIMIT 1`).bind(actor.principalId, null, artifactId)]
}
export function assertManagedInventoryPrincipal(results: D1Result[], deps: ManageDeps, actor: ManageActor): void {
  requireManageActor(actor, deps)
  assertPolicyPrincipal(results, deps, actor, 1)
  const principal = results[1].results[0] as { global_authority: number }
  if (!principal.global_authority && results[2].results.length === 0) throw new PolicyError('forbidden')
}
export function managedRevisionAuthorityStatement(deps: ManageDeps, actor: ManageActor, artifactId: string): D1PreparedStatement {
  return deps.db.prepare(`${managedRevisionInventorySql(deps, actor)} ORDER BY revision_id`).bind(actor.principalId, null, artifactId)
}
export function decodeManagedRevisionAuthority(result: D1Result): { revisionId: string; policyFingerprint: string }[] {
  return (result.results as { revision_id: string; policy_fingerprint: string }[])
    .map(row => ({ revisionId: row.revision_id, policyFingerprint: row.policy_fingerprint }))
}

function discoveryStatements(deps: ManageDeps, actor: ManageActor, pageId: string | null): D1PreparedStatement[] {
  requireManageActor(actor, deps)
  const policy = principalSql('SELECT json_array(page.page_id)')
  return [instanceStatement(deps.db), policyPrincipalStatement(deps.db, actor, []),
    deps.db.prepare(`SELECT ${pageColumns} ${pageJoin}
      WHERE (?3 IS NULL OR page.page_id = ?3) AND (SELECT page_authority FROM (${policy}))
      ORDER BY page.page_id`).bind(actor.principalId, null, pageId)]
}
function assertDiscovery(results: D1Result[], deps: ManageDeps, actor: ManageActor): ManagedPage[] {
  requireManageActor(actor, deps)
  // The empty selector is deliberate: discovery needs a valid principal, not global authority.
  assertPolicyPrincipal(results, deps, actor, 1)
  return (results[2].results as PageRow[]).map(decodePage)
}
function unavailable(error: unknown): never { if (error instanceof PolicyError) throw error; throw new PolicyError('unavailable') }
async function fingerprint(value: unknown): Promise<string> {
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(value)))
  return Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, '0')).join('')
}
type Cursor = { instance: string; principal: string; epoch: number; fingerprint: string; after: string }
function parseCursor(value: string): Cursor {
  try {
    if (value.length > 1024 || !/^[A-Za-z0-9_-]+$/.test(value)) throw new Error()
    const parsed = JSON.parse(atob(value.replace(/-/g, '+').replace(/_/g, '/'))) as Cursor
    if (!parsed || Object.keys(parsed).sort().join(',') !== 'after,epoch,fingerprint,instance,principal' ||
      typeof parsed.instance !== 'string' || typeof parsed.principal !== 'string' || !Number.isSafeInteger(parsed.epoch) ||
      !/^[0-9a-f]{64}$/.test(parsed.fingerprint) || !/^pg_[a-z2-7]{26}$/.test(parsed.after)) throw new Error()
    return parsed
  } catch { throw new PolicyError('invalid_state') }
}
export async function listManagedCatalogue(deps: ManageDeps, actor: ManageActor, input: { cursor?: string | null; limit?: number } = {}): Promise<{ pages: ManagedPage[]; nextCursor: string | null }> {
  const limit = input.limit ?? 50
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new PolicyError('invalid_state')
  const cursor = input.cursor == null ? null : parseCursor(input.cursor)
  try {
    const pages = assertDiscovery(await deps.db.batch(discoveryStatements(deps, actor, null)), deps, actor)
    const digest = await fingerprint(pages)
    if (cursor && (cursor.instance !== deps.config.instanceId || cursor.principal !== actor.principalId || cursor.epoch !== actor.authorityEpoch || cursor.fingerprint !== digest || !pages.some(page => page.pageId === cursor.after))) throw new PolicyError('conflict')
    const remaining = cursor ? pages.filter(page => page.pageId > cursor.after) : pages
    const slice = remaining.slice(0, limit)
    const next: Cursor | null = remaining.length > limit ? { instance: deps.config.instanceId, principal: actor.principalId, epoch: actor.authorityEpoch, fingerprint: digest, after: slice[slice.length - 1].pageId } : null
    return { pages: slice, nextCursor: next ? btoa(JSON.stringify(next)).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_') : null }
  } catch (error) { return unavailable(error) }
}
export async function getManagedPage(deps: ManageDeps, actor: ManageActor, pageId: string): Promise<ManagedPage | null> {
  try { return assertDiscovery(await deps.db.batch(discoveryStatements(deps, actor, pageId)), deps, actor)[0] ?? null }
  catch (error) { return unavailable(error) }
}
