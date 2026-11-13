import { env } from "cloudflare:workers"
import { beforeEach, describe, expect, it } from "vitest"
import { assignRole, claimPageStatements } from "../../domains/catalogue/commands"
import { executeGuarded, type GuardRequest } from "../../domains/catalogue/guard"
import { decideRead } from "../../domains/catalogue/read"
import { actor, artifactId, authenticatedActor, bootstrap, configs, digest, jwks, pageFixture, pageId, revisionId, teamIdentity } from "./fixtures/catalogue"

const provider = `ar_${"b".repeat(26)}`, otherProvider = `ar_${"c".repeat(26)}`
const publisherId = `pr_${"b".repeat(26)}`
const path = "/shared/asset.js"
beforeEach(async () => {
  await bootstrap()
  await pageFixture({ route: { kind: "tree_page", pageRef: "docs/page.html" } })
  await pageFixture({ artifact: provider, revision: `rv_${"b".repeat(26)}`, page: `pg_${"b".repeat(26)}`, route: { kind: "tree_page", pageRef: "private/provider.html" } })
  await pageFixture({ artifact: otherProvider, revision: `rv_${"c".repeat(26)}`, page: `pg_${"c".repeat(26)}`, route: { kind: "tree_page", pageRef: "private/other.html" } })
  await env.DB.prepare("INSERT INTO principals (principal_id,issuer,subject,created_at) VALUES (?, 'https://team.cloudflareaccess.com', 'publisher', 1)").bind(publisherId).run()
})

async function createRevision(id: string): Promise<void> {
  await env.DB.batch([
    env.DB.prepare("INSERT INTO revisions (revision_id,artifact_id,origin,manifest_sha256,manifest_object_key,sealed_at) VALUES (?,?,'published',?,'next',2)").bind(id, artifactId, digest),
    env.DB.prepare("INSERT INTO revision_resources (revision_id,path,kind,object_key,sha256,size,content_type) VALUES (?,'/docs/page.html','document','page',?,1,'text/html')").bind(id, digest),
  ])
}
function pageRow(id: string): D1PreparedStatement {
  return env.DB.prepare("INSERT INTO revision_pages (revision_id,page_id,document_path,metadata_json) VALUES (?,?,'/docs/page.html','{}')").bind(id, pageId)
}
function stage(id: string): GuardRequest { return { action: "stage", pageId, artifactId, revisionId: id, requestDigest: digest, occurredAt: 10 } }

describe("ownership edge admission in the guarded transaction", () => {
  it("enforces subtree-local ownership at admission even for an administrator", async () => {
    const deps = { db: env.DB, config: (await configs()).manage, jwks, now: () => 10 }
    const artifact = `ar_${"e".repeat(26)}`, page = `pg_${"e".repeat(26)}`
    const current = `rv_${"e".repeat(26)}`, next = `rv_${"f".repeat(26)}`
    await pageFixture({ artifact, page, revision: current, route: { kind: "subtree", slug: "consumer" } })
    await env.DB.batch([
      env.DB.prepare("INSERT INTO revisions (revision_id,artifact_id,origin,manifest_sha256,manifest_object_key,sealed_at) VALUES (?,?,'published',?,'next',2)").bind(next, artifact, digest),
      env.DB.prepare("INSERT INTO revision_resources (revision_id,path,kind,object_key,sha256,size,content_type) VALUES (?,'/a/consumer/index.html','document','page',?,1,'text/html')").bind(next, digest),
    ])
    const guard: GuardRequest = { action: "stage", pageId: page, artifactId: artifact, revisionId: next, requestDigest: digest, occurredAt: 10 }
    const row = () => env.DB.prepare("INSERT INTO revision_pages (revision_id,page_id,document_path,metadata_json) VALUES (?,?,'/a/consumer/index.html','{}')").bind(next, page)
    for (const edge of [
      { ownerPageId: page, path: "/a/consumer/asset.js", providerArtifactId: provider },
      { ownerPageId: page, path: "/shared/asset.js", providerArtifactId: artifact },
      { ownerPageId: page, path: "/a/consumer-other/asset.js", providerArtifactId: artifact },
    ]) {
      await expect(executeGuarded(deps, actor, [guard], [row()], { revisionId: next, edges: [edge] })).rejects.toMatchObject({ code: "forbidden" })
      expect(await env.DB.prepare("SELECT count(*) AS n FROM revision_pages WHERE revision_id = ?").bind(next).first()).toEqual({ n: 0 })
    }
    await executeGuarded(deps, actor, [guard], [row()], { revisionId: next, edges: [{ ownerPageId: page, path: "/a/consumer/asset.js", providerArtifactId: artifact }] })
    expect(await env.DB.prepare("SELECT count(*) AS n FROM resource_owners WHERE owner_revision_id = ?").bind(next).first()).toEqual({ n: 1 })
  })
  it("refuses new cross-artefact edges for a page publisher with no effects or audit rows", async () => {
    const deps = { db: env.DB, config: (await configs()).manage, jwks, now: () => 10 }
    await assignRole(deps, actor, { targetPrincipalId: publisherId, expectedTargetAuthorityEpoch: 0, role: "publisher", scope: { kind: "page", pageId } })
    const publisher = await authenticatedActor("publisher")
    const next = `rv_${"d".repeat(26)}`
    await createRevision(next)
    const before = await env.DB.prepare("SELECT count(*) AS n FROM mutation_events").first()
    await expect(executeGuarded(deps, publisher, [stage(next)], [pageRow(next), env.DB.prepare("UPDATE artifacts SET content_version = 99 WHERE artifact_id = ?").bind(artifactId)], { revisionId: next, edges: [{ ownerPageId: pageId, path, providerArtifactId: provider }] })).rejects.toMatchObject({ code: "forbidden" })
    expect(await env.DB.prepare("SELECT count(*) AS n FROM resource_owners").first()).toEqual({ n: 0 })
    expect(await env.DB.prepare("SELECT content_version FROM artifacts WHERE artifact_id = ?").bind(artifactId).first()).toEqual({ content_version: 0 })
    expect(await env.DB.prepare("SELECT count(*) AS n FROM mutation_events").first()).toEqual(before)
  })
  it("allows admin and installation publisher to create cross-artefact edges", async () => {
    const deps = { db: env.DB, config: (await configs()).manage, jwks, now: () => 10 }
    const first = `rv_${"d".repeat(26)}`, second = `rv_${"e".repeat(26)}`
    await createRevision(first)
    await createRevision(second)
    await executeGuarded(deps, actor, [stage(first)], [pageRow(first)], { revisionId: first, edges: [{ ownerPageId: pageId, path, providerArtifactId: provider }] })
    await assignRole(deps, actor, { targetPrincipalId: publisherId, expectedTargetAuthorityEpoch: 0, role: "publisher", scope: { kind: "installation" } })
    const publisher = await authenticatedActor("publisher")
    await executeGuarded(deps, publisher, [stage(second)], [pageRow(second)], { revisionId: second, edges: [{ ownerPageId: pageId, path: "/shared/another.js", providerArtifactId: otherProvider }] })
    expect(await env.DB.prepare("SELECT path,provider_artifact_id FROM resource_owners ORDER BY path").all()).toMatchObject({ results: [{ path: "/shared/another.js", provider_artifact_id: otherProvider }, { path, provider_artifact_id: provider }] })
  })
  it("allows a page publisher to preserve exactly an active edge, not retarget it", async () => {
    const deps = { db: env.DB, config: (await configs()).manage, jwks, now: () => 10 }
    const initial = `rv_${"f".repeat(26)}`
    await createRevision(initial)
    await executeGuarded(deps, actor, [stage(initial)], [pageRow(initial)], { revisionId: initial, edges: [{ ownerPageId: pageId, path, providerArtifactId: provider }] })
    await executeGuarded(deps, actor, [{ action: "publish", pageId, artifactId, revisionId: initial, expectedPolicyEpoch: 0, expectedContentVersion: 0, requestDigest: digest, occurredAt: 10 }], [
      env.DB.prepare("UPDATE mounts SET revision_id = ? WHERE artifact_id = ?").bind(initial, artifactId),
    ], undefined, [env.DB.prepare("UPDATE artifacts SET active_revision_id = ?, content_version = content_version + 1 WHERE artifact_id = ?").bind(initial, artifactId)])
    await assignRole(deps, actor, { targetPrincipalId: publisherId, expectedTargetAuthorityEpoch: 0, role: "publisher", scope: { kind: "page", pageId } })
    const publisher = await authenticatedActor("publisher")
    const next = `rv_${"d".repeat(26)}`, retarget = `rv_${"e".repeat(26)}`
    await createRevision(next)
    await createRevision(retarget)
    await executeGuarded(deps, publisher, [stage(next)], [pageRow(next)], { revisionId: next, edges: [{ ownerPageId: pageId, path, providerArtifactId: provider }] })
    expect(await env.DB.prepare("SELECT provider_artifact_id FROM resource_owners WHERE owner_revision_id = ? AND path = ?").bind(next, path).first()).toEqual({ provider_artifact_id: provider })
    await expect(executeGuarded(deps, publisher, [stage(retarget)], [pageRow(retarget)], { revisionId: retarget, edges: [{ ownerPageId: pageId, path, providerArtifactId: otherProvider }] })).rejects.toMatchObject({ code: "forbidden" })
    expect(await env.DB.prepare("SELECT count(*) AS n FROM resource_owners WHERE owner_revision_id = ?").bind(retarget).first()).toEqual({ n: 0 })
  })
  it("rolls back a page publisher's pre-admission active revision flip", async () => {
    const deps = { db: env.DB, config: (await configs()).manage, jwks, now: () => 10 }
    const initial = `rv_${"f".repeat(26)}`
    await createRevision(initial)
    await executeGuarded(deps, actor, [stage(initial)], [pageRow(initial)], { revisionId: initial, edges: [{ ownerPageId: pageId, path, providerArtifactId: provider }] })
    await executeGuarded(deps, actor, [{ action: "publish", pageId, artifactId, revisionId: initial, expectedPolicyEpoch: 0, expectedContentVersion: 0, requestDigest: digest, occurredAt: 10 }], [
      env.DB.prepare("UPDATE mounts SET revision_id = ? WHERE artifact_id = ?").bind(initial, artifactId),
    ], undefined, [env.DB.prepare("UPDATE artifacts SET active_revision_id = ?, content_version = content_version + 1 WHERE artifact_id = ?").bind(initial, artifactId)])
    await assignRole(deps, actor, { targetPrincipalId: publisherId, expectedTargetAuthorityEpoch: 0, role: "publisher", scope: { kind: "page", pageId } })
    const publisher = await authenticatedActor("publisher")
    const next = `rv_${"d".repeat(26)}`
    await createRevision(next)
    await expect(executeGuarded(deps, publisher, [stage(next)], [pageRow(next), env.DB.prepare("UPDATE artifacts SET active_revision_id = ? WHERE artifact_id = ?").bind(next, artifactId)], { revisionId: next, edges: [{ ownerPageId: pageId, path, providerArtifactId: provider }] })).rejects.toMatchObject({ code: "forbidden" })
    expect(await env.DB.prepare("SELECT active_revision_id FROM artifacts WHERE artifact_id = ?").bind(artifactId).first()).toEqual({ active_revision_id: initial })
  })
  it("re-admits historical cross-artefact edges on promotion and pinning", async () => {
    const deps = { db: env.DB, config: (await configs()).manage, jwks, now: () => 10 }
    const withEdge = `rv_${"d".repeat(26)}`, withoutEdge = `rv_${"e".repeat(26)}`
    await createRevision(withEdge)
    await executeGuarded(deps, actor, [stage(withEdge)], [pageRow(withEdge)], { revisionId: withEdge, edges: [{ ownerPageId: pageId, path, providerArtifactId: provider }] })
    const promote = async (revision: string, version: number) => executeGuarded(deps, actor, [{ action: "publish", pageId, artifactId, revisionId: revision, expectedPolicyEpoch: 0, expectedContentVersion: version, requestDigest: digest, occurredAt: 10 }], [
      env.DB.prepare("UPDATE mounts SET revision_id = ? WHERE artifact_id = ?").bind(revision, artifactId),
    ], undefined, [env.DB.prepare("UPDATE artifacts SET active_revision_id = ?, content_version = content_version + 1 WHERE artifact_id = ?").bind(revision, artifactId)])
    await promote(withEdge, 0)
    await createRevision(withoutEdge)
    await executeGuarded(deps, actor, [stage(withoutEdge)], [pageRow(withoutEdge)])
    await promote(withoutEdge, 1)
    await assignRole(deps, actor, { targetPrincipalId: publisherId, expectedTargetAuthorityEpoch: 0, role: "publisher", scope: { kind: "page", pageId } })
    const publisher = await authenticatedActor("publisher")
    const publish: GuardRequest = { action: "publish", pageId, artifactId, revisionId: withEdge, expectedPolicyEpoch: 0, expectedContentVersion: 2, requestDigest: digest, occurredAt: 10 }
    await expect(executeGuarded(deps, publisher, [publish], [])).rejects.toMatchObject({ code: "forbidden" })
    await expect(executeGuarded(deps, publisher, [{ ...publish, action: "share" }], [])).rejects.toMatchObject({ code: "forbidden" })
    const subject = { kind: "page" as const, route: { kind: "tree_page" as const, pageRef: "docs/page.html" }, candidates: ["/docs/page.html"], fragmentPath: null }
    const credentials = { team: teamIdentity, shareKey: null, shareCookie: null, pinnedProof: null, nowSeconds: 1 }
    expect(await decideRead(env.DB, (await configs()).read, subject, credentials, null)).toMatchObject({ kind: "allow", plan: { revisionId: withoutEdge } })
    await promote(withEdge, 2)
    expect(await decideRead(env.DB, (await configs()).read, subject, credentials, null)).toMatchObject({ kind: "allow", plan: { revisionId: withEdge } })
  })
  it("claims a new page and admits its cross-artefact edge in one guarded batch", async () => {
    const deps = { db: env.DB, config: (await configs()).manage, jwks, now: () => 10 }
    const newArtifact = `ar_${"d".repeat(26)}`, newRevision = `rv_${"d".repeat(26)}`, newPage = `pg_${"d".repeat(26)}`
    await env.DB.batch([
      env.DB.prepare("INSERT INTO artifacts (artifact_id,origin,created_at) VALUES (?,'published',1)").bind(newArtifact),
      env.DB.prepare("INSERT INTO revisions (revision_id,artifact_id,origin,manifest_sha256,manifest_object_key,sealed_at) VALUES (?,?,'published',?,'new',1)").bind(newRevision, newArtifact, digest),
      env.DB.prepare("INSERT INTO revision_resources (revision_id,path,kind,object_key,sha256,size,content_type) VALUES (?,'/new/page.html','document','new-page',?,1,'text/html')").bind(newRevision, digest),
      env.DB.prepare("INSERT INTO mounts (path,artifact_id,revision_id,kind) VALUES ('/new/page.html',?,?,'document')").bind(newArtifact, newRevision),
    ])
    const guard: GuardRequest = { action: "create_page", pageId: newPage, artifactId: newArtifact, revisionId: newRevision, requestDigest: digest, occurredAt: 10 }
    await executeGuarded(deps, actor, [guard], [
      ...claimPageStatements(deps, actor, { pageId: newPage, artifactId: newArtifact, route: { kind: "tree_page", pageRef: "new/page.html" }, at: 10 }),
      env.DB.prepare("INSERT INTO revision_pages (revision_id,page_id,document_path,metadata_json) VALUES (?,?,'/new/page.html','{}')").bind(newRevision, newPage),
    ], { revisionId: newRevision, edges: [{ ownerPageId: newPage, path, providerArtifactId: provider }] }, [env.DB.prepare("UPDATE artifacts SET active_revision_id = ? WHERE artifact_id = ?").bind(newRevision, newArtifact)])
    expect(await env.DB.prepare("SELECT provider_artifact_id FROM resource_owners WHERE owner_revision_id = ? AND owner_page_id = ?").bind(newRevision, newPage).first()).toEqual({ provider_artifact_id: provider })
    expect(await env.DB.prepare("SELECT created_by FROM pages WHERE page_id = ?").bind(newPage).first()).toEqual({ created_by: actor.principalId })
  })
  it("rolls back a forged page-to-foreign-revision ownership edge", async () => {
    const deps = { db: env.DB, config: (await configs()).manage, jwks, now: () => 10 }
    const foreignRevision = `rv_${"g".repeat(26)}`
    await env.DB.prepare("INSERT INTO revisions (revision_id,artifact_id,origin,manifest_sha256,manifest_object_key,sealed_at) VALUES (?,?,'published',?,'foreign',2)").bind(foreignRevision, provider, digest).run()
    const before = await env.DB.prepare("SELECT count(*) AS n FROM mutation_events").first()
    await expect(executeGuarded(deps, actor, [stage(foreignRevision)], [
      env.DB.prepare("INSERT INTO revision_resources (revision_id,path,kind,object_key,sha256,size,content_type) VALUES (?,'/forged.html','document','forged',?,1,'text/html')").bind(foreignRevision, digest),
      env.DB.prepare("INSERT INTO revision_pages (revision_id,page_id,document_path,metadata_json) VALUES (?,?,'/forged.html','{}')").bind(foreignRevision, pageId),
    ], { revisionId: foreignRevision, edges: [{ ownerPageId: pageId, path, providerArtifactId: provider }] })).rejects.toMatchObject({ code: "forbidden" })
    expect(await env.DB.prepare("SELECT count(*) AS n FROM revision_pages WHERE revision_id = ? AND page_id = ?").bind(foreignRevision, pageId).first()).toEqual({ n: 0 })
    expect(await env.DB.prepare("SELECT count(*) AS n FROM mutation_events").first()).toEqual(before)
  })
})
