import type { BeginCommand, PublicationReceipt } from '../publication/types'
import { isPublicationToken } from '../publication/staging'
import { importAliasStatement, importPagePolicyStatements, type ManageDeps } from './commands'
import { requireManageActor, requireImportReadContext, importReadCursorIdentity, type ManageActor, type ImportReadContext } from './principals'
import { executeGuarded, PolicyError } from './guard'
import { isShareKey, shareKeyDigests } from './share-secrets'
import { importShortlinkStatement, type ShortlinkMapping } from './shortlinks'
import { importPreviewOwned, importPreviewStatements } from './previews'
import { newId, isCatalogueId } from './ids'
import { documentRouteOf, ownershipEdgeFeasible } from './revision-paths'
import type { SubtreeOrTree } from './routing/grammar'
import { conflictingImportOperationIndexes } from './import-operation-set'

export interface ImportSelection {
  readonly version: 1
  readonly inventoryId: string
  readonly selectionId: string
  readonly planId: string
  readonly command: BeginCommand
}
export interface ImportApproval {
  readonly inventoryId: string; readonly selectionId: string; readonly sourceInstance: string
  readonly objectKey: string; readonly objectVersion: string; readonly sha256: string
  readonly approvalRef: string; readonly kind: 'synthetic' | 'historical'; readonly g1bRef: string | null; readonly maxInventoryBytes: number
}
export interface ImportFile {
  readonly path: string; readonly kind: 'document' | 'subdocument' | 'fragment' | 'asset'
  readonly contentType: string; readonly size: number; readonly sha256: string
  readonly sourceRef: string; readonly sourceVersion: string; readonly provenance: string
}
export interface ImportPolicy {
  readonly operationId: string; readonly sourcePageId: string; readonly pageId: string
  readonly expectedPolicyEpoch: number | null; readonly grantId: string | null
  readonly visibility: { readonly captured: true; readonly value: string | null; readonly metadataV: string | null; readonly expiresAt: number | null }
  readonly share: { readonly captured: true; readonly key: string | null; readonly expiresAt: number | null }
}
export type ImportOperation =
  | { readonly kind: 'page_policy'; readonly policy: ImportPolicy }
  | { readonly kind: 'alias'; readonly operationId: string; readonly aliasKind: 'redirect_exact' | 'redirect_prefix'; readonly path: string; readonly to: string; readonly status: 301 | 302 | 307 | 308; readonly targetPageId: string | null }
  | { readonly kind: 'shortlink'; readonly operationId: string; readonly mapping: ShortlinkMapping }
  | { readonly kind: 'preview_selection'; readonly operationId: string; readonly pageId: string; readonly path: string }
export interface ApprovedImportInventory {
  readonly version: 1; readonly inventoryId: string; readonly selectionId: string
  readonly sourceInstance: string; readonly sourceArtifactId: string; readonly approvalRef: string
  readonly kind: 'synthetic' | 'historical'
  readonly command: BeginCommand
  readonly pageMappings: readonly { readonly sourcePageId: string; readonly pageId: string; readonly documentPath: string; readonly route: string; readonly ownershipEvidenceRef: string }[]
  readonly edgeEvidence: readonly { readonly ownerPageId: string; readonly path: string; readonly providerArtifactId: string | null; readonly evidenceRef: string }[]
  readonly removals?: readonly ({ readonly kind: 'resource'; readonly path: string; readonly evidenceRef: string } | { readonly kind: 'edge'; readonly ownerPageId: string; readonly path: string; readonly providerArtifactId: string | null; readonly evidenceRef: string })[]
  readonly evidence: { readonly selectionDigest: string; readonly corpusDigest: string; readonly mappingRef: string; readonly capturedAt: number; readonly complete: true; readonly g1bRef: string | null }
  readonly files: readonly ImportFile[]
  readonly operations: readonly ImportOperation[]
}
export interface AdmittedImportSelection { readonly selection: ImportSelection; readonly inventory: ApprovedImportInventory; readonly approval: ImportApproval; readonly planKid: string; readonly planDigest: string; readonly sourceDigest: string }
export interface ImportMappingSummary { readonly pages: number; readonly aliases: number; readonly shortlinks: number; readonly previews: number }
const admitted = new WeakMap<object, ImportReadContext>()
const grantProducers = new WeakMap<object, ReadonlyMap<string, string>>()
type PlanCandidate = { readonly kid:string; readonly planDigest:string; readonly sourceDigest:string }
const candidates = new WeakMap<object, readonly PlanCandidate[]>()
export const IMPORT_METADATA_LIMIT = 128
const hex = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
const text = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 1024
function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null'
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  const obj = value as Record<string, unknown>
  return `{${Object.keys(obj).sort().map(k => `${JSON.stringify(k)}:${canonical(obj[k])}`).join(',')}}`
}


export async function admitImportSelection(selection: ImportSelection, input: unknown, approval: ImportApproval, deps: ManageDeps, readContext: ImportReadContext): Promise<AdmittedImportSelection> {
  await requireImportReadContext(readContext, deps)
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new PolicyError('invalid_state')
  if (!isPublicationToken(selection.planId)) throw new PolicyError('invalid_state', 'selection_graph_mismatch')
  const inventory = input as ApprovedImportInventory
  if (inventory.kind === 'historical' && (!text(approval.g1bRef) || inventory.evidence?.g1bRef !== approval.g1bRef)) throw new PolicyError('invalid_state', 'g1b_evidence_required')
  if (selection.version !== 1 || !text(selection.planId) || selection.inventoryId !== approval.inventoryId || selection.selectionId !== approval.selectionId || inventory.version !== 1 || inventory.inventoryId !== approval.inventoryId || inventory.selectionId !== approval.selectionId || inventory.sourceInstance !== approval.sourceInstance || inventory.approvalRef !== approval.approvalRef || inventory.kind !== approval.kind || !text(inventory.sourceArtifactId) || !inventory.evidence || inventory.evidence.complete !== true || !hex(inventory.evidence.selectionDigest) || !hex(inventory.evidence.corpusDigest) || !text(inventory.evidence.mappingRef) || !Number.isSafeInteger(inventory.evidence.capturedAt) || (inventory.kind === 'historical' && (!text(approval.g1bRef) || inventory.evidence.g1bRef !== approval.g1bRef)) || !Array.isArray(inventory.files) || !Array.isArray(inventory.operations)) throw new PolicyError('invalid_state')
  if (!inventory.command || !selection.command || canonical(inventory.command) !== canonical(selection.command) || !Array.isArray(selection.command.pages) || selection.command.pages.length === 0 || !Array.isArray(selection.command.files) || !Array.isArray(selection.command.edges)) throw new PolicyError('invalid_state', 'selection_graph_mismatch')
  if (!Array.isArray(inventory.pageMappings) || !Array.isArray(inventory.edgeEvidence)) throw new PolicyError('invalid_state', 'selection_graph_mismatch')
  if (!Array.isArray(inventory.files) || !Array.isArray(inventory.operations) || (inventory.removals !== undefined && !Array.isArray(inventory.removals))) throw new PolicyError('invalid_state', 'selection_graph_mismatch')
  if (selection.command.edges.some(edge => !edge || (edge.providerArtifactId !== null && !text(edge.providerArtifactId)))) throw new PolicyError('invalid_state', 'selection_graph_mismatch')
  const filesByPath = new Map(selection.command.files.map(file => [file.path,file]))
  const pagesById = new Map(selection.command.pages.map(page => [page.pageId,page]))
  const declaredEdges = new Set(selection.command.edges.map(edge => canonical([edge.ownerPageId,edge.path,edge.providerArtifactId])))
  const normalizedEdges = new Set(selection.command.edges.map(edge => canonical([edge.ownerPageId,edge.path,edge.providerArtifactId ?? selection.command.artifactId])))
  const mappingByPage = new Map(inventory.pageMappings.filter(mapping => mapping && typeof mapping === 'object').map(mapping => [mapping.pageId,mapping]))
  const removalKeys = new Set<string>()
  for (const removal of inventory.removals ?? []) {
    if (!removal || !text(removal.path) || !text(removal.evidenceRef) || (removal.kind !== 'resource' && removal.kind !== 'edge') || (removal.kind === 'edge' && (!text(removal.ownerPageId) || (removal.providerArtifactId !== null && !text(removal.providerArtifactId))))) throw new PolicyError('invalid_state', 'invalid_removal')
    const key = removal.kind === 'resource' ? canonical(['resource', removal.path]) : canonical(['edge', removal.ownerPageId, removal.path, removal.providerArtifactId])
    if (removalKeys.has(key) || (removal.kind === 'resource' ? filesByPath.has(removal.path) : normalizedEdges.has(canonical([removal.ownerPageId,removal.path,removal.providerArtifactId ?? selection.command.artifactId])))) throw new PolicyError('invalid_state', 'invalid_removal')
    removalKeys.add(key)
  }
  const livePages = selection.command.pages.filter(page => page.disposition !== 'drop')
  if (inventory.pageMappings.length !== livePages.length || inventory.edgeEvidence.length !== selection.command.edges.length) throw new PolicyError('invalid_state', 'selection_graph_mismatch')
  const sourcePages = new Set<string>(), targetPages = new Map<string, SubtreeOrTree>()
  for (const mapping of inventory.pageMappings) {
    if (!mapping || !text(mapping.sourcePageId) || !text(mapping.pageId) || !text(mapping.route) || !text(mapping.ownershipEvidenceRef) || sourcePages.has(mapping.sourcePageId) || targetPages.has(mapping.pageId)) throw new PolicyError('invalid_state', 'selection_graph_mismatch')
    const page = pagesById.get(mapping.pageId)
    if (!page || page.disposition === 'drop' || typeof mapping.documentPath !== 'string' || page.documentPath !== mapping.documentPath) throw new PolicyError('invalid_state', 'selection_graph_mismatch')
    sourcePages.add(mapping.sourcePageId)
    const route = documentRouteOf(mapping.documentPath)
    if (!route || mapping.route !== (route.kind === 'subtree' ? `/a/${route.slug}/` : `/${route.pageRef}`)) throw new PolicyError('invalid_state', 'selection_graph_mismatch')
    targetPages.set(mapping.pageId, route)
  }
  const edgeKeys = new Set<string>()
  for (const edge of inventory.edgeEvidence) {
    if (!edge || typeof edge.path !== 'string' || (edge.providerArtifactId !== null && !text(edge.providerArtifactId))) throw new PolicyError('invalid_state', 'selection_graph_mismatch')
    const key = canonical([edge.ownerPageId,edge.path,edge.providerArtifactId])
    if (!text(edge.evidenceRef) || edgeKeys.has(key) || !declaredEdges.has(key)) throw new PolicyError('invalid_state', 'selection_graph_mismatch')
    const owner = targetPages.get(edge.ownerPageId)
    const providerIsLocal = edge.providerArtifactId === null || edge.providerArtifactId === selection.command.artifactId
    if (!owner || !ownershipEdgeFeasible(owner, edge.path, providerIsLocal)) throw new PolicyError('invalid_state', 'selection_graph_mismatch')
    edgeKeys.add(key)
  }
  const paths = new Set<string>()
  for (const file of inventory.files) {
    if (!file || !text(file.path) || paths.has(file.path) || !text(file.sourceRef) || !text(file.sourceVersion) || !text(file.provenance) || !hex(file.sha256) || !Number.isSafeInteger(file.size) || file.size < 0 || !text(file.contentType) || !['document','subdocument','fragment','asset'].includes(file.kind)) throw new PolicyError('invalid_state')
    paths.add(file.path)
    const declared = filesByPath.get(file.path)
    if (!declared || declared.source !== 'client' || declared.kind !== file.kind || declared.sha256 !== file.sha256 || declared.size !== file.size || declared.contentType !== file.contentType) throw new PolicyError('conflict')
  }
  if (selection.command.files.some(f => f.source === 'client' && !paths.has(f.path))) throw new PolicyError('conflict')
  const ids = new Set<string>()
  const policyPages = new Set<string>()
  for (const op of inventory.operations) {
    if (!op || typeof op !== 'object') throw new PolicyError('invalid_state')
    const id = op.kind === 'page_policy' ? op.policy?.operationId : op.operationId
    if (!text(id) || ids.has(id)) throw new PolicyError('invalid_state')
    ids.add(id)
    if (op.kind === 'page_policy') {
      const p = op.policy
      if (p?.visibility?.value === 'shared' && !isCatalogueId(p.grantId, 'gr')) throw new PolicyError('invalid_state', 'selection_graph_mismatch')
      if (!p || !text(p.pageId) || !text(p.sourcePageId) || !p.visibility || p.visibility.captured !== true || !p.share || p.share.captured !== true || (p.visibility.metadataV !== null && p.visibility.metadataV !== p.visibility.value) || (p.visibility.value === 'shared' && (!p.share.key || !isShareKey(p.share.key) || !text(p.grantId))) || !pagesById.has(p.pageId) || pagesById.get(p.pageId)?.disposition === 'drop' || pagesById.get(p.pageId)?.expectedPolicyEpoch !== p.expectedPolicyEpoch) throw new PolicyError('invalid_state')
      if (policyPages.has(p.pageId) || mappingByPage.get(p.pageId)?.sourcePageId !== p.sourcePageId) throw new PolicyError('invalid_state', 'selection_graph_mismatch')
      if (p.visibility.expiresAt !== null || (p.visibility.value === 'shared' && p.share.expiresAt !== null)) throw new PolicyError('invalid_state', 'expiring_policy_unsupported')
      if ((p.visibility.value !== null && typeof p.visibility.value !== 'string') || (p.share.key !== null && typeof p.share.key !== 'string')) throw new PolicyError('invalid_state')
      policyPages.add(p.pageId)
    } else if (op.kind === 'alias') {
      if (op.targetPageId !== null && !targetPages.has(op.targetPageId)) throw new PolicyError('invalid_state', 'selection_graph_mismatch')
      importAliasStatement(deps.db, {kind:op.aliasKind,key:op.path,to:op.to,status:op.status,targetPageId:op.targetPageId,at:deps.now()})
    } else if (op.kind === 'shortlink') {
      if (!op.mapping || !op.mapping.pageId || !targetPages.has(op.mapping.pageId)) throw new PolicyError('invalid_state', 'selection_graph_mismatch')
      await importShortlinkStatement(deps.db, op.mapping)
    } else if (op.kind === 'preview_selection') {
      if (!targetPages.has(op.pageId) || !['image/jpeg','image/png'].includes(filesByPath.get(op.path)?.contentType ?? '')) throw new PolicyError('invalid_state', 'selection_graph_mismatch')
    } else throw new PolicyError('invalid_state')
  }
  if (conflictingImportOperationIndexes(inventory.operations).size) throw new PolicyError('invalid_state', 'selection_graph_mismatch')
  if (selection.command.pages.some(page => page.disposition === 'new' && !policyPages.has(page.pageId))) throw new PolicyError('invalid_state', 'missing_policy_evidence')
  const planInput = canonical({
    instanceId:deps.config.instanceId,
    selection: {version:selection.version,inventoryId:selection.inventoryId,selectionId:selection.selectionId,planId:selection.planId},
    pin: {objectKey:approval.objectKey,objectVersion:approval.objectVersion,sha256:approval.sha256,maxInventoryBytes:approval.maxInventoryBytes,approvalRef:approval.approvalRef,sourceInstance:approval.sourceInstance,kind:approval.kind,g1bRef:approval.g1bRef},
  })
  const sourceInput = canonical({instanceId:deps.config.instanceId,files:inventory.files.map(({path,kind,contentType,size,sha256}) => ({path,kind,contentType,size,sha256}))})
  const sign = async (key:CryptoKey, domain:string, kid:string, input:string) => Array.from(new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${domain}\0${kid}\0${input}`))), b => b.toString(16).padStart(2,'0')).join('')
  const options = await Promise.all(deps.config.shareVerifierKeys.map(async key => ({
    kid:key.kid, planDigest:await sign(key.key,'forge.import.plan.v2',key.kid,planInput), sourceDigest:await sign(key.key,'forge.import.source.v2',key.kid,sourceInput),
  })))
  if (!options.length) throw new PolicyError('invalid_state')
  const result = structuredClone({ selection, inventory, approval, planKid:options[0].kid, planDigest:options[0].planDigest, sourceDigest:options[0].sourceDigest })
  const freeze = (value: unknown): void => {
    if (value && typeof value === 'object' && !Object.isFrozen(value)) {
      for (const child of Object.values(value)) freeze(child)
      Object.freeze(value)
    }
  }
  freeze(result)
  grantProducers.set(result, new Map(result.inventory.operations.flatMap(op => op.kind === 'page_policy' && op.policy.visibility.value === 'shared' && op.policy.grantId !== null ? [[op.policy.grantId, op.policy.pageId] as const] : [])))
  admitted.set(result, readContext)
  candidates.set(result, options)
  return result
}

function selectCandidate(context: AdmittedImportSelection, predicate: (candidate:PlanCandidate) => boolean): AdmittedImportSelection {
  const authority = admitted.get(context)
  const options = candidates.get(context)
  if (!authority || !options) throw new PolicyError('forbidden')
  const selected = options.find(predicate)
  if (!selected) throw new PolicyError('conflict')
  if (selected.planDigest === context.planDigest) return context
  const result = Object.freeze({...context,planKid:selected.kid,planDigest:selected.planDigest,sourceDigest:selected.sourceDigest})
  admitted.set(result, authority)
  grantProducers.set(result, grantProducers.get(context)!)
  candidates.set(result, options)
  return result
}

/** Only a digest already persisted for this admitted plan may select a retained candidate. */
export function selectImportPlan(context: AdmittedImportSelection, digest: string): AdmittedImportSelection {
  return selectCandidate(context, candidate => candidate.planDigest === digest)
}

/** Caller must authenticate the cursor and its key ID before selecting by key. */
export function importPlanForKid(context: AdmittedImportSelection, kid: string): AdmittedImportSelection {
  return selectCandidate(context, candidate => candidate.kid === kid)
}

export async function importCursorIdentity(context: AdmittedImportSelection, deps: ManageDeps) {
  const authority = admitted.get(context)
  if (!authority) throw new PolicyError('forbidden')
  return importReadCursorIdentity(authority, deps)
}

export async function inspectImportTarget(deps: ManageDeps, context: AdmittedImportSelection, observationKid: string): Promise<string> {
  return (await inspectImportTargetObserved(deps, context, observationKid)).digest
}

type GrantReference = {grant_id:string;page_id:string}
function unproducedGrantIds(context: AdmittedImportSelection): string[] {
  const producers = grantProducers.get(context)
  if (!producers) throw new PolicyError('forbidden')
  return [...new Set(context.inventory.operations.flatMap(op => op.kind === 'shortlink' && op.mapping.grantId !== null && producers.get(op.mapping.grantId) !== op.mapping.pageId ? [op.mapping.grantId] : []))]
}

async function inspectImportTargetObserved(deps: ManageDeps, context: AdmittedImportSelection, observationKid: string): Promise<{digest:string;grantReferences:GrantReference[]}> {
  if (!admitted.has(context)) throw new PolicyError('forbidden')
  await requireImportReadContext(admitted.get(context)!, deps)
  const command = context.selection.command
  const paths = JSON.stringify([...command.files.map(f => f.path), ...command.edges.map(e => e.path)])
  const pageIds = JSON.stringify([...command.pages.map(p => p.pageId), ...context.inventory.operations.flatMap(op => op.kind === 'page_policy' ? [op.policy.pageId] : op.kind === 'preview_selection' ? [op.pageId] : [])])
  const providers = JSON.stringify(command.edges.flatMap(e => e.providerArtifactId ? [e.providerArtifactId] : []))
  const routes = JSON.stringify(command.pages.flatMap(p => {
    const r = p.documentPath && documentRouteOf(p.documentPath)
    return r ? [{kind:r.kind, key:r.kind === 'subtree' ? r.slug : r.pageRef}] : []
  }))
  const aliases = JSON.stringify(context.inventory.operations.filter(op => op.kind === 'alias').map(op => ({kind:op.aliasKind,key:op.path})))
  const links = JSON.stringify(context.inventory.operations.filter(op => op.kind === 'shortlink').map(op => op.mapping))
  const results = await deps.db.batch([
    deps.db.prepare('SELECT artifact_id,active_revision_id,content_version FROM artifacts WHERE artifact_id=? OR artifact_id IN (SELECT value FROM json_each(?)) ORDER BY artifact_id').bind(command.artifactId, providers),
    deps.db.prepare('SELECT p.*,g.grant_id,g.key_kid,g.key_hmac,g.mode,g.origin,g.pinned_revision_id,g.revoked_at FROM pages p LEFT JOIN share_grants g ON g.page_id=p.page_id AND (g.revoked_at IS NULL OR g.grant_id IN (SELECT json_extract(value,\'$.policy.grantId\') FROM json_each(?2) WHERE json_extract(value,\'$.kind\')=\'page_policy\')) WHERE p.page_id IN (SELECT value FROM json_each(?1)) ORDER BY p.page_id,g.grant_id').bind(pageIds,JSON.stringify(context.inventory.operations)),
    deps.db.prepare("SELECT * FROM share_grants WHERE grant_id IN (SELECT json_extract(value,'$.policy.grantId') FROM json_each(?) WHERE json_extract(value,'$.kind')='page_policy') ORDER BY grant_id").bind(JSON.stringify(context.inventory.operations)),
    deps.db.prepare("SELECT json_extract(j.value,'$.key') AS slug, EXISTS (SELECT 1 FROM mounts m WHERE m.path >= '/a/'||json_extract(j.value,'$.key')||'/' AND m.path < '/a/'||json_extract(j.value,'$.key')||'0' AND m.artifact_id IS NOT ?2) AS occupied FROM json_each(?1) j WHERE json_extract(j.value,'$.kind')='subtree' ORDER BY slug").bind(routes,command.artifactId),
    deps.db.prepare('SELECT * FROM mounts WHERE path IN (SELECT value FROM json_each(?)) ORDER BY path').bind(paths),
    deps.db.prepare(`SELECT DISTINCT r.* FROM routes r JOIN json_each(?1) j ON (r.kind='redirect_exact' AND r.route_key=j.value) OR (r.kind='redirect_prefix' AND substr(j.value,1,length(r.route_key))=r.route_key) OR (r.kind='subtree' AND substr(j.value,1,length('/a/'||r.route_key||'/'))='/a/'||r.route_key||'/') UNION SELECT r.* FROM routes r JOIN json_each(?2) j ON r.kind=json_extract(j.value,'$.kind') AND r.route_key=json_extract(j.value,'$.key') UNION SELECT r.* FROM routes r JOIN json_each(?3) j ON r.kind=json_extract(j.value,'$.kind') AND r.route_key=json_extract(j.value,'$.key') ORDER BY kind,route_key`).bind(paths,routes,aliases),
    deps.db.prepare("SELECT DISTINCT s.* FROM shortlink_mappings s JOIN json_each(?) j ON s.mapping_id=json_extract(j.value,'$.mappingId') OR (s.provider_origin=json_extract(j.value,'$.providerOrigin') AND s.short_domain=json_extract(j.value,'$.shortDomain') AND s.short_code=json_extract(j.value,'$.shortCode')) ORDER BY s.mapping_id").bind(links),
    deps.db.prepare('SELECT grant_id,page_id FROM share_grants WHERE grant_id IN (SELECT value FROM json_each(?)) ORDER BY grant_id').bind(JSON.stringify(unproducedGrantIds(context))),
    deps.db.prepare('SELECT artifact_id FROM publication_imports WHERE instance_id=? AND source_instance=? AND source_artifact_id=? LIMIT 1').bind(deps.config.instanceId,context.inventory.sourceInstance,context.inventory.sourceArtifactId),
  ])
  const related = results.map(result => result.results)
  const key = deps.config.shareVerifierKeys.find(candidate => candidate.kid === observationKid)
  if (!key) throw new PolicyError('conflict')
  const digest = Array.from(new Uint8Array(await crypto.subtle.sign('HMAC', key.key, new TextEncoder().encode(`forge.import.target.v1\0${canonical(related)}`))), b => b.toString(16).padStart(2,'0')).join('')
  return {digest,grantReferences:results[7].results as GrantReference[]}
}

interface CompletionTarget {
  readonly sessionId: string; readonly artifactId: string; readonly revisionId: string
  readonly planId: string; readonly planDigest: string; readonly publicationReceipt: PublicationReceipt
}
type CompletionInput = CompletionTarget & { readonly at: number }

function summary(context: AdmittedImportSelection): ImportMappingSummary {
  return {
    pages: context.inventory.operations.filter(op => op.kind === 'page_policy').length,
    aliases: context.inventory.operations.filter(op => op.kind === 'alias').length,
    shortlinks: context.inventory.operations.filter(op => op.kind === 'shortlink').length,
    previews: context.inventory.operations.filter(op => op.kind === 'preview_selection').length,
  }
}

function assertion(db: D1Database, predicate: string, ...values: (string | number | null)[]): D1PreparedStatement {
  return db.prepare(`INSERT INTO import_assertions(assertion_id,verdict) SELECT ?, CASE WHEN ${predicate} THEN 'ok' ELSE 'conflict' END`).bind(newId('ev'), ...values)
}

export async function buildImportCompletion(deps: ManageDeps, actor: ManageActor, context: AdmittedImportSelection, target: CompletionInput): Promise<{ statements: D1PreparedStatement[]; mappingSummary: ImportMappingSummary }> {
  requireManageActor(actor, deps)
  if (!admitted.has(context) || target.planId !== context.selection.planId || target.planDigest !== context.planDigest) throw new PolicyError('forbidden')
  const { db } = deps
  const { inventory, selection, approval } = context
  const statements: D1PreparedStatement[] = [
    assertion(db, `EXISTS (SELECT 1 FROM publication_sessions WHERE session_id=? AND instance_id=? AND artifact_id=? AND revision_id=? AND import_plan_id=? AND import_plan_digest=?)`, target.sessionId, deps.config.instanceId, target.artifactId, target.revisionId, target.planId, target.planDigest),
    assertion(db, `NOT EXISTS (SELECT 1 FROM publication_imports WHERE instance_id=? AND source_instance=? AND source_artifact_id=? AND artifact_id<>?) AND (NOT EXISTS (SELECT 1 FROM publication_imports WHERE instance_id=? AND source_instance=? AND source_artifact_id=?) OR ?=?)`, deps.config.instanceId, inventory.sourceInstance, inventory.sourceArtifactId, target.artifactId, deps.config.instanceId, inventory.sourceInstance, inventory.sourceArtifactId, selection.command.artifactId, target.artifactId),
    db.prepare(`INSERT INTO publication_imports(instance_id,plan_id,plan_digest,inventory_id,selection_id,source_instance,source_artifact_id,source_digest,approval_ref,session_id,artifact_id,revision_id,receipt_json) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(deps.config.instanceId, target.planId, target.planDigest, selection.inventoryId, selection.selectionId, inventory.sourceInstance, inventory.sourceArtifactId, context.sourceDigest, approval.approvalRef, target.sessionId, target.artifactId, target.revisionId, JSON.stringify(target.publicationReceipt)),
  ]
  const explicitPreviews = new Set(inventory.operations.flatMap(op => op.kind === 'preview_selection' ? [op.pageId] : []))
  const kept = selection.command.pages.filter(page => page.disposition === 'keep' && !explicitPreviews.has(page.pageId))
  if (selection.command.expectedRevisionId && kept.length) {
    const previews = await db.prepare('SELECT page_id,original_path FROM preview_selections WHERE revision_id=? AND page_id IN (SELECT value FROM json_each(?))').bind(selection.command.expectedRevisionId, JSON.stringify(kept.map(p => p.pageId))).all<{page_id:string;original_path:string|null}>()
    for (const preview of previews.results) {
      if (!preview.original_path || !importPreviewOwned(selection.command, preview.page_id, preview.original_path) || !selection.command.files.some(f => f.path === preview.original_path && f.source === 'base')) throw new PolicyError('conflict', 'kept_preview_unsupported')
      statements.push(assertion(db, 'EXISTS (SELECT 1 FROM preview_selections WHERE page_id=? AND revision_id=? AND original_path=?)', preview.page_id, selection.command.expectedRevisionId, preview.original_path))
      statements.push(...importPreviewStatements(db, preview.page_id, target.artifactId, target.revisionId, preview.original_path, newId('ev')))
    }
    statements.push(assertion(db, `NOT EXISTS (
      SELECT 1 FROM preview_selections old
      JOIN publication_pages pp ON pp.session_id=? AND pp.page_id=old.page_id AND pp.disposition='keep'
      WHERE old.revision_id=? AND old.page_id NOT IN (SELECT value FROM json_each(?))
        AND (old.original_path IS NULL OR NOT EXISTS (
          SELECT 1 FROM preview_selections current
          WHERE current.page_id=old.page_id AND current.revision_id=? AND current.original_path=old.original_path
        ))
    )`, target.sessionId, selection.command.expectedRevisionId, JSON.stringify([...explicitPreviews]), target.revisionId))
  }
  for (const op of [...inventory.operations.filter(op => op.kind === 'page_policy'), ...inventory.operations.filter(op => op.kind !== 'page_policy')]) {
    const operationId = op.kind === 'page_policy' ? op.policy.operationId : op.operationId
    let after: object
    if (op.kind === 'page_policy') {
      const p = op.policy
      const visibility = p.visibility.value === 'public' ? 'public' : p.visibility.value === 'shared' ? 'shared' : 'private'
      const epoch = (p.expectedPolicyEpoch ?? 0) + (selection.command.pages.find(page => page.pageId === p.pageId)?.disposition === 'restore' ? 1 : 0)
      statements.push(assertion(db, `EXISTS (SELECT 1 FROM pages WHERE page_id=? AND artifact_id=? AND tombstoned_at IS NULL AND policy_epoch=?)`, p.pageId, target.artifactId, epoch))
      const key = visibility === 'shared' ? p.share.key : null
      statements.push(...await importPagePolicyStatements(deps, actor, {pageId:p.pageId, visibility, key, grantId:p.grantId, at:target.at}))
      const verifier = key ? (await shareKeyDigests(deps.config.shareVerifierKeys.slice(0,1), deps.config.instanceId, key))[0] : null
      after = { pageId:p.pageId, artifactId:target.artifactId, visibility, policyEpoch:epoch + 1, grantId:visibility === 'shared' ? p.grantId : null, verifier }
    } else if (op.kind === 'alias') {
      statements.push(importAliasStatement(db, {kind:op.aliasKind,key:op.path,to:op.to,status:op.status,targetPageId:op.targetPageId,at:target.at}))
      statements.push(assertion(db, `EXISTS (SELECT 1 FROM routes WHERE kind=? AND route_key=? AND redirect_to=? AND redirect_status=? AND target_page_id IS ?)`, op.aliasKind,op.path,op.to,op.status,op.targetPageId))
      after = {kind:op.aliasKind,key:op.path,to:op.to,status:op.status,targetPageId:op.targetPageId}
    } else if (op.kind === 'shortlink') {
      const m = op.mapping
      statements.push(assertion(db, `? IS NULL OR EXISTS (SELECT 1 FROM share_grants WHERE grant_id=? AND page_id=?)`, m.grantId, m.grantId, m.pageId))
      statements.push(await importShortlinkStatement(db, m))
      statements.push(assertion(db, `EXISTS (SELECT 1 FROM shortlink_mappings WHERE mapping_id=? AND provider_origin=? AND provider_id IS ? AND short_domain=? AND short_code=? AND short_url=? AND page_id IS ? AND grant_id IS ? AND destination=? AND source=? AND observed_at=? AND destination_digest=?)`, m.mappingId,m.providerOrigin,m.providerId,m.shortDomain,m.shortCode,m.shortUrl,m.pageId,m.grantId,m.destination,m.source,m.observedAt,m.destinationDigest))
      after = m
    } else {
      statements.push(...importPreviewStatements(db, op.pageId, target.artifactId, target.revisionId, op.path, newId('ev')))
      after = {pageId:op.pageId,revisionId:target.revisionId,path:op.path}
    }
    statements.push(db.prepare('INSERT INTO catalogue_import_operations(instance_id,plan_id,operation_id,kind,after_json) VALUES (?,?,?,?,?)').bind(deps.config.instanceId, target.planId, operationId, op.kind, JSON.stringify(after)))
  }
  return {statements, mappingSummary:summary(context)}
}

export async function assertImportReplay(deps: ManageDeps, actor: ManageActor, context: AdmittedImportSelection, target: CompletionTarget, deadline?: number): Promise<ImportMappingSummary> {
  requireManageActor(actor, deps)
  if (!admitted.has(context) || target.planId !== context.selection.planId || target.planDigest !== context.planDigest) throw new PolicyError('forbidden')
  const { db } = deps
  const checks: D1PreparedStatement[] = [
    assertion(db, `EXISTS (SELECT 1 FROM publication_imports WHERE instance_id=? AND plan_id=? AND plan_digest=? AND session_id=? AND artifact_id=? AND revision_id=? AND receipt_json=?)`, deps.config.instanceId, target.planId, target.planDigest, target.sessionId, target.artifactId, target.revisionId, JSON.stringify(target.publicationReceipt)),
    assertion(db, `EXISTS (SELECT 1 FROM artifacts WHERE artifact_id=? AND active_revision_id=?)`, target.artifactId, target.revisionId),
  ]
  for (const op of context.inventory.operations) {
    const id = op.kind === 'page_policy' ? op.policy.operationId : op.operationId
    checks.push(assertion(db, `EXISTS (SELECT 1 FROM catalogue_import_operations WHERE instance_id=? AND plan_id=? AND operation_id=? AND kind=?)`, deps.config.instanceId, target.planId, id, op.kind))
    if (op.kind === 'page_policy') {
      const p = op.policy
      const visibility = p.visibility.value === 'public' ? 'public' : p.visibility.value === 'shared' ? 'shared' : 'private'
      checks.push(assertion(db, `EXISTS (SELECT 1 FROM pages WHERE page_id=? AND artifact_id=? AND visibility=? AND policy_epoch=? AND tombstoned_at IS NULL)`, p.pageId, target.artifactId, visibility, (p.expectedPolicyEpoch ?? 0) + 1 + (context.selection.command.pages.find(page => page.pageId === p.pageId)?.disposition === 'restore' ? 1 : 0)))
      if (visibility === 'shared' && p.share.key) {
        const keys = await shareKeyDigests(deps.config.shareVerifierKeys, deps.config.instanceId, p.share.key)
        const alternatives = keys.map(() => '(key_kid=? AND key_hmac=?)').join(' OR ')
        checks.push(assertion(db, `EXISTS (SELECT 1 FROM share_grants g WHERE g.grant_id=? AND g.page_id=? AND g.mode='follow_active' AND g.origin='imported' AND g.pinned_revision_id IS NULL AND g.revoked_at IS NULL AND (${alternatives}))`, p.grantId, p.pageId, ...keys.flatMap(k => [k.kid,k.hmac])))
      } else checks.push(assertion(db, `NOT EXISTS (SELECT 1 FROM share_grants WHERE page_id=? AND revoked_at IS NULL)`, p.pageId))
    } else if (op.kind === 'alias') {
      checks.push(assertion(db, `EXISTS (SELECT 1 FROM routes WHERE kind=? AND route_key=? AND redirect_to=? AND redirect_status=? AND target_page_id IS ?)`, op.aliasKind,op.path,op.to,op.status,op.targetPageId))
    } else if (op.kind === 'shortlink') {
      const m = op.mapping
      checks.push(assertion(db, `EXISTS (SELECT 1 FROM shortlink_mappings WHERE mapping_id=? AND provider_origin=? AND provider_id IS ? AND short_domain=? AND short_code=? AND short_url=? AND page_id IS ? AND grant_id IS ? AND destination=? AND source=? AND observed_at=? AND destination_digest=?)`, m.mappingId,m.providerOrigin,m.providerId,m.shortDomain,m.shortCode,m.shortUrl,m.pageId,m.grantId,m.destination,m.source,m.observedAt,m.destinationDigest))
    } else {
      checks.push(assertion(db, `EXISTS (SELECT 1 FROM preview_selections WHERE page_id=? AND revision_id=? AND original_path=?)`, op.pageId,target.revisionId,op.path))
    }
  }
  await executeGuarded(deps, actor, [{action:'import_state',requestDigest:context.planDigest,occurredAt:deps.now()}], checks, undefined, [], deadline)
  return summary(context)
}

export async function inspectImportConflicts(deps: ManageDeps, context: AdmittedImportSelection): Promise<readonly { code: string; pageId?: string; path?: string }[]> {
  if (!admitted.has(context)) throw new PolicyError('forbidden')
  return inspectImportConflictsFor(deps, context)
}

// The producer index belongs to the complete admitted inventory, not a chunk.
async function inspectImportConflictsFor(deps: ManageDeps, context: AdmittedImportSelection, observedReferences?: readonly GrantReference[]): Promise<readonly { code: string; pageId?: string; path?: string }[]> {
  if (!admitted.has(context)) throw new PolicyError('forbidden')
  await requireImportReadContext(admitted.get(context)!, deps)
  const issues: { code: string; pageId?: string; path?: string }[] = []
  const { db } = deps
  const mapping = await db.prepare('SELECT artifact_id FROM publication_imports WHERE instance_id=? AND source_instance=? AND source_artifact_id=? LIMIT 1').bind(deps.config.instanceId,context.inventory.sourceInstance,context.inventory.sourceArtifactId).first<{artifact_id:string}>()
  if (mapping && mapping.artifact_id !== context.selection.command.artifactId) issues.push({code:'source_mapping_conflict'})
  const operations = context.inventory.operations
  const producers = grantProducers.get(context)!
  const references = observedReferences ?? (await db.prepare('SELECT grant_id,page_id FROM share_grants WHERE grant_id IN (SELECT value FROM json_each(?)) ORDER BY grant_id').bind(JSON.stringify(unproducedGrantIds(context))).all<GrantReference>()).results
  const [policyRows, grantRows, aliasRows, linkRows] = await db.batch([
    db.prepare('SELECT page_id,artifact_id,policy_epoch,tombstoned_at FROM pages WHERE page_id IN (SELECT json_extract(value,\'$.policy.pageId\') FROM json_each(?) WHERE json_extract(value,\'$.kind\')=\'page_policy\')').bind(JSON.stringify(operations)),
    db.prepare('SELECT grant_id,page_id,key_kid,key_hmac,mode,pinned_revision_id,origin,revoked_at FROM share_grants WHERE grant_id IN (SELECT json_extract(value,\'$.policy.grantId\') FROM json_each(?) WHERE json_extract(value,\'$.kind\')=\'page_policy\')').bind(JSON.stringify(operations)),
    db.prepare('SELECT r.kind,r.route_key,r.redirect_to,r.redirect_status,r.target_page_id FROM routes r JOIN json_each(?) j ON r.kind=json_extract(j.value,\'$.aliasKind\') AND r.route_key=json_extract(j.value,\'$.path\') WHERE json_extract(j.value,\'$.kind\')=\'alias\'').bind(JSON.stringify(operations)),
    db.prepare('SELECT DISTINCT s.* FROM shortlink_mappings s JOIN json_each(?) j ON json_extract(j.value,\'$.kind\')=\'shortlink\' AND (s.mapping_id=json_extract(j.value,\'$.mapping.mappingId\') OR (s.provider_origin=json_extract(j.value,\'$.mapping.providerOrigin\') AND s.short_domain=json_extract(j.value,\'$.mapping.shortDomain\') AND s.short_code=json_extract(j.value,\'$.mapping.shortCode\')))').bind(JSON.stringify(operations)),
  ])
  for (const op of context.inventory.operations) {
    if (op.kind === 'page_policy') {
      const p = op.policy
      const row = (policyRows.results as {page_id:string;artifact_id:string;policy_epoch:number;tombstoned_at:number|null}[]).find(r => r.page_id === p.pageId)
      const disposition = context.selection.command.pages.find(page => page.pageId === p.pageId)?.disposition
      if (p.expectedPolicyEpoch === null ? row !== undefined : !row || row.artifact_id !== context.selection.command.artifactId || row.policy_epoch !== p.expectedPolicyEpoch || (disposition === 'restore' ? row.tombstoned_at === null : row.tombstoned_at !== null)) issues.push({code:'policy_conflict',pageId:p.pageId})
      if (p.visibility.value === 'shared' && p.grantId && p.share.key) {
        const grant = (grantRows.results as {grant_id:string;page_id:string;key_kid:string;key_hmac:string;mode:string;pinned_revision_id:string|null;origin:string;revoked_at:number|null}[]).find(r => r.grant_id === p.grantId)
        const keys = await shareKeyDigests(deps.config.shareVerifierKeys, deps.config.instanceId, p.share.key)
        if (grant && (grant.page_id !== p.pageId || grant.mode !== 'follow_active' || grant.pinned_revision_id !== null || grant.origin !== 'imported' || grant.revoked_at !== null || !keys.some(k => k.kid === grant.key_kid && k.hmac === grant.key_hmac))) issues.push({code:'grant_conflict',pageId:p.pageId})
      }
    } else if (op.kind === 'alias') {
      const row = (aliasRows.results as {kind:string;route_key:string;redirect_to:string;redirect_status:number;target_page_id:string|null}[]).find(r => r.kind === op.aliasKind && r.route_key === op.path)
      if (row && (row.redirect_to !== op.to || row.redirect_status !== op.status || row.target_page_id !== op.targetPageId)) issues.push({code:'alias_conflict',path:op.path})
    } else if (op.kind === 'shortlink') {
      const m = op.mapping
      if (m.grantId !== null && producers.get(m.grantId) !== m.pageId && !references.some(grant => grant.grant_id === m.grantId && grant.page_id === m.pageId)) issues.push({code:'grant_conflict',pageId:m.pageId ?? undefined})
      const row = (linkRows.results as Record<string,unknown>[]).find(r => r.mapping_id === m.mappingId || (r.provider_origin === m.providerOrigin && r.short_domain === m.shortDomain && r.short_code === m.shortCode))
      if (row && (row.mapping_id !== m.mappingId || row.provider_origin !== m.providerOrigin || row.provider_id !== m.providerId || row.short_domain !== m.shortDomain || row.short_code !== m.shortCode || row.short_url !== m.shortUrl || row.page_id !== m.pageId || row.grant_id !== m.grantId || row.destination !== m.destination || row.source !== m.source || row.observed_at !== m.observedAt || row.destination_digest !== m.destinationDigest)) issues.push({code:'shortlink_conflict',pageId:m.pageId ?? undefined})
    } else if (op.kind === 'preview_selection' && !importPreviewOwned(context.selection.command, op.pageId, op.path)) {
      issues.push({code:'preview_not_owned', pageId:op.pageId, path:op.path})
    }
  }
  return issues
}

/** One bounded observation. The opaque position is carried in a signed caller cursor. */
export async function inspectImportChunk(deps: ManageDeps, context: AdmittedImportSelection, position: string | null, observationKid: string): Promise<{nextPosition:string|null;targetDigest:string;issues:readonly {code:string;pageId?:string;path?:string}[]}> {
  const readContext = admitted.get(context)
  if (!readContext) throw new PolicyError('forbidden')
  await requireImportReadContext(readContext, deps)
  const command = context.selection.command
  const phases = ['pages','files','edges','operations','live_pages','resources','owners','previews'] as const
  type Phase = typeof phases[number]
  let cursor: {phase:Phase; index:number; last:string; owner:string} = {phase:'pages',index:0,last:'',owner:''}
  if (position !== null) {
    try {
      const value = JSON.parse(position) as typeof cursor
      if (!phases.includes(value.phase) || !Number.isSafeInteger(value.index) || value.index < 0 || typeof value.last !== 'string' || typeof value.owner !== 'string') throw new Error()
      cursor = value
    } catch { throw new PolicyError('invalid_state', 'invalid_import_cursor') }
  }
  const artifact = command.artifactId ? await deps.db.prepare('SELECT active_revision_id,content_version FROM artifacts WHERE artifact_id=?').bind(command.artifactId).first<{active_revision_id:string|null;content_version:number}>() : null
  const issues: {code:string;pageId?:string;path?:string}[] = []
  if (command.artifactId && (!artifact || artifact.active_revision_id !== command.expectedRevisionId || artifact.content_version !== command.expectedContentVersion)) issues.push({code:'conflict'})
  const nextPhase = (): typeof cursor | null => {
    let index = phases.indexOf(cursor.phase) + 1
    while (index < phases.length) {
      const phase = phases[index]
      if ((phase === 'files' || phase === 'edges') && command[phase].length === 0) { index++; continue }
      if (phase === 'live_pages' && !command.artifactId) { index++; continue }
      if ((phase === 'resources' || phase === 'owners' || phase === 'previews') && !command.expectedRevisionId) { index++; continue }
      return {phase,index:0,last:'',owner:''}
    }
    return null
  }
  let next: typeof cursor | null = null
  let observation: unknown
  if (cursor.phase === 'pages' || cursor.phase === 'files' || cursor.phase === 'edges' || cursor.phase === 'operations') {
    const items = cursor.phase === 'operations' ? context.inventory.operations : command[cursor.phase]
    const slice = items.slice(cursor.index, cursor.index + IMPORT_METADATA_LIMIT)
    next = cursor.index + slice.length < items.length ? { ...cursor, index:cursor.index + slice.length } : nextPhase()
    const chunkCommand = {
      ...command, expectedRevisionId:null,
      pages: cursor.phase === 'pages' ? command.pages.slice(cursor.index,cursor.index + IMPORT_METADATA_LIMIT) : [],
      files: cursor.phase === 'files' ? command.files.slice(cursor.index,cursor.index + IMPORT_METADATA_LIMIT) : [],
      edges: cursor.phase === 'edges' ? command.edges.slice(cursor.index,cursor.index + IMPORT_METADATA_LIMIT) : [],
    }
    const operations = cursor.phase === 'operations' ? context.inventory.operations.slice(cursor.index,cursor.index + IMPORT_METADATA_LIMIT) : []
    const chunk: AdmittedImportSelection = { ...context, selection:{...context.selection,command:chunkCommand}, inventory:{...context.inventory,operations} }
    admitted.set(chunk, readContext)
    grantProducers.set(chunk, grantProducers.get(context)!)
    const target = await inspectImportTargetObserved(deps, chunk, observationKid)
    if (cursor.phase === 'operations') {
      const conflictChunk: AdmittedImportSelection = { ...chunk, selection:{...context.selection,command:{...command,expectedRevisionId:null}} }
      admitted.set(conflictChunk, readContext)
      grantProducers.set(conflictChunk, grantProducers.get(context)!)
      issues.push(...await inspectImportConflictsFor(deps, conflictChunk, target.grantReferences))
    }
    observation = {targetDigest:target.digest}
  } else {
    const base = command.expectedRevisionId
    let rows: Record<string,unknown>[] = []
    if (command.artifactId && cursor.phase === 'live_pages') rows = (await deps.db.prepare("SELECT p.page_id,p.artifact_id,p.policy_epoch,p.visibility,p.tombstoned_at,r.kind,r.route_key,r.document_path FROM pages p LEFT JOIN routes r ON r.page_id=p.page_id AND r.kind IN ('subtree','tree_page') WHERE p.artifact_id=? AND p.tombstoned_at IS NULL AND p.page_id>? ORDER BY p.page_id LIMIT ?").bind(command.artifactId,cursor.last,IMPORT_METADATA_LIMIT + 1).all<Record<string,unknown>>()).results
    if (base && cursor.phase === 'resources') rows = (await deps.db.prepare('SELECT path,kind,sha256,size,content_type FROM revision_resources WHERE revision_id=? AND path>? ORDER BY path LIMIT ?').bind(base,cursor.last,IMPORT_METADATA_LIMIT + 1).all<Record<string,unknown>>()).results
    if (base && cursor.phase === 'owners') rows = (await deps.db.prepare('SELECT owner_page_id,path,provider_artifact_id FROM resource_owners WHERE owner_revision_id=? AND (owner_page_id>? OR (owner_page_id=? AND path>?)) ORDER BY owner_page_id,path LIMIT ?').bind(base,cursor.owner,cursor.owner,cursor.last,IMPORT_METADATA_LIMIT + 1).all<Record<string,unknown>>()).results
    if (base && cursor.phase === 'previews') rows = (await deps.db.prepare('SELECT page_id,original_path,recipe_sha256,input_sha256,content_sha256,extension FROM preview_selections WHERE revision_id=? AND page_id>? ORDER BY page_id LIMIT ?').bind(base,cursor.last,IMPORT_METADATA_LIMIT + 1).all<Record<string,unknown>>()).results
    const more = rows.length > IMPORT_METADATA_LIMIT
    if (more) rows = rows.slice(0,IMPORT_METADATA_LIMIT)
    const files = new Map(command.files.map(f => [f.path,f]))
    const edges = new Set(command.edges.map(e => canonical([e.ownerPageId,e.path,e.providerArtifactId ?? command.artifactId])))
    const resourceRemovals = new Set((context.inventory.removals ?? []).flatMap(r => r.kind === 'resource' ? [r.path] : []))
    const edgeRemovals = new Set((context.inventory.removals ?? []).flatMap(r => r.kind === 'edge' ? [canonical([r.ownerPageId,r.path,r.providerArtifactId ?? command.artifactId])] : []))
    const keptPages = new Set(command.pages.filter(p => p.disposition === 'keep').map(p => p.pageId))
    const explicitPreviews = new Set(context.inventory.operations.flatMap(op => op.kind === 'preview_selection' ? [op.pageId] : []))
    for (const row of rows) {
      if (cursor.phase === 'resources') {
        const path = String(row.path)
        if (!files.has(path) && !resourceRemovals.has(path)) issues.push({code:'resource_removal_undeclared',path})
      } else if (cursor.phase === 'owners') {
        const pageId = String(row.owner_page_id), path = String(row.path), provider = row.provider_artifact_id
        const edge = canonical([pageId,path,provider])
        if (!edges.has(edge) && !edgeRemovals.has(edge)) issues.push({code:'edge_removal_undeclared',pageId,path})
      } else if (cursor.phase === 'previews') {
        const pageId = String(row.page_id), path = row.original_path
        if (keptPages.has(pageId) && !explicitPreviews.has(pageId)) {
          if (typeof path !== 'string') issues.push({code:'kept_derived_preview_unsupported',pageId})
          else if (!importPreviewOwned(command,pageId,path) || files.get(path)?.source !== 'base') issues.push({code:'kept_preview_not_preserved',pageId,path})
        }
      }
    }
    if (more) {
      const last = rows[rows.length - 1]
      next = {...cursor,last:String(cursor.phase === 'previews' || cursor.phase === 'live_pages' ? last.page_id : last.path),owner:cursor.phase === 'owners' ? String(last.owner_page_id) : ''}
    } else next = nextPhase()
    observation = rows
  }
  const key = deps.config.shareVerifierKeys.find(candidate => candidate.kid === observationKid)
  if (!key) throw new PolicyError('conflict')
  const bytes = new TextEncoder().encode(`forge.import.chunk.v1\0${canonical({cursor,artifact,observation})}`)
  const targetDigest = Array.from(new Uint8Array(await crypto.subtle.sign('HMAC', key.key, bytes)), b => b.toString(16).padStart(2,'0')).join('')
  return {nextPosition:next ? JSON.stringify(next) : null,targetDigest,issues}
}
