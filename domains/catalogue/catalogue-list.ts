import type { ReadInstanceConfig } from './instance-config'
import { canonicalUrl } from './routing/grammar'

export interface CatalogueEntry {
  readonly pageId: string
  readonly url: string
  readonly visibility: 'private' | 'shared' | 'public' | null
  readonly metadata: unknown
}

export async function listCatalogue(db: D1Database, config: ReadInstanceConfig, viewer: 'anonymous' | 'team', page: { readonly after: string | null; readonly limit: number }): Promise<readonly CatalogueEntry[]> {
  const results = await db.batch([
    db.prepare('SELECT instance_id FROM instance_meta WHERE singleton = 1'),
    db.prepare(`SELECT p.page_id, p.visibility, r.kind, r.route_key, rp.metadata_json
      FROM pages p JOIN artifacts a ON a.artifact_id = p.artifact_id AND a.active_revision_id IS NOT NULL
      JOIN revision_pages rp ON rp.revision_id = a.active_revision_id AND rp.page_id = p.page_id
      JOIN routes r ON r.page_id = p.page_id AND r.kind IN ('subtree', 'tree_page')
      WHERE p.tombstoned_at IS NULL AND (?1 = 1 OR p.visibility = 'public') AND (?2 IS NULL OR p.page_id > ?2)
      ORDER BY p.page_id LIMIT ?3`).bind(viewer === 'team' ? 1 : 0, page.after, page.limit),
  ])
  if ((results[0].results[0] as { instance_id: string } | undefined)?.instance_id !== config.instanceId) throw new Error('instance_mismatch')
  return (results[1].results as { page_id: string; visibility: CatalogueEntry['visibility']; kind: 'subtree' | 'tree_page'; route_key: string; metadata_json: string }[]).map(row => ({
    pageId: row.page_id,
    url: canonicalUrl(row.kind === 'subtree' ? { kind: 'subtree', slug: row.route_key } : { kind: 'tree_page', pageRef: row.route_key }),
    visibility: viewer === 'team' ? row.visibility : null,
    metadata: JSON.parse(row.metadata_json),
  }))
}
