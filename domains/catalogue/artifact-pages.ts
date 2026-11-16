import { PolicyError } from './guard'
import { documentRouteOf } from './revision-paths'
import type { SubtreeOrTree } from './routing/grammar'

export type SqlParam = `?${number}`
export interface LivePage {
  readonly pageId: string
  readonly policyEpoch: number
  readonly documentPath: string
  readonly route: SubtreeOrTree
}

/** Prepare selector, not an authorization decision. */
export function livePagesStatement(db: D1Database, artifactId: string): D1PreparedStatement {
  return db.prepare(`SELECT p.page_id, p.policy_epoch, r.kind, r.route_key, r.document_path
    FROM pages p LEFT JOIN routes r ON r.page_id = p.page_id AND r.kind IN ('subtree','tree_page')
    WHERE p.artifact_id = ? AND p.tombstoned_at IS NULL`).bind(artifactId)
}

export function livePagesFrom(result: D1Result): readonly LivePage[] {
  const pages: LivePage[] = []
  const seen = new Set<string>()
  for (const row of result.results as { page_id: string; policy_epoch: number; kind: string | null; route_key: string | null; document_path: string | null }[]) {
    const route = row.document_path === null ? null : documentRouteOf(row.document_path)
    if (!route || seen.has(row.page_id) || route.kind !== row.kind ||
        (route.kind === 'subtree' ? route.slug : route.pageRef) !== row.route_key) throw new PolicyError('invariant_violation')
    seen.add(row.page_id)
    pages.push({ pageId: row.page_id, policyEpoch: row.policy_epoch, documentPath: row.document_path!, route })
  }
  return pages
}

/** Shared Catalogue definition of a live grant; alias is an SQL identifier, never SQL text. */
export function activeGrantSql(alias: string): string {
  if (!/^[a-z][a-z0-9_]*$/.test(alias)) throw new PolicyError('invalid_state')
  return `${alias}.revoked_at IS NULL`
}

/** Embed only a numbered bind parameter, never caller-provided SQL. */
export function activePinnedGrantSql(revision: SqlParam): string {
  if (!/^\?[1-9][0-9]*$/.test(revision)) throw new PolicyError('invalid_state')
  return `EXISTS (SELECT 1 FROM share_grants g WHERE g.pinned_revision_id = ${revision} AND ${activeGrantSql('g')})`
}
