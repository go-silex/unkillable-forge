import type { BeginCommand, PublicationReceipt } from '../publication/types'
import { importAliasStatement, importPagePolicyStatements, type ManageDeps } from './commands'
import { requireManageActor, type ManageActor } from './principals'
import { executeGuarded, PolicyError } from './guard'
import { isShareKey, shareKeyDigests } from './share-secrets'
import { importShortlinkStatement, type ShortlinkMapping } from './shortlinks'
import { importPreviewStatements } from './previews'
import { newId } from './ids'
import { documentRouteOf } from './revision-paths'

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
  readonly evidence: { readonly selectionDigest: string; readonly corpusDigest: string; readonly mappingRef: string; readonly capturedAt: number; readonly complete: true; readonly g1bRef: string | null }
  readonly files: readonly ImportFile[]
  readonly operations: readonly ImportOperation[]
}
export interface AdmittedImportSelection { readonly selection: ImportSelection; readonly inventory: ApprovedImportInventory; readonly approval: ImportApproval; readonly planDigest: string; readonly sourceDigest: string }
export interface ImportMappingSummary { readonly pages: number; readonly aliases: number; readonly shortlinks: number; readonly previews: number }
const admitted = new WeakSet<object>()
const hash = async (value: string): Promise<string> => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))), x => x.toString(16).padStart(2, '0')).join('')
const hex = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
const text = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 1024
function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null'
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  const obj = value as Record<string, unknown>
  return `{${Object.keys(obj).sort().map(k => `${JSON.stringify(k)}:${canonical(obj[k])}`).join(',')}}`
}

export async function admitImportSelection(selection: ImportSelection, input: unknown, approval: ImportApproval, deps: ManageDeps): Promise<AdmittedImportSelection> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new PolicyError('invalid_state')
  const inventory = input as ApprovedImportInventory
  if (inventory.kind === 'historical' && (!text(approval.g1bRef) || inventory.evidence?.g1bRef !== approval.g1bRef)) throw new PolicyError('invalid_state', 'g1b_evidence_required')
  if (selection.version !== 1 || !text(selection.planId) || selection.inventoryId !== approval.inventoryId || selection.selectionId !== approval.selectionId || inventory.version !== 1 || inventory.inventoryId !== approval.inventoryId || inventory.selectionId !== approval.selectionId || inventory.sourceInstance !== approval.sourceInstance || inventory.approvalRef !== approval.approvalRef || inventory.kind !== approval.kind || !text(inventory.sourceArtifactId) || !inventory.evidence || inventory.evidence.complete !== true || !hex(inventory.evidence.selectionDigest) || !hex(inventory.evidence.corpusDigest) || !text(inventory.evidence.mappingRef) || !Number.isSafeInteger(inventory.evidence.capturedAt) || (inventory.kind === 'historical' && (!text(approval.g1bRef) || inventory.evidence.g1bRef !== approval.g1bRef)) || !Array.isArray(inventory.files) || !Array.isArray(inventory.operations)) throw new PolicyError('invalid_state')
  if (!inventory.command || !selection.command || canonical(inventory.command) !== canonical(selection.command) || !Array.isArray(selection.command.pages) || selection.command.pages.length === 0 || !Array.isArray(selection.command.files) || !Array.isArray(selection.command.edges)) throw new PolicyError('invalid_state', 'selection_graph_mismatch')
  if (!Array.isArray(inventory.pageMappings) || !Array.isArray(inventory.edgeEvidence)) throw new PolicyError('invalid_state', 'selection_graph_mismatch')
  const livePages = selection.command.pages.filter(page => page.disposition !== 'drop')
  if (inventory.pageMappings.length !== livePages.length || inventory.edgeEvidence.length !== selection.command.edges.length) throw new PolicyError('invalid_state', 'selection_graph_mismatch')
  const sourcePages = new Set<string>(), targetPages = new Set<string>()
  for (const mapping of inventory.pageMappings) {
    if (!mapping || !text(mapping.sourcePageId) || !text(mapping.pageId) || !text(mapping.route) || !text(mapping.ownershipEvidenceRef) || sourcePages.has(mapping.sourcePageId) || targetPages.has(mapping.pageId) || !livePages.some(p => p.pageId === mapping.pageId && p.documentPath === mapping.documentPath)) throw new PolicyError('invalid_state', 'selection_graph_mismatch')
    sourcePages.add(mapping.sourcePageId); targetPages.add(mapping.pageId)
    const route = documentRouteOf(mapping.documentPath)
    if (!route || mapping.route !== (route.kind === 'subtree' ? `/a/${route.slug}/` : `/${route.pageRef}`)) throw new PolicyError('invalid_state', 'selection_graph_mismatch')
  }
  const edgeKeys = new Set<string>()
  for (const edge of inventory.edgeEvidence) {
    const key = canonical([edge.ownerPageId,edge.path,edge.providerArtifactId])
    if (!text(edge.evidenceRef) || edgeKeys.has(key) || !selection.command.edges.some(e => e.ownerPageId === edge.ownerPageId && e.path === edge.path && e.providerArtifactId === edge.providerArtifactId)) throw new PolicyError('invalid_state', 'selection_graph_mismatch')
    edgeKeys.add(key)
  }
  const paths = new Set<string>()
  for (const file of inventory.files) {
    if (!file || !text(file.path) || paths.has(file.path) || !text(file.sourceRef) || !text(file.sourceVersion) || !text(file.provenance) || !hex(file.sha256) || !Number.isSafeInteger(file.size) || file.size < 0 || !text(file.contentType) || !['document','subdocument','fragment','asset'].includes(file.kind)) throw new PolicyError('invalid_state')
    paths.add(file.path)
    const declared = selection.command.files.find(f => f.path === file.path && f.source === 'client')
    if (!declared || declared.kind !== file.kind || declared.sha256 !== file.sha256 || declared.size !== file.size || declared.contentType !== file.contentType) throw new PolicyError('conflict')
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
      if (!p || !text(p.pageId) || !text(p.sourcePageId) || !p.visibility || p.visibility.captured !== true || !p.share || p.share.captured !== true || (p.visibility.metadataV !== null && p.visibility.metadataV !== p.visibility.value) || (p.visibility.value === 'shared' && (!p.share.key || !isShareKey(p.share.key) || !text(p.grantId))) || !selection.command.pages.some(page => page.pageId === p.pageId && page.disposition !== 'drop' && page.expectedPolicyEpoch === p.expectedPolicyEpoch)) throw new PolicyError('invalid_state')
      if (policyPages.has(p.pageId) || !inventory.pageMappings.some(m => m.pageId === p.pageId && m.sourcePageId === p.sourcePageId)) throw new PolicyError('invalid_state', 'selection_graph_mismatch')
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
      if (!targetPages.has(op.pageId) || !selection.command.files.some(f => f.path === op.path && ['image/jpeg','image/png'].includes(f.contentType))) throw new PolicyError('invalid_state', 'selection_graph_mismatch')
    } else throw new PolicyError('invalid_state')
  }
  if (selection.command.pages.some(page => page.disposition === 'new' && !policyPages.has(page.pageId))) throw new PolicyError('invalid_state', 'missing_policy_evidence')
  const sourceDigest = await hash(JSON.stringify(inventory.files.map(({path,kind,contentType,size,sha256}) => ({path,kind,contentType,size,sha256}))))
  const key = deps.config.shareVerifierKeys[0]
  if (!key) throw new PolicyError('invalid_state')
  const bytes = new TextEncoder().encode(`forge.import.plan.v1\0${canonical({selection, pin:approval.sha256, approvalRef:approval.approvalRef})}`)
  const planDigest = Array.from(new Uint8Array(await crypto.subtle.sign('HMAC', key.key, bytes)), b => b.toString(16).padStart(2, '0')).join('')
  const result = structuredClone({ selection, inventory, approval, planDigest, sourceDigest })
  const freeze = (value: unknown): void => {
    if (value && typeof value === 'object' && !Object.isFrozen(value)) {
      for (const child of Object.values(value)) freeze(child)
      Object.freeze(value)
    }
  }
  freeze(result)
  admitted.add(result)
  return result
}

export async function inspectImportTarget(deps: ManageDeps, context: AdmittedImportSelection): Promise<string> {
  if (!admitted.has(context)) throw new PolicyError('forbidden')
  const command = context.selection.command
  const artifact = command.artifactId ? await deps.db.prepare('SELECT artifact_id, active_revision_id, content_version FROM artifacts WHERE artifact_id = ?').bind(command.artifactId).first() : null
  const pages = []
  for (const page of command.pages) pages.push(await deps.db.prepare('SELECT p.page_id,p.artifact_id,p.visibility,p.policy_epoch,p.tombstoned_at,g.grant_id,g.key_kid,g.key_hmac,g.mode,g.pinned_revision_id,g.revoked_at FROM pages p LEFT JOIN share_grants g ON g.page_id=p.page_id AND g.revoked_at IS NULL WHERE p.page_id=?').bind(page.pageId).first())
  const related: unknown[] = []
  for (const file of command.files) {
    related.push((await deps.db.prepare(`SELECT path,artifact_id,revision_id,kind FROM mounts WHERE path=?`).bind(file.path).all()).results)
    related.push((await deps.db.prepare(`SELECT kind,route_key,page_id,artifact_id,redirect_to,redirect_status,target_page_id FROM routes WHERE (kind='redirect_exact' AND route_key=?) OR (kind='redirect_prefix' AND substr(?,1,length(route_key))=route_key) OR (kind='subtree' AND substr(?,1,length('/a/'||route_key||'/'))='/a/'||route_key||'/')`).bind(file.path,file.path,file.path).all()).results)
  }
  for (const page of command.pages) {
    if (!page.documentPath) continue
    const route = documentRouteOf(page.documentPath)
    if (route?.kind === 'subtree') related.push((await deps.db.prepare(`SELECT path,artifact_id,revision_id,kind FROM mounts WHERE path >= ? AND path < ? ORDER BY path`).bind(`/a/${route.slug}/`, `/a/${route.slug}0`).all()).results)
    if (route) related.push((await deps.db.prepare(`SELECT kind,route_key,page_id,artifact_id,document_path FROM routes WHERE kind=? AND route_key=?`).bind(route.kind, route.kind === 'subtree' ? route.slug : route.pageRef).all()).results)
  }
  for (const edge of command.edges) {
    related.push((await deps.db.prepare(`SELECT o.owner_page_id,o.path,o.provider_artifact_id,o.owner_revision_id FROM resource_owners o JOIN artifacts a ON a.active_revision_id=o.owner_revision_id WHERE o.owner_page_id=? AND o.path=?`).bind(edge.ownerPageId,edge.path).all()).results)
    if (edge.providerArtifactId) related.push(await deps.db.prepare('SELECT artifact_id,active_revision_id,content_version FROM artifacts WHERE artifact_id=?').bind(edge.providerArtifactId).first())
  }
  for (const op of context.inventory.operations) {
    if (op.kind === 'alias') related.push((await deps.db.prepare('SELECT * FROM routes WHERE kind=? AND route_key=?').bind(op.aliasKind,op.path).all()).results)
    if (op.kind === 'shortlink') related.push((await deps.db.prepare('SELECT * FROM shortlink_mappings WHERE mapping_id=? OR (provider_origin=? AND short_domain=? AND short_code=?)').bind(op.mapping.mappingId,op.mapping.providerOrigin,op.mapping.shortDomain,op.mapping.shortCode).all()).results)
    if (op.kind === 'preview_selection') related.push((await deps.db.prepare('SELECT * FROM preview_selections WHERE page_id=?').bind(op.pageId).all()).results)
  }
  related.push((await deps.db.prepare('SELECT plan_id,plan_digest,artifact_id,revision_id FROM publication_imports WHERE instance_id=? AND source_instance=? AND source_artifact_id=?').bind(deps.config.instanceId,context.inventory.sourceInstance,context.inventory.sourceArtifactId).all()).results)
  const key = deps.config.shareVerifierKeys[0]
  if (!key) throw new PolicyError('invalid_state')
  return Array.from(new Uint8Array(await crypto.subtle.sign('HMAC', key.key, new TextEncoder().encode(`forge.import.target.v1\0${canonical({artifact,pages,related})}`))), b => b.toString(16).padStart(2,'0')).join('')
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
  for (const op of [...inventory.operations.filter(op => op.kind === 'page_policy'), ...inventory.operations.filter(op => op.kind !== 'page_policy')]) {
    const operationId = op.kind === 'page_policy' ? op.policy.operationId : op.operationId
    let after: object
    if (op.kind === 'page_policy') {
      const p = op.policy
      const visibility = p.visibility.value === 'public' ? 'public' : p.visibility.value === 'shared' ? 'shared' : 'private'
      const epoch = p.expectedPolicyEpoch ?? 0
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

export async function assertImportReplay(deps: ManageDeps, actor: ManageActor, context: AdmittedImportSelection, target: CompletionTarget): Promise<ImportMappingSummary> {
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
      checks.push(assertion(db, `EXISTS (SELECT 1 FROM pages WHERE page_id=? AND artifact_id=? AND visibility=? AND policy_epoch=? AND tombstoned_at IS NULL)`, p.pageId, target.artifactId, visibility, (p.expectedPolicyEpoch ?? 0) + 1))
      if (visibility === 'shared' && p.share.key) {
        const keys = await shareKeyDigests(deps.config.shareVerifierKeys, deps.config.instanceId, p.share.key)
        const alternatives = keys.map(() => '(key_kid=? AND key_hmac=?)').join(' OR ')
        checks.push(assertion(db, `EXISTS (SELECT 1 FROM share_grants g JOIN catalogue_import_operations o ON o.instance_id=? AND o.plan_id=? AND o.operation_id=? WHERE g.grant_id=? AND g.page_id=? AND g.mode='follow_active' AND g.origin='imported' AND g.pinned_revision_id IS NULL AND g.revoked_at IS NULL AND g.key_kid=json_extract(o.after_json,'$.verifier.kid') AND g.key_hmac=json_extract(o.after_json,'$.verifier.hmac') AND (${alternatives}))`, deps.config.instanceId, target.planId, id, p.grantId, p.pageId, ...keys.flatMap(k => [k.kid,k.hmac])))
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
  await executeGuarded(deps, actor, [{action:'import_state',requestDigest:context.planDigest,occurredAt:deps.now()}], checks)
  return summary(context)
}

export async function inspectImportConflicts(deps: ManageDeps, context: AdmittedImportSelection): Promise<readonly { code: string; pageId?: string; path?: string }[]> {
  if (!admitted.has(context)) throw new PolicyError('forbidden')
  const issues: { code: string; pageId?: string; path?: string }[] = []
  const { db } = deps
  const mapping = await db.prepare('SELECT artifact_id FROM publication_imports WHERE instance_id=? AND source_instance=? AND source_artifact_id=? LIMIT 1').bind(deps.config.instanceId,context.inventory.sourceInstance,context.inventory.sourceArtifactId).first<{artifact_id:string}>()
  if (mapping && mapping.artifact_id !== context.selection.command.artifactId) issues.push({code:'source_mapping_conflict'})
  for (const op of context.inventory.operations) {
    if (op.kind === 'page_policy') {
      const p = op.policy
      const row = await db.prepare('SELECT artifact_id,policy_epoch,tombstoned_at FROM pages WHERE page_id=?').bind(p.pageId).first<{artifact_id:string;policy_epoch:number;tombstoned_at:number|null}>()
      if (p.expectedPolicyEpoch === null ? row !== null : !row || row.artifact_id !== context.selection.command.artifactId || row.policy_epoch !== p.expectedPolicyEpoch || row.tombstoned_at !== null) issues.push({code:'policy_conflict',pageId:p.pageId})
    } else if (op.kind === 'alias') {
      const row = await db.prepare('SELECT redirect_to,redirect_status,target_page_id FROM routes WHERE kind=? AND route_key=?').bind(op.aliasKind,op.path).first<{redirect_to:string;redirect_status:number;target_page_id:string|null}>()
      if (row && (row.redirect_to !== op.to || row.redirect_status !== op.status || row.target_page_id !== op.targetPageId)) issues.push({code:'alias_conflict',path:op.path})
    } else if (op.kind === 'shortlink') {
      const m = op.mapping
      const row = await db.prepare('SELECT * FROM shortlink_mappings WHERE mapping_id=? OR (provider_origin=? AND short_domain=? AND short_code=?) LIMIT 1').bind(m.mappingId,m.providerOrigin,m.shortDomain,m.shortCode).first<Record<string,unknown>>()
      if (row && (row.mapping_id !== m.mappingId || row.provider_origin !== m.providerOrigin || row.provider_id !== m.providerId || row.short_domain !== m.shortDomain || row.short_code !== m.shortCode || row.short_url !== m.shortUrl || row.page_id !== m.pageId || row.grant_id !== m.grantId || row.destination !== m.destination || row.source !== m.source || row.observed_at !== m.observedAt || row.destination_digest !== m.destinationDigest)) issues.push({code:'shortlink_conflict',pageId:m.pageId ?? undefined})
    }
  }
  return issues
}
