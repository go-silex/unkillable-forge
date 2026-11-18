import { PolicyError } from '../catalogue/guard'
import { assertManagedAuthority, managedAuthorityStatements } from '../catalogue/managed-state'
import { assertPolicyPrincipal, policyPrincipalStatement } from '../catalogue/read'
import { requireManageActor } from '../catalogue/principals'
import type { ManageActor } from '../catalogue/principals'
import type { ManageDeps } from '../catalogue/commands'
import type { EnrichmentErrorCode } from './enrichments'

export type EnrichmentStatus = { state: 'disabled'; reason: 'not_requested' } | { state: 'pending' | 'running'; attempt: number } | { state: 'ready'; source: 'preserved' | 'generated' | 'created' } | { state: 'failed'; code: EnrichmentErrorCode; retryable: boolean } | { state: 'superseded' }
export interface EnrichmentPage { readonly version: 1; readonly artifactId: string; readonly revisionId: string; readonly observedAt: number; readonly items: readonly { pageId: string; revisionId: string; og: EnrichmentStatus; shortlink: EnrichmentStatus }[]; readonly nextCursor: string | null }
type Job = { page_id: string; kind: 'og' | 'shortlink'; state: string; attempt: number; result_source: 'preserved' | 'generated' | 'created' | null; error_code: EnrichmentErrorCode | null; retryable: number | null }
function decode(job: Job | undefined): EnrichmentStatus {
  if (!job) return { state: 'disabled', reason: 'not_requested' }
  if (job.state === 'pending' || job.state === 'running') return { state: job.state, attempt: job.attempt }
  if (job.state === 'ready' && job.result_source) return { state: 'ready', source: job.result_source }
  if (job.state === 'failed' && job.error_code && (job.retryable === 0 || job.retryable === 1)) return { state: 'failed', code: job.error_code, retryable: job.retryable === 1 }
  if (job.state === 'superseded') return { state: 'superseded' }
  throw new PolicyError('invariant_violation')
}
async function hash(value: string): Promise<string> { return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))), b => b.toString(16).padStart(2,'0')).join('') }

/** Authorization, page identities and mutable job snapshot are read in one primary D1 batch. */
export async function readEnrichments(deps: ManageDeps, actor: ManageActor, input: { artifactId: string; revisionId: string; cursor?: string | null; limit?: number }): Promise<EnrichmentPage> {
  if (!/^ar_[a-z2-7]{26}$/.test(input.artifactId) || !/^rv_[a-z2-7]{26}$/.test(input.revisionId)) throw new PolicyError('invalid_state')
  const limit = input.limit ?? 50
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100 || (input.cursor != null && (typeof input.cursor !== 'string' || input.cursor.length > 1000))) throw new PolicyError('invalid_state')
  let cursor: { fingerprint: string; after: string } | null = null
  if (input.cursor) {
    try { const value = JSON.parse(input.cursor); if (!value || Object.keys(value).sort().join(',') !== 'after,fingerprint' || typeof value.after !== 'string' || !/^pg_[a-z2-7]{26}$/.test(value.after) || typeof value.fingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(value.fingerprint)) throw 0; cursor = value } catch { throw new PolicyError('invalid_state') }
  }
  try {
    const results = await deps.db.batch([
      ...managedAuthorityStatements(deps, actor, input.artifactId, input.revisionId),
      deps.db.prepare('SELECT active_revision_id,content_version FROM artifacts WHERE artifact_id=?').bind(input.artifactId),
      deps.db.prepare('SELECT revision_id FROM revisions WHERE artifact_id=? AND revision_id=?').bind(input.artifactId,input.revisionId),
      deps.db.prepare(`SELECT COALESCE(json_group_array(json_array(job_id,state,attempt,updated_at,error_code,retryable,result_source)),'[]') AS inventory FROM (SELECT job_id,state,attempt,updated_at,error_code,retryable,result_source FROM enrichment_jobs WHERE artifact_id=? AND revision_id=? ORDER BY job_id)`).bind(input.artifactId,input.revisionId),
      deps.db.prepare('SELECT page_id FROM revision_pages WHERE revision_id=? AND page_id>? ORDER BY page_id LIMIT ?').bind(input.revisionId,cursor?.after ?? '',limit+1),
      deps.db.prepare(`SELECT j.page_id,j.kind,j.state,j.attempt,j.result_source,j.error_code,j.retryable FROM enrichment_jobs j WHERE j.artifact_id=? AND j.revision_id=? AND j.page_id>? AND j.job_id=(SELECT k.job_id FROM enrichment_jobs k WHERE k.page_id=j.page_id AND k.revision_id=j.revision_id AND k.kind=j.kind ORDER BY k.created_at DESC,k.job_id DESC LIMIT 1) AND j.page_id IN (SELECT page_id FROM revision_pages WHERE revision_id=? AND page_id>? ORDER BY page_id LIMIT ?)`).bind(input.artifactId,input.revisionId,cursor?.after ?? '',input.revisionId,cursor?.after ?? '',limit+1),
    ])
    const authority = assertManagedAuthority(results, deps, actor)
    const artifact = results[3].results[0], revision = results[4].results[0], inventory = results[5].results[0]
    if (!artifact || !revision || !inventory) throw new PolicyError('not_found')
    const fingerprint = await hash(JSON.stringify([1,deps.config.instanceId,actor.principalId,actor.authorityEpoch,input.artifactId,input.revisionId,artifact,authority.policyFingerprint,inventory]))
    if (cursor && cursor.fingerprint !== fingerprint) throw new PolicyError('conflict')
    const rows = results[6].results as { page_id: string }[], jobs = results[7].results as Job[]
    const selected = rows.slice(0,limit)
    return { version: 1, artifactId: input.artifactId, revisionId: input.revisionId, observedAt: deps.now(), items: selected.map(({page_id}) => ({ pageId: page_id, revisionId: input.revisionId, og: decode(jobs.find(j => j.page_id === page_id && j.kind === 'og')), shortlink: decode(jobs.find(j => j.page_id === page_id && j.kind === 'shortlink')) })), nextCursor: rows.length > limit ? JSON.stringify({ fingerprint, after: selected[selected.length-1].page_id }) : null }
  } catch (error) { if (error instanceof PolicyError) throw error; throw new PolicyError('unavailable') }
}

/** One exact page observation, separately reauthorized after retry admission. */
export async function readPageEnrichment(deps: ManageDeps, actor: ManageActor, input: { artifactId: string; revisionId: string; pageId: string }): Promise<EnrichmentPage['items'][number]> {
  if (!/^ar_[a-z2-7]{26}$/.test(input.artifactId) || !/^rv_[a-z2-7]{26}$/.test(input.revisionId) || !/^pg_[a-z2-7]{26}$/.test(input.pageId)) throw new PolicyError('invalid_state')
  try {
    requireManageActor(actor, deps)
    const results = await deps.db.batch([
      deps.db.prepare('SELECT instance_id FROM instance_meta WHERE singleton=1'),
      policyPrincipalStatement(deps.db, actor, [input.pageId]),
      deps.db.prepare('SELECT rp.page_id FROM revision_pages rp JOIN revisions r ON r.revision_id=rp.revision_id JOIN pages p ON p.page_id=rp.page_id AND p.artifact_id=r.artifact_id WHERE r.artifact_id=? AND rp.revision_id=? AND rp.page_id=?').bind(input.artifactId,input.revisionId,input.pageId),
      deps.db.prepare(`SELECT j.page_id,j.kind,j.state,j.attempt,j.result_source,j.error_code,j.retryable FROM enrichment_jobs j WHERE j.artifact_id=? AND j.revision_id=? AND j.page_id=? AND j.job_id=(SELECT k.job_id FROM enrichment_jobs k WHERE k.page_id=j.page_id AND k.revision_id=j.revision_id AND k.kind=j.kind ORDER BY k.created_at DESC,k.job_id DESC LIMIT 1)`).bind(input.artifactId,input.revisionId,input.pageId),
    ])
    assertPolicyPrincipal(results, deps, actor, 1)
    if (!results[2].results[0]) throw new PolicyError('not_found')
    const jobs = results[3].results as Job[]
    return { pageId: input.pageId, revisionId: input.revisionId, og: decode(jobs.find(j => j.kind === 'og')), shortlink: decode(jobs.find(j => j.kind === 'shortlink')) }
  } catch (error) { if (error instanceof PolicyError) throw error; throw new PolicyError('unavailable') }
}
