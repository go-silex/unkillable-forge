import { env } from "cloudflare:workers"
import { beforeEach, describe, expect, it } from "vitest"
import { decideRead } from "../../domains/catalogue/read"
import { PublicationService } from "../../domains/publication"
import type { BeginCommand, PublicationDeps, PublicationReceipt } from "../../domains/publication/types"
import { RevisionStore } from "../../domains/store/revision-store"
import { actor, bootstrap, configs, instanceId, jwks, teamIdentity } from "./fixtures/catalogue"
import { body, clock, content, documentCommand, publishDocument, storedBytes } from "./fixtures/publication"

beforeEach(async () => { await bootstrap() })
const path = "/a/lifecycle/index.html"

async function setup() {
  const time = clock(10_000), config = await configs()
  const store = new RevisionStore(env.REVISION_BYTES, instanceId)
  const deps: PublicationDeps = { db: env.DB, config: config.manage, jwks, now: time.now, store, publication: { sessionTtlMs: 60_000, maxUploadTimeoutMs: 1000, retainMs: 900_000, marginMs: 1000, manageClockSkewMs: 0, readClockSkewMs: 0 } }
  return { time, store, deps, read: config.read, publication: new PublicationService(deps) }
}

async function nextCommand(receipt: PublicationReceipt, pageId: string) {
  const file = await content("next document")
  const command: BeginCommand = { idempotencyKey: "lifecycle-next", artifactId: receipt.artifactId, expectedRevisionId: receipt.revisionId, expectedContentVersion: receipt.contentVersion, files: [{ path, kind: "document", size: file.size, sha256: file.sha256, contentType: "text/html", source: "client" }], pages: [{ pageId, disposition: "keep", documentPath: path, metadata: {}, expectedPolicyEpoch: 0 }], edges: [] }
  return { file, command }
}

describe("publication lifecycle and native revision integrity", () => {
  it.each(["not_sealed", "closed", "expired"] as const)("distinguishes %s before attempting revision activation", async state => {
    const { publication, time, read, store } = await setup()
    const first = await documentCommand(`lifecycle-${state}`, path, "original")
    const initial = await publishDocument(publication, actor, first.command, first.bytes)
    const next = await nextCommand(initial.receipt, first.pageId)
    const session = await publication.begin(actor, next.command)
    if (state !== "not_sealed") {
      await publication.upload(actor, session.sessionId, path, body(next.file.bytes))
      await publication.seal(actor, session.sessionId)
      if (state === "closed") await publication.abort(actor, session.sessionId)
      else time.advance(60_001)
    }
    await expect(publication.commit(actor, session.sessionId)).rejects.toMatchObject({ code: "invalid_state", detail: `publication_${state}` })
    expect(await decideRead(env.DB, read, { kind: "page", route: { kind: "subtree", slug: "lifecycle" }, candidates: [path], fragmentPath: null }, { team: teamIdentity, shareKey: null, shareCookie: null, pinnedProof: null, nowSeconds: 1 }, null)).toMatchObject({ kind: "allow", plan: { revisionId: initial.session.revisionId } })
    expect(await storedBytes(store, { artifactId: initial.session.artifactId, revisionId: initial.session.revisionId, kind: "resource", path })).toEqual(first.bytes)
  })

  it.each(["delete", "replace"] as const)("refuses commit after out-of-band native R2 %s", async mutation => {
    const { publication, read, store } = await setup()
    const first = await documentCommand(`native-${mutation}`, path, "original")
    const initial = await publishDocument(publication, actor, first.command, first.bytes)
    const next = await nextCommand(initial.receipt, first.pageId)
    const session = await publication.begin(actor, next.command)
    await publication.upload(actor, session.sessionId, path, body(next.file.bytes))
    await publication.seal(actor, session.sessionId)
    const ref = { artifactId: session.artifactId, revisionId: session.revisionId, kind: "resource" as const, path }
    const object = await store.head(ref)
    if (!object) throw new Error("sealed object missing before native fault injection")
    if (mutation === "delete") await env.REVISION_BYTES.delete(object.key)
    else await env.REVISION_BYTES.put(object.key, next.file.bytes)
    await expect(publication.commit(actor, session.sessionId)).rejects.toMatchObject({ code: "invalid_state" })
    expect(await decideRead(env.DB, read, { kind: "page", route: { kind: "subtree", slug: "lifecycle" }, candidates: [path], fragmentPath: null }, { team: teamIdentity, shareKey: null, shareCookie: null, pinnedProof: null, nowSeconds: 1 }, null)).toMatchObject({ kind: "allow", plan: { revisionId: initial.session.revisionId } })
    expect(await storedBytes(store, { artifactId: initial.session.artifactId, revisionId: initial.session.revisionId, kind: "resource", path })).toEqual(first.bytes)
  })

  it.each(["short", "long", "checksum"] as const)("reports %s upload as an integrity failure", async failure => {
    const { publication, store } = await setup()
    const original = await documentCommand(`integrity-${failure}`, path, "right")
    const session = await publication.begin(actor, original.command)
    const bad = await content(failure === "short" ? "no" : failure === "long" ? "longer than declared" : "wrong")
    await expect(publication.upload(actor, session.sessionId, path, body(bad.bytes))).rejects.toMatchObject({ code: "integrity_error" })
    expect(await storedBytes(store, { artifactId: session.artifactId, revisionId: session.revisionId, kind: "resource", path })).toBeNull()
    expect(await publication.status(actor, session.sessionId)).toMatchObject({ state: "open", files: [{ path, stored: false }] })
  })

  it("classifies its own upload deadline rather than an unknown provider failure", async () => {
    const { deps, store } = await setup()
    const publication = new PublicationService({ ...deps, publication: { ...deps.publication, maxUploadTimeoutMs: 100, marginMs: 1000 } })
    const input = await documentCommand("own-timeout", path, "body")
    const session = await publication.begin(actor, input.command)
    const stalled = new ReadableStream<Uint8Array>({ pull() { return new Promise<void>(() => {}) } }, { highWaterMark: 0 })
    await expect(publication.upload(actor, session.sessionId, path, stalled)).rejects.toMatchObject({ code: "unavailable", detail: "publication_upload_timeout" })
    expect(await publication.status(actor, session.sessionId)).toMatchObject({ state: "open", files: [{ path, stored: false }] })
    expect(await storedBytes(store, { artifactId: session.artifactId, revisionId: session.revisionId, kind: "resource", path })).toBeNull()
  }, 30_000)
})
