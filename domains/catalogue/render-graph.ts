import type { ManageDeps } from './commands'
import { PolicyError } from './guard'
import { requireManageActor, type ManageActor } from './principals'
import { assertPolicyPrincipal, policyPrincipalStatement } from './read'

/** A graph is an allowlist, not a promise that arbitrary references resolve. */
export interface RenderResource {
  readonly path: string
  readonly kind: 'document' | 'subdocument' | 'fragment' | 'asset'
  readonly artifactId: string
  readonly revisionId: string
  readonly objectKey: string
  readonly objectVersion: string
  readonly sha256: string
  readonly size: number
  readonly contentType: string
}
export interface RenderGraph {
  readonly version: 1
  readonly instanceId: string
  readonly artifactId: string
  readonly revisionId: string
  readonly pageId: string
  readonly policyEpoch: number
  readonly contentVersion: number
  readonly routeKind: 'subtree' | 'tree_page'
  readonly routeKey: string
  readonly documentPath: string
  readonly recipeSha256: string
  readonly resources: readonly RenderResource[]
  readonly inputSha256: string
}
export interface RenderGraphTarget {
  readonly artifactId: string
  readonly revisionId: string
  readonly pageId: string
  readonly expectedPolicyEpoch: number
  readonly expectedContentVersion: number
  readonly recipeSha256: string
}

// Bindings ?1..?6 are the immutable target and its expected versions. Local
// resources shadow mounted providers exactly as in the pinned F05 resolver.
const graphCte = `WITH target AS (
 SELECT p.page_id,p.artifact_id,a.active_revision_id AS revision_id,p.policy_epoch,a.content_version,
   r.kind AS route_kind,r.route_key,rp.document_path
 FROM instance_meta i JOIN pages p ON p.page_id=?2 AND p.artifact_id=?3 AND p.tombstoned_at IS NULL AND p.policy_epoch=?5
 JOIN artifacts a ON a.artifact_id=p.artifact_id AND a.active_revision_id=?4 AND a.content_version=?6
 JOIN routes r ON r.page_id=p.page_id AND r.kind IN ('subtree','tree_page')
 JOIN revision_pages rp ON rp.page_id=p.page_id AND rp.revision_id=a.active_revision_id
 WHERE i.singleton=1 AND i.instance_id=?1 AND NOT EXISTS (SELECT 1 FROM revision_discards d WHERE d.revision_id=a.active_revision_id)
), paths AS (
 SELECT t.document_path AS path,t.artifact_id AS provider FROM target t
 UNION
 SELECT rr.path,t.artifact_id FROM target t JOIN revision_resources rr ON rr.revision_id=t.revision_id
 WHERE t.route_kind='subtree' AND rr.kind<>'document' AND substr(rr.path,1,length('/a/'||t.route_key||'/'))='/a/'||t.route_key||'/'
 UNION
 SELECT o.path,o.provider_artifact_id FROM target t JOIN resource_owners o ON o.owner_revision_id=t.revision_id AND o.owner_page_id=t.page_id
 WHERE t.route_kind='tree_page'
), graph AS (
 SELECT paths.path,rr.kind,COALESCE(m.artifact_id,t.artifact_id) AS artifact_id,rr.revision_id,
   rr.object_key,rr.object_version,rr.sha256,rr.size,rr.content_type
 FROM target t JOIN paths
 LEFT JOIN revision_resources local ON local.revision_id=t.revision_id AND local.path=paths.path
 LEFT JOIN mounts m ON local.path IS NULL AND m.path=paths.path AND m.artifact_id=paths.provider AND m.artifact_id<>t.artifact_id
   AND m.kind IN ('fragment','asset') AND EXISTS (SELECT 1 FROM artifacts ma WHERE ma.artifact_id=m.artifact_id AND ma.active_revision_id=m.revision_id)
 LEFT JOIN revision_resources rr ON rr.path=paths.path AND rr.revision_id=COALESCE(m.revision_id,t.revision_id)
   AND (m.path IS NULL OR rr.kind=m.kind)
   AND (paths.path=t.document_path AND paths.provider=t.artifact_id AND rr.kind='document'
     OR paths.path<>t.document_path AND t.route_kind='subtree' AND paths.provider=t.artifact_id AND rr.kind<>'document'
     OR paths.path<>t.document_path AND t.route_kind='tree_page' AND paths.provider=COALESCE(m.artifact_id,t.artifact_id) AND rr.kind IN ('fragment','asset'))
)`
const targetValues = (instanceId: string, target: RenderGraphTarget): [string,string,string,string,number,number] =>
  [instanceId,target.pageId,target.artifactId,target.revisionId,target.expectedPolicyEpoch,target.expectedContentVersion]
// A revision admits at most 10,000 files and 20,000 ownership edges.
const maxResources = 30_000
const maxChunkBytes = 65_536
const encoder = new TextEncoder()
const hex = (bytes: ArrayBuffer) => Array.from(new Uint8Array(bytes), b => b.toString(16).padStart(2,'0')).join('')

/** Fresh primary authorization and graph are read in one D1 batch snapshot. */
export async function captureRenderGraph(deps: ManageDeps, actor: ManageActor, target: RenderGraphTarget): Promise<RenderGraph> {
  requireManageActor(actor, deps)
  if (!target || !/^[a-f0-9]{64}$/.test(target.recipeSha256) || !Number.isSafeInteger(target.expectedPolicyEpoch) || target.expectedPolicyEpoch < 0 || !Number.isSafeInteger(target.expectedContentVersion) || target.expectedContentVersion < 0) throw new PolicyError('invalid_state')
  try {
    const values = targetValues(deps.config.instanceId, target)
    const result = await deps.db.batch([
      deps.db.prepare('SELECT instance_id FROM instance_meta WHERE singleton=1'),
      policyPrincipalStatement(deps.db, actor, [target.pageId]),
      deps.db.prepare(`${graphCte} SELECT * FROM target`).bind(...values),
      deps.db.prepare(`${graphCte} SELECT * FROM graph ORDER BY path COLLATE BINARY LIMIT ${maxResources + 1}`).bind(...values),
    ])

    assertPolicyPrincipal(result, deps, actor, 1)
    const t = result[2].results[0] as Record<string, unknown> | undefined
    if (!t) throw new PolicyError('conflict')
    const rows = result[3].results as Record<string, unknown>[]
    if (!rows.length || rows.length > maxResources) throw new PolicyError('invalid_state')
    const resources: RenderResource[] = rows.map(row => {
      if (typeof row.path !== 'string' || !['document','subdocument','fragment','asset'].includes(String(row.kind)) || typeof row.artifact_id !== 'string' || typeof row.revision_id !== 'string' || typeof row.object_key !== 'string' || typeof row.object_version !== 'string' || !row.object_version || typeof row.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(row.sha256) || !Number.isSafeInteger(row.size) || (row.size as number) < 0 || typeof row.content_type !== 'string') throw new PolicyError('invalid_state')
      return { path: row.path, kind: row.kind as RenderResource['kind'], artifactId: row.artifact_id, revisionId: row.revision_id, objectKey: row.object_key, objectVersion: row.object_version, sha256: row.sha256, size: row.size as number, contentType: row.content_type }
    })
    const documentPath = String(t.document_path)
    if (resources.filter(r => r.path === documentPath && r.kind === 'document').length !== 1) throw new PolicyError('invalid_state')
    const content = { version: 1 as const, instanceId: deps.config.instanceId, artifactId: target.artifactId, revisionId: target.revisionId, pageId: target.pageId, policyEpoch: target.expectedPolicyEpoch, contentVersion: target.expectedContentVersion, routeKind: t.route_kind as RenderGraph['routeKind'], routeKey: String(t.route_key), documentPath, recipeSha256: target.recipeSha256, resources }
    const bytes = encoder.encode(JSON.stringify(content))
    return { ...content, inputSha256: hex(await crypto.subtle.digest('SHA-256', bytes)) }
  } catch (error) { if (error instanceof PolicyError) throw error; throw new PolicyError('unavailable') }
}
/** Check persisted bytes against the job's independently stored input digest. */
export async function verifyRenderGraph(graph: RenderGraph, expectedInputSha256: string, expectedRecipeSha256: string): Promise<void> {
  if (!graph || graph.version !== 1 || graph.inputSha256 !== expectedInputSha256 || graph.recipeSha256 !== expectedRecipeSha256 ||
      !/^[a-f0-9]{64}$/.test(expectedInputSha256) || !/^[a-f0-9]{64}$/.test(expectedRecipeSha256) ||
      !Array.isArray(graph.resources) || graph.resources.length < 1 || graph.resources.length > maxResources) throw new PolicyError('invalid_state')
  const content = { version: graph.version, instanceId: graph.instanceId, artifactId: graph.artifactId, revisionId: graph.revisionId, pageId: graph.pageId, policyEpoch: graph.policyEpoch, contentVersion: graph.contentVersion, routeKind: graph.routeKind, routeKey: graph.routeKey, documentPath: graph.documentPath, recipeSha256: graph.recipeSha256, resources: graph.resources.map(r => ({ path: r.path, kind: r.kind, artifactId: r.artifactId, revisionId: r.revisionId, objectKey: r.objectKey, objectVersion: r.objectVersion, sha256: r.sha256, size: r.size, contentType: r.contentType })) }
  const bytes = encoder.encode(JSON.stringify(content))
  if (hex(await crypto.subtle.digest('SHA-256', bytes)) !== expectedInputSha256) throw new PolicyError('invalid_state')
}

/** Place all assertions and cleanups around effects in the same mutation batch.
 * Verify the persisted graph against the independently stored job digest first. */
export function renderGraphAssertionStatements(db: D1Database, graph: RenderGraph): { readonly assertions: readonly D1PreparedStatement[]; readonly cleanups: readonly D1PreparedStatement[] } {
  const target: RenderGraphTarget = { artifactId: graph.artifactId, revisionId: graph.revisionId, pageId: graph.pageId, expectedPolicyEpoch: graph.policyEpoch, expectedContentVersion: graph.contentVersion, recipeSha256: graph.recipeSha256 }
  if (graph.version !== 1 || graph.resources.length < 1 || graph.resources.length > maxResources || !/^[a-f0-9]{64}$/.test(graph.recipeSha256) || !/^[a-f0-9]{64}$/.test(graph.inputSha256)) throw new PolicyError('invalid_state')
  const chunks: string[] = []
  let entries: string[] = [], bytes = 2
  for (const resource of graph.resources) {
    const item = JSON.stringify(resource), size = encoder.encode(item).length
    if (size + 2 > maxChunkBytes) throw new PolicyError('invalid_state')
    if (bytes + size + (entries.length ? 1 : 0) > maxChunkBytes) {
      chunks.push(`[${entries.join(',')}]`); entries = []; bytes = 2
    }
    bytes += size + (entries.length ? 1 : 0); entries.push(item)
  }
  if (entries.length) chunks.push(`[${entries.join(',')}]`)
  const columns = `path,kind,artifact_id,revision_id,object_key,object_version,sha256,size,content_type`
  const expectedColumns = `json_extract(value,'$.path'),json_extract(value,'$.kind'),json_extract(value,'$.artifactId'),json_extract(value,'$.revisionId'),json_extract(value,'$.objectKey'),json_extract(value,'$.objectVersion'),json_extract(value,'$.sha256'),json_extract(value,'$.size'),json_extract(value,'$.contentType')`
  const sql = `${graphCte}, expected AS (SELECT ${expectedColumns} FROM json_each(?7))
    INSERT INTO enrichment_assertions (assertion_id,verdict) SELECT ?8, CASE WHEN
    EXISTS (SELECT 1 FROM target WHERE route_kind=?9 AND route_key=?10 AND document_path=?11)
    AND NOT EXISTS (SELECT * FROM expected EXCEPT SELECT ${columns} FROM graph)
    AND (SELECT count(*) FROM graph)=?12
    THEN 'ok' ELSE 'conflict' END`
  const assertions: D1PreparedStatement[] = [], cleanups: D1PreparedStatement[] = []
  for (const chunk of chunks) {
    const assertion = crypto.randomUUID()
    assertions.push(db.prepare(sql).bind(...targetValues(graph.instanceId, target),chunk,assertion,graph.routeKind,graph.routeKey,graph.documentPath,graph.resources.length))
    cleanups.push(db.prepare('DELETE FROM enrichment_assertions WHERE assertion_id=?').bind(assertion))
  }
  return { assertions, cleanups }
}
