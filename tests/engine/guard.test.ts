import { env } from "cloudflare:workers"
import { beforeEach, describe, expect, it } from "vitest"
import { assignRole, disablePrincipal, revokeRole } from "../../domains/catalogue/commands"
import { executeGuarded, type GuardRequest } from "../../domains/catalogue/guard"
import { actor, adminRoleId, artifactId, authenticatedActor, bootstrap, configs, digest, jwks, pageFixture, pageId, principalId, revisionId } from "./fixtures/catalogue"

const guard: GuardRequest = { action: "set_visibility", pageId, artifactId, expectedPolicyEpoch: 0, requestDigest: digest, occurredAt: 10 }
const effect = () => env.DB.prepare("UPDATE pages SET visibility = 'public' WHERE page_id = ?").bind(pageId)
beforeEach(async () => { await bootstrap(); await pageFixture() })

describe("transactional policy guard", () => {
  it("commits an authorized effect and audit event together", async () => {
    const deps = { db: env.DB, config: (await configs()).manage, jwks, now: () => 10 }
    await executeGuarded(deps, actor, [guard], [effect()])
    expect(await env.DB.prepare("SELECT visibility FROM pages WHERE page_id = ?").bind(pageId).first()).toEqual({ visibility: "public" })
    expect(await env.DB.prepare("SELECT action, verdict FROM mutation_events").first()).toEqual({ action: "set_visibility", verdict: "ok" })
  })
  it.each([
    ["missing page", { ...guard, pageId: `pg_${"b".repeat(26)}` }, "not_found"],
    ["stale policy", { ...guard, expectedPolicyEpoch: 1 }, "conflict"],
    ["stale content", { ...guard, action: "unpublish", expectedContentVersion: 1 }, "conflict"],
    ["stale target authority", { ...guard, action: "disable_principal", targetPrincipalId: principalId, expectedTargetAuthorityEpoch: 1 }, "conflict"],
    ["missing publish revision", { ...guard, action: "publish", expectedContentVersion: 0, revisionId: `rv_${"b".repeat(26)}` }, "not_found"],
    ["foreign pinned revision", { ...guard, action: "share", revisionId: `rv_${"b".repeat(26)}` }, "invalid_state"],
    ["last administrator", { ...guard, action: "revoke_role", targetPrincipalId: principalId, roleGrantId: adminRoleId, expectedTargetAuthorityEpoch: 0 }, "last_admin"],
  ] as [string, GuardRequest, string][])("rejects %s with no effect or audit event", async (_name, input, code) => {
    const deps = { db: env.DB, config: (await configs()).manage, jwks, now: () => 10 }
    await expect(executeGuarded(deps, actor, [input], [effect()])).rejects.toMatchObject({ code })
    expect(await env.DB.prepare("SELECT visibility, policy_epoch FROM pages WHERE page_id = ?").bind(pageId).first()).toEqual({ visibility: "private", policy_epoch: 0 })
    expect(await env.DB.prepare("SELECT count(*) AS n FROM mutation_events").first()).toEqual({ n: 0 })
  })
  it("rejects an unknown runtime action instead of treating it as authorized", async () => {
    const deps = { db: env.DB, config: (await configs()).manage, jwks, now: () => 10 }
    const unknown = { ...guard, action: "unknown" } as unknown as GuardRequest
    await expect(executeGuarded(deps, actor, [unknown], [effect()])).rejects.toMatchObject({ code: "forbidden" })
    expect(await env.DB.prepare("SELECT visibility FROM pages WHERE page_id = ?").bind(pageId).first()).toEqual({ visibility: "private" })
  })
  it("rejects publication into another artefact's reserved subtree even without a mount collision", async () => {
    const foreignArtifact = `ar_${"b".repeat(26)}`, foreignRevision = `rv_${"b".repeat(26)}`
    await env.DB.batch([
      env.DB.prepare("INSERT INTO artifacts (artifact_id,origin,created_at) VALUES (?,'published',1)").bind(foreignArtifact),
      env.DB.prepare("INSERT INTO revisions (revision_id,artifact_id,origin,manifest_sha256,manifest_object_key,sealed_at) VALUES (?,?,'published',?,'foreign',1)").bind(foreignRevision, foreignArtifact, digest),
      env.DB.prepare("INSERT INTO revision_resources (revision_id,path,kind,object_key,sha256,size,content_type) VALUES (?,'/a/sample/unmounted.js','asset','foreign',?,1,'application/javascript')").bind(foreignRevision, digest),
    ])
    const deps = { db: env.DB, config: (await configs()).manage, jwks, now: () => 10 }
    await expect(executeGuarded(deps, actor, [{ action: "create_page", pageId: `pg_${"b".repeat(26)}`, artifactId: foreignArtifact, revisionId: foreignRevision, requestDigest: digest, occurredAt: 10 }], [effect()])).rejects.toMatchObject({ code: "conflict" })
    expect(await env.DB.prepare("SELECT visibility FROM pages WHERE page_id = ?").bind(pageId).first()).toEqual({ visibility: "private" })
  })
  it("maps real D1 missing-schema and named guard failures", async () => {
    const config = (await configs()).manage
    await expect(executeGuarded({ db: env.EMPTY_DB, config, jwks, now: () => 10 }, actor, [guard], [])).rejects.toMatchObject({ code: "unavailable" })
    const statement = env.DB.prepare("INSERT INTO mutation_events (event_id,instance_id,action,actor_principal_id,actor_surface,request_digest,occurred_at,verdict) VALUES (?,?,?,?,?,?,?,'instance_mismatch')").bind(`ev_${"a".repeat(26)}`, config.instanceId, "stage", principalId, "manage", digest, 10)
    await expect(env.DB.batch([statement])).rejects.toThrow(/CHECK constraint failed: guard_instance_mismatch/)
    await env.DB.prepare("DELETE FROM instance_meta").run()
    await expect(executeGuarded({ db: env.DB, config, jwks, now: () => 10 }, actor, [guard], [effect()])).rejects.toMatchObject({ code: "instance_mismatch" })
  })
  it("rejects empty, duplicate, and multiple role guards before touching absent D1", async () => {
    const deps = { db: env.EMPTY_DB, config: (await configs()).manage, jwks, now: () => 10 }
    await expect(executeGuarded(deps, actor, [], [])).rejects.toMatchObject({ code: "invalid_state" })
    await expect(executeGuarded(deps, actor, [guard, guard], [])).rejects.toMatchObject({ code: "invalid_state" })
    const first: GuardRequest = { ...guard, action: "revoke_role", targetPrincipalId: principalId, roleGrantId: adminRoleId, expectedTargetAuthorityEpoch: 0 }
    const second: GuardRequest = { ...first, pageId: `pg_${"b".repeat(26)}`, targetPrincipalId: `pr_${"b".repeat(26)}` }
    await expect(executeGuarded(deps, actor, [first, second], [])).rejects.toMatchObject({ code: "invalid_state" })
    await expect(executeGuarded(deps, actor, [{ ...guard, action: "stage", revisionId }], [], { revisionId, edges: [{ ownerPageId: `pg_${"b".repeat(26)}`, path: "/asset.js", providerArtifactId: artifactId }] })).rejects.toMatchObject({ code: "invalid_state" })
    await expect(executeGuarded(deps, { ...actor }, [guard], [])).rejects.toMatchObject({ code: "unauthenticated" })
  })
  it("revalidates publisher page scope and revoked authority", async () => {
    const publisherId = `pr_${"b".repeat(26)}`
    await env.DB.prepare("INSERT INTO principals (principal_id,issuer,subject,created_at) VALUES (?, 'https://team.cloudflareaccess.com', 'publisher', 1)").bind(publisherId).run()
    const deps = { db: env.DB, config: (await configs()).manage, jwks, now: () => 10 }
    const role = await assignRole(deps, actor, { targetPrincipalId: publisherId, expectedTargetAuthorityEpoch: 0, role: "publisher", scope: { kind: "page", pageId } })
    const publisher = await authenticatedActor("publisher")
    await expect(executeGuarded(deps, publisher, [{ ...guard, action: "create_page", pageId: `pg_${"c".repeat(26)}` }], [])).rejects.toMatchObject({ code: "forbidden" })
    await expect(executeGuarded(deps, publisher, [{ ...guard, pageId: `pg_${"c".repeat(26)}` }], [])).rejects.toMatchObject({ code: "forbidden" })
    await revokeRole(deps, actor, { targetPrincipalId: publisherId, expectedTargetAuthorityEpoch: 1, roleGrantId: role.roleGrantId })
    await expect(executeGuarded(deps, publisher, [guard], [effect()])).rejects.toMatchObject({ code: "conflict" })
    expect(await env.DB.prepare("SELECT visibility FROM pages WHERE page_id = ?").bind(pageId).first()).toEqual({ visibility: "private" })
  })
  it("permits installation publishers to create and change pages but not assign roles", async () => {
    const publisherId = `pr_${"b".repeat(26)}`
    await env.DB.prepare("INSERT INTO principals (principal_id,issuer,subject,created_at) VALUES (?, 'https://team.cloudflareaccess.com', 'publisher', 1)").bind(publisherId).run()
    const deps = { db: env.DB, config: (await configs()).manage, jwks, now: () => 10 }
    await assignRole(deps, actor, { targetPrincipalId: publisherId, expectedTargetAuthorityEpoch: 0, role: "publisher", scope: { kind: "installation" } })
    const publisher = await authenticatedActor("publisher")
    await executeGuarded(deps, publisher, [{ ...guard, action: "create_page", pageId: `pg_${"c".repeat(26)}`, revisionId }], [])
    await executeGuarded(deps, publisher, [guard], [effect()])
    expect(await env.DB.prepare("SELECT visibility FROM pages WHERE page_id = ?").bind(pageId).first()).toEqual({ visibility: "public" })
    await expect(executeGuarded(deps, publisher, [{ ...guard, action: "assign_role", targetPrincipalId: publisherId, expectedTargetAuthorityEpoch: 1 }], [])).rejects.toMatchObject({ code: "forbidden" })
  })
  it("retains one administrator when two administrators concurrently disable each other", async () => {
    const other = `pr_${"b".repeat(26)}`
    await env.DB.batch([
      env.DB.prepare("INSERT INTO principals (principal_id,issuer,subject,created_at) VALUES (?, 'https://team.cloudflareaccess.com', 'other-admin', 1)").bind(other),
      env.DB.prepare("INSERT INTO role_grants (role_grant_id,principal_id,role,scope_kind,origin,granted_at) VALUES (?,?,'admin','installation','bootstrap',1)").bind(`rg_${"b".repeat(26)}`, other),
    ])
    const deps = { db: env.DB, config: (await configs()).manage, jwks, now: () => 10 }
    const otherActor = await authenticatedActor("other-admin")
    const results = await Promise.allSettled([
      disablePrincipal(deps, actor, { targetPrincipalId: other, expectedTargetAuthorityEpoch: 0 }),
      disablePrincipal(deps, otherActor, { targetPrincipalId: principalId, expectedTargetAuthorityEpoch: 0 }),
    ])
    expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1)
    const failure = results.find(result => result.status === "rejected")
    expect(failure?.status === "rejected" ? failure.reason.code : undefined).toBe("unauthenticated")
    expect(await env.DB.prepare("SELECT count(*) AS n FROM principals p JOIN role_grants g ON g.principal_id = p.principal_id WHERE p.status = 'active' AND g.role = 'admin' AND g.revoked_at IS NULL").first()).toEqual({ n: 1 })
  })
})
