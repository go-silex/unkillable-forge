import { env } from "cloudflare:workers"
import { beforeEach, describe, expect, it } from "vitest"
import { share, setVisibility } from "../../domains/catalogue/commands"
import { decideRead, type ReadCredentials, type ReadSubject } from "../../domains/catalogue/read"
import { actor, addOwnership, artifactId, bootstrap, configs, digest, jwks, pageFixture, pageId, revisionId, teamIdentity } from "./fixtures/catalogue"

const provider = `ar_${"b".repeat(26)}`, providerRevision = `rv_${"b".repeat(26)}`, providerPage = `pg_${"b".repeat(26)}`
const path = "/shared/asset.js"
const none: ReadCredentials = { team: null, shareKey: null, shareCookie: null, pinnedProof: null, nowSeconds: 1 }
const page: ReadSubject = { kind: "page", route: { kind: "tree_page", pageRef: "docs/page.html" }, candidates: ["/docs/page.html"], fragmentPath: null }
const pinned = (resource: string): ReadSubject => ({ kind: "pinned", pageId, revisionId, path: resource })
beforeEach(async () => { await bootstrap(); await pageFixture({ route: { kind: "tree_page", pageRef: "docs/page.html" } }) })

async function proofForPage(): Promise<string> {
  const decision = await decideRead(env.DB, (await configs()).read, page, none, null)
  if (decision.kind !== "allow" || !decision.plan.pinnedProof) throw new Error("authorized page did not mint a proof")
  return decision.plan.pinnedProof
}

describe("pinned ownership authority", () => {
  it("keeps old local bytes after the owner drops a path and another artefact claims it", async () => {
    const { read, manage } = await configs()
    await env.DB.batch([
      env.DB.prepare("INSERT INTO revision_resources (revision_id,path,kind,object_key,sha256,size,content_type) VALUES (?,?,'asset','local-r1',?,1,'application/javascript')").bind(revisionId, path, digest),
      env.DB.prepare("INSERT INTO mounts (path,artifact_id,revision_id,kind) VALUES (?,?,?,'asset')").bind(path, artifactId, revisionId),
    ])
    await addOwnership(path, artifactId)
    await setVisibility({ db: env.DB, config: manage, jwks, now: () => 10 }, actor, { pageId, artifactId, expectedPolicyEpoch: 0, visibility: "public" })
    const proof = await proofForPage()
    const next = `rv_${"c".repeat(26)}`
    await env.DB.batch([
      env.DB.prepare("INSERT INTO revisions (revision_id,artifact_id,origin,manifest_sha256,manifest_object_key,sealed_at) VALUES (?,?,'published',?,'next',2)").bind(next, artifactId, digest),
      env.DB.prepare("INSERT INTO revision_resources (revision_id,path,kind,object_key,sha256,size,content_type) VALUES (?,'/docs/page.html','document','next-page',?,1,'text/html')").bind(next, digest),
      env.DB.prepare("INSERT INTO revision_pages (revision_id,page_id,document_path,metadata_json) VALUES (?,?,'/docs/page.html','{}')").bind(next, pageId),
      env.DB.prepare("DELETE FROM mounts WHERE path = ?").bind(path),
      env.DB.prepare("UPDATE mounts SET revision_id = ? WHERE path = '/docs/page.html'").bind(next),
      env.DB.prepare("UPDATE artifacts SET active_revision_id = ?,content_version = 1 WHERE artifact_id = ?").bind(next, artifactId),
    ])
    await pageFixture({ artifact: provider, revision: providerRevision, page: providerPage, route: { kind: "tree_page", pageRef: "private/provider.html" } })
    await env.DB.batch([
      env.DB.prepare("INSERT INTO revision_resources (revision_id,path,kind,object_key,sha256,size,content_type) VALUES (?,?,'asset','private-provider',?,1,'application/javascript')").bind(providerRevision, path, digest),
      env.DB.prepare("INSERT INTO mounts (path,artifact_id,revision_id,kind) VALUES (?,?,?,'asset')").bind(path, provider, providerRevision),
    ])
    expect(await decideRead(env.DB, read, pinned(path), { ...none, pinnedProof: proof }, null)).toMatchObject({ kind: "allow", plan: { artifactId, revisionId, resource: { objectKey: "local-r1" } } })
  })
  it("follows the declared external provider's active revision but denies absent, stale or replaced mounts", async () => {
    const { read, manage } = await configs()
    await pageFixture({ artifact: provider, revision: providerRevision, page: providerPage, route: { kind: "tree_page", pageRef: "private/provider.html" } })
    await env.DB.batch([
      env.DB.prepare("INSERT INTO revision_resources (revision_id,path,kind,object_key,sha256,size,content_type) VALUES (?,?,'asset','provider-r1',?,1,'application/javascript')").bind(providerRevision, path, digest),
      env.DB.prepare("INSERT INTO mounts (path,artifact_id,revision_id,kind) VALUES (?,?,?,'asset')").bind(path, provider, providerRevision),
    ])
    await addOwnership(path, provider)
    await setVisibility({ db: env.DB, config: manage, jwks, now: () => 10 }, actor, { pageId, artifactId, expectedPolicyEpoch: 0, visibility: "public" })
    const proof = await proofForPage()
    const credentials = { ...none, pinnedProof: proof }
    expect(await decideRead(env.DB, read, pinned(path), credentials, null)).toMatchObject({ kind: "allow", plan: { artifactId: provider, revisionId: providerRevision, resource: { objectKey: "provider-r1" } } })
    const next = `rv_${"c".repeat(26)}`
    await env.DB.batch([
      env.DB.prepare("INSERT INTO revisions (revision_id,artifact_id,origin,manifest_sha256,manifest_object_key,sealed_at) VALUES (?,?,'published',?,'provider-next',2)").bind(next, provider, digest),
      env.DB.prepare("INSERT INTO revision_resources (revision_id,path,kind,object_key,sha256,size,content_type) VALUES (?,?,'asset','provider-r2',?,1,'application/javascript')").bind(next, path, digest),
      env.DB.prepare("UPDATE artifacts SET active_revision_id = ? WHERE artifact_id = ?").bind(next, provider),
    ])
    expect(await decideRead(env.DB, read, pinned(path), credentials, null)).toEqual({ kind: "deny", reason: "not_found" })
    await env.DB.prepare("UPDATE mounts SET revision_id = ? WHERE path = ?").bind(next, path).run()
    expect(await decideRead(env.DB, read, pinned(path), credentials, null)).toMatchObject({ kind: "allow", plan: { artifactId: provider, revisionId: next, resource: { objectKey: "provider-r2" } } })
    await env.DB.prepare("DELETE FROM mounts WHERE path = ?").bind(path).run()
    expect(await decideRead(env.DB, read, pinned(path), credentials, null)).toEqual({ kind: "deny", reason: "not_found" })
    const thirdArtifact = `ar_${"c".repeat(26)}`, thirdRevision = `rv_${"d".repeat(26)}`, thirdPage = `pg_${"c".repeat(26)}`
    await pageFixture({ artifact: thirdArtifact, revision: thirdRevision, page: thirdPage, route: { kind: "tree_page", pageRef: "private/replacement.html" } })
    await env.DB.batch([
      env.DB.prepare("INSERT INTO revision_resources (revision_id,path,kind,object_key,sha256,size,content_type) VALUES (?,?,'asset','private-third',?,1,'application/javascript')").bind(thirdRevision, path, digest),
      env.DB.prepare("INSERT INTO mounts (path,artifact_id,revision_id,kind) VALUES (?,?,?,'asset')").bind(path, thirdArtifact, thirdRevision),
    ])
    expect(await decideRead(env.DB, read, pinned(path), credentials, null)).toEqual({ kind: "deny", reason: "not_found" })
  })
  it("never reads a sibling document or subdocument through a forged edge, even for team or a grant", async () => {
    const { read, manage } = await configs()
    await pageFixture({ artifact: provider, revision: providerRevision, page: providerPage, route: { kind: "tree_page", pageRef: "private/provider.html" } })
    await env.DB.batch([
      env.DB.prepare("INSERT INTO revision_resources (revision_id,path,kind,object_key,sha256,size,content_type) VALUES (?,'/private/tab.html','subdocument','private-tab',?,1,'text/html')").bind(providerRevision, digest),
      env.DB.prepare("INSERT INTO mounts (path,artifact_id,revision_id,kind) VALUES ('/private/tab.html',?,?,'subdocument')").bind(provider, providerRevision),
    ])
    await addOwnership("/private/provider.html", provider)
    await addOwnership("/private/tab.html", provider)
    const deps = { db: env.DB, config: manage, jwks, now: () => 10 }
    const grant = await share(deps, actor, { pageId, artifactId, expectedPolicyEpoch: 0, mode: "follow_active" })
    const shared = await decideRead(env.DB, read, { kind: "share", route: { kind: "tree_page", pageRef: "docs/page.html" }, candidates: ["/docs/page.html"] }, { ...none, shareKey: grant.key }, null)
    if (shared.kind !== "allow" || !shared.plan.pinnedProof) throw new Error("share proof unavailable")
    const teamPage = await decideRead(env.DB, read, page, { ...none, team: teamIdentity }, null)
    if (teamPage.kind !== "allow" || !teamPage.plan.pinnedProof) throw new Error("team proof unavailable")
    expect(await decideRead(env.DB, read, pinned("/docs/page.html"), { ...none, team: teamIdentity, pinnedProof: teamPage.plan.pinnedProof }, null)).toMatchObject({ kind: "allow" })
    expect(await decideRead(env.DB, read, pinned("/docs/page.html"), { ...none, pinnedProof: shared.plan.pinnedProof }, null)).toMatchObject({ kind: "allow" })
    for (const candidate of ["/private/provider.html", "/private/tab.html"]) {
      expect(await decideRead(env.DB, read, pinned(candidate), { ...none, team: teamIdentity, pinnedProof: teamPage.plan.pinnedProof }, null)).toEqual({ kind: "deny", reason: "not_found" })
      expect(await decideRead(env.DB, read, pinned(candidate), { ...none, pinnedProof: shared.plan.pinnedProof }, null)).toEqual({ kind: "deny", reason: "not_found" })
    }
  })
})
