import { env } from "cloudflare:workers"
import { beforeEach, describe, expect, it } from "vitest"
import { newId } from "../../domains/catalogue/ids"
import { PublicationService } from "../../domains/publication"
import { collectRevision, type CollectionDeps } from "../../domains/publication/collection"
import { RevisionStore } from "../../domains/store/revision-store"
import { actor, bootstrap, configs, instanceId, jwks } from "./fixtures/catalogue"
import { body, clock, content, documentCommand, publishDocument, storedBytes } from "./fixtures/publication"

beforeEach(async () => { await bootstrap() })

describe("publication collection boundary", () => {
  it("refuses unsafe retention and upload margins without deleting revision bytes", async () => {
    const store = new RevisionStore(env.REVISION_BYTES, instanceId)
    const ref = { artifactId: newId("ar"), revisionId: newId("rv") }
    const resource = { ...ref, kind: "resource" as const, path: "/document.html" }
    const original = await content("retained bytes")
    await store.put(resource, original, body(original.bytes))
    const time = clock(2_000_000)
    const deps: CollectionDeps = { db: env.DB, store, now: time.now, retainMs: 900_002, marginMs: 102, maxUploadTimeoutMs: 100, manageClockSkewMs: 1, readClockSkewMs: 1 }

    await expect(collectRevision({ ...deps, retainMs: 900_001 }, ref)).rejects.toThrow("unsafe collection configuration")
    expect(await storedBytes(store, resource)).toEqual(original.bytes)
    await expect(collectRevision({ ...deps, marginMs: 101 }, ref)).rejects.toThrow("unsafe collection configuration")
    expect(await storedBytes(store, resource)).toEqual(original.bytes)
  })

  it("refuses another instance without deleting its revision bytes", async () => {
    const store = new RevisionStore(env.REVISION_BYTES, "another-forge")
    const ref = { artifactId: newId("ar"), revisionId: newId("rv") }
    const resource = { ...ref, kind: "resource" as const, path: "/document.html" }
    const original = await content("isolated bytes")
    await store.put(resource, original, body(original.bytes))
    const deps: CollectionDeps = { db: env.DB, store, now: () => 2_000_000, retainMs: 900_002, marginMs: 102, maxUploadTimeoutMs: 100, manageClockSkewMs: 1, readClockSkewMs: 1 }

    await expect(collectRevision(deps, ref)).rejects.toThrow("collection instance mismatch")
    expect(await storedBytes(store, resource)).toEqual(original.bytes)
  })
  it("sweeps a late native PUT after discard without allowing the revision to be restored", async () => {
    const time = clock(10_000)
    const store = new RevisionStore(env.REVISION_BYTES, instanceId)
    const options = { sessionTtlMs: 60_000, maxUploadTimeoutMs: 1000, retainMs: 900_000, marginMs: 1000, manageClockSkewMs: 0, readClockSkewMs: 0 }
    const publication = new PublicationService({ db: env.DB, config: (await configs()).manage, jwks, now: time.now, store, publication: options })
    const maintenance: CollectionDeps = { db: env.DB, store, now: time.now, retainMs: options.retainMs, marginMs: options.marginMs, maxUploadTimeoutMs: options.maxUploadTimeoutMs, manageClockSkewMs: options.manageClockSkewMs, readClockSkewMs: options.readClockSkewMs }
    const path = "/a/late-put/index.html"
    const original = await documentCommand("late-put-original", path, "original bytes")
    const initial = await publishDocument(publication, actor, original.command, original.bytes)
    const removed = await publication.unpublish(actor, { idempotencyKey: "late-put-remove", artifactId: initial.session.artifactId, expectedContentVersion: initial.receipt.contentVersion })
    const ref = { artifactId: initial.session.artifactId, revisionId: initial.session.revisionId }
    const resource = { ...ref, kind: "resource" as const, path }
    time.advance(900_001)
    expect(await collectRevision(maintenance, ref)).toBe("purged")
    expect(await storedBytes(store, resource)).toBeNull()

    // Fault injection: a native PUT admitted before the fence completes after deletion.
    // The byte store does not consult D1; this models the late completion at its real seam.
    const late = await content("late native bytes")
    await store.put(resource, late, body(late.bytes))
    expect(await storedBytes(store, resource)).toEqual(late.bytes)
    await expect(publication.restore(actor, { idempotencyKey: "late-put-restore", ...ref, expectedContentVersion: removed.contentVersion })).rejects.toThrow()
    await collectRevision(maintenance, ref)
    expect(await storedBytes(store, resource)).toBeNull()
    expect(await collectRevision(maintenance, ref)).toBe("already_purged")
    expect(await storedBytes(store, resource)).toBeNull()
  })
})
