import type { ManageDeps } from "./commands"
import type { VerifiedIdentity } from "./identity"
import { newId } from "./ids"
import { mapPolicyError, PolicyError } from "./guard"

export interface ActorView {
  readonly principalId: string
  readonly status: "active" | "disabled"
  readonly authorityEpoch: number
  readonly roles: readonly {
    readonly roleGrantId: string
    readonly role: "publisher" | "admin"
    readonly scope: { readonly kind: "installation" } | { readonly kind: "page"; readonly pageId: string }
  }[]
}

type PrincipalRow = { principal_id: string; status: "active" | "disabled"; authority_epoch: number }
type RoleRow = { role_grant_id: string; role: "publisher" | "admin"; scope_kind: "installation" | "page"; scope_page_id: string | null }

export async function resolveActor(deps: ManageDeps, identity: VerifiedIdentity): Promise<ActorView | null> {
  if (identity.surface !== "manage" || !identity.subject) return null
  try {
    const [instance, , principal, roles] = await deps.db.batch([
      deps.db.prepare("SELECT instance_id FROM instance_meta WHERE singleton = 1 AND instance_id = ?").bind(deps.config.instanceId),
      deps.db.prepare(`INSERT INTO principals (principal_id, issuer, subject, email_hint, created_at)
        SELECT ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM instance_meta WHERE singleton = 1 AND instance_id = ?)
        ON CONFLICT (issuer, subject) DO NOTHING`).bind(newId("pr"), identity.issuer, identity.subject, identity.email, deps.now(), deps.config.instanceId),
      deps.db.prepare("SELECT principal_id, status, authority_epoch FROM principals WHERE issuer = ? AND subject = ?").bind(identity.issuer, identity.subject),
      deps.db.prepare(`SELECT g.role_grant_id, g.role, g.scope_kind, g.scope_page_id FROM role_grants g
        JOIN principals p ON p.principal_id = g.principal_id
        WHERE p.issuer = ? AND p.subject = ? AND g.revoked_at IS NULL`).bind(identity.issuer, identity.subject),
    ])
    if (!instance.results.length) throw new PolicyError("instance_mismatch")
    const row = principal.results[0] as PrincipalRow | undefined
    if (!row) return null
    return {
      principalId: row.principal_id,
      status: row.status,
      authorityEpoch: row.authority_epoch,
      roles: (roles.results as RoleRow[]).map(role => ({
        roleGrantId: role.role_grant_id,
        role: role.role,
        scope: role.scope_kind === "installation" ? { kind: "installation" as const } : { kind: "page" as const, pageId: role.scope_page_id! },
      })),
    }
  } catch (error) {
    throw mapPolicyError(error)
  }
}
