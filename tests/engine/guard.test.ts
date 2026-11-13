import { env } from "cloudflare:workers"
import { assignRole, disablePrincipal, revokeRole } from "../../domains/catalogue/commands"
import { configs } from "./fixtures/catalogue"
import { beforeEach, describe, expect, it } from "vitest"
import { executeGuarded, guardStatement, type GuardInput } from "../../domains/catalogue/guard"
import { actor, adminRoleId, artifactId, bootstrap, digest, instanceId, pageFixture, pageId, principalId } from "./fixtures/catalogue"

const target = { pageId, artifactId, expectedPolicyEpoch: 0 }
const guard: GuardInput = { action: "set_visibility", actor: { principalId, surface: "manage", expectedAuthorityEpoch: 0 }, ...target, requestDigest: digest, occurredAt: 10 }
const effect = () => env.DB.prepare("UPDATE pages SET visibility = 'public' WHERE page_id = ?").bind(pageId)

beforeEach(async () => { await bootstrap(); await pageFixture() })

describe("transactional policy guard", () => {
  it("commits an authorized effect and its audit event together", async () => {
    await executeGuarded(env.DB, instanceId, [guard], [effect()])
    expect(await env.DB.prepare("SELECT visibility FROM pages WHERE page_id = ?").bind(pageId).first()).toEqual({ visibility: "public" })
    expect(await env.DB.prepare("SELECT action, verdict FROM mutation_events").first()).toEqual({ action: "set_visibility", verdict: "ok" })
  })
  it.each([
    ["instance mismatch", "other-instance", guard, "instance_mismatch"],
    ["read surface", instanceId, { ...guard, actor: { ...guard.actor, surface: "read" as const } }, "forbidden"],
    ["missing principal", instanceId, { ...guard, actor: { ...guard.actor, principalId: `pr_${"b".repeat(26)}` } }, "unauthenticated"],
    ["stale authority", instanceId, { ...guard, actor: { ...guard.actor, expectedAuthorityEpoch: 1 } }, "conflict"],
    ["missing page", instanceId, { ...guard, pageId: `pg_${"b".repeat(26)}` }, "not_found"],
    ["stale policy", instanceId, { ...guard, expectedPolicyEpoch: 1 }, "conflict"],
    ["stale content", instanceId, { ...guard, action: "unpublish", expectedContentVersion: 1 }, "conflict"],
    ["stale target authority", instanceId, { ...guard, action: "disable_principal", targetPrincipalId: principalId, expectedTargetAuthorityEpoch: 1 }, "conflict"],
    ["unknown publish revision", instanceId, { ...guard, action: "publish", expectedContentVersion: 0, revisionId: `rv_${"b".repeat(26)}` }, "not_found"],
    ["foreign pinned revision", instanceId, { ...guard, action: "share", revisionId: `rv_${"b".repeat(26)}` }, "invalid_state"],
    ["last administrator", instanceId, { ...guard, action: "revoke_role" as const, targetPrincipalId: principalId, roleGrantId: adminRoleId, expectedTargetAuthorityEpoch: 0 }, "last_admin"],
  ] as [string, string, GuardInput, string][])("rejects %s and rolls back all effects", async (_name, instance, input, code) => {
    await expect(executeGuarded(env.DB, instance, [input], [effect()])).rejects.toMatchObject({ code })
    expect(await env.DB.prepare("SELECT visibility, policy_epoch FROM pages WHERE page_id = ?").bind(pageId).first()).toEqual({ visibility: "private", policy_epoch: 0 })
    expect(await env.DB.prepare("SELECT count(*) AS n FROM mutation_events").first()).toEqual({ n: 0 })
  })
  it("exposes the named D1 CHECK failure used by error mapping", async () => {
    await expect(env.DB.batch([guardStatement(env.DB, "other-instance", guard)])).rejects.toThrow(/CHECK constraint failed: guard_instance_mismatch/)
  })
  it("returns unavailable for a real D1 without the schema", async () => {
    await expect(executeGuarded(env.EMPTY_DB, instanceId, [guard], [])).rejects.toMatchObject({ code: "unavailable" })
  })
  it("rejects multiple role guards before either administrator can be withdrawn", async () => {
    const second = `pr_${"b".repeat(26)}`
    const secondRole = `rg_${"b".repeat(26)}`
    await env.DB.batch([
      env.DB.prepare("INSERT INTO principals (principal_id, issuer, subject, created_at) VALUES (?, 'https://team.cloudflareaccess.com', 'second', 1)").bind(second),
      env.DB.prepare("INSERT INTO role_grants (role_grant_id, principal_id, role, scope_kind, origin, granted_at) VALUES (?, ?, 'admin', 'installation', 'bootstrap', 1)").bind(secondRole, second),
    ])
    const first: GuardInput = { ...guard, action: "revoke_role", targetPrincipalId: principalId, roleGrantId: adminRoleId, expectedTargetAuthorityEpoch: 0 }
    const other: GuardInput = { ...first, targetPrincipalId: second, roleGrantId: secondRole }
    await expect(executeGuarded(env.DB, instanceId, [first, other], [env.DB.prepare("UPDATE role_grants SET revoked_at = 10, revoked_by = ? WHERE role = 'admin'").bind(principalId)])).rejects.toMatchObject({ code: "invalid_state" })
    expect(await env.DB.prepare("SELECT count(*) AS n FROM role_grants WHERE role = 'admin' AND revoked_at IS NULL").first()).toEqual({ n: 2 })
  })
  it("rejects last-admin disable as well as role revocation", async () => {
    await expect(executeGuarded(env.DB, instanceId, [{ ...guard, action: "disable_principal", targetPrincipalId: actor.principalId, expectedTargetAuthorityEpoch: 0 }], [])).rejects.toMatchObject({ code: "last_admin" })
  })
  it("rechecks page scope and a revoked role inside the guarded batch", async () => {
    const publisher = `pr_${"b".repeat(26)}`
    await env.DB.prepare("INSERT INTO principals (principal_id, issuer, subject, created_at) VALUES (?, 'https://team.cloudflareaccess.com', 'publisher', 1)").bind(publisher).run()
    const deps = { db: env.DB, config: (await configs()).manage, now: () => 10 }
    const role = await assignRole(deps, actor, { targetPrincipalId: publisher, expectedTargetAuthorityEpoch: 0, role: "publisher", scope: { kind: "page", pageId } })
    const scoped = { ...guard, actor: { principalId: publisher, surface: "manage" as const, expectedAuthorityEpoch: 1 } }
    await expect(executeGuarded(env.DB, instanceId, [{ ...scoped, action: "create_page", pageId: `pg_${"c".repeat(26)}` }], [])).rejects.toMatchObject({ code: "forbidden" })
    await expect(executeGuarded(env.DB, instanceId, [{ ...scoped, pageId: `pg_${"c".repeat(26)}` }], [])).rejects.toMatchObject({ code: "forbidden" })
    await revokeRole(deps, actor, { targetPrincipalId: publisher, expectedTargetAuthorityEpoch: 1, roleGrantId: role.roleGrantId })
    await expect(executeGuarded(env.DB, instanceId, [scoped], [effect()])).rejects.toMatchObject({ code: "conflict" })
    expect(await env.DB.prepare("SELECT visibility FROM pages WHERE page_id = ?").bind(pageId).first()).toEqual({ visibility: "private" })
  })
  it("permits an installation publisher to create and change pages but not assign roles", async () => {
    const publisher = `pr_${"b".repeat(26)}`
    await env.DB.prepare("INSERT INTO principals (principal_id, issuer, subject, created_at) VALUES (?, 'https://team.cloudflareaccess.com', 'publisher', 1)").bind(publisher).run()
    const deps = { db: env.DB, config: (await configs()).manage, now: () => 10 }
    await assignRole(deps, actor, { targetPrincipalId: publisher, expectedTargetAuthorityEpoch: 0, role: "publisher", scope: { kind: "installation" } })
    const scoped = { ...guard, actor: { principalId: publisher, surface: "manage" as const, expectedAuthorityEpoch: 1 } }
    await executeGuarded(env.DB, instanceId, [{ ...scoped, action: "create_page", pageId: `pg_${"c".repeat(26)}` }], [])
    await executeGuarded(env.DB, instanceId, [scoped], [effect()])
    expect(await env.DB.prepare("SELECT visibility FROM pages WHERE page_id = ?").bind(pageId).first()).toEqual({ visibility: "public" })
    await expect(executeGuarded(env.DB, instanceId, [{ ...scoped, action: "assign_role", targetPrincipalId: publisher, expectedTargetAuthorityEpoch: 1 }], [])).rejects.toMatchObject({ code: "forbidden" })
  })
  it("rejects empty and duplicate guard targets before touching an absent D1 schema", async () => {
    await expect(executeGuarded(env.EMPTY_DB, instanceId, [], [])).rejects.toMatchObject({ code: "invalid_state" })
    await expect(executeGuarded(env.EMPTY_DB, instanceId, [guard, guard], [])).rejects.toMatchObject({ code: "invalid_state" })
    const first = { ...guard, targetPrincipalId: principalId, pageId: undefined }
    const second = { ...first, action: "stage" as const }
    await expect(executeGuarded(env.EMPTY_DB, instanceId, [first, second], [])).rejects.toMatchObject({ code: "invalid_state" })
  })
  it("retains an administrator when two administrators concurrently disable one another", async () => {
    const other = `pr_${"b".repeat(26)}`
    const otherRole = `rg_${"b".repeat(26)}`
    await env.DB.batch([
      env.DB.prepare("INSERT INTO principals (principal_id,issuer,subject,created_at) VALUES (?, 'https://team.cloudflareaccess.com', 'other-admin', 1)").bind(other),
      env.DB.prepare("INSERT INTO role_grants (role_grant_id,principal_id,role,scope_kind,origin,granted_at) VALUES (?,?,'admin','installation','bootstrap',1)").bind(otherRole, other),
    ])
    const deps = { db: env.DB, config: (await configs()).manage, now: () => 10 }
    const results = await Promise.allSettled([
      disablePrincipal(deps, actor, { targetPrincipalId: other, expectedTargetAuthorityEpoch: 0 }),
      disablePrincipal(deps, { principalId: other, surface: "manage", authorityEpoch: 0 }, { targetPrincipalId: principalId, expectedTargetAuthorityEpoch: 0 }),
    ])
    expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1)
    expect(results.filter(result => result.status === "rejected")).toHaveLength(1)
    const failure = results.find(result => result.status === "rejected")
    expect(failure?.status === "rejected" ? failure.reason.code : undefined).toBe("unauthenticated")
    expect(await env.DB.prepare("SELECT count(*) AS n FROM principals p JOIN role_grants g ON g.principal_id = p.principal_id WHERE p.status = 'active' AND g.role = 'admin' AND g.revoked_at IS NULL").first()).toEqual({ n: 1 })
  })
})
