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

  it("classifies complete wrong digests and lengths as integrity errors without committing bytes", async () => {
    const store = new RevisionStore(env.REVISION_BYTES, "store-failures")
    const rev = revision()
    const data = bytes("correct bytes")
    const metadata = await expected(data)
    const cases = [
      { name: "checksum", metadata: { ...metadata, sha256: "0".repeat(64) }, data },
      { name: "underlength", metadata: { ...metadata, size: metadata.size + 1 }, data },
      { name: "overlength", metadata: { ...metadata, size: metadata.size - 1 }, data },
      { name: "declared-zero", metadata: await expected(new Uint8Array()), data },
    ]
    for (const scenario of cases) {
      const ref = resource(rev, `/failures/${scenario.name}`)
      await expect(store.put(ref, scenario.metadata, stream(scenario.data)), scenario.name).rejects.toMatchObject({ code: "integrity_error" })
      expect(await store.head(ref), scenario.name).toBeNull()
      expect(await readBytes(store, ref), scenario.name).toBeNull()
      const stored = await put(store, ref, data)
      expect(stored.version, scenario.name).toBeTruthy()
      expect(await put(store, ref, data), scenario.name).toEqual(stored)
      expect(await store.head(ref), scenario.name).toEqual(stored)
      expect(await readBytes(store, ref), scenario.name).toEqual(data)
    }
  }, 30_000)

  it("stores and reconciles a genuinely empty object", async () => {
    const store = new RevisionStore(env.REVISION_BYTES, "store-empty")
    const ref = resource(revision(), "/empty")
    const data = new Uint8Array()
    const original = await put(store, ref, data)
    expect(original.size).toBe(0)
    expect(original.version).toBeTruthy()
    expect(await put(store, ref, data)).toEqual(original)
    expect(await store.head(ref)).toEqual(original)
    expect(await readBytes(store, ref)).toEqual(data)
  })

  it("preserves an existing object when another producer errors or aborts", async () => {
    const store = new RevisionStore(env.REVISION_BYTES, "store-producer")
    const rev = revision()
    const existing = resource(rev, "/existing")
    const data = bytes("correct bytes")
    const metadata = await expected(data)
    const original = await put(store, existing, data)
    const failed = resource(rev, "/producer-error")
    const producer = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(data.subarray(0, 3)); controller.error(new Error("producer failed")) },
    })
    await expect(store.put(failed, metadata, producer)).rejects.toMatchObject({ code: "unavailable" })
    expect(await store.head(failed)).toBeNull()
    expect(await readBytes(store, failed)).toBeNull()

    let signalPull!: () => void
    let signalCancel!: () => void
    const pulled = new Promise<void>(resolve => { signalPull = resolve })
    const cancelled = new Promise<void>(resolve => { signalCancel = resolve })
    const pending = new ReadableStream<Uint8Array>({
      pull(controller) { controller.enqueue(data.subarray(0, 3)); signalPull(); return new Promise<void>(() => {}) },
      cancel() { signalCancel() },
    }, { highWaterMark: 0 })
    const abort = new AbortController()
    const interrupted = store.put(resource(rev, "/aborted"), metadata, pending, abort.signal)
    const rejection = expect(interrupted).rejects.toMatchObject({ code: "unavailable" })
    await pulled
    abort.abort()
    await rejection
    await cancelled
    const aborted = resource(rev, "/aborted")
    expect(await store.head(aborted)).toBeNull()
    expect(await readBytes(store, aborted)).toBeNull()
    for (const ref of [failed, aborted]) {
      const stored = await put(store, ref, data)
      expect(await put(store, ref, data)).toEqual(stored)
      expect(await readBytes(store, ref)).toEqual(data)
    }
    expect(await store.head(existing)).toEqual(original)
    expect(await readBytes(store, existing)).toEqual(data)
  }, 30_000)

  it("cancels an already-aborted unpulled producer without waiting for cancellation", async () => {
    const store = new RevisionStore(env.REVISION_BYTES, "store-preabort")
    const ref = resource(revision(), "/preabort")
    const data = bytes("not uploaded")
    const metadata = await expected(data)
    let pulled = false
    let signalCancel!: () => void
    const cancelled = new Promise<void>(resolve => { signalCancel = resolve })
    const body = new ReadableStream<Uint8Array>({
      pull() { pulled = true },
      cancel() { signalCancel(); return new Promise<void>(() => {}) },
    }, { highWaterMark: 0 })
    const abort = new AbortController()
    abort.abort()
    await expect(store.put(ref, metadata, body, abort.signal)).rejects.toMatchObject({ code: "unavailable" })
    await cancelled
    expect(pulled).toBe(false)
    expect(await store.head(ref)).toBeNull()
    expect(await readBytes(store, ref)).toBeNull()
    const stored = await put(store, ref, data)
    expect(await put(store, ref, data)).toEqual(stored)
    expect(await readBytes(store, ref)).toEqual(data)
  }, 30_000)

  it("reconciles an existing object without waiting for an uncooperative producer cancellation", async () => {
    const store = new RevisionStore(env.REVISION_BYTES, "store-pending")
    const ref = resource(revision(), "/pending")
    const data = bytes("already stored")
    const metadata = await expected(data)
    const original = await put(store, ref, data)
    let signalCancel!: () => void
    const cancelled = new Promise<void>(resolve => { signalCancel = resolve })
    const body = new ReadableStream<Uint8Array>({
      pull() { return new Promise<void>(() => {}) },
      cancel() { signalCancel(); return new Promise<void>(() => {}) },
    })
    const retry = store.put(ref, metadata, body)
    expect(await retry).toEqual(original)
    await cancelled
    expect(await store.head(ref)).toEqual(original)
    expect(await readBytes(store, ref)).toEqual(data)
  }, 30_000)

  it("converges concurrent identical writes on one native version", async () => {
    const store = new RevisionStore(env.REVISION_BYTES, "store-converge")
    const ref = resource(revision(), "/same")
    const data = bytes("same concurrent bytes")
    const metadata = await expected(data)
    let release!: () => void
    let signalBothPulled!: () => void
    const ready = new Promise<void>(resolve => { signalBothPulled = resolve })
    const gate = new Promise<void>(resolve => { release = resolve })
    let pulls = 0
    const gated = () => new ReadableStream<Uint8Array>({
      async pull(controller) {
        pulls++
        if (pulls === 2) signalBothPulled()
        await gate
        controller.enqueue(data)
        controller.close()
      },
    }, { highWaterMark: 0 })
    const results = Promise.all([store.put(ref, metadata, gated()), store.put(ref, metadata, gated())])
    await ready
    release()
    const [first, second] = await results
    expect(first.version).toBeTruthy()
    expect(second).toEqual(first)
    expect(await store.head(ref)).toEqual(first)
    expect(await readBytes(store, ref)).toEqual(data)
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
    const survivorInfo = await put(store, survivor, keptRevision)
    const foreignInfo = await put(other, foreign, keptInstance)
    const data = bytes("collection object")
    const metadata = await expected(data)
    const refs = Array.from({ length: 1005 }, (_, index) => resource(rev, `/bulk/${index.toString().padStart(4, "0")}`))
    const manifest: RevisionObjectRef = { ...rev, kind: "manifest" }
    const manifestInfo = await put(store, manifest, bytes("manifest"))
    const expectedObjects = new Map([[manifestInfo.key, manifestInfo]])
    for (let start = 0; start < refs.length; start += 16) {
      const written = await Promise.all(refs.slice(start, start + 16).map(ref => store.put(ref, metadata, stream(data))))
      for (const object of written) expectedObjects.set(object.key, object)
    }
    let cursor: string | null = null
    let pages = 0
    const seen = new Set<string>()
    do {
      const page = await store.listRevision(rev, cursor)
      pages++
      expect(page.objects.length).toBeLessThanOrEqual(1000)
      for (const object of page.objects) {
        expect(seen.has(object.key)).toBe(false)
        seen.add(object.key)
        const written = expectedObjects.get(object.key)
        expect(written).toBeDefined()
        expect(object.size).toBe(written!.size)
        expect(object.version).toBe(written!.version)
        expect(object.version).toBeTruthy()
        if (object.sha256 !== null) expect(object.sha256).toBe(written!.sha256)
      }
      cursor = page.cursor
    } while (cursor !== null)
    expect(pages).toBeGreaterThan(1)
    expect(seen).toEqual(new Set(expectedObjects.keys()))
    expect(seen.has(survivorInfo.key)).toBe(false)
    expect(seen.has(foreignInfo.key)).toBe(false)
    expect(await readBytes(store, manifest)).toEqual(bytes("manifest"))
    expect(await readBytes(store, refs[0])).toEqual(data)
    expect(await readBytes(store, refs[1004])).toEqual(data)
    expect(await store.deleteRevision(rev)).toBe(1006)
    for (let start = 0; start < refs.length; start += 16) {
      const remaining = await Promise.all(refs.slice(start, start + 16).map(ref => store.head(ref)))
      expect(remaining.every(value => value === null)).toBe(true)
    }
    expect(await store.head(manifest)).toBeNull()
    expect(await store.deleteRevision(rev)).toBe(0)
    expect(await readBytes(store, survivor)).toEqual(keptRevision)
    expect(await readBytes(other, foreign)).toEqual(keptInstance)
  }, 120_000)
})
