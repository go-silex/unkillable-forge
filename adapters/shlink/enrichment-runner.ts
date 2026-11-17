import { executeGuarded, PolicyError } from '../../domains/catalogue/guard'
import { readPagePolicy, revealShare, type ManageDeps } from '../../domains/catalogue/commands'
import type { ManageActor } from '../../domains/catalogue/principals'
import { setShortlinkMapping, shortlinkDestinationDigest } from '../../domains/catalogue/shortlinks'
import { readShortlinkMappingIdentity } from '../../domains/catalogue/shortlink-lookup'
import { readShortlinkIntent } from '../../domains/delivery/shortlink-intent'
import { claimEnrichment, failEnrichment, finalizeShortlink } from '../../domains/delivery/enrichments'
import { createShortlink, type ShlinkConfig } from './client'


/** One explicitly invoked, guarded job. This adapter never retargets an existing alias. */
export async function runShortlinkEnrichment(deps: ManageDeps, actor: ManageActor, config: ShlinkConfig, jobId: string, deadlineMs: number): Promise<void> {
  if (!Number.isSafeInteger(deadlineMs) || deadlineMs < 1 || deadlineMs > 120_000) throw new PolicyError('invalid_state')
  const job = await readShortlinkIntent(deps.db, jobId)
  if (!job) throw new PolicyError('not_found')
  const policy = await readPagePolicy(deps, actor, job.page_id)
  if (!policy || policy.artifactId !== job.artifact_id || policy.policyEpoch !== job.expected_policy_epoch || policy.contentVersion !== job.expected_content_version) throw new PolicyError('conflict')
  if (new URL(config.collectionUrl).origin !== job.provider_origin) throw new PolicyError('conflict')
  await executeGuarded(deps, actor, [{ action:'enrich_page', artifactId:job.artifact_id, revisionId:job.revision_id, pageId:job.page_id, expectedContentVersion:job.expected_content_version, expectedPolicyEpoch:job.expected_policy_epoch, requestDigest:job.input_sha256, occurredAt:deps.now() }], [])
  let destination: string
  if (job.desired_grant_id === null) {
    if (policy.visibility !== 'public' || !policy.canonicalUrl) throw new PolicyError('conflict')
    destination = policy.canonicalUrl
  } else {
    if (policy.visibility !== 'shared' || policy.grant?.grantId !== job.desired_grant_id || !policy.shareUrlPrefix || (policy.grant.mode === 'pinned' && policy.grant.revisionId !== job.revision_id)) throw new PolicyError('conflict')
    const { key } = await revealShare(deps, actor, { artifactId: job.artifact_id, pageId: job.page_id, grantId: job.desired_grant_id, expectedPolicyEpoch: job.expected_policy_epoch })
    destination = `${policy.shareUrlPrefix}${encodeURIComponent(key)}/`
  }
  if (await shortlinkDestinationDigest(destination) !== job.destination_sha256) throw new PolicyError('conflict')
  const started = deps.now()
  const attempt = await claimEnrichment(deps.db, deps.config.instanceId, jobId, started, deadlineMs)
  const request = config.fetch ?? fetch
  const remaining = started + deadlineMs - deps.now()
  const controller = new AbortController()
  let cancelTimer = () => {}
  try {
    if (remaining < 1 || remaining > deadlineMs) throw new PolicyError('conflict')
    const timeout = new Promise<never>((_, reject) => {
      const timer = setTimeout(() => { controller.abort(); reject(new PolicyError('unavailable')) }, remaining)
      cancelTimer = () => clearTimeout(timer)
    })
    const result = await Promise.race([createShortlink({ ...config, fetch: (input, init) => request(input, { ...init, signal: controller.signal }) }, { shortCode: job.requested_short_code, shortDomain: job.requested_short_domain, destination }), timeout])
    if (result.state === 'failed') {
      await failEnrichment(deps.db, deps.config.instanceId, attempt, deps.now(), result.code, result.retryable)
      return
    }
    // Persist only an exact new observation. A pre-existing foreign identity is never updated.
    const existing = await readShortlinkMappingIdentity(deps.db, job.desired_mapping_id)
    if (existing) {
      if (existing.provider_origin !== job.provider_origin || existing.short_domain !== job.requested_short_domain || existing.short_code !== job.requested_short_code || existing.page_id !== job.page_id || existing.grant_id !== job.desired_grant_id || existing.destination_digest !== job.destination_sha256) throw new PolicyError('conflict')
    } else {
      await setShortlinkMapping(deps, actor, { artifactId:job.artifact_id, revisionId:job.revision_id, pageId:job.page_id, expectedContentVersion:job.expected_content_version, expectedPolicyEpoch:job.expected_policy_epoch }, { op:'create', mapping: { mappingId:job.desired_mapping_id, providerOrigin:result.mapping.providerOrigin, providerId:result.mapping.providerId, shortDomain:job.requested_short_domain, shortCode:result.mapping.shortCode, shortUrl:result.mapping.shortUrl, pageId:job.page_id, grantId:job.desired_grant_id, destination:result.mapping.destination, source:'created', observedAt:deps.now(), destinationDigest:job.destination_sha256 } })
    }
    await finalizeShortlink(deps, actor, attempt)
  } catch (error) {
    try { await failEnrichment(deps.db, deps.config.instanceId, attempt, deps.now(), error instanceof PolicyError && error.code === 'conflict' ? 'shortlink_conflict' : 'shortlink_unavailable', !(error instanceof PolicyError && error.code === 'conflict')) } catch { /* A later lease or policy transition owns the job. */ }
    throw error
  } finally { cancelTimer() }
}
