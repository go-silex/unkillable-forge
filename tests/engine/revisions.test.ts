import { env } from "cloudflare:workers"
import { beforeEach, describe, expect, it } from "vitest"
import { revokeShare, rotateShare, setVisibility, share } from "../../domains/catalogue/commands"
import { decideRead, type ReadCredentials, type ReadSubject } from "../../domains/catalogue/read"
import { resolveRead } from "../../domains/catalogue/resolve"
import { actor, artifactId, authenticatedReader, bootstrap, configs, digest, jwks, pageFixture, pageId, revisionId } from "./fixtures/catalogue"

const nextRevision = `rv_${"b".repeat(26)}`
const path = "/a/sample/index.html"
const none: ReadCredentials = { team: null, shareKey: null, shareCookie: null, pinnedProof: null, nowSeconds: 1 }
const shareSubject: ReadSubject = { kind: "share", route: { kind: "subtree", slug: "sample" }, candidates: [path] }
const page: ReadSubject = { kind: "page", route: { kind: "subtree", slug: "sample" }, candidates: [path], fragmentPath: null }
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
    const grant = await share({ db: env.DB, config: manage, jwks, now: () => 10 }, actor, { pageId, artifactId, expectedPolicyEpoch: 0, ...(mode === "pinned" ? { mode, revisionId } : { mode }) })
    await publishNext()
    expect(await decideRead(env.DB, read, shareSubject, { ...none, shareKey: grant.key }, null)).toMatchObject({ kind: "allow", plan: { revisionId: mode === "pinned" ? revisionId : nextRevision, authority: { basis: "share_key" } } })
    expect(await decideRead(env.DB, read, shareSubject, { ...none, shareKey: "wrongkey123" }, null)).toEqual({ kind: "deny", reason: "not_found" })
  })
  it("only accepts authentic, fresh and unexpired proofs of a previously authorized document", async () => {
    const { read, manage } = await configs()
    const deps = { db: env.DB, config: manage, jwks, now: () => 10 }
    await setVisibility(deps, actor, { pageId, artifactId, expectedPolicyEpoch: 0, visibility: "public" })
    const initial = await decideRead(env.DB, read, page, none, null)
    if (initial.kind !== "allow" || !initial.plan.pinnedProof) throw new Error("public page did not yield a pinned proof")
    const proof = initial.plan.pinnedProof
    await publishNext()
    const request = new Request(`https://forge.example.test/_revisions/${pageId}/${revisionId}/a/sample/index.html`)
    const resolveDeps = { db: env.DB, config: read, jwks, nowSeconds: () => 2 }
    expect(await resolveRead(request, { ...resolveDeps, pinnedProof: proof })).toMatchObject({ kind: "serve", plan: { revisionId } })
    expect(await resolveRead(request, resolveDeps)).toMatchObject({ kind: "deny", status: 404 })
    expect(await resolveRead(request, { ...resolveDeps, pinnedProof: `${proof}x` })).toMatchObject({ kind: "deny", status: 404 })
    const parts = proof.split(".")
    expect(await resolveRead(request, { ...resolveDeps, pinnedProof: `${parts[0]}.unknown.${parts[2]}.${parts[3]}` })).toMatchObject({ kind: "deny", status: 404 })
    const otherKey = await crypto.subtle.importKey("raw", new Uint8Array(32).fill(9), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"])
    expect(await resolveRead(request, { ...resolveDeps, config: { ...read, shareVerifierKeys: [{ kid: "one", key: otherKey }] }, pinnedProof: proof })).toMatchObject({ kind: "deny", status: 404 })
    await pageFixture({ artifact: `ar_${"c".repeat(26)}`, revision: `rv_${"c".repeat(26)}`, page: `pg_${"b".repeat(26)}`, route: { kind: "subtree", slug: "other" }, visibility: "public" })
    expect(await decideRead(env.DB, read, { ...pinned, pageId: `pg_${"b".repeat(26)}`, revisionId: `rv_${"c".repeat(26)}`, path: "/a/other/index.html" }, { ...none, pinnedProof: proof }, null)).toEqual({ kind: "deny", reason: "not_found" })
    expect(await decideRead(env.DB, read, { ...pinned, revisionId: nextRevision }, { ...none, pinnedProof: proof }, null)).toEqual({ kind: "deny", reason: "not_found" })
    await env.DB.prepare("UPDATE instance_meta SET instance_id = 'other-instance' WHERE singleton = 1").run()
    expect(await decideRead(env.DB, { ...read, instanceId: "other-instance" }, pinned, { ...none, pinnedProof: proof }, null)).toEqual({ kind: "deny", reason: "not_found" })
    await env.DB.prepare("UPDATE instance_meta SET instance_id = ? WHERE singleton = 1").bind(read.instanceId).run()
    expect(await resolveRead(request, { ...resolveDeps, nowSeconds: () => 902, pinnedProof: proof })).toMatchObject({ kind: "deny", status: 404 })
    await setVisibility(deps, actor, { pageId, artifactId, expectedPolicyEpoch: 1, visibility: "public" })
    expect(await resolveRead(request, { ...resolveDeps, pinnedProof: proof })).toMatchObject({ kind: "deny", status: 404 })
  })
  it("requires the original still-valid verified team identity with a team proof", async () => {
    const { read } = await configs()
    const team = await authenticatedReader(3)
    const allowed = await decideRead(env.DB, read, page, { ...none, team }, null)
    if (allowed.kind !== "allow" || !allowed.plan.pinnedProof) throw new Error("team proof unavailable")
    const proof = allowed.plan.pinnedProof
    expect(await decideRead(env.DB, read, pinned, { ...none, team, pinnedProof: proof, nowSeconds: 2 }, null)).toMatchObject({ kind: "allow" })
    expect(await decideRead(env.DB, read, pinned, { ...none, pinnedProof: proof, nowSeconds: 2 }, null)).toEqual({ kind: "deny", reason: "not_found" })
    expect(await decideRead(env.DB, read, pinned, { ...none, team, pinnedProof: proof, nowSeconds: 3 }, null)).toEqual({ kind: "deny", reason: "not_found" })
    expect(await decideRead(env.DB, read, pinned, { ...none, team: { ...team }, pinnedProof: proof, nowSeconds: 2 }, null)).toEqual({ kind: "deny", reason: "not_found" })
  })
  it.each(["revoke", "rotate"] as const)("invalidates a previously valid grant proof on %s", async (change) => {
    const { read, manage } = await configs()
    const deps = { db: env.DB, config: manage, jwks, now: () => 10 }
    const grant = await share(deps, actor, { pageId, artifactId, expectedPolicyEpoch: 0, mode: "pinned", revisionId })
    const initial = await decideRead(env.DB, read, shareSubject, { ...none, shareKey: grant.key }, null)
    if (initial.kind !== "allow" || !initial.plan.pinnedProof) throw new Error("share did not yield a pinned proof")
    await publishNext()
    expect(await decideRead(env.DB, read, pinned, { ...none, pinnedProof: initial.plan.pinnedProof }, null)).toMatchObject({ kind: "allow" })
    if (change === "revoke") await revokeShare(deps, actor, { pageId, artifactId, expectedPolicyEpoch: 1, grantId: grant.grantId })
    else await rotateShare(deps, actor, { pageId, artifactId, expectedPolicyEpoch: 1, grantId: grant.grantId })
    expect(await decideRead(env.DB, read, pinned, { ...none, pinnedProof: initial.plan.pinnedProof }, null)).toEqual({ kind: "deny", reason: "not_found" })
  })
  it("denies a pinned grant and its proof when the revision does not contain the page", async () => {
    const { read, manage } = await configs()
    const deps = { db: env.DB, config: manage, jwks, now: () => 10 }
    const grant = await share(deps, actor, { pageId, artifactId, expectedPolicyEpoch: 0, mode: "pinned", revisionId })
    const initial = await decideRead(env.DB, read, shareSubject, { ...none, shareKey: grant.key }, null)
    if (initial.kind !== "allow" || !initial.plan.pinnedProof) throw new Error("share proof unavailable")
    await publishNext()
    await env.DB.prepare("DELETE FROM revision_pages WHERE revision_id = ? AND page_id = ?").bind(revisionId, pageId).run()
    expect(await decideRead(env.DB, read, shareSubject, { ...none, shareKey: grant.key }, null)).toEqual({ kind: "deny", reason: "not_found" })
    expect(await decideRead(env.DB, read, pinned, { ...none, pinnedProof: initial.plan.pinnedProof }, null)).toEqual({ kind: "deny", reason: "not_found" })
  })
})
