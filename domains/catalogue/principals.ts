import type { ManageDeps } from "./commands"
import { authenticate, type VerifiedIdentity } from "./identity"
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

declare const manageActorBrand: unique symbol
export interface ManageActor extends ActorView {
  readonly instanceId: string
  readonly audience: string
  readonly issuer: string
  readonly subject: string
  readonly expiresAt: number
  readonly [manageActorBrand]: true
}

const manageActors = new WeakSet<object>()

/** Catalogue-internal check: only unexpired handles minted here carry authority. */
export function requireManageActor(actor: unknown, deps: ManageDeps): asserts actor is ManageActor {
  const nowMs = deps.now()
  if (typeof actor !== "object" || actor === null || !manageActors.has(actor) ||
      !Number.isFinite(nowMs) || nowMs >= (actor as ManageActor).expiresAt * 1000 ||
      (actor as ManageActor).instanceId !== deps.config.instanceId ||
      (actor as ManageActor).issuer !== `https://${deps.config.accessTeamDomain}` ||
      !deps.config.manageAudiences.includes((actor as ManageActor).audience)) {
    throw new PolicyError("unauthenticated")
  }
}

export async function authenticateManage(request: Request, deps: ManageDeps): Promise<ManageActor | null> {
  const now = deps.now() / 1000
  const instanceId = deps.config.instanceId
  const teamDomain = deps.config.accessTeamDomain
  const audiences = [...deps.config.manageAudiences]
  const identity = await authenticate(request, {
    teamDomain,
    audiences,
    surface: "manage",
  }, deps.jwks, now)
  if (!identity || identity.expiresAt <= now || instanceId !== deps.config.instanceId ||
      teamDomain !== deps.config.accessTeamDomain || !deps.config.manageAudiences.includes(identity.audience)) return null
  const view = await resolveActor(deps, identity)
  if (!view) return null
  const roles = Object.freeze(view.roles.map(role => Object.freeze({
    ...role, scope: Object.freeze(role.scope),
  })))
  const actor = Object.freeze({ ...view, roles, instanceId, audience: identity.audience, issuer: identity.issuer, subject: identity.subject!, expiresAt: identity.expiresAt }) as ManageActor
  manageActors.add(actor)
  requireManageActor(actor, deps)
  return actor
}

type PrincipalRow = { principal_id: string; status: "active" | "disabled"; authority_epoch: number }
type RoleRow = { role_grant_id: string; role: "publisher" | "admin"; scope_kind: "installation" | "page"; scope_page_id: string | null }

async function resolveActor(deps: ManageDeps, identity: VerifiedIdentity): Promise<ActorView | null> {
  if (identity.surface !== "manage" || !identity.subject) return null
  if (!identity.issuer.startsWith("https://") || [...identity.issuer].length > 255 ||
      [...identity.subject].length > 255 || (identity.email !== null && [...identity.email].length > 320) ||
      [identity.issuer, identity.subject, identity.email].some(value => value?.includes("\0"))) {
    throw new PolicyError("invalid_state")
  }
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
