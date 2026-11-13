import { env } from "cloudflare:workers"
import { beforeEach, describe, expect, it } from "vitest"
import { revokeShare, setVisibility, share } from "../../domains/catalogue/commands"
import { decideRead, type ReadCredentials, type ReadSubject } from "../../domains/catalogue/read"
import { actor, artifactId, bootstrap, configs, digest, pageFixture, pageId, revisionId } from "./fixtures/catalogue"

const nextRevision = `rv_${"b".repeat(26)}`
const path = "/a/sample/index.html"
const none: ReadCredentials = { team: null, shareKey: null, shareCookie: null, pinnedProof: null }
const shareSubject: ReadSubject = { kind: "share", route: { kind: "subtree", slug: "sample" }, candidates: [path] }
const pinned: ReadSubject = { kind: "pinned", pageId, revisionId, path }

beforeEach(async () => { await bootstrap(); await pageFixture() })
async function publishNext(): Promise<void> {
  await env.DB.batch([
    env.DB.prepare("INSERT INTO revisions (revision_id,artifact_id,origin,manifest_sha256,manifest_object_key,sealed_at) VALUES (?,?,'published',?,'next-manifest',2)").bind(nextRevision, artifactId, digest),
    env.DB.prepare("INSERT INTO revision_resources (revision_id,path,kind,object_key,sha256,size,content_type) VALUES (?,?,'document','next-document',?,1,'text/html')").bind(nextRevision, path, digest),
    env.DB.prepare("INSERT INTO revision_pages (revision_id,page_id,document_path,metadata_json) VALUES (?,?,?,'{}')").bind(nextRevision, pageId, path),
    env.DB.prepare("UPDATE mounts SET revision_id = ? WHERE path = ?").bind(nextRevision, path),
    env.DB.prepare("UPDATE artifacts SET active_revision_id = ?, content_version = content_version + 1 WHERE artifact_id = ?").bind(nextRevision, artifactId),
  ])
}

describe("revision and grant authority", () => {
  it.each(["pinned", "follow_active"] as const)("%s grant selects the correct revision after publication", async (mode) => {
    const { read, manage } = await configs()
    const grant = await share({ db: env.DB, config: manage, now: () => 10 }, actor, { pageId, artifactId, expectedPolicyEpoch: 0, ...(mode === "pinned" ? { mode, revisionId } : { mode }) })
    await publishNext()
    const decision = await decideRead(env.DB, read, shareSubject, { ...none, shareKey: grant.key }, null)
    expect(decision).toMatchObject({ kind: "allow", plan: { revisionId: mode === "pinned" ? revisionId : nextRevision, authority: { basis: "share_key" } } })
    expect(await decideRead(env.DB, read, shareSubject, { ...none, shareKey: "wrongkey123" }, null)).toEqual({ kind: "deny", reason: "not_found" })
  })
  it("old revision requires matching fresh proof even for a currently public page", async () => {
    const { read, manage } = await configs()
    await setVisibility({ db: env.DB, config: manage, now: () => 10 }, actor, { pageId, artifactId, expectedPolicyEpoch: 0, visibility: "public" })
    await publishNext()
    expect(await decideRead(env.DB, read, pinned, none, null)).toEqual({ kind: "deny", reason: "not_found" })
    const proof = { instanceId: read.instanceId, pageId, revisionId, policyEpoch: 1, basis: { kind: "public" as const } }
    expect(await decideRead(env.DB, read, pinned, { ...none, pinnedProof: proof }, null)).toMatchObject({ kind: "allow", plan: { revisionId } })
    expect(await decideRead(env.DB, read, pinned, { ...none, pinnedProof: { ...proof, policyEpoch: 0 } }, null)).toEqual({ kind: "deny", reason: "not_found" })
    expect(await decideRead(env.DB, read, { ...pinned, path: "/other/private.js" }, { ...none, pinnedProof: proof }, null)).toEqual({ kind: "deny", reason: "not_found" })
  })
  it("denies a formerly valid pinned proof immediately after grant revocation", async () => {
    const { read, manage } = await configs()
    const deps = { db: env.DB, config: manage, now: () => 10 }
    const grant = await share(deps, actor, { pageId, artifactId, expectedPolicyEpoch: 0, mode: "pinned", revisionId })
    await publishNext()
    const proof = { instanceId: read.instanceId, pageId, revisionId, policyEpoch: 1, basis: { kind: "grant" as const, grantId: grant.grantId } }
    expect(await decideRead(env.DB, read, pinned, { ...none, pinnedProof: proof }, null)).toMatchObject({ kind: "allow" })
    await revokeShare(deps, actor, { pageId, artifactId, expectedPolicyEpoch: 1, grantId: grant.grantId })
    expect(await decideRead(env.DB, read, pinned, { ...none, pinnedProof: proof }, null)).toEqual({ kind: "deny", reason: "not_found" })
  })
})
