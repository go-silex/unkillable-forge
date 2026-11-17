import type { ReadInstanceConfig } from './instance-config'
import { resolvePreviewCard, type CardSelection } from './preview-cards'
import { resolveSharedPreview } from './previews'
import type { SubtreeOrTree } from './routing/grammar'
import type { ReadCredentials } from './read'

/** Resolve an exact page's route internally; the route and document never come from the URL. */
export async function resolveHttpCard(db: D1Database, config: ReadInstanceConfig, pageId: string, revisionId: string, credentials: ReadCredentials, selection: CardSelection) {
  const row = await db.prepare(`SELECT r.kind, r.route_key, rp.document_path FROM routes r
    JOIN revision_pages rp ON rp.page_id = r.page_id
    WHERE r.page_id = ?1 AND rp.revision_id = ?2 AND r.kind IN ('subtree','tree_page')`).bind(pageId, revisionId).first<{ kind: string; route_key: string; document_path: string }>()
  if (!row || (row.kind !== 'subtree' && row.kind !== 'tree_page')) return null
  const route: SubtreeOrTree = row.kind === 'subtree' ? { kind: 'subtree', slug: row.route_key } : { kind: 'tree_page', pageRef: row.route_key }
  return resolvePreviewCard(db, config, { route, candidates: [row.document_path], pageId, revisionId, selection, credentials })
}

export { resolveSharedPreview }
