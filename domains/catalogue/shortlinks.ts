import type { ManageDeps } from './commands'
import { executeGuarded, PolicyError, type GuardRequest } from './guard'
import { newId } from './ids'
import { requireManageActor, type ManageActor } from './principals'
import { validShortlinkIdentity } from './shortlink-identity'

/** Protected metadata: destination and its digest must not be exposed in ordinary status. */
export interface ShortlinkMapping {
  readonly mappingId: string
  readonly providerOrigin: string
  readonly providerId: string | null
  readonly shortDomain: string
  readonly shortCode: string
  readonly shortUrl: string
  readonly pageId: string | null
  readonly grantId: string | null
  readonly destination: string
  readonly source: 'imported' | 'created'
  readonly observedAt: number
  readonly destinationDigest: string
}

export interface ShortlinkTarget {
  readonly pageId: string
  readonly artifactId: string
  readonly revisionId: string
  readonly expectedPolicyEpoch: number
  readonly expectedContentVersion: number
}

export async function shortlinkDestinationDigest(destination: string): Promise<string> {
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(destination)))
  return Array.from(hash, byte => byte.toString(16).padStart(2, '0')).join('')
}
export async function importShortlinkStatement(db: D1Database, m: ShortlinkMapping): Promise<D1PreparedStatement> {
  if (!m || !m.mappingId || !m.providerOrigin || !m.shortCode || !m.shortUrl || !m.destination || !m.pageId || !['created', 'imported'].includes(m.source) || !Number.isSafeInteger(m.observedAt) || m.observedAt < 0 || m.destinationDigest !== await shortlinkDestinationDigest(m.destination) || !validShortlinkIdentity(m.providerOrigin, m.shortDomain, m.shortCode, m.shortUrl)) throw new PolicyError('invalid_state')
  return db.prepare('INSERT OR IGNORE INTO shortlink_mappings (mapping_id,provider_origin,provider_id,short_domain,short_code,short_url,page_id,grant_id,destination,source,observed_at,destination_digest) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)').bind(m.mappingId, m.providerOrigin, m.providerId, m.shortDomain, m.shortCode, m.shortUrl, m.pageId, m.grantId, m.destination, m.source, m.observedAt, m.destinationDigest)
}


/** Insert an exact provider observation or explicitly reconcile an existing observation with CAS. */
export async function setShortlinkMapping(deps: ManageDeps, actor: ManageActor, target: ShortlinkTarget, command:
  | { readonly op: 'create'; readonly mapping: ShortlinkMapping }
  | { readonly op: 'reconcile'; readonly mapping: ShortlinkMapping; readonly expectedDestinationDigest: string }
): Promise<void> {
  requireManageActor(actor, deps)
  const m = command.mapping
  if (!m || !m.mappingId || !m.providerOrigin || !m.shortCode || !m.shortUrl || !m.destination || m.pageId !== target.pageId || (m.source !== 'created' && m.source !== 'imported') || !Number.isSafeInteger(m.observedAt) || m.observedAt < 0 || m.destinationDigest !== await shortlinkDestinationDigest(m.destination) || (command.op !== 'create' && command.op !== 'reconcile') || (command.op === 'reconcile' && !/^[a-f0-9]{64}$/.test(command.expectedDestinationDigest))) throw new PolicyError('invalid_state')
  if (!validShortlinkIdentity(m.providerOrigin, m.shortDomain, m.shortCode, m.shortUrl)) throw new PolicyError('invalid_state')
  // Newly-created identities may be recorded by an in-scope publisher. Imported or
  // existing identities require the administrator-only set_shortlink guard.
  const action = command.op === 'create' && m.source === 'created' ? 'enrich_page' : 'set_shortlink'
  const audit = JSON.stringify({ action, op: command.op, mappingId: m.mappingId, pageId: target.pageId, revisionId: target.revisionId })
  const guard: GuardRequest = { action, ...target, requestDigest: await shortlinkDestinationDigest(audit), occurredAt: deps.now() }
  const db = deps.db
  // A CHECK refusal inside the same D1 batch makes grant and mapping assertions
  // transactional with the authority guard and the following write.
  const assertion = db.prepare(`INSERT INTO mutation_events (event_id,instance_id,action,actor_principal_id,actor_surface,page_id,artifact_id,grant_id,target_principal_id,role_grant_id,expected_authority_epoch,expected_policy_epoch,expected_content_version,expected_target_authority_epoch,request_digest,occurred_at,revision_id,verdict)
    SELECT ?,instance_id,action,actor_principal_id,actor_surface,page_id,artifact_id,grant_id,target_principal_id,role_grant_id,expected_authority_epoch,expected_policy_epoch,expected_content_version,expected_target_authority_epoch,request_digest,occurred_at,revision_id,'conflict' FROM mutation_events
    WHERE (? IS NOT NULL AND NOT EXISTS (SELECT 1 FROM share_grants WHERE grant_id = ? AND page_id = ? AND (? = 'imported' OR revoked_at IS NULL)))
       OR (? = 'reconcile' AND NOT EXISTS (SELECT 1 FROM shortlink_mappings WHERE mapping_id = ? AND provider_origin = ? AND short_domain = ? AND short_code = ? AND page_id = ? AND destination_digest = ? AND source = ?)) LIMIT 1`)
    .bind(newId('ev'), m.grantId, m.grantId, target.pageId, m.source, command.op, m.mappingId, m.providerOrigin, m.shortDomain, m.shortCode, target.pageId, command.op === 'reconcile' ? command.expectedDestinationDigest : '', m.source)
  const effect = command.op === 'create'
    ? db.prepare('INSERT INTO shortlink_mappings (mapping_id,provider_origin,provider_id,short_domain,short_code,short_url,page_id,grant_id,destination,source,observed_at,destination_digest) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)').bind(m.mappingId, m.providerOrigin, m.providerId, m.shortDomain, m.shortCode, m.shortUrl, m.pageId, m.grantId, m.destination, m.source, m.observedAt, m.destinationDigest)
    : db.prepare('UPDATE shortlink_mappings SET provider_id = ?, short_url = ?, grant_id = ?, destination = ?, observed_at = ?, destination_digest = ? WHERE mapping_id = ? AND provider_origin = ? AND short_domain = ? AND short_code = ? AND page_id = ? AND destination_digest = ? AND source = ?').bind(m.providerId, m.shortUrl, m.grantId, m.destination, m.observedAt, m.destinationDigest, m.mappingId, m.providerOrigin, m.shortDomain, m.shortCode, target.pageId, command.expectedDestinationDigest, m.source)
  await executeGuarded(deps, actor, [guard], [assertion, effect])
}
