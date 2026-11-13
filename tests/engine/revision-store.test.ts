import { env } from "cloudflare:workers"
import { describe, expect, it } from "vitest"
import { newId } from "../../domains/catalogue/ids"
import { RevisionStore, type RevisionObjectRef, type RevisionRef } from "../../domains/store/revision-store"

const encoder = new TextEncoder()
const bytes = (value: string) => encoder.encode(value)

async function expected(data: Uint8Array<ArrayBuffer>): Promise<{ size: number; sha256: string }> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", data))
  return { size: data.byteLength, sha256: Array.from(digest, byte => byte.toString(16).padStart(2, "0")).join("") }
}

function stream(data: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream({ start(controller) { controller.enqueue(data); controller.close() } })
}

function revision(): RevisionRef {
  return { artifactId: newId("ar"), revisionId: newId("rv") }
}

function resource(ref: RevisionRef, path: string): RevisionObjectRef {
  return { ...ref, kind: "resource", path }
}

async function put(store: RevisionStore, ref: RevisionObjectRef, data: Uint8Array<ArrayBuffer>) {
  return store.put(ref, await expected(data), stream(data))
}

async function readBytes(store: RevisionStore, ref: RevisionObjectRef): Promise<Uint8Array | null> {
  const object = await store.get(ref)
  if (!object) return null
  if (!("body" in object)) throw new Error("Expected an object body")
  return new Uint8Array(await object.arrayBuffer())
}

describe("Revision Store with local R2", () => {
  it("reconciles a lost reply without changing the original bytes or version", async () => {
    const store = new RevisionStore(env.REVISION_BYTES, "store-retry")
    const ref: RevisionObjectRef = { ...revision(), kind: "manifest" }
    const data = new Uint8Array([0, 255, 128, 13, 10, 42])
    const first = await put(store, ref, data)
    // The caller cannot tell whether its first response arrived; it retries the same upload.
    const retry = await put(store, ref, data)
    expect(retry).toEqual(first)
    expect(await store.head(ref)).toEqual(first)
    expect(await readBytes(store, ref)).toEqual(data)
  })

  it("lets exactly one of two different writers create a resource and refuses replacement", async () => {
    const store = new RevisionStore(env.REVISION_BYTES, "store-race")
    const ref = resource(revision(), "/race/data.bin")
    const candidates = [bytes("first writer"), bytes("second writer")]
    const results = await Promise.allSettled(candidates.map(data => put(store, ref, data)))
    const winners = results.flatMap((result, index) => result.status === "fulfilled" ? [{ index, info: result.value }] : [])
    const losers = results.flatMap((result, index) => result.status === "rejected" ? [{ index, error: result.reason }] : [])
    expect(winners).toHaveLength(1)
    expect(losers).toHaveLength(1)
    expect(losers[0].error).toMatchObject({ code: "conflict" })
    expect(await readBytes(store, ref)).toEqual(candidates[winners[0].index])
    expect(await store.head(ref)).toEqual(winners[0].info)
    await expect(put(store, ref, candidates[losers[0].index])).rejects.toMatchObject({ code: "conflict" })
    expect(await readBytes(store, ref)).toEqual(candidates[winners[0].index])
    expect(await store.head(ref)).toEqual(winners[0].info)
  })

  it("never exposes a partial object after checksum, length, producer, or cancellation failure", async () => {
    const store = new RevisionStore(env.REVISION_BYTES, "store-failures")
    const rev = revision()
    const data = bytes("correct bytes")
    const metadata = await expected(data)
    const cases: { name: string; run: (ref: RevisionObjectRef) => Promise<unknown> }[] = [
      { name: "checksum", run: ref => store.put(ref, { ...metadata, sha256: "0".repeat(64) }, stream(data)) },
      { name: "underlength", run: ref => store.put(ref, { ...metadata, size: metadata.size + 1 }, stream(data)) },
      { name: "overlength", run: ref => store.put(ref, { ...metadata, size: metadata.size - 1 }, stream(data)) },
      { name: "producer-error", run: ref => store.put(ref, metadata, new ReadableStream({ start(controller) { controller.enqueue(data.subarray(0, 3)); controller.error(new Error("producer failed")) } })) },
      { name: "cancelled", run: ref => {
        const abort = new AbortController()
        const body = new ReadableStream<Uint8Array>({ pull(controller) { controller.enqueue(data.subarray(0, 3)); abort.abort() } })
        return store.put(ref, metadata, body, abort.signal)
      } },
    ]
    for (const scenario of cases) {
      const ref = resource(rev, `/failures/${scenario.name}`)
      await expect(scenario.run(ref), scenario.name).rejects.toMatchObject({ code: expect.stringMatching(/^(integrity_error|unavailable)$/) })
      expect(await store.head(ref), scenario.name).toBeNull()
      expect(await readBytes(store, ref), scenario.name).toBeNull()
      const stored = await put(store, ref, data)
      expect(await store.head(ref), scenario.name).toEqual(stored)
      expect(await readBytes(store, ref), scenario.name).toEqual(data)
    }
  }, 30_000)

  it("keeps instance and revision identities separate and preserves exact long Unicode paths", async () => {
    const first = new RevisionStore(env.REVISION_BYTES, "store-isolation")
    const second = new RevisionStore(env.REVISION_BYTES, "store-isolation-other")
    const rev = revision()
    const otherRev = { ...rev, revisionId: newId("rv") }
    const longPath = `/unicode/${"é漢".repeat(600)}/file.txt`
    const paths = [longPath, `${longPath}%2Ftail`, `${longPath}/tail`, "/unicode/é.txt", "/unicode/e\u0301.txt"]
    const refs = paths.map(path => resource(rev, path))
    const payloads = paths.map((_, index) => bytes(`distinct payload ${index}`))
    for (let index = 0; index < refs.length; index++) await put(first, refs[index], payloads[index])
    const foreignInstance = resource(rev, longPath)
    const foreignRevision = resource(otherRev, longPath)
    expect(await second.head(foreignInstance)).toBeNull()
    expect(await first.head(foreignRevision)).toBeNull()
    await put(second, foreignInstance, bytes("other instance"))
    await put(first, foreignRevision, bytes("other revision"))
    for (let index = 0; index < refs.length; index++) expect(await readBytes(first, refs[index])).toEqual(payloads[index])
    expect(await readBytes(second, foreignInstance)).toEqual(bytes("other instance"))
    expect(await readBytes(first, foreignRevision)).toEqual(bytes("other revision"))
  })

  it("collects every page of a revision without touching another revision or instance", async () => {
    const store = new RevisionStore(env.REVISION_BYTES, "store-collection")
    const other = new RevisionStore(env.REVISION_BYTES, "store-collection-other")
    const rev = revision()
    const otherRev = { ...rev, revisionId: newId("rv") }
    const survivor = resource(otherRev, "/keep.txt")
    const foreign = resource(rev, "/keep.txt")
    const keptRevision = bytes("other revision survives")
    const keptInstance = bytes("other instance survives")
    await put(store, survivor, keptRevision)
    await put(other, foreign, keptInstance)
    const data = bytes("collection object")
    const metadata = await expected(data)
    const refs = Array.from({ length: 1005 }, (_, index) => resource(rev, `/bulk/${index.toString().padStart(4, "0")}`))
    for (let start = 0; start < refs.length; start += 16) {
      await Promise.all(refs.slice(start, start + 16).map(ref => store.put(ref, metadata, stream(data))))
    }
    expect(await readBytes(store, refs[0])).toEqual(data)
    expect(await readBytes(store, refs[1004])).toEqual(data)
    expect(await store.deleteRevision(rev)).toBe(1005)
    for (let start = 0; start < refs.length; start += 16) {
      const remaining = await Promise.all(refs.slice(start, start + 16).map(ref => store.head(ref)))
      expect(remaining.every(value => value === null)).toBe(true)
    }
    expect(await store.deleteRevision(rev)).toBe(0)
    expect(await readBytes(store, survivor)).toEqual(keptRevision)
    expect(await readBytes(other, foreign)).toEqual(keptInstance)
  }, 120_000)
})
