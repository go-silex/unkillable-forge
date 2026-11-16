import { readPagePolicy, type ManageDeps, type ShareResult } from '../../domains/catalogue/commands'
import { readActivePageRevision } from '../../domains/catalogue/read'
import type { ManageActor } from '../../domains/catalogue/principals'
import { shortlinkDestinationDigest } from '../../domains/catalogue/shortlinks'
import { enqueueEnrichment } from '../../domains/delivery/enrichments'
import { runShortlinkEnrichment } from './enrichment-runner'
import type { ShlinkConfig } from './client'

/** Enrich only a freshly minted, revealable share; never choose a destination for a private page. */
export async function triggerShareShortlink(deps: ManageDeps, actor: ManageActor, config: ShlinkConfig, shortDomain: string, target: { pageId: string; artifactId: string }, share: ShareResult): Promise<void> {
  if (!share.key || !share.revealable) return
  const domain = new URL(`https://${shortDomain}`)
  const provider = new URL(config.collectionUrl)
  if (domain.host !== shortDomain || domain.username || domain.password || domain.pathname !== '/' || domain.search || domain.hash || provider.protocol !== 'https:' || provider.username || provider.password || provider.search || provider.hash) throw new Error('Invalid shortlink configuration')
  const policy = await readPagePolicy(deps, actor, target.pageId)
  if (!policy || policy.artifactId !== target.artifactId || policy.visibility !== 'shared' || policy.policyEpoch !== share.policyEpoch || policy.grant?.grantId !== share.grantId || !policy.shareUrlPrefix) throw new Error('Share changed')
  const revisionId = await readActivePageRevision(deps, actor, { ...target, expectedPolicyEpoch: policy.policyEpoch, expectedContentVersion: policy.contentVersion })
  if (!revisionId || (policy.grant.mode === 'pinned' && policy.grant.revisionId !== revisionId)) throw new Error('Share revision unavailable')
  const destination = `${policy.shareUrlPrefix}${encodeURIComponent(share.key)}/`
  const destinationSha256 = await shortlinkDestinationDigest(destination)
  const mappingId = crypto.randomUUID(), shortCode = `f-${crypto.randomUUID()}`
  const inputSha256 = await shortlinkDestinationDigest(JSON.stringify({ ...target, revisionId, grantId: share.grantId, policyEpoch: policy.policyEpoch, contentVersion: policy.contentVersion, providerOrigin: provider.origin, shortDomain, shortCode, destinationSha256 }))
  const job = await enqueueEnrichment(deps, actor, { ...target, revisionId, expectedContentVersion: policy.contentVersion, expectedPolicyEpoch: policy.policyEpoch, kind: 'shortlink', inputSha256, desiredGrantId: share.grantId, mappingId, providerOrigin: provider.origin, shortDomain, shortCode, destinationSha256 })
  await runShortlinkEnrichment(deps, actor, config, job, 10_000)
}
