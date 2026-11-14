import { env } from "cloudflare:workers"
import { beforeEach, describe, expect, it } from "vitest"
import { decideRead } from "../../domains/catalogue/read"
import { PublicationService } from "../../domains/publication"
import type { BeginCommand, PublicationDeps, PublicationReceipt } from "../../domains/publication/types"
import { RevisionStore, StoreError, type StoredObjectInfo } from "../../domains/store/revision-store"
import { actor, bootstrap, configs, instanceId, jwks, teamIdentity } from "./fixtures/catalogue"
import { body, clock, content, documentCommand, publishDocument, storedBytes } from "./fixtures/publication"

const path = "/a/deadline/index.html"
beforeEach(async () => { await bootstrap() })

async function setup() {
  const time = clock(10_000), config = await configs()
  const store = new RevisionStore(env.REVISION_BYTES, instanceId)
  const deps: PublicationDeps = { db: env.DB, config: config.manage, jwks, now: time.now, store, publication: { sessionTtlMs: 60_000, maxUploadTimeoutMs: 2000, retainMs: 900_000, marginMs: 2000, manageClockSkewMs: 0, readClockSkewMs: 0 } }
  return { store, deps, read: config.read, publication: new PublicationService(deps) }
}

async function update(receipt: PublicationReceipt, pageId: string, key: string) {
  const file = await content("replacement document bytes")
  const command: BeginCommand = { idempotencyKey: key, artifactId: receipt.artifactId, expectedRevisionId: receipt.revisionId, expectedContentVersion: receipt.contentVersion, files: [{ path, kind: "document", size: file.size, sha256: file.sha256, contentType: "text/html", source: "client" }], pages: [{ pageId, disposition: "keep", documentPath: path, metadata: {}, expectedPolicyEpoch: 0 }], edges: [] }
  return { file, command }
}

function passThrough(store: RevisionStore, put: RevisionStore["put"]): RevisionStore {
  return new Proxy(store, {
    get(target, property) {
      if (property === "put") return put
      const value = Reflect.get(target, property, target)
      return typeof value === "function" ? value.bind(target) : value
    },
  })
}

function afterAbort(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve()
  return new Promise(resolve => signal.addEventListener("abort", () => resolve(), { once: true }))
}

describe("publication deadline causal outcomes", () => {
  it("preserves a native producer failure observed before the upload deadline", async () => {
    const { store, deps, read, publication } = await setup()
    const original = await documentCommand("deadline-failure-original", path, "active original bytes")
    const initial = await publishDocument(publication, actor, original.command, original.bytes)
    const next = await update(initial.receipt, original.pageId, "deadline-failure-update")
    const session = await publication.begin(actor, next.command)
    let captured: unknown
    let failedBeforeAbort = false
    const wrapped = passThrough(store, async (ref, expected, stream, signal) => {
      if (!signal) throw new Error("Publication did not supply its deadline signal")
      try { return await store.put(ref, expected, stream, signal) }
      catch (error) {
        captured = error
        failedBeforeAbort = !signal.aborted
        await afterAbort(signal)
        throw error
      }
    })
    const subject = new PublicationService({ ...deps, store: wrapped })
    let pulls = 0
    const failing = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (pulls++ === 0) controller.enqueue(next.file.bytes.subarray(0, 3))
        else controller.error(new Error("client producer failed"))
      },
    }, { highWaterMark: 0 })
    const result = await subject.upload(actor, session.sessionId, path, failing).then(() => null, error => error)
    expect(pulls).toBe(2)
    expect(failedBeforeAbort).toBe(true)
    expect(captured).toBeInstanceOf(StoreError)
    expect(captured).toMatchObject({ code: "unavailable" })
    expect(result).toBe(captured)
    expect(await publication.status(actor, session.sessionId)).toMatchObject({ state: "open", files: [{ path, stored: false }] })
    expect(await storedBytes(store, { artifactId: session.artifactId, revisionId: session.revisionId, kind: "resource", path })).toBeNull()
    expect(await decideRead(env.DB, read, { kind: "page", route: { kind: "subtree", slug: "deadline" }, candidates: [path], fragmentPath: null }, { team: teamIdentity, shareKey: null, shareCookie: null, pinnedProof: null, nowSeconds: 1 }, null)).toMatchObject({ kind: "allow", plan: { revisionId: initial.session.revisionId } })
    expect(await storedBytes(store, { artifactId: initial.session.artifactId, revisionId: initial.session.revisionId, kind: "resource", path })).toEqual(original.bytes)
    expect(await publication.upload(actor, session.sessionId, path, body(next.file.bytes))).toMatchObject({ stored: true, state: "open" })
  }, 15_000)

  it("reconciles a native sealed winner before translating an elapsed deadline", async () => {
    const { store, deps, publication } = await setup()
    const original = await documentCommand("deadline-winner-original", path, "active original bytes")
    const initial = await publishDocument(publication, actor, original.command, original.bytes)
    const next = await update(initial.receipt, original.pageId, "deadline-winner-update")
    const session = await publication.begin(actor, next.command)
    await publication.upload(actor, session.sessionId, path, body(next.file.bytes))
    const manifestRef = { artifactId: session.artifactId, revisionId: session.revisionId, kind: "manifest" as const }
    let firstStored: StoredObjectInfo | undefined
    let winnerState: string | undefined
    let winnerBeforeAbort = false
    let winnerManifest: StoredObjectInfo | null = null
    let winnerBytes: Uint8Array | null = null
    const wrapped = passThrough(store, async (ref, expected, stream, signal) => {
      const stored = await store.put(ref, expected, stream, signal)
      if (ref.kind !== "manifest") return stored
      if (!signal) throw new Error("Publication did not supply its deadline signal")
      firstStored = stored
      const winner = await publication.seal(actor, session.sessionId)
      winnerState = winner.state
      winnerManifest = await store.head(manifestRef)
      winnerBytes = await storedBytes(store, manifestRef)
      winnerBeforeAbort = !signal.aborted
      await afterAbort(signal)
      return stored
    })
    const subject = new PublicationService({ ...deps, store: wrapped })
    const result = await subject.seal(actor, session.sessionId).then(value => value, error => error)
    expect(winnerState).toBe("sealed")
    expect(winnerBeforeAbort).toBe(true)
    expect(firstStored).toBeDefined()
    expect(winnerManifest).toEqual(firstStored)
    expect(winnerBytes).not.toBeNull()
    expect(result).toMatchObject({ sessionId: session.sessionId, revisionId: session.revisionId, state: "sealed" })
    expect(await store.head(manifestRef)).toEqual(firstStored)
    expect(await storedBytes(store, manifestRef)).toEqual(winnerBytes)
    const receipt = await publication.commit(actor, session.sessionId)
    expect(receipt).toMatchObject({ artifactId: session.artifactId, revisionId: session.revisionId })
    expect(await publication.commit(actor, session.sessionId)).toEqual(receipt)
    expect(await store.head(manifestRef)).toEqual(firstStored)
    expect(await storedBytes(store, manifestRef)).toEqual(winnerBytes)
    expect(await storedBytes(store, { artifactId: session.artifactId, revisionId: session.revisionId, kind: "resource", path })).toEqual(next.file.bytes)
  }, 15_000)
})
