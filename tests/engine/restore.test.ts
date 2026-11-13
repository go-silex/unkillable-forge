import { env } from "cloudflare:workers"
import { beforeEach, describe, expect, it } from "vitest"
import { assignRole, claimPageStatements, readPagePolicy, restorePageStatements, retirePageStatements, share } from "../../domains/catalogue/commands"
import { executeGuarded, type GuardInput } from "../../domains/catalogue/guard"
import { decideRead, type ReadCredentials, type ReadSubject } from "../../domains/catalogue/read"
import { actor, artifactId, bootstrap, configs, digest, instanceId, pageFixture, pageId, principalId, revisionId } from "./fixtures/catalogue"

const route = { kind: "tree_page" as const, pageRef: "docs/page.html" }
const target = { pageId, artifactId, expectedPolicyEpoch: 0 }
const guardActor = { principalId, surface: "manage" as const, expectedAuthorityEpoch: 0 }
const unpublish: GuardInput = { action: "unpublish", actor: guardActor, pageId, artifactId, expectedPolicyEpoch: 1, expectedContentVersion: 0, requestDigest: digest, occurredAt: 20 }
const restore: GuardInput = { action: "restore_page", actor: guardActor, pageId, artifactId, revisionId, expectedContentVersion: 1, requestDigest: digest, occurredAt: 30 }
const anonymous: ReadCredentials = { team: null, shareKey: null, shareCookie: null, pinnedProof: null }

beforeEach(async () => { await bootstrap(); await pageFixture({ route }) })

async function retire(): Promise<string> {
  const deps = { db: env.DB, config: (await configs()).manage, now: () => 10 }
  const grant = await share(deps, actor, { ...target, mode: "follow_active" })
  await executeGuarded(env.DB, instanceId, [unpublish], [
    ...retirePageStatements(env.DB, { pageId, actorPrincipalId: principalId, at: 20 }),
    env.DB.prepare("UPDATE artifacts SET content_version = content_version + 1 WHERE artifact_id = ?").bind(artifactId),
  ])
  return grant.key!
}

describe("restore composition", () => {
  it.each(["dropped page", "fully unpublished artefact"]) ("restores a %s as private without reviving a grant", async (scenario) => {
    const oldKey = await retire()
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
    const effects = [env.DB.prepare("INSERT INTO mounts (path, artifact_id, revision_id, kind) VALUES ('/docs/page.html', ?, ?, 'document')").bind(artifactId, revisionId)]
    await executeGuarded(env.DB, instanceId, [restore], [
      ...effects, ...restorePageStatements(env.DB, { pageId, revisionId, at: 30 }),
      env.DB.prepare("UPDATE artifacts SET active_revision_id = ?, content_version = content_version + 1 WHERE artifact_id = ?").bind(revisionId, artifactId),
    ])
    expect(await readPagePolicy({ db: env.DB, config: manage, now: () => 30 }, actor, pageId)).toMatchObject({ pageId, visibility: "private", policyEpoch: 3, grant: null })
    expect(await env.DB.prepare("SELECT revoked_reason, sealed_key FROM share_grants WHERE page_id = ?").bind(pageId).first()).toEqual({ revoked_reason: "unpublished", sealed_key: null })
    const subject: ReadSubject = { kind: "share", route, candidates: ["/docs/page.html"] }
    expect(await decideRead(env.DB, read, subject, { ...anonymous, shareKey: oldKey }, null)).toEqual({ kind: "deny", reason: "not_found" })
    const page: ReadSubject = { kind: "page", route, candidates: ["/docs/page.html"], fragmentPath: null }
    expect(await decideRead(env.DB, read, page, { ...anonymous, shareCookie: { pageRef: route.pageRef, key: oldKey } }, null)).toEqual({ kind: "deny", reason: "login_required" })
    const proof = { instanceId, pageId, revisionId, policyEpoch: 1, basis: { kind: "public" as const } }
    expect(await decideRead(env.DB, read, { kind: "pinned", pageId, revisionId, path: "/docs/page.html" }, { ...anonymous, pinnedProof: proof }, null)).toEqual({ kind: "deny", reason: "not_found" })
  })
  it("does not restore when another page has reclaimed its route", async () => {
    await retire()
    const claimant = `pg_${"b".repeat(26)}`
    const create: GuardInput = { action: "create_page", actor: guardActor, pageId: claimant, artifactId, requestDigest: digest, occurredAt: 25 }
    await executeGuarded(env.DB, instanceId, [create], claimPageStatements(env.DB, { pageId: claimant, artifactId, route, actorPrincipalId: principalId, at: 25 }))
    await expect(executeGuarded(env.DB, instanceId, [restore], restorePageStatements(env.DB, { pageId, revisionId, at: 30 }))).rejects.toMatchObject({ code: "conflict" })
    expect(await env.DB.prepare("SELECT tombstoned_at, policy_epoch FROM pages WHERE page_id = ?").bind(pageId).first()).toEqual({ tombstoned_at: 20, policy_epoch: 2 })
    expect(await env.DB.prepare("SELECT page_id FROM routes WHERE kind = 'tree_page' AND route_key = 'docs/page.html'").first()).toEqual({ page_id: claimant })
  })
  it("requires installation-level authority and a matching tombstone and content version", async () => {
    const publisher = `pr_${"b".repeat(26)}`
    await env.DB.prepare("INSERT INTO principals (principal_id,issuer,subject,created_at) VALUES (?, 'https://team.cloudflareaccess.com', 'publisher', 1)").bind(publisher).run()
    const deps = { db: env.DB, config: (await configs()).manage, now: () => 10 }
    await assignRole(deps, actor, { targetPrincipalId: publisher, expectedTargetAuthorityEpoch: 0, role: "publisher", scope: { kind: "page", pageId } })
    await retire()
    const scoped = { ...restore, actor: { principalId: publisher, surface: "manage" as const, expectedAuthorityEpoch: 1 } }
    await expect(executeGuarded(env.DB, instanceId, [scoped], [])).rejects.toMatchObject({ code: "forbidden" })
    await expect(executeGuarded(env.DB, instanceId, [{ ...restore, expectedContentVersion: 0 }], [])).rejects.toMatchObject({ code: "conflict" })
    await expect(executeGuarded(env.DB, instanceId, [{ ...restore, pageId: `pg_${"c".repeat(26)}` }], [])).rejects.toMatchObject({ code: "not_found" })
    await expect(executeGuarded(env.DB, instanceId, [{ ...restore, revisionId: `rv_${"c".repeat(26)}` }], [])).rejects.toMatchObject({ code: "not_found" })
  })
  it("rejects live pages, wrong artefacts and revisions without the page", async () => {
    await expect(executeGuarded(env.DB, instanceId, [{ ...restore, expectedContentVersion: 0 }], [])).rejects.toMatchObject({ code: "conflict" })
    await retire()
    const otherArtifact = `ar_${"b".repeat(26)}`
    const otherRevision = `rv_${"b".repeat(26)}`
    const otherPage = `pg_${"b".repeat(26)}`
    await pageFixture({ artifact: otherArtifact, revision: otherRevision, page: otherPage, route: { kind: "tree_page", pageRef: "other/page.html" } })
    await expect(executeGuarded(env.DB, instanceId, [{ ...restore, artifactId: otherArtifact, revisionId: otherRevision }], [])).rejects.toMatchObject({ code: "not_found" })
    await expect(executeGuarded(env.DB, instanceId, [{ ...restore, revisionId: otherRevision }], [])).rejects.toMatchObject({ code: "not_found" })
    const emptyRevision = `rv_${"c".repeat(26)}`
    await env.DB.prepare("INSERT INTO revisions (revision_id,artifact_id,origin,manifest_sha256,manifest_object_key,sealed_at) VALUES (?,?,'published',?,'empty',2)").bind(emptyRevision, artifactId, digest).run()
    await expect(executeGuarded(env.DB, instanceId, [{ ...restore, revisionId: emptyRevision }], [])).rejects.toMatchObject({ code: "not_found" })
    await env.DB.prepare("INSERT INTO revision_resources (revision_id,path,kind,object_key,sha256,size,content_type) VALUES (?, '/other/page.html', 'document', 'colliding', ?, 1, 'text/html')").bind(revisionId, digest).run()
    await expect(executeGuarded(env.DB, instanceId, [restore], [])).rejects.toMatchObject({ code: "conflict" })
  })
  it("allows an installation publisher to restore a subtree under its original page ID", async () => {
    const otherArtifact = `ar_${"b".repeat(26)}`
    const otherRevision = `rv_${"b".repeat(26)}`
    const otherPage = `pg_${"b".repeat(26)}`
    const publisher = `pr_${"b".repeat(26)}`
    await pageFixture({ artifact: otherArtifact, revision: otherRevision, page: otherPage, route: { kind: "subtree", slug: "second" } })
    await env.DB.prepare("INSERT INTO principals (principal_id,issuer,subject,created_at) VALUES (?, 'https://team.cloudflareaccess.com', 'publisher', 1)").bind(publisher).run()
    const deps = { db: env.DB, config: (await configs()).manage, now: () => 10 }
    await assignRole(deps, actor, { targetPrincipalId: publisher, expectedTargetAuthorityEpoch: 0, role: "publisher", scope: { kind: "installation" } })
    const old: GuardInput = { ...unpublish, pageId: otherPage, artifactId: otherArtifact, expectedPolicyEpoch: 0 }
    await executeGuarded(env.DB, instanceId, [old], [...retirePageStatements(env.DB, { pageId: otherPage, actorPrincipalId: principalId, at: 20 }), env.DB.prepare("UPDATE artifacts SET content_version = 1 WHERE artifact_id = ?").bind(otherArtifact)])
    const next: GuardInput = { ...restore, actor: { principalId: publisher, surface: "manage", expectedAuthorityEpoch: 1 }, pageId: otherPage, artifactId: otherArtifact, revisionId: otherRevision }
    await executeGuarded(env.DB, instanceId, [next], restorePageStatements(env.DB, { pageId: otherPage, revisionId: otherRevision, at: 30 }))
    expect(await env.DB.prepare("SELECT page_id, route_key FROM routes WHERE kind = 'subtree' AND route_key = 'second'").first()).toEqual({ page_id: otherPage, route_key: "second" })
    expect(await readPagePolicy(deps, { principalId: publisher, authorityEpoch: 1, surface: "manage" }, otherPage)).toMatchObject({ pageId: otherPage, visibility: "private", policyEpoch: 2, grant: null })
  })
})
