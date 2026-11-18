import type { ManageDeps } from './commands'
import { requireManageActor, type ManageActor } from './principals'

/** Internal work inventory; execution still performs fresh guarded admission. */
export async function listRunnableShortlinkJobs(deps: ManageDeps, actor: ManageActor, now: number, limit: number, scope?: { artifactId: string; revisionId: string; pageId: string }): Promise<readonly string[]> {
  requireManageActor(actor, deps)
  const jobs = await deps.db.prepare(`SELECT j.job_id FROM enrichment_jobs j
    WHERE j.kind='shortlink' AND (j.state='pending' OR (j.state='running' AND j.lease_expires_at<=?))
      AND (? IS NULL OR (j.artifact_id=? AND j.revision_id=? AND j.page_id=? AND j.job_id=(SELECT k.job_id FROM enrichment_jobs k WHERE k.page_id=j.page_id AND k.revision_id=j.revision_id AND k.kind='shortlink' ORDER BY k.created_at DESC,k.job_id DESC LIMIT 1)))
      AND EXISTS (SELECT 1 FROM principals p WHERE p.principal_id=? AND p.status='active' AND p.authority_epoch=?)
      AND EXISTS (SELECT 1 FROM role_grants r WHERE r.principal_id=? AND r.revoked_at IS NULL AND (r.role='admin' OR (r.role='publisher' AND (r.scope_kind='installation' OR (r.scope_kind='page' AND r.scope_page_id=j.page_id)))))
    ORDER BY j.updated_at,j.job_id LIMIT ?`).bind(now,scope?.artifactId ?? null,scope?.artifactId ?? null,scope?.revisionId ?? null,scope?.pageId ?? null,actor.principalId,actor.authorityEpoch,actor.principalId,limit).all<{job_id:string}>()
  return jobs.results.map(job => job.job_id)
}
