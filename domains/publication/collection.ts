import type { RevisionRef, RevisionStore } from '../store/revision-store'

/** Server-owned maintenance configuration. All durations and timestamps are milliseconds. */
export interface CollectionDeps {
  readonly db: D1Database
  readonly store: RevisionStore
  readonly now: () => number
  readonly retainMs: number
  readonly marginMs: number
  readonly maxUploadTimeoutMs: number
  readonly manageClockSkewMs: number
  readonly readClockSkewMs: number
}

export type CollectionResult = 'purged' | 'already_purged' | 'orphan_purged' | 'not_found'

function clock(deps: CollectionDeps): number {
  const value = deps.now()
  if (!Number.isSafeInteger(value) || value < 0) throw new Error('invalid collection clock')
  return value
}

function validate(deps: CollectionDeps): void {
  const values = [deps.retainMs, deps.marginMs, deps.maxUploadTimeoutMs, deps.manageClockSkewMs, deps.readClockSkewMs]
  if (values.some(value => !Number.isSafeInteger(value) || value < 0)) throw new Error('invalid collection configuration')
  const skews = deps.manageClockSkewMs + deps.readClockSkewMs
  if (!Number.isSafeInteger(skews) || !Number.isSafeInteger(900_000 + skews) ||
      !Number.isSafeInteger(deps.maxUploadTimeoutMs + skews) ||
      deps.retainMs < 900_000 + skews || deps.marginMs < deps.maxUploadTimeoutMs + skews) {
    throw new Error('unsafe collection configuration')
  }
}

/**
 * Internal maintenance only. Callers must enforce bounded upload/copy deadlines and
 * serialize seal against session closure; Catalogue must reject discarded revisions.
 * A rejected D1 discard assertion is intentionally propagated, never treated as success.
 */
export async function collectRevision(deps: CollectionDeps, ref: RevisionRef): Promise<CollectionResult> {
  validate(deps)
  if (!ref || !/^ar_[a-z2-7]{26}$/.test(ref.artifactId) || !/^rv_[a-z2-7]{26}$/.test(ref.revisionId)) {
    throw new Error('invalid revision reference')
  }
  const now = clock(deps)
  const instance = await deps.db.prepare('SELECT instance_id FROM instance_meta WHERE singleton = 1').first<{ instance_id: string }>()
  if (!instance || instance.instance_id !== deps.store.instanceId) throw new Error('collection instance mismatch')

  // Committed sessions are already sealed: no new transfers can start. Keep
  // their commit timestamp as the in-flight margin origin rather than closing
  // them at the time maintenance happens to discover their expiry.
  await deps.db.prepare(`UPDATE publication_sessions SET closed_at = ?1
    WHERE instance_id = ?2 AND closed_at IS NULL AND expires_at <= ?3
      AND NOT EXISTS (SELECT 1 FROM publication_events e WHERE e.session_id = publication_sessions.session_id AND e.action = 'commit')`)
    .bind(now, instance.instance_id, now - deps.manageClockSkewMs).run()

  const revision = await deps.db.prepare('SELECT artifact_id FROM revisions WHERE revision_id = ?').bind(ref.revisionId).first<{ artifact_id: string }>()
  if (!revision) {
    // A never-sealed prefix is safe only when its unique session is closed long
    // enough and no concurrent seal can succeed after that primary close.
    const orphan = await deps.db.prepare(`SELECT session_id FROM publication_sessions s
      WHERE s.instance_id = ?1 AND s.artifact_id = ?2 AND s.revision_id = ?3
        AND s.closed_at IS NOT NULL AND s.closed_at <= ?4
        AND NOT EXISTS (SELECT 1 FROM revisions r WHERE r.revision_id = s.revision_id)`)
      .bind(instance.instance_id, ref.artifactId, ref.revisionId, now - deps.marginMs).first<{ session_id: string }>()
    if (!orphan) return 'not_found'
    await deps.store.deleteRevision(ref)
    return 'orphan_purged'
  }
  if (revision.artifact_id !== ref.artifactId) throw new Error('revision artifact mismatch')

  // The verdict CHECK makes the eligibility decision and permanent claim one
  // serialized primary write. Existing claims are resumable, never recreated.
  await deps.db.prepare(`INSERT INTO revision_discards (revision_id, discarded_at, verdict)
    SELECT ?1, ?2, CASE
      WHEN NOT EXISTS (SELECT 1 FROM revisions r WHERE r.revision_id = ?1 AND r.artifact_id = ?3) THEN 'not_found'
      WHEN EXISTS (SELECT 1 FROM artifacts a WHERE a.active_revision_id = ?1) THEN 'revision_active'
      WHEN EXISTS (SELECT 1 FROM share_grants g WHERE g.pinned_revision_id = ?1 AND g.revoked_at IS NULL) THEN 'revision_pinned'
      WHEN EXISTS (SELECT 1 FROM publication_sessions s
        WHERE (s.revision_id = ?1 OR s.base_revision_id = ?1)
          AND CASE
            WHEN s.closed_at IS NOT NULL THEN s.closed_at > ?4
            WHEN EXISTS (SELECT 1 FROM publication_events e WHERE e.session_id = s.session_id AND e.action = 'commit')
              THEN EXISTS (SELECT 1 FROM publication_events e WHERE e.session_id = s.session_id AND e.action = 'commit' AND e.occurred_at > ?4)
            ELSE 1 END) THEN 'revision_staged'
      WHEN EXISTS (SELECT 1 FROM revisions r WHERE r.revision_id = ?1 AND r.sealed_at > ?5)
        OR EXISTS (SELECT 1 FROM publication_events e WHERE e.artifact_id = ?3
          AND e.action IN ('commit','restore','unpublish') AND e.occurred_at > ?5) THEN 'revision_retained'
      ELSE 'ok' END
    WHERE NOT EXISTS (SELECT 1 FROM revision_discards WHERE revision_id = ?1)`)
    .bind(ref.revisionId, now, ref.artifactId, now - deps.marginMs, now - deps.retainMs).run()

  const claim = await deps.db.prepare('SELECT discarded_at, purged_at FROM revision_discards WHERE revision_id = ?')
    .bind(ref.revisionId).first<{ discarded_at: number; purged_at: number | null }>()
  if (!claim) throw new Error('collection claim missing')
  // A sweep is only a present observation: a previously admitted native R2
  // put may finish later. Maintenance must revisit every discard and closed
  // orphan indefinitely, not just unpurged claims (one R2 listing per prefix).
  const deleted = await deps.store.deleteRevision(ref)
  if (claim.purged_at !== null) return deleted === 0 ? 'already_purged' : 'purged'
  const purgedAt = Math.max(clock(deps), claim.discarded_at)
  await deps.db.prepare('UPDATE revision_discards SET purged_at = ?1 WHERE revision_id = ?2 AND purged_at IS NULL')
    .bind(purgedAt, ref.revisionId).run()
  return 'purged'
}
