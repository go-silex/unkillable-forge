import { env } from "cloudflare:workers"
import { beforeEach, describe, expect, it } from "vitest"
import { assignRole, claimPageStatements, readPagePolicy, restorePageStatements, retirePageStatements, share } from "../../domains/catalogue/commands"
import { executeGuarded, type GuardRequest } from "../../domains/catalogue/guard"
import { decideRead, type ReadCredentials, type ReadSubject } from "../../domains/catalogue/read"
import { actor, artifactId, authenticatedActor, bootstrap, configs, digest, jwks, pageFixture, pageId, principalId, revisionId } from "./fixtures/catalogue"

const route = { kind: "tree_page" as const, pageRef: "docs/page.html" }
const target = { pageId, artifactId, expectedPolicyEpoch: 0 }
const unpublish: GuardRequest = { action: "unpublish", pageId, artifactId, expectedPolicyEpoch: 1, expectedContentVersion: 0, requestDigest: digest, occurredAt: 20 }
const restore: GuardRequest = { action: "restore_page", pageId, artifactId, revisionId, expectedContentVersion: 1, requestDigest: digest, occurredAt: 30 }
const anonymous: ReadCredentials = { team: null, shareKey: null, shareCookie: null, pinnedProof: null, nowSeconds: 1 }
beforeEach(async () => { await bootstrap(); await pageFixture({ route }) })

async function retire(): Promise<{ key: string; proof: string }> {
  const { read, manage } = await configs()
  const deps = { db: env.DB, config: manage, jwks, now: () => 10 }
  const grant = await share(deps, actor, { ...target, mode: "follow_active" })
  const decision = await decideRead(env.DB, read, { kind: "share", route, candidates: ["/docs/page.html"] }, { ...anonymous, shareKey: grant.key }, null)
  if (decision.kind !== "allow" || !decision.plan.pinnedProof || !grant.key) throw new Error("share fixture did not authorize a proof")
  await executeGuarded(deps, actor, [unpublish], [
    ...retirePageStatements(env.DB, { pageId, actorPrincipalId: principalId, at: 20 }),
    env.DB.prepare("UPDATE artifacts SET content_version = content_version + 1 WHERE artifact_id = ?").bind(artifactId),
  ])
  return { key: grant.key, proof: decision.plan.pinnedProof }
}

describe("restore composition", () => {
  it.each(["dropped page", "fully unpublished artefact"]) ("restores a %s privately without reviving a grant", async (scenario) => {
    const old = await retire()
    await env.DB.prepare("DELETE FROM mounts WHERE artifact_id = ?").bind(artifactId).run()
    if (scenario === "fully unpublished artefact") {
      await env.DB.prepare("UPDATE artifacts SET active_revision_id = NULL WHERE artifact_id = ?").bind(artifactId).run()
    } else {
      const laterRevision = `rv_${"b".repeat(26)}`
      await env.DB.batch([
        env.DB.prepare("INSERT INTO revisions (revision_id,artifact_id,origin,manifest_sha256,manifest_object_key,sealed_at) VALUES (?,?,'published',?,'later',2)").bind(laterRevision, artifactId, digest),
        env.DB.prepare("UPDATE artifacts SET active_revision_id = ? WHERE artifact_id = ?").bind(laterRevision, artifactId),
      ])
    }
    const { read, manage } = await configs()
    const deps = { db: env.DB, config: manage, jwks, now: () => 30 }
    await executeGuarded(deps, actor, [restore], [
      env.DB.prepare("INSERT INTO mounts (path,artifact_id,revision_id,kind) VALUES ('/docs/page.html',?,?,'document')").bind(artifactId, revisionId),
      ...restorePageStatements(env.DB, { pageId, revisionId, at: 30 }),
      env.DB.prepare("UPDATE artifacts SET active_revision_id = ?, content_version = content_version + 1 WHERE artifact_id = ?").bind(revisionId, artifactId),
    ])
    expect(await readPagePolicy(deps, actor, pageId)).toMatchObject({ pageId, visibility: "private", policyEpoch: 3, grant: null })
    expect(await env.DB.prepare("SELECT revoked_reason, sealed_key FROM share_grants WHERE page_id = ?").bind(pageId).first()).toEqual({ revoked_reason: "unpublished", sealed_key: null })
    const subject: ReadSubject = { kind: "share", route, candidates: ["/docs/page.html"] }
    expect(await decideRead(env.DB, read, subject, { ...anonymous, shareKey: old.key }, null)).toEqual({ kind: "deny", reason: "not_found" })
    const page: ReadSubject = { kind: "page", route, candidates: ["/docs/page.html"], fragmentPath: null }
    expect(await decideRead(env.DB, read, page, { ...anonymous, shareCookie: { pageRef: route.pageRef, key: old.key } }, null)).toEqual({ kind: "deny", reason: "login_required" })
    expect(await decideRead(env.DB, read, { kind: "pinned", pageId, revisionId, path: "/docs/page.html" }, { ...anonymous, pinnedProof: old.proof }, null)).toEqual({ kind: "deny", reason: "not_found" })
  })
  it("rolls back if another page has reclaimed the route", async () => {
    await retire()
    const claimant = `pg_${"b".repeat(26)}`
    const deps = { db: env.DB, config: (await configs()).manage, jwks, now: () => 25 }
    const create: GuardRequest = { action: "create_page", pageId: claimant, artifactId, revisionId, requestDigest: digest, occurredAt: 25 }
    await executeGuarded(deps, actor, [create], claimPageStatements(env.DB, { pageId: claimant, artifactId, route, actorPrincipalId: principalId, at: 25 }))
    await expect(executeGuarded(deps, actor, [restore], restorePageStatements(env.DB, { pageId, revisionId, at: 30 }))).rejects.toMatchObject({ code: "conflict" })
    expect(await env.DB.prepare("SELECT tombstoned_at, policy_epoch FROM pages WHERE page_id = ?").bind(pageId).first()).toEqual({ tombstoned_at: 20, policy_epoch: 2 })
    expect(await env.DB.prepare("SELECT page_id FROM routes WHERE kind = 'tree_page' AND route_key = 'docs/page.html'").first()).toEqual({ page_id: claimant })
  })
  it("requires installation scope and a matching tombstone, revision and version", async () => {
    const publisherId = `pr_${"b".repeat(26)}`
    await env.DB.prepare("INSERT INTO principals (principal_id,issuer,subject,created_at) VALUES (?, 'https://team.cloudflareaccess.com', 'publisher', 1)").bind(publisherId).run()
    const deps = { db: env.DB, config: (await configs()).manage, jwks, now: () => 10 }
    await assignRole(deps, actor, { targetPrincipalId: publisherId, expectedTargetAuthorityEpoch: 0, role: "publisher", scope: { kind: "page", pageId } })
    const publisher = await authenticatedActor("publisher")
    await retire()
    await expect(executeGuarded(deps, publisher, [restore], [])).rejects.toMatchObject({ code: "forbidden" })
    await expect(executeGuarded(deps, actor, [{ ...restore, expectedContentVersion: 0 }], [])).rejects.toMatchObject({ code: "conflict" })
    await expect(executeGuarded(deps, actor, [{ ...restore, pageId: `pg_${"c".repeat(26)}` }], [])).rejects.toMatchObject({ code: "not_found" })
    await expect(executeGuarded(deps, actor, [{ ...restore, revisionId: `rv_${"c".repeat(26)}` }], [])).rejects.toMatchObject({ code: "not_found" })
  })
  it("rejects live pages, wrong artefacts, missing page membership and foreign path claims", async () => {
    const deps = { db: env.DB, config: (await configs()).manage, jwks, now: () => 10 }
    await expect(executeGuarded(deps, actor, [{ ...restore, expectedContentVersion: 0 }], [])).rejects.toMatchObject({ code: "conflict" })
    await retire()
    const otherArtifact = `ar_${"b".repeat(26)}`, otherRevision = `rv_${"b".repeat(26)}`, otherPage = `pg_${"b".repeat(26)}`
    await pageFixture({ artifact: otherArtifact, revision: otherRevision, page: otherPage, route: { kind: "tree_page", pageRef: "other/page.html" } })
    await expect(executeGuarded(deps, actor, [{ ...restore, artifactId: otherArtifact, revisionId: otherRevision }], [])).rejects.toMatchObject({ code: "not_found" })
    await expect(executeGuarded(deps, actor, [{ ...restore, revisionId: otherRevision }], [])).rejects.toMatchObject({ code: "not_found" })
    const emptyRevision = `rv_${"c".repeat(26)}`
    await env.DB.prepare("INSERT INTO revisions (revision_id,artifact_id,origin,manifest_sha256,manifest_object_key,sealed_at) VALUES (?,?,'published',?,'empty',2)").bind(emptyRevision, artifactId, digest).run()
    await expect(executeGuarded(deps, actor, [{ ...restore, revisionId: emptyRevision }], [])).rejects.toMatchObject({ code: "not_found" })
    await env.DB.prepare("INSERT INTO revision_resources (revision_id,path,kind,object_key,sha256,size,content_type) VALUES (?, '/other/page.html', 'document', 'colliding', ?, 1, 'text/html')").bind(revisionId, digest).run()
    await expect(executeGuarded(deps, actor, [restore], [])).rejects.toMatchObject({ code: "conflict" })
  })
  it("allows installation publisher to restore a subtree under its original page ID", async () => {
    const otherArtifact = `ar_${"b".repeat(26)}`, otherRevision = `rv_${"b".repeat(26)}`, otherPage = `pg_${"b".repeat(26)}`, publisherId = `pr_${"b".repeat(26)}`
    await pageFixture({ artifact: otherArtifact, revision: otherRevision, page: otherPage, route: { kind: "subtree", slug: "second" } })
    await env.DB.prepare("INSERT INTO principals (principal_id,issuer,subject,created_at) VALUES (?, 'https://team.cloudflareaccess.com', 'publisher', 1)").bind(publisherId).run()
    const deps = { db: env.DB, config: (await configs()).manage, jwks, now: () => 10 }
    await assignRole(deps, actor, { targetPrincipalId: publisherId, expectedTargetAuthorityEpoch: 0, role: "publisher", scope: { kind: "installation" } })
    const publisher = await authenticatedActor("publisher")
    await executeGuarded(deps, actor, [{ ...unpublish, pageId: otherPage, artifactId: otherArtifact, expectedPolicyEpoch: 0 }], [...retirePageStatements(env.DB, { pageId: otherPage, actorPrincipalId: principalId, at: 20 }), env.DB.prepare("UPDATE artifacts SET content_version = 1 WHERE artifact_id = ?").bind(otherArtifact)])
    await executeGuarded(deps, publisher, [{ ...restore, pageId: otherPage, artifactId: otherArtifact, revisionId: otherRevision }], restorePageStatements(env.DB, { pageId: otherPage, revisionId: otherRevision, at: 30 }))
    expect(await env.DB.prepare("SELECT page_id, route_key FROM routes WHERE kind = 'subtree' AND route_key = 'second'").first()).toEqual({ page_id: otherPage, route_key: "second" })
    expect(await readPagePolicy(deps, publisher, otherPage)).toMatchObject({ pageId: otherPage, visibility: "private", policyEpoch: 2, grant: null })
  })
})
