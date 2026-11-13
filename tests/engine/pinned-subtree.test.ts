import { env } from "cloudflare:workers"
import { beforeEach, describe, expect, it } from "vitest"
import { share } from "../../domains/catalogue/commands"
import { decideRead, type ReadCredentials, type ReadSubject } from "../../domains/catalogue/read"
import { actor, addOwnership, artifactId, bootstrap, configs, digest, jwks, pageFixture, pageId, revisionId, teamIdentity } from "./fixtures/catalogue"

const none: ReadCredentials = { team: null, shareKey: null, shareCookie: null, pinnedProof: null, nowSeconds: 1 }
const route = { kind: "subtree", slug: "sample" } as const
const page: ReadSubject = { kind: "page", route, candidates: ["/a/sample/index.html"], fragmentPath: null }
const pinned = (path: string): ReadSubject => ({ kind: "pinned", pageId, revisionId, path })

beforeEach(async () => { await bootstrap(); await pageFixture() })

describe("pinned subtree confinement", () => {
  it("serves a real owned subtree asset but rejects an equally real outside asset despite an ownership edge", async () => {
    const { read, manage } = await configs()
    for (const path of ["/a/sample/inside.js", "/a/other/outside.js"]) {
      await env.DB.batch([
        env.DB.prepare("INSERT INTO revision_resources (revision_id,path,kind,object_key,sha256,size,content_type) VALUES (?,?,'asset',?,?,1,'application/javascript')").bind(revisionId, path, path, digest),
        env.DB.prepare("INSERT INTO mounts (path,artifact_id,revision_id,kind) VALUES (?,?,?,'asset')").bind(path, artifactId, revisionId),
      ])
      await addOwnership(path, artifactId)
    }
    const grant = await share({ db: env.DB, config: manage, jwks, now: () => 10 }, actor, { pageId, artifactId, expectedPolicyEpoch: 0, mode: "follow_active" })
    const sharePage = await decideRead(env.DB, read, { kind: "share", route, candidates: ["/a/sample/index.html"] }, { ...none, shareKey: grant.key }, null)
    const teamPage = await decideRead(env.DB, read, page, { ...none, team: teamIdentity }, null)
    if (sharePage.kind !== "allow" || !sharePage.plan.pinnedProof || teamPage.kind !== "allow" || !teamPage.plan.pinnedProof) throw new Error("authorized page proofs unavailable")
    for (const credentials of [{ ...none, pinnedProof: sharePage.plan.pinnedProof }, { ...none, team: teamIdentity, pinnedProof: teamPage.plan.pinnedProof }]) {
      expect(await decideRead(env.DB, read, pinned("/a/sample/inside.js"), credentials, null)).toMatchObject({ kind: "allow", plan: { resource: { objectKey: "/a/sample/inside.js" } } })
      expect(await decideRead(env.DB, read, pinned("/a/other/outside.js"), credentials, null)).toEqual({ kind: "deny", reason: "not_found" })
    }
  })
})
