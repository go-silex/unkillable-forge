import { executeGuarded, PolicyError, type GuardRequest } from '../catalogue/guard'
import type { ManageDeps } from '../catalogue/commands'
import type { ManageActor } from '../catalogue/principals'
import type { PublicationReceipt } from '../publication/types'
import { ogIntentStatement } from './enrichments'

// Two statements per page: leave headroom for D1 batch limits and bound retries.
const batchSize = 40

/** Post-commit, best-effort side effect. Each successful batch is durable; replay repairs gaps. */
export async function enqueuePublicationIntents(deps: ManageDeps, actor: ManageActor, receipt: PublicationReceipt): Promise<void> {
  if (!receipt.revisionId || !receipt.pages.length) return
  const revisionId = receipt.revisionId
  const requested = new Set(receipt.pages.map(page => page.pageId))
  const rows = await deps.db.prepare(`SELECT p.page_id,p.policy_epoch FROM pages p JOIN revision_pages rp ON rp.page_id=p.page_id WHERE p.artifact_id=? AND rp.revision_id=? AND p.tombstoned_at IS NULL ORDER BY p.page_id`).bind(receipt.artifactId, revisionId).all<{ page_id: string; policy_epoch: number }>()
  const pages = rows.results.filter(row => requested.has(row.page_id))
  const at = deps.now()
  if (!Number.isSafeInteger(at) || at < 0) throw new PolicyError('invalid_state')
  // This is the audit request digest, not an invented render-input digest.
  const bytes = new TextEncoder().encode(JSON.stringify(['publication-og-intents', receipt.artifactId, revisionId, receipt.contentVersion]))
  const digest = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), b => b.toString(16).padStart(2, '0')).join('')
  async function enqueue(group: typeof pages): Promise<void> {
    const guards: GuardRequest[] = group.map(page => ({ action: 'enrich_page', artifactId: receipt.artifactId, revisionId, pageId: page.page_id, expectedContentVersion: receipt.contentVersion, expectedPolicyEpoch: page.policy_epoch, requestDigest: digest, occurredAt: at }))
    const effects = group.map(page => ogIntentStatement(deps.db, { jobId: crypto.randomUUID(), artifactId: receipt.artifactId, revisionId, pageId: page.page_id, expectedContentVersion: receipt.contentVersion, expectedPolicyEpoch: page.policy_epoch, desiredGrantId: null, now: at }))
    try { await executeGuarded(deps, actor, guards, effects) }
    catch (error) {
      if (error instanceof PolicyError && error.code === 'conflict') {
        const current = await deps.db.prepare('SELECT active_revision_id,content_version FROM artifacts WHERE artifact_id=?').bind(receipt.artifactId).first<{ active_revision_id: string | null; content_version: number }>()
        if (!current || current.active_revision_id !== revisionId || current.content_version !== receipt.contentVersion) throw error
      }
      // A single changed or inaccessible page must not suppress other authorized pages.
      if (error instanceof PolicyError && ['forbidden', 'not_found', 'conflict'].includes(error.code) && group.length > 1) {
        const middle = Math.floor(group.length / 2)
        await enqueue(group.slice(0, middle))
        await enqueue(group.slice(middle))
      } else if (!(error instanceof PolicyError) || !['forbidden', 'not_found', 'conflict'].includes(error.code)) throw error
    }
  }
  for (let i = 0; i < pages.length; i += batchSize) await enqueue(pages.slice(i, i + batchSize))
}
