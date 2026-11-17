import type { ManageDeps } from '../../domains/catalogue/commands'
import { PolicyError } from '../../domains/catalogue/guard'
import { requireManageActor, type ManageActor } from '../../domains/catalogue/principals'
import { listRunnableShortlinkJobs } from '../../domains/catalogue/shortlink-job-inventory'
import { enrichmentJobState } from '../../domains/delivery/job-state'
import { runShortlinkEnrichment } from './enrichment-runner'
import type { ShlinkConfig } from './client'

/** Explicit invocation under a live, authenticated actor; not an autonomous service identity. */
export async function drainShortlinkJobs(deps: ManageDeps, actor: ManageActor, config: ShlinkConfig, input: { limit: number; deadlineMs: number; scope?: { artifactId: string; revisionId: string; pageId: string } }): Promise<{ examined: number; completed: number; failed: number }> {
  requireManageActor(actor, deps)
  if (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 5 || !Number.isSafeInteger(input.deadlineMs) || input.deadlineMs < 1 || input.deadlineMs > 10_000) throw new PolicyError('invalid_state')
  const now = deps.now()
  if (!Number.isSafeInteger(now) || now < 0) throw new PolicyError('invalid_state')
  const jobs = await listRunnableShortlinkJobs(deps, actor, now, input.limit, input.scope)
  let completed = 0, failed = 0
  for (const jobId of jobs) {
    requireManageActor(actor, deps)
    try {
      await runShortlinkEnrichment(deps, actor, config, jobId, input.deadlineMs)
      const state = await enrichmentJobState(deps.db, jobId)
      if (state === 'ready') completed++; else failed++
    } catch { failed++ }
  }
  return { examined: jobs.length, completed, failed }
}
