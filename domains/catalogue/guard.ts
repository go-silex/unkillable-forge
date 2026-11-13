import { newId } from "./ids"

export type GuardAction = "create_page" | "stage" | "publish" | "restore_page" | "unpublish" | "set_visibility" | "share" | "rotate_share" | "revoke_share" | "reveal_share" | "import_share" | "set_alias" | "assign_role" | "revoke_role" | "disable_principal"
export interface GuardInput {
  readonly action: GuardAction
  readonly actor: { readonly principalId: string; readonly surface: "read" | "manage"; readonly expectedAuthorityEpoch: number }
  readonly pageId?: string
  readonly artifactId?: string
  readonly grantId?: string
  readonly targetPrincipalId?: string
  readonly roleGrantId?: string
  readonly expectedPolicyEpoch?: number
  readonly expectedContentVersion?: number
  readonly expectedTargetAuthorityEpoch?: number
  readonly revisionId?: string
  readonly requestDigest: string
  readonly occurredAt: number
}
export type PolicyErrorCode = "instance_mismatch" | "unauthenticated" | "forbidden" | "not_found" | "conflict" | "invalid_state" | "last_admin" | "invariant_violation" | "unavailable"
export class PolicyError extends Error {
  readonly code: PolicyErrorCode
  readonly detail: string | null
  constructor(code: PolicyErrorCode, detail: string | null = null) {
    super(detail ? `${code}: ${detail}` : code)
    this.name = "PolicyError"
    this.code = code
    this.detail = detail
  }
}

const GUARD_SQL = `INSERT INTO mutation_events (
  event_id, instance_id, action, actor_principal_id, actor_surface,
  page_id, artifact_id, grant_id, target_principal_id, role_grant_id,
  expected_authority_epoch, expected_policy_epoch, expected_content_version,
  expected_target_authority_epoch, request_digest, occurred_at, revision_id, verdict)
SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17,
CASE
  WHEN NOT EXISTS (SELECT 1 FROM instance_meta WHERE singleton = 1 AND instance_id = ?2) THEN 'instance_mismatch'
  WHEN ?5 IS NOT 'manage' THEN 'forbidden'
  WHEN NOT EXISTS (SELECT 1 FROM principals WHERE principal_id = ?4 AND status = 'active') THEN 'unauthenticated'
  WHEN (SELECT authority_epoch FROM principals WHERE principal_id = ?4) IS NOT ?11 THEN 'conflict'
  WHEN ?3 IN ('import_share', 'set_alias', 'assign_role', 'revoke_role', 'disable_principal')
    AND NOT EXISTS (SELECT 1 FROM role_grants WHERE principal_id = ?4 AND revoked_at IS NULL AND role = 'admin') THEN 'forbidden'
  WHEN ?3 IN ('create_page', 'restore_page') AND NOT EXISTS (SELECT 1 FROM role_grants WHERE principal_id = ?4 AND revoked_at IS NULL AND (role = 'admin' OR (role = 'publisher' AND scope_kind = 'installation'))) THEN 'forbidden'
  WHEN ?3 IN ('stage', 'publish', 'unpublish', 'set_visibility', 'share', 'rotate_share', 'revoke_share', 'reveal_share')
    AND NOT EXISTS (SELECT 1 FROM role_grants WHERE principal_id = ?4 AND revoked_at IS NULL AND (role = 'admin' OR (role = 'publisher' AND scope_kind = 'installation') OR (role = 'publisher' AND scope_kind = 'page' AND scope_page_id = ?6))) THEN 'forbidden'
  WHEN ?3 = 'create_page' AND EXISTS (SELECT 1 FROM pages WHERE page_id = ?6) THEN 'conflict'
  WHEN ?3 IN ('publish', 'unpublish', 'set_visibility', 'share', 'rotate_share', 'revoke_share', 'reveal_share', 'import_share')
    AND NOT EXISTS (SELECT 1 FROM pages WHERE page_id = ?6 AND artifact_id = ?7 AND tombstoned_at IS NULL) THEN 'not_found'
  WHEN ?3 = 'stage' AND ?6 IS NOT NULL AND NOT EXISTS (SELECT 1 FROM pages WHERE page_id = ?6 AND artifact_id = ?7 AND tombstoned_at IS NULL) THEN 'not_found'
  WHEN ?3 IN ('publish', 'restore_page') AND NOT EXISTS (SELECT 1 FROM revisions WHERE revision_id = ?17 AND artifact_id = ?7) THEN 'not_found'
  WHEN ?3 = 'restore_page' AND NOT EXISTS (SELECT 1 FROM pages WHERE page_id = ?6 AND artifact_id = ?7) THEN 'not_found'
  WHEN ?3 = 'restore_page' AND NOT EXISTS (SELECT 1 FROM revision_pages WHERE revision_id = ?17 AND page_id = ?6) THEN 'not_found'
  WHEN ?3 = 'set_alias' AND ?6 IS NOT NULL AND NOT EXISTS (SELECT 1 FROM pages WHERE page_id = ?6 AND tombstoned_at IS NULL) THEN 'not_found'
  WHEN ?3 IN ('rotate_share', 'revoke_share', 'reveal_share') AND NOT EXISTS (SELECT 1 FROM share_grants WHERE grant_id = ?8 AND page_id = ?6 AND revoked_at IS NULL) THEN 'not_found'
  WHEN ?3 IN ('assign_role', 'revoke_role', 'disable_principal') AND NOT EXISTS (SELECT 1 FROM principals WHERE principal_id = ?9) THEN 'not_found'
  WHEN ?3 = 'revoke_role' AND NOT EXISTS (SELECT 1 FROM role_grants WHERE role_grant_id = ?10 AND principal_id = ?9 AND revoked_at IS NULL) THEN 'not_found'
  WHEN ?3 = 'restore_page' AND EXISTS (SELECT 1 FROM pages WHERE page_id = ?6 AND tombstoned_at IS NULL) THEN 'conflict'
  WHEN ?3 IN ('publish', 'unpublish', 'set_visibility', 'share', 'rotate_share', 'revoke_share', 'reveal_share', 'import_share') AND (SELECT policy_epoch FROM pages WHERE page_id = ?6) IS NOT ?12 THEN 'conflict'
  WHEN ?3 IN ('publish', 'unpublish', 'restore_page') AND (SELECT content_version FROM artifacts WHERE artifact_id = ?7) IS NOT ?13 THEN 'conflict'
  WHEN ?3 IN ('assign_role', 'revoke_role', 'disable_principal') AND (SELECT authority_epoch FROM principals WHERE principal_id = ?9) IS NOT ?14 THEN 'conflict'
  WHEN ?3 IN ('create_page', 'publish', 'restore_page') AND ?17 IS NOT NULL AND EXISTS (SELECT 1 FROM revision_resources rr JOIN mounts m ON m.path = rr.path WHERE rr.revision_id = ?17 AND m.artifact_id IS NOT ?7) THEN 'conflict'
  WHEN ?3 IN ('share', 'rotate_share') AND ?17 IS NOT NULL AND NOT EXISTS (SELECT 1 FROM revisions WHERE revision_id = ?17 AND artifact_id = ?7) THEN 'invalid_state'
  WHEN ?3 = 'reveal_share' AND (SELECT sealed_key FROM share_grants WHERE grant_id = ?8) IS NULL THEN 'invalid_state'
  WHEN ?3 = 'revoke_role' AND (SELECT role FROM role_grants WHERE role_grant_id = ?10) = 'admin' AND NOT EXISTS (SELECT 1 FROM role_grants g JOIN principals p ON p.principal_id = g.principal_id WHERE g.role = 'admin' AND g.revoked_at IS NULL AND p.status = 'active' AND g.role_grant_id <> ?10) THEN 'last_admin'
  WHEN ?3 = 'disable_principal' AND EXISTS (SELECT 1 FROM role_grants WHERE principal_id = ?9 AND role = 'admin' AND revoked_at IS NULL) AND NOT EXISTS (SELECT 1 FROM role_grants g JOIN principals p ON p.principal_id = g.principal_id WHERE g.role = 'admin' AND g.revoked_at IS NULL AND p.status = 'active' AND g.principal_id <> ?9) THEN 'last_admin'
  ELSE 'ok' END`

export function guardStatement(db: D1Database, instanceId: string, input: GuardInput): D1PreparedStatement {
  return db.prepare(GUARD_SQL).bind(newId("ev"), instanceId, input.action, input.actor.principalId, input.actor.surface,
    input.pageId ?? null, input.artifactId ?? null, input.grantId ?? null, input.targetPrincipalId ?? null,
    input.roleGrantId ?? null, input.actor.expectedAuthorityEpoch, input.expectedPolicyEpoch ?? null,
    input.expectedContentVersion ?? null, input.expectedTargetAuthorityEpoch ?? null,
    input.requestDigest, input.occurredAt, input.revisionId ?? null)
}

export function mapPolicyError(error: unknown): PolicyError {
  if (error instanceof PolicyError) return error
  const pending: unknown[] = [error]
  const seen = new Set<unknown>()
  const messages: string[] = []
  while (pending.length) {
    const current = pending.pop()
    if (current == null || seen.has(current)) continue
    seen.add(current)
    if (current instanceof PolicyError) return current
    if (typeof current === "object") {
      const item = current as { message?: unknown; cause?: unknown; errors?: unknown }
      if (typeof item.message === "string") messages.push(item.message)
      if (item.cause !== undefined) pending.push(item.cause)
      if (Array.isArray(item.errors)) pending.push(...item.errors)
    } else {
      messages.push(String(current))
    }
  }
  const message = messages.join("\n")
  const named = message.match(/CHECK constraint failed: guard_(instance_mismatch|unauthenticated|forbidden|not_found|conflict|invalid_state|last_admin)\b/)
  if (named) return new PolicyError(named[1] as PolicyErrorCode)
  const unique = message.match(/UNIQUE constraint failed:\s*([^\s,:]+(?:\.[^\s,:]+)?)/)
  if (unique) return new PolicyError("conflict", unique[1])
  if (/constraint failed/i.test(message) || /SQLITE_CONSTRAINT/i.test(message)) return new PolicyError("invariant_violation")
  return new PolicyError("unavailable")
}

export async function executeGuarded(db: D1Database, instanceId: string, guards: readonly GuardInput[], effects: readonly D1PreparedStatement[]): Promise<readonly D1Result[]> {
  if (guards.length === 0) throw new PolicyError("invalid_state")
  if (guards.length !== 1 && guards.some(g => g.action === "assign_role" || g.action === "revoke_role" || g.action === "disable_principal")) {
    throw new PolicyError("invalid_state")
  }
  const pages = new Set<string>()
  const principals = new Set<string>()
  for (const guard of guards) {
    if (guard.pageId !== undefined) {
      if (pages.has(guard.pageId)) throw new PolicyError("invalid_state")
      pages.add(guard.pageId)
    }
    if (guard.targetPrincipalId !== undefined) {
      if (principals.has(guard.targetPrincipalId)) throw new PolicyError("invalid_state")
      principals.add(guard.targetPrincipalId)
    }
  }
  try {
    return await db.batch([...guards.map(g => guardStatement(db, instanceId, g)), ...effects])
  } catch (error) {
    throw mapPolicyError(error)
  }
}
