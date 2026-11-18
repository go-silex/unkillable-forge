import { executeGuarded, PolicyError } from '../catalogue/guard'
import type { ManageDeps } from '../catalogue/commands'
import type { ManageActor } from '../catalogue/principals'
import { DerivedStore, type DerivedDescriptor } from '../store/derived-store'
import type { DerivedObjectRef } from '../store/derived-store'
import { renderGraphAssertionStatements, verifyRenderGraph, type RenderGraph } from '../catalogue/render-graph'

const leases = new WeakMap<object, { jobId: string; token: string; attempt: number }>()
export interface EnrichmentAttempt { readonly jobId: string; readonly attempt: number }
export type EnqueueEnrichment = {
  readonly artifactId: string; readonly revisionId: string; readonly pageId: string
  readonly expectedContentVersion: number; readonly expectedPolicyEpoch: number
  readonly inputSha256: string; readonly desiredGrantId: string | null
} & ({ readonly kind: 'og'; readonly graph: RenderGraph } | { readonly kind: 'shortlink'; readonly mappingId: string; readonly providerOrigin: string; readonly shortDomain: string; readonly shortCode: string; readonly destinationSha256: string })
const validTarget = `EXISTS (SELECT 1 FROM pages p JOIN artifacts a ON a.artifact_id = p.artifact_id
  JOIN revision_pages rp ON rp.page_id = p.page_id AND rp.revision_id = j.revision_id
  WHERE p.page_id = j.page_id AND p.artifact_id = j.artifact_id AND p.tombstoned_at IS NULL
    AND p.policy_epoch = j.expected_policy_epoch AND a.content_version = j.expected_content_version
    AND a.active_revision_id = j.revision_id
    AND NOT EXISTS (SELECT 1 FROM revision_discards d WHERE d.revision_id = j.revision_id)
    AND (j.desired_grant_id IS NULL OR EXISTS (SELECT 1 FROM share_grants g WHERE g.grant_id = j.desired_grant_id AND g.page_id = j.page_id AND g.revoked_at IS NULL AND p.visibility = 'shared' AND (g.mode = 'follow_active' OR (g.mode = 'pinned' AND g.pinned_revision_id = j.revision_id)))))`

function nowValue(now: () => number): number {
  const value = now()
  if (!Number.isSafeInteger(value) || value < 0) throw new PolicyError('invalid_state')
  return value
}
function handle(attempt: EnrichmentAttempt) {
  const value = leases.get(attempt)
  if (!value || value.jobId !== attempt.jobId || value.attempt !== attempt.attempt) throw new PolicyError('forbidden')
  return value
}
function assertStatement(db: D1Database, assertion: string, predicate: string, values: unknown[]): D1PreparedStatement {
  return db.prepare(`INSERT INTO enrichment_assertions (assertion_id,verdict) SELECT ?, CASE WHEN ${predicate} THEN 'ok' ELSE 'conflict' END`).bind(assertion, ...values)
}

/** Serialized graph chunks stay below D1's per-value bound, including UTF-8 expansion. */
export function enrichmentGraphChunks(graph: RenderGraph): string[] {
  const json = JSON.stringify(graph), chunks: string[] = []
  for (let start = 0; start < json.length;) {
    let end = Math.min(start + 16000, json.length)
    if (end < json.length && json.charCodeAt(end - 1) >= 0xd800 && json.charCodeAt(end - 1) <= 0xdbff) end--
    chunks.push(json.slice(start, end)); start = end
  }
  return chunks
}

export async function validateEnrichmentGraph(graph: RenderGraph, expected: { instanceId: string; artifactId: string; revisionId: string; pageId: string; policyEpoch: number; contentVersion: number; inputSha256: string; recipeSha256: string }): Promise<void> {
  const text = (v: unknown) => typeof v === 'string' && v.length > 0
  const hash = (v: unknown) => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v)
  if (!graph || graph.instanceId !== expected.instanceId || graph.artifactId !== expected.artifactId || graph.revisionId !== expected.revisionId || graph.pageId !== expected.pageId || graph.policyEpoch !== expected.policyEpoch || graph.contentVersion !== expected.contentVersion || !['subtree','tree_page'].includes(graph.routeKind) || !text(graph.routeKey) || !text(graph.documentPath) || !Array.isArray(graph.resources)) throw new PolicyError('invalid_state')
  const paths = new Set<string>()
  let documents = 0
  for (const r of graph.resources) {
    if (!r || !text(r.path) || paths.has(r.path) || !['document','subdocument','fragment','asset'].includes(r.kind) || !text(r.artifactId) || !text(r.revisionId) || !text(r.objectKey) || !text(r.objectVersion) || !hash(r.sha256) || !Number.isSafeInteger(r.size) || r.size < 0 || !text(r.contentType) || new TextEncoder().encode(JSON.stringify(r)).length + 2 > 65536) throw new PolicyError('invalid_state')
    if (r.path === graph.documentPath && r.kind === 'document') documents++
    paths.add(r.path)
  }
  if (documents !== 1) throw new PolicyError('invalid_state')
  await verifyRenderGraph(graph, expected.inputSha256, expected.recipeSha256)
}

export async function loadEnrichmentOgGraph(db: D1Database, instanceId: string, jobId: string): Promise<RenderGraph> {
  const results = await db.batch([
    db.prepare("SELECT j.* FROM enrichment_jobs j JOIN instance_meta i ON i.singleton=1 AND i.instance_id=? WHERE j.job_id=? AND j.kind='og'").bind(instanceId,jobId),
    db.prepare('SELECT chunk_index,payload FROM enrichment_graph_chunks WHERE job_id=? ORDER BY chunk_index').bind(jobId),
  ])
  const job = results[0].results[0] as { artifact_id: string; revision_id: string; page_id: string; expected_policy_epoch: number; expected_content_version: number; input_sha256: string; recipe_sha256: string } | undefined
  const chunks = results[1].results as { chunk_index: number; payload: string }[]
  if (!job || !chunks.length || chunks.some((c, i) => c.chunk_index !== i || typeof c.payload !== 'string' || !c.payload || new TextEncoder().encode(c.payload).length > 65536)) throw new PolicyError('invalid_state')
  let graph: RenderGraph
  try { graph = JSON.parse(chunks.map(c => c.payload).join('')) as RenderGraph } catch { throw new PolicyError('invalid_state') }
  await validateEnrichmentGraph(graph, { instanceId, artifactId: job.artifact_id, revisionId: job.revision_id, pageId: job.page_id, policyEpoch: job.expected_policy_epoch, contentVersion: job.expected_content_version, inputSha256: job.input_sha256, recipeSha256: job.recipe_sha256 })
  return graph
}

/** Compose an unprepared intent into the caller's guarded publication transaction. */
export function ogIntentStatement(db: D1Database, input: { jobId: string; artifactId: string; revisionId: string; pageId: string; expectedContentVersion: number; expectedPolicyEpoch: number; desiredGrantId: string | null; now: number }): D1PreparedStatement {
  if (!input.jobId || !input.artifactId || !input.revisionId || !input.pageId || !Number.isSafeInteger(input.expectedContentVersion) || input.expectedContentVersion < 0 || !Number.isSafeInteger(input.expectedPolicyEpoch) || input.expectedPolicyEpoch < 0 || !Number.isSafeInteger(input.now) || input.now < 0) throw new PolicyError('invalid_state')
  return db.prepare("INSERT INTO enrichment_jobs (job_id,artifact_id,revision_id,page_id,kind,input_sha256,recipe_sha256,desired_grant_id,expected_content_version,expected_policy_epoch,state,attempt,created_at,updated_at) SELECT ?,?,?,?,'og',NULL,NULL,?,?,?,'pending',0,?,? WHERE NOT EXISTS (SELECT 1 FROM enrichment_jobs WHERE kind='og' AND artifact_id=? AND revision_id=? AND page_id=? AND expected_content_version=? AND expected_policy_epoch=? AND desired_grant_id IS ?)").bind(input.jobId,input.artifactId,input.revisionId,input.pageId,input.desiredGrantId,input.expectedContentVersion,input.expectedPolicyEpoch,input.now,input.now,input.artifactId,input.revisionId,input.pageId,input.expectedContentVersion,input.expectedPolicyEpoch,input.desiredGrantId)
}

/** Read the immutable target needed to capture an intent's graph. */
export async function readOgIntent(db: D1Database, instanceId: string, jobId: string): Promise<{ artifactId: string; revisionId: string; pageId: string; expectedContentVersion: number; expectedPolicyEpoch: number; prepared: boolean }> {
  const row = await db.prepare("SELECT j.artifact_id,j.revision_id,j.page_id,j.expected_content_version,j.expected_policy_epoch,j.input_sha256 FROM enrichment_jobs j JOIN instance_meta i ON i.singleton=1 AND i.instance_id=? WHERE j.job_id=? AND j.kind='og'").bind(instanceId,jobId).first<{ artifact_id: string; revision_id: string; page_id: string; expected_content_version: number; expected_policy_epoch: number; input_sha256: string | null }>()
  if (!row) throw new PolicyError('not_found')
  return { artifactId: row.artifact_id, revisionId: row.revision_id, pageId: row.page_id, expectedContentVersion: row.expected_content_version, expectedPolicyEpoch: row.expected_policy_epoch, prepared: row.input_sha256 !== null }
}

/** Freeze a pending intent only while its complete captured provider graph is current. */
export async function prepareEnrichmentOg(deps: ManageDeps, actor: ManageActor, jobId: string, graph: RenderGraph): Promise<void> {
  const job = await deps.db.prepare("SELECT artifact_id,revision_id,page_id,expected_content_version,expected_policy_epoch FROM enrichment_jobs WHERE job_id=? AND kind='og'").bind(jobId).first<{ artifact_id: string; revision_id: string; page_id: string; expected_content_version: number; expected_policy_epoch: number }>()
  if (!job) throw new PolicyError('not_found')
  await validateEnrichmentGraph(graph, { instanceId: deps.config.instanceId, artifactId: job.artifact_id, revisionId: job.revision_id, pageId: job.page_id, policyEpoch: job.expected_policy_epoch, contentVersion: job.expected_content_version, inputSha256: graph.inputSha256, recipeSha256: graph.recipeSha256 })
  const now = nowValue(deps.now), assertion = crypto.randomUUID()
  const graphAssertions = renderGraphAssertionStatements(deps.db, graph)
  await executeGuarded(deps, actor, [{ action:'enrich_page',artifactId:job.artifact_id,revisionId:job.revision_id,pageId:job.page_id,expectedContentVersion:job.expected_content_version,expectedPolicyEpoch:job.expected_policy_epoch,requestDigest:graph.inputSha256,occurredAt:now }], [
    assertStatement(deps.db, assertion, `EXISTS (SELECT 1 FROM enrichment_jobs j WHERE j.job_id=? AND j.kind='og' AND j.state='pending' AND j.attempt=0 AND j.input_sha256 IS NULL AND j.recipe_sha256 IS NULL AND j.artifact_id=? AND j.revision_id=? AND j.page_id=? AND j.expected_content_version=? AND j.expected_policy_epoch=? AND j.created_at<=? AND NOT EXISTS (SELECT 1 FROM enrichment_graph_chunks c WHERE c.job_id=j.job_id) AND ${validTarget})`, [jobId,job.artifact_id,job.revision_id,job.page_id,job.expected_content_version,job.expected_policy_epoch,now]),
    ...graphAssertions.assertions,
    deps.db.prepare('UPDATE enrichment_jobs SET input_sha256=?,recipe_sha256=?,updated_at=? WHERE job_id=?').bind(graph.inputSha256,graph.recipeSha256,now,jobId),
    ...enrichmentGraphChunks(graph).map((chunk, index) => deps.db.prepare('INSERT INTO enrichment_graph_chunks (job_id,chunk_index,payload) VALUES (?,?,?)').bind(jobId,index,chunk)),
    ...graphAssertions.cleanups,
    deps.db.prepare('DELETE FROM enrichment_assertions WHERE assertion_id=?').bind(assertion),
  ])
}

/** Enqueue is a guarded Catalogue mutation and cannot alter publication receipts. */
export async function enqueueEnrichment(deps: ManageDeps, actor: ManageActor, input: EnqueueEnrichment): Promise<string> {
  if (!input || !['og','shortlink'].includes(input.kind) || !/^[a-f0-9]{64}$/.test(input.inputSha256) || (input.kind === 'shortlink' && (!input.mappingId || !input.providerOrigin || !/^[a-z0-9.-]+(?::[0-9]+)?$/.test(input.shortDomain) || !input.shortCode || !/^[a-f0-9]{64}$/.test(input.destinationSha256)))) throw new PolicyError('invalid_state')
  if (input.kind === 'og') await validateEnrichmentGraph(input.graph, { instanceId: deps.config.instanceId, artifactId: input.artifactId, revisionId: input.revisionId, pageId: input.pageId, policyEpoch: input.expectedPolicyEpoch, contentVersion: input.expectedContentVersion, inputSha256: input.inputSha256, recipeSha256: input.graph?.recipeSha256 })
  const graphAssertions = input.kind === 'og' ? renderGraphAssertionStatements(deps.db, input.graph) : { assertions: [], cleanups: [] }
  const now = nowValue(deps.now), jobId = crypto.randomUUID(), assertion = crypto.randomUUID()
  const digest = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(input)))), x => x.toString(16).padStart(2,'0')).join('')
  await executeGuarded(deps, actor, [{ action: 'enrich_page', artifactId: input.artifactId, revisionId: input.revisionId, pageId: input.pageId, expectedContentVersion: input.expectedContentVersion, expectedPolicyEpoch: input.expectedPolicyEpoch, requestDigest: digest, occurredAt: now }], [
    assertStatement(deps.db, assertion, `? IS NULL OR EXISTS (SELECT 1 FROM share_grants g JOIN pages p ON p.page_id = g.page_id WHERE g.grant_id = ? AND g.page_id = ? AND g.revoked_at IS NULL AND p.visibility = 'shared' AND (g.mode='follow_active' OR (g.mode='pinned' AND g.pinned_revision_id=?)))`, [input.desiredGrantId,input.desiredGrantId,input.pageId,input.revisionId]),
    ...graphAssertions.assertions,
    deps.db.prepare(`INSERT INTO enrichment_jobs (job_id,artifact_id,revision_id,page_id,kind,input_sha256,recipe_sha256,desired_grant_id,desired_mapping_id,provider_origin,requested_short_domain,requested_short_code,destination_sha256,expected_content_version,expected_policy_epoch,state,attempt,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'pending',0,?,?)`).bind(jobId,input.artifactId,input.revisionId,input.pageId,input.kind,input.inputSha256,input.kind === 'og' ? input.graph.recipeSha256 : null,input.desiredGrantId,input.kind === 'shortlink' ? input.mappingId : null,input.kind === 'shortlink' ? input.providerOrigin : null,input.kind === 'shortlink' ? input.shortDomain : null,input.kind === 'shortlink' ? input.shortCode : null,input.kind === 'shortlink' ? input.destinationSha256 : null,input.expectedContentVersion,input.expectedPolicyEpoch,now,now),
    ...(input.kind === 'og' ? enrichmentGraphChunks(input.graph).map((chunk, index) => deps.db.prepare('INSERT INTO enrichment_graph_chunks (job_id,chunk_index,payload) VALUES (?,?,?)').bind(jobId,index,chunk)) : []),
    ...graphAssertions.cleanups,
    deps.db.prepare('DELETE FROM enrichment_assertions WHERE assertion_id = ?').bind(assertion),
  ])
  return jobId
}

/** A process-local attempt handle is not a caller-supplied lease token. */
export async function claimEnrichment(db: D1Database, instanceId: string, jobId: string, now: number, leaseMs: number): Promise<EnrichmentAttempt> {
  if (!Number.isSafeInteger(now) || now < 0 || !Number.isSafeInteger(leaseMs) || leaseMs < 1 || leaseMs > 120_000 || !Number.isSafeInteger(now + leaseMs)) throw new PolicyError('invalid_state')
  const token = crypto.randomUUID(), assertion = crypto.randomUUID()
  try {
    const result = await db.batch([
      assertStatement(db, assertion, `EXISTS (SELECT 1 FROM enrichment_jobs j JOIN instance_meta i ON i.singleton = 1 AND i.instance_id = ? WHERE j.job_id = ? AND j.input_sha256 IS NOT NULL AND (j.state = 'pending' OR (j.state = 'running' AND j.lease_expires_at <= ?)) AND ${validTarget})`, [instanceId,jobId,now]),
      db.prepare(`UPDATE enrichment_attempts SET completed_at = ?, outcome = 'expired' WHERE job_id = ? AND completed_at IS NULL`).bind(now,jobId),
      db.prepare(`UPDATE enrichment_jobs SET state='running', attempt=attempt+1, lease_token=?, lease_expires_at=?, updated_at=? WHERE job_id=?`).bind(token,now+leaseMs,now,jobId),
      db.prepare(`INSERT INTO enrichment_attempts (job_id,attempt,lease_token,started_at,lease_expires_at) SELECT job_id,attempt,lease_token,?,lease_expires_at FROM enrichment_jobs WHERE job_id=?`).bind(now,jobId),
      db.prepare('SELECT attempt FROM enrichment_jobs WHERE job_id=? AND lease_token=?').bind(jobId,token),
      db.prepare('DELETE FROM enrichment_assertions WHERE assertion_id=?').bind(assertion),
    ])
    const attempt = (result[4].results[0] as { attempt: number } | undefined)?.attempt
    if (!Number.isSafeInteger(attempt)) throw new PolicyError('unavailable')
    const value = Object.freeze({ jobId, attempt: attempt! }); leases.set(value, { jobId, attempt: attempt!, token }); return value
  } catch (error) { if (error instanceof PolicyError) throw error; throw new PolicyError('conflict') }
}

export async function renewEnrichment(db: D1Database, instanceId: string, attempt: EnrichmentAttempt, now: number, leaseMs: number): Promise<void> {
  const lease = handle(attempt)
  if (!Number.isSafeInteger(now) || now < 0 || !Number.isSafeInteger(leaseMs) || leaseMs < 1 || leaseMs > 120_000 || !Number.isSafeInteger(now + leaseMs)) throw new PolicyError('invalid_state')
  const assertion = crypto.randomUUID()
  try { await db.batch([
    assertStatement(db, assertion, `EXISTS (SELECT 1 FROM enrichment_jobs j JOIN instance_meta i ON i.singleton=1 AND i.instance_id=? WHERE j.job_id=? AND j.state='running' AND j.attempt=? AND j.lease_token=? AND j.lease_expires_at>? AND ${validTarget})`, [instanceId,lease.jobId,lease.attempt,lease.token,now]),
    db.prepare('UPDATE enrichment_jobs SET lease_expires_at=?, updated_at=? WHERE job_id=?').bind(now+leaseMs,now,lease.jobId),
    db.prepare('UPDATE enrichment_attempts SET lease_expires_at=? WHERE job_id=? AND attempt=? AND lease_token=?').bind(now+leaseMs,lease.jobId,lease.attempt,lease.token),
    db.prepare('DELETE FROM enrichment_assertions WHERE assertion_id=?').bind(assertion),
  ]) } catch { throw new PolicyError('conflict') }
}

/** A timed-out PUT can leave unselected immutable bytes; no physical collection is performed here. */
export async function putEnrichmentOg(db: D1Database, instanceId: string, attempt: EnrichmentAttempt, store: DerivedStore, ref: DerivedObjectRef, expected: { size: number; sha256: string }, body: ReadableStream<Uint8Array>, clock: () => number, deadlineMs: number): Promise<DerivedDescriptor> {
  const lease = handle(attempt)
  if (!Number.isSafeInteger(deadlineMs) || deadlineMs < 1 || deadlineMs > 120_000) throw new PolicyError('invalid_state')
  const started = nowValue(clock), deadline = started + deadlineMs
  if (!Number.isSafeInteger(deadline)) throw new PolicyError('invalid_state')
  const assertion = crypto.randomUUID()
  await db.batch([
    assertStatement(db, assertion, `EXISTS (SELECT 1 FROM enrichment_jobs j JOIN instance_meta i ON i.singleton=1 AND i.instance_id=? WHERE j.job_id=? AND j.state='running' AND j.kind='og' AND j.attempt=? AND j.lease_token=? AND j.lease_expires_at>=? AND j.page_id=? AND j.artifact_id=? AND j.revision_id=? AND j.input_sha256=? AND j.recipe_sha256=? AND ${validTarget})`, [instanceId,lease.jobId,lease.attempt,lease.token,deadline,ref.pageId,ref.artifactId,ref.revisionId,ref.inputSha256,ref.recipeSha256]),
    db.prepare('DELETE FROM enrichment_assertions WHERE assertion_id=?').bind(assertion),
  ])
  const remaining = deadline - nowValue(clock)
  if (remaining < 1 || remaining > deadlineMs) throw new PolicyError('conflict')
  const signal = AbortSignal.timeout(remaining)
  const descriptor = await store.put(ref, expected, body, signal)
  const finished = nowValue(clock)
  if (signal.aborted || finished < started || finished >= deadline) throw new PolicyError('conflict')
  return descriptor
}

/** Select only bytes already verified by Store; stale attempts cannot select them. */
export async function finalizeOg(deps: ManageDeps, actor: ManageActor, attempt: EnrichmentAttempt, store: DerivedStore, descriptor: DerivedDescriptor, signal?: AbortSignal): Promise<void> {
  const { db, config } = deps, instanceId = config.instanceId
  const lease = handle(attempt)
  if (descriptor.ref.extension !== 'jpg') throw new PolicyError('invalid_state')
  const stored = await store.head(descriptor.ref)
  if (!stored || stored.objectVersion !== descriptor.objectVersion || stored.objectKey !== descriptor.objectKey || stored.size !== descriptor.size || stored.sha256 !== descriptor.sha256) throw new PolicyError('invalid_state')
  const r = descriptor.ref, assertion = crypto.randomUUID()
  const graph = await loadEnrichmentOgGraph(db, instanceId, lease.jobId)
  const graphAssertions = renderGraphAssertionStatements(db, graph)
  const now = nowValue(deps.now)
  if (signal?.aborted) throw new PolicyError('conflict')
  await executeGuarded(deps, actor, [{ action:'enrich_page', artifactId:graph.artifactId, revisionId:graph.revisionId, pageId:graph.pageId, expectedContentVersion:graph.contentVersion, expectedPolicyEpoch:graph.policyEpoch, requestDigest:graph.inputSha256, occurredAt:now }], [
    assertStatement(db, assertion, `EXISTS (SELECT 1 FROM enrichment_jobs j JOIN instance_meta i ON i.singleton=1 AND i.instance_id=? WHERE j.job_id=? AND j.state='running' AND j.attempt=? AND j.lease_token=? AND j.lease_expires_at>? AND j.kind='og' AND j.page_id=? AND j.artifact_id=? AND j.revision_id=? AND j.input_sha256=? AND j.recipe_sha256=? AND ${validTarget})`, [instanceId,lease.jobId,lease.attempt,lease.token,now,r.pageId,r.artifactId,r.revisionId,r.inputSha256,r.recipeSha256]),
    ...graphAssertions.assertions,
    assertStatement(db, `${assertion}-object`, `NOT EXISTS (SELECT 1 FROM preview_objects o WHERE o.page_id=? AND o.revision_id=? AND o.recipe_sha256=? AND o.input_sha256=? AND o.content_sha256=? AND o.extension=? AND (o.artifact_id<>? OR o.size<>? OR o.object_version<>?))`, [r.pageId,r.revisionId,r.recipeSha256,r.inputSha256,r.contentSha256,r.extension,r.artifactId,descriptor.size,descriptor.objectVersion]),
    db.prepare('INSERT INTO preview_objects (page_id,revision_id,artifact_id,recipe_sha256,input_sha256,content_sha256,extension,size,object_version) VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT DO NOTHING').bind(r.pageId,r.revisionId,r.artifactId,r.recipeSha256,r.inputSha256,r.contentSha256,r.extension,descriptor.size,descriptor.objectVersion),
    db.prepare(`INSERT INTO preview_selections (page_id,revision_id,recipe_sha256,input_sha256,content_sha256,extension) VALUES (?,?,?,?,?,?) ON CONFLICT(page_id,revision_id) DO UPDATE SET recipe_sha256=excluded.recipe_sha256,input_sha256=excluded.input_sha256,content_sha256=excluded.content_sha256,extension=excluded.extension WHERE preview_selections.original_path IS NULL`).bind(r.pageId,r.revisionId,r.recipeSha256,r.inputSha256,r.contentSha256,r.extension),
    db.prepare(`UPDATE enrichment_jobs SET state='ready',result_source=CASE WHEN EXISTS (SELECT 1 FROM preview_selections s WHERE s.page_id=enrichment_jobs.page_id AND s.revision_id=enrichment_jobs.revision_id AND s.original_path IS NOT NULL) OR EXISTS (SELECT 1 FROM routes r JOIN revision_resources rr ON rr.revision_id=enrichment_jobs.revision_id JOIN pages p ON p.page_id=r.page_id WHERE r.page_id=enrichment_jobs.page_id AND rr.content_type IN ('image/jpeg','image/png') AND ((r.kind='subtree' AND rr.path IN ('/a/'||r.route_key||'/og.jpg','/a/'||r.route_key||'/og.jpeg','/a/'||r.route_key||'/og.png')) OR (r.kind='tree_page' AND (rr.path IN ('/'||substr(r.route_key,1,length(r.route_key)-5)||'.og.jpg','/'||substr(r.route_key,1,length(r.route_key)-5)||'.og.jpeg','/'||substr(r.route_key,1,length(r.route_key)-5)||'.og.png') OR ((r.route_key='index.html' OR r.route_key LIKE '%/index.html') AND rr.path IN ('/'||substr(r.route_key,1,length(r.route_key)-10)||'og.jpg','/'||substr(r.route_key,1,length(r.route_key)-10)||'og.jpeg','/'||substr(r.route_key,1,length(r.route_key)-10)||'og.png'))) AND EXISTS (SELECT 1 FROM resource_owners ro WHERE ro.owner_revision_id=rr.revision_id AND ro.owner_page_id=p.page_id AND ro.path=rr.path AND ro.provider_artifact_id=p.artifact_id)))) THEN 'preserved' ELSE 'generated' END,lease_token=NULL,lease_expires_at=NULL,updated_at=? WHERE job_id=?`).bind(now,lease.jobId),
    db.prepare("UPDATE enrichment_attempts SET completed_at=?,outcome='ready' WHERE job_id=? AND attempt=? AND lease_token=?").bind(now,lease.jobId,lease.attempt,lease.token),
    db.prepare('DELETE FROM enrichment_assertions WHERE assertion_id=?').bind(assertion),
    ...graphAssertions.cleanups,
    db.prepare('DELETE FROM enrichment_assertions WHERE assertion_id=?').bind(`${assertion}-object`),
  ]); leases.delete(attempt)
}

/** Finalize only the exact provider identity and destination admitted in the job. */
export async function finalizeShortlink(deps: ManageDeps, actor: ManageActor, attempt: EnrichmentAttempt): Promise<void> {
  const { db, config } = deps, instanceId = config.instanceId
  const lease = handle(attempt), assertion = crypto.randomUUID()
  const job = await db.prepare("SELECT artifact_id,revision_id,page_id,expected_content_version,expected_policy_epoch,input_sha256 FROM enrichment_jobs WHERE job_id=? AND kind='shortlink'").bind(lease.jobId).first<{ artifact_id: string; revision_id: string; page_id: string; expected_content_version: number; expected_policy_epoch: number; input_sha256: string }>()
  if (!job) throw new PolicyError('not_found')
  const now = nowValue(deps.now)
  await executeGuarded(deps, actor, [{ action:'enrich_page', artifactId:job.artifact_id, revisionId:job.revision_id, pageId:job.page_id, expectedContentVersion:job.expected_content_version, expectedPolicyEpoch:job.expected_policy_epoch, requestDigest:job.input_sha256, occurredAt:now }], [
    assertStatement(db, assertion, `EXISTS (SELECT 1 FROM enrichment_jobs j JOIN instance_meta i ON i.singleton=1 AND i.instance_id=? JOIN shortlink_mappings m ON m.mapping_id=j.desired_mapping_id AND m.provider_origin=j.provider_origin AND m.short_domain=j.requested_short_domain AND m.short_code=j.requested_short_code AND m.destination_digest=j.destination_sha256 AND m.page_id=j.page_id AND m.grant_id IS j.desired_grant_id WHERE j.job_id=? AND j.state='running' AND j.kind='shortlink' AND j.attempt=? AND j.lease_token=? AND j.lease_expires_at>? AND ${validTarget})`, [instanceId,lease.jobId,lease.attempt,lease.token,now]),
    db.prepare("UPDATE enrichment_jobs SET state='ready',result_source=(SELECT CASE source WHEN 'created' THEN 'created' ELSE 'preserved' END FROM shortlink_mappings WHERE mapping_id=enrichment_jobs.desired_mapping_id),lease_token=NULL,lease_expires_at=NULL,updated_at=? WHERE job_id=?").bind(now,lease.jobId),
    db.prepare("UPDATE enrichment_attempts SET completed_at=?,outcome='ready' WHERE job_id=? AND attempt=? AND lease_token=?").bind(now,lease.jobId,lease.attempt,lease.token),
    db.prepare('DELETE FROM enrichment_assertions WHERE assertion_id=?').bind(assertion),
  ]); leases.delete(attempt)
}

export type EnrichmentErrorCode = 'render_timeout' | 'render_rejected' | 'render_unavailable' | 'integrity_error' | 'shortlink_unavailable' | 'shortlink_conflict' | 'target_changed'

export async function failEnrichment(db: D1Database, instanceId: string, attempt: EnrichmentAttempt, now: number, code: EnrichmentErrorCode, retryable: boolean): Promise<void> {
  const lease = handle(attempt), assertion = crypto.randomUUID()
  if (!Number.isSafeInteger(now) || now < 0 || !['render_timeout','render_rejected','render_unavailable','integrity_error','shortlink_unavailable','shortlink_conflict','target_changed'].includes(code) || typeof retryable !== 'boolean') throw new PolicyError('invalid_state')
  try { await db.batch([
    assertStatement(db, assertion, `EXISTS (SELECT 1 FROM enrichment_jobs j JOIN instance_meta i ON i.singleton=1 AND i.instance_id=? WHERE j.job_id=? AND j.state='running' AND j.attempt=? AND j.lease_token=? AND j.lease_expires_at>?)`, [instanceId,lease.jobId,lease.attempt,lease.token,now]),
    db.prepare("UPDATE enrichment_jobs SET state='failed',error_code=?,retryable=?,lease_token=NULL,lease_expires_at=NULL,updated_at=? WHERE job_id=?").bind(code,retryable ? 1 : 0,now,lease.jobId),
    db.prepare("UPDATE enrichment_attempts SET completed_at=?,outcome='failed',error_code=? WHERE job_id=? AND attempt=? AND lease_token=?").bind(now,code,lease.jobId,lease.attempt,lease.token),
    db.prepare('DELETE FROM enrichment_assertions WHERE assertion_id=?').bind(assertion),
  ]); leases.delete(attempt) } catch { throw new PolicyError('conflict') }
}

/** A retry rechecks the original content, policy and grant instead of retargeting. */
export async function retryEnrichment(deps: ManageDeps, actor: ManageActor, jobId: string): Promise<void> {
  const row = await deps.db.prepare(`SELECT artifact_id,revision_id,page_id,expected_content_version,expected_policy_epoch FROM enrichment_jobs WHERE job_id=?`).bind(jobId).first<{artifact_id:string;revision_id:string;page_id:string;expected_content_version:number;expected_policy_epoch:number}>()
  if (!row) throw new PolicyError('not_found')
  const now = nowValue(deps.now), assertion = crypto.randomUUID()
  const digest = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`retry:${jobId}`))), x => x.toString(16).padStart(2,'0')).join('')
  await executeGuarded(deps, actor, [{action:'enrich_page',artifactId:row.artifact_id,revisionId:row.revision_id,pageId:row.page_id,expectedContentVersion:row.expected_content_version,expectedPolicyEpoch:row.expected_policy_epoch,requestDigest:digest,occurredAt:now}], [
    assertStatement(deps.db, assertion, `EXISTS (SELECT 1 FROM enrichment_jobs j WHERE j.job_id=? AND j.state='failed' AND j.retryable=1 AND ${validTarget})`, [jobId]),
    deps.db.prepare("UPDATE enrichment_jobs SET state='pending',error_code=NULL,retryable=NULL,updated_at=? WHERE job_id=?").bind(now,jobId),
    deps.db.prepare('DELETE FROM enrichment_assertions WHERE assertion_id=?').bind(assertion),
  ])
}

/** Internal, bounded single-job transition; it cannot alter Catalogue or publication state. */
export async function supersedeEnrichment(db: D1Database, instanceId: string, jobId: string, now: number): Promise<void> {
  if (!Number.isSafeInteger(now) || now < 0) throw new PolicyError('invalid_state')
  const assertion = crypto.randomUUID()
  try { await db.batch([
    assertStatement(db, assertion, `EXISTS (SELECT 1 FROM enrichment_jobs j JOIN instance_meta i ON i.singleton=1 AND i.instance_id=? WHERE j.job_id=? AND j.state IN ('pending','running') AND NOT ${validTarget})`, [instanceId,jobId]),
    db.prepare("UPDATE enrichment_attempts SET completed_at=?,outcome='superseded' WHERE job_id=? AND completed_at IS NULL").bind(now,jobId),
    db.prepare("UPDATE enrichment_jobs SET state='superseded',lease_token=NULL,lease_expires_at=NULL,updated_at=? WHERE job_id=?").bind(now,jobId),
    db.prepare('DELETE FROM enrichment_assertions WHERE assertion_id=?').bind(assertion),
  ]) } catch { throw new PolicyError('conflict') }
}

/** Retry requested kinds atomically, repairing only a missing committed-publication OG intent. */
export async function retryEnrichmentKinds(deps: ManageDeps, actor: ManageActor, input: {
  artifactId: string; revisionId: string; pageId: string; expectedContentVersion: number; expectedPolicyEpoch: number; kinds: readonly ('og' | 'shortlink')[]
}): Promise<readonly { kind: 'og' | 'shortlink'; jobId: string }[]> {
  if (!Array.isArray(input.kinds) || input.kinds.length < 1 || input.kinds.length > 2 || new Set(input.kinds).size !== input.kinds.length || input.kinds.some(kind => kind !== 'og' && kind !== 'shortlink')) throw new PolicyError('invalid_state')
  const now = nowValue(deps.now), assertion = crypto.randomUUID()
  const digest = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(input)))), x => x.toString(16).padStart(2,'0')).join('')
  const statements: D1PreparedStatement[] = []
  if (input.kinds.includes('og')) {
    // Never replace an existing job, even a stale or terminal one: its retry rules still apply.
    statements.push(deps.db.prepare(`INSERT INTO enrichment_jobs (job_id,artifact_id,revision_id,page_id,kind,input_sha256,recipe_sha256,desired_grant_id,expected_content_version,expected_policy_epoch,state,attempt,created_at,updated_at)
      SELECT ?,?,?,?,'og',NULL,NULL,NULL,?,?,'pending',0,?,?
      WHERE EXISTS (SELECT 1 FROM publication_events WHERE action='commit' AND instance_id=? AND artifact_id=? AND revision_id=?)
        AND NOT EXISTS (SELECT 1 FROM enrichment_jobs WHERE page_id=? AND revision_id=? AND kind='og')`)
      .bind(crypto.randomUUID(),input.artifactId,input.revisionId,input.pageId,input.expectedContentVersion,input.expectedPolicyEpoch,now,now,deps.config.instanceId,input.artifactId,input.revisionId,input.pageId,input.revisionId))
  }
  for (const kind of input.kinds) {
    const id = `${assertion}-${kind}`
    const selected = `(SELECT k.job_id FROM enrichment_jobs k WHERE k.page_id=? AND k.revision_id=? AND k.kind=? ORDER BY k.created_at DESC,k.job_id DESC LIMIT 1)`
    statements.push(assertStatement(deps.db, id, `EXISTS (SELECT 1 FROM enrichment_jobs j WHERE j.job_id=${selected} AND j.artifact_id=? AND j.expected_content_version=? AND j.expected_policy_epoch=? AND (j.state='pending' OR (j.state='failed' AND j.retryable=1) OR (j.state='running' AND j.lease_expires_at<=?)) AND ${validTarget})`, [input.pageId,input.revisionId,kind,input.artifactId,input.expectedContentVersion,input.expectedPolicyEpoch,now]))
    statements.push(deps.db.prepare(`SELECT job_id FROM enrichment_jobs WHERE job_id=${selected}`).bind(input.pageId,input.revisionId,kind))
    statements.push(deps.db.prepare(`UPDATE enrichment_jobs SET state='pending',error_code=NULL,retryable=NULL,updated_at=? WHERE job_id=${selected} AND state='failed'`).bind(now,input.pageId,input.revisionId,kind))
    statements.push(deps.db.prepare('DELETE FROM enrichment_assertions WHERE assertion_id=?').bind(id))
  }
  const results = await executeGuarded(deps, actor, [{ action:'enrich_page',artifactId:input.artifactId,revisionId:input.revisionId,pageId:input.pageId,expectedContentVersion:input.expectedContentVersion,expectedPolicyEpoch:input.expectedPolicyEpoch,requestDigest:digest,occurredAt:now }], statements)
  return input.kinds.map((kind, index) => {
    const row = results[2 + (input.kinds.includes('og') ? 1 : 0) + index * 4].results[0] as { job_id: string } | undefined
    if (!row) throw new PolicyError('unavailable')
    return { kind, jobId: row.job_id }
  })
}
