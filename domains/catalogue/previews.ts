import { decideRead, type ReadCredentials, type ReadPlan } from './read'
import type { ReadInstanceConfig } from './instance-config'
import type { SubtreeOrTree } from './routing/grammar'
import { derivedObjectKey } from '../store/revision-store'
import type { DerivedDescriptor } from '../store/derived-store'
import { documentRouteOf } from './revision-paths'
import type { BeginCommand } from '../publication/types'

export interface SharedPreviewPlan {
  readonly kind: 'unfurl'
  readonly authority: ReadPlan['authority']
  readonly instanceId: string
  readonly artifactId: string
  readonly revisionId: string
  readonly pageId: string
  readonly title: string
  readonly description: string | null
  readonly image: { readonly kind: 'original'; readonly path: string; readonly sha256: string; readonly size: number; readonly contentType: string; readonly objectKey: string; readonly objectVersion: string } | { readonly kind: 'derived'; readonly descriptor: DerivedDescriptor } | null
  readonly cache: 'no-store'
}

export interface PreviewRequest {
  readonly route: SubtreeOrTree
  readonly candidates: readonly string[]
  readonly credentials: ReadCredentials
}
/** Mirror the transactional ownership rule for a proposed publication graph. */
export function importPreviewOwned(command: BeginCommand, pageId: string, path: string): boolean {
  const page = command.pages.find(p => p.pageId === pageId && p.disposition !== 'drop')
  const file = command.files.find(f => f.path === path && ['image/jpeg', 'image/png'].includes(f.contentType))
  if (!page?.documentPath || !file) return false
  const route = documentRouteOf(page.documentPath)
  return (route?.kind === 'subtree' && path.startsWith(`/a/${route.slug}/`)) ||
    command.edges.some(e => e.ownerPageId === pageId && e.path === path && (e.providerArtifactId === null || e.providerArtifactId === command.artifactId))
}

/** Select an original image only when the admitted revision owns it. */
export function importPreviewStatements(db: D1Database, pageId: string, artifactId: string, revisionId: string, path: string, assertionId: string): readonly D1PreparedStatement[] {
  return [
    db.prepare(`INSERT INTO import_assertions(assertion_id,verdict)
      SELECT ?, CASE WHEN EXISTS (
        SELECT 1 FROM pages p JOIN revision_pages rp ON rp.page_id=p.page_id AND rp.revision_id=?
        JOIN revision_resources rr ON rr.revision_id=rp.revision_id AND rr.path=? AND rr.content_type IN ('image/jpeg','image/png')
        JOIN routes r ON r.page_id=p.page_id AND r.kind IN ('subtree','tree_page')
        WHERE p.page_id=? AND p.artifact_id=? AND p.tombstoned_at IS NULL
          AND ((r.kind='subtree' AND substr(rr.path,1,length('/a/'||r.route_key||'/'))='/a/'||r.route_key||'/')
            OR EXISTS (SELECT 1 FROM resource_owners ro WHERE ro.owner_revision_id=rp.revision_id AND ro.owner_page_id=p.page_id AND ro.path=rr.path AND ro.provider_artifact_id=p.artifact_id))
      ) THEN 'ok' ELSE 'conflict' END`).bind(assertionId, revisionId, path, pageId, artifactId),
    db.prepare('INSERT OR IGNORE INTO preview_selections(page_id,revision_id,original_path) VALUES (?,?,?)').bind(pageId, revisionId, path),
    db.prepare(`INSERT INTO import_assertions(assertion_id,verdict) SELECT ?, CASE WHEN EXISTS (SELECT 1 FROM preview_selections WHERE page_id=? AND revision_id=? AND original_path=?) THEN 'ok' ELSE 'conflict' END`).bind(`${assertionId}:selection`, pageId, revisionId, path),
  ]
}


/** Resolve the document first; image selection is never an admission credential. */
export async function resolvePagePreview(db: D1Database, config: ReadInstanceConfig, input: PreviewRequest): Promise<SharedPreviewPlan | null> {
  const shared = input.credentials.shareKey !== null
  const subject = shared
    ? { kind: 'share' as const, route: input.route, candidates: input.candidates }
    : { kind: 'page' as const, route: input.route, candidates: input.candidates, fragmentPath: null }
  const decision = await decideRead(db, config, subject, input.credentials, null)
  if (decision.kind !== 'allow' || (shared && decision.plan.authority.basis !== 'share_key')) return null
  const plan = decision.plan
  const { pageId, grantId, policyEpoch, basis } = plan.authority
  if (!pageId || policyEpoch === null || !['team', 'public', 'share_key', 'share_cookie'].includes(basis)) return null
  if ((basis === 'share_key' || basis === 'share_cookie') && !grantId) return null
  const base = input.route.kind === 'subtree'
    ? `/a/${input.route.slug}/og`
    : `/${input.route.pageRef.slice(0, -5)}.og`
  const indexBase = input.route.kind === 'tree_page' && (input.route.pageRef === 'index.html' || input.route.pageRef.endsWith('/index.html'))
    ? `/${input.route.pageRef.slice(0, -'index.html'.length)}og`
    : null
  const imagePaths = [indexBase, base].filter((value): value is string => value !== null)
    .flatMap(value => ['jpg', 'jpeg', 'png'].map(extension => `${value}.${extension}`))
  const row = await db.prepare(`SELECT rp.metadata_json, rr.path AS original_path, rr.sha256 AS original_sha256,
      rr.size AS original_size, rr.content_type AS original_content_type, rr.object_key AS original_object_key,
      rr.object_version AS original_object_version, s.recipe_sha256, s.input_sha256, s.content_sha256, s.extension,
      o.size AS derived_size, o.object_version AS derived_version
    FROM instance_meta i JOIN pages p ON p.page_id = ?2 AND p.artifact_id = ?3
      AND p.tombstoned_at IS NULL AND p.policy_epoch = ?5
    JOIN routes r ON r.page_id = p.page_id AND r.kind = ?8 AND r.route_key = ?9
    JOIN artifacts a ON a.artifact_id = p.artifact_id
    LEFT JOIN share_grants g ON g.grant_id = ?6 AND g.page_id = p.page_id AND g.revoked_at IS NULL
    JOIN revision_pages rp ON rp.page_id = p.page_id AND rp.revision_id = ?4
    LEFT JOIN preview_selections s ON s.page_id = rp.page_id AND s.revision_id = rp.revision_id
    LEFT JOIN revision_resources rr ON rr.revision_id = rp.revision_id AND rr.path = (
      SELECT candidate.path FROM revision_resources candidate
      WHERE candidate.revision_id = rp.revision_id
        AND (candidate.path IN (SELECT value FROM json_each(?10)) OR candidate.path = s.original_path)
        AND candidate.content_type IN ('image/jpeg','image/png')
        AND ((r.kind = 'subtree' AND substr(candidate.path, 1, length('/a/' || r.route_key || '/')) = '/a/' || r.route_key || '/')
          OR EXISTS (SELECT 1 FROM resource_owners ro WHERE ro.owner_revision_id = rp.revision_id AND ro.owner_page_id = rp.page_id AND ro.path = candidate.path AND ro.provider_artifact_id = p.artifact_id))
      ORDER BY CASE WHEN candidate.path = s.original_path THEN -1 ELSE coalesce((SELECT CAST(key AS INTEGER) FROM json_each(?10) WHERE value = candidate.path), 1000) END LIMIT 1)
    LEFT JOIN preview_objects o ON o.page_id = s.page_id AND o.revision_id = s.revision_id AND o.recipe_sha256 = s.recipe_sha256 AND o.input_sha256 = s.input_sha256 AND o.content_sha256 = s.content_sha256 AND o.extension = s.extension AND o.artifact_id = p.artifact_id
    WHERE i.singleton = 1 AND i.instance_id = ?1 AND NOT EXISTS (SELECT 1 FROM revision_discards d WHERE d.revision_id = rp.revision_id)
      AND ((?7 = 'team' AND a.active_revision_id = ?4)
        OR (?7 = 'public' AND p.visibility = 'public' AND a.active_revision_id = ?4)
        OR (?7 IN ('share_key','share_cookie') AND p.visibility = 'shared' AND g.grant_id IS NOT NULL
          AND ((g.mode = 'follow_active' AND a.active_revision_id = ?4) OR (?7 = 'share_key' AND g.mode = 'pinned' AND g.pinned_revision_id = ?4))))`)
    .bind(config.instanceId, pageId, plan.artifactId, plan.revisionId, policyEpoch, grantId, basis, input.route.kind, input.route.kind === 'subtree' ? input.route.slug : input.route.pageRef, JSON.stringify(imagePaths)).first<Record<string, unknown>>()
  if (!row) return null
  let metadata: unknown
  try { metadata = JSON.parse(String(row.metadata_json)) } catch { return null }
  const info = metadata && typeof metadata === 'object' && !Array.isArray(metadata)
    ? metadata as Record<string, unknown>
    : {}
  const title = typeof info.title === 'string' ? info.title : ''
  const description = typeof info.description === 'string' ? info.description : null
  let image: SharedPreviewPlan['image'] = null
  if (typeof row.original_path === 'string' && typeof row.original_sha256 === 'string' && typeof row.original_size === 'number' && typeof row.original_content_type === 'string' && typeof row.original_object_key === 'string' && typeof row.original_object_version === 'string') {
    image = { kind: 'original', path: row.original_path, sha256: row.original_sha256, size: row.original_size, contentType: row.original_content_type, objectKey: row.original_object_key, objectVersion: row.original_object_version }
  } else if (typeof row.recipe_sha256 === 'string' && typeof row.input_sha256 === 'string' && typeof row.content_sha256 === 'string' && (row.extension === 'jpg' || row.extension === 'png') && typeof row.derived_size === 'number' && typeof row.derived_version === 'string') {
    const ref: DerivedDescriptor['ref'] = { kind: 'og', artifactId: plan.artifactId, revisionId: plan.revisionId, pageId, recipeSha256: row.recipe_sha256, inputSha256: row.input_sha256, contentSha256: row.content_sha256, extension: row.extension }
    const objectKey = derivedObjectKey(config.instanceId, ref)
    image = { kind: 'derived', descriptor: { ref, objectKey, size: row.derived_size, sha256: ref.contentSha256, contentType: ref.extension === 'jpg' ? 'image/jpeg' : 'image/png', objectVersion: row.derived_version } }
  }
  return { kind: 'unfurl', authority: plan.authority, instanceId: config.instanceId, artifactId: plan.artifactId, revisionId: plan.revisionId, pageId, title, description, image, cache: 'no-store' }
}

export async function resolveSharedPreview(db: D1Database, config: ReadInstanceConfig, input: {
  readonly route: SubtreeOrTree
  readonly candidates: readonly string[]
  readonly key: string
  readonly nowSeconds: number
}): Promise<SharedPreviewPlan | null> {
  return resolvePagePreview(db, config, {
    route: input.route, candidates: input.candidates,
    credentials: { team: null, shareKey: input.key, shareCookie: null, pinnedProof: null, nowSeconds: input.nowSeconds },
  })
}
