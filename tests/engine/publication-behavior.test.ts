import { env } from "cloudflare:workers"
import { beforeEach, describe, expect, it } from "vitest"
import { assignRole, disablePrincipal, readPagePolicy, revokeRole, revokeShare, setVisibility, share } from "../../domains/catalogue/commands"
import { newId } from "../../domains/catalogue/ids"
import type { ReadInstanceConfig } from "../../domains/catalogue/instance-config"
import { decideRead, type ReadCredentials } from "../../domains/catalogue/read"
import { PublicationService } from "../../domains/publication"
import { collectRevision } from "../../domains/publication/collection"
import type { BeginCommand, PublicationDeps, PublicationReceipt } from "../../domains/publication/types"
import { RevisionStore } from "../../domains/store/revision-store"
import { actor, authenticatedActor, bootstrap, configs, instanceId, jwks, teamIdentity } from "./fixtures/catalogue"
import { body, clock, content, documentCommand, publishDocument, storedBytes } from "./fixtures/publication"

const path = "/a/sample/index.html"
const route = { kind: "subtree" as const, slug: "sample" }
const anonymous: ReadCredentials = { team: null, shareKey: null, shareCookie: null, pinnedProof: null, nowSeconds: 1 }

beforeEach(async () => { await bootstrap() })

async function setup() {
  const time = clock(10_000)
  const { manage, read } = await configs()
  const store = new RevisionStore(env.REVISION_BYTES, instanceId)
  const deps: PublicationDeps = { db: env.DB, config: manage, jwks, now: time.now, store, publication: { sessionTtlMs: 60_000, maxUploadTimeoutMs: 1000, retainMs: 900_000, marginMs: 1000, manageClockSkewMs: 0, readClockSkewMs: 0 } }
  return { publication: new PublicationService(deps), deps, store, time, read }
}

async function update(receipt: PublicationReceipt, pageId: string, key: string, text: string, source: "client" | "base" = "client"): Promise<{ command: BeginCommand; bytes: Uint8Array<ArrayBuffer> }> {
  const file = await content(text)
  return { bytes: file.bytes, command: { idempotencyKey: key, artifactId: receipt.artifactId, expectedRevisionId: receipt.revisionId, expectedContentVersion: receipt.contentVersion, files: [{ path, kind: "document", sha256: file.sha256, size: file.size, contentType: "text/html", source }], pages: [{ pageId, disposition: "keep", documentPath: path, metadata: {}, expectedPolicyEpoch: 0 }], edges: [] } }
}
async function visible(read: ReadInstanceConfig) {
  return decideRead(env.DB, read, { kind: "page", route, candidates: [path], fragmentPath: null }, { ...anonymous, team: teamIdentity }, null)
}

function collection(deps: PublicationDeps) {
  return { db: deps.db, store: deps.store, now: deps.now, retainMs: deps.publication.retainMs, marginMs: deps.publication.marginMs, maxUploadTimeoutMs: deps.publication.maxUploadTimeoutMs, manageClockSkewMs: deps.publication.manageClockSkewMs, readClockSkewMs: deps.publication.readClockSkewMs }
}

describe("publication against local D1 and R2", () => {
  it("allows one of two same-base commits and retains the loser's staging bytes", async () => {
    const { publication, store, read } = await setup()
    const first = await documentCommand("initial", path, "original")
    const initial = await publishDocument(publication, actor, first.command, first.bytes)
    const left = await update(initial.receipt, first.pageId, "left", "left bytes")
    const right = await update(initial.receipt, first.pageId, "right", "right bytes")
    const a = await publication.begin(actor, left.command)
    const b = await publication.begin(actor, right.command)
    await publication.upload(actor, a.sessionId, path, body(left.bytes))
    await publication.upload(actor, b.sessionId, path, body(right.bytes))
    await publication.seal(actor, a.sessionId)
    await publication.seal(actor, b.sessionId)
    const results = await Promise.allSettled([publication.commit(actor, a.sessionId), publication.commit(actor, b.sessionId)])
    expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1)
    expect(results.filter(result => result.status === "rejected")).toHaveLength(1)
    const winner = results[0].status === "fulfilled" ? a : b
    const loser = winner === a ? b : a
    expect(await visible(read)).toMatchObject({ kind: "allow", plan: { revisionId: winner.revisionId } })
    expect(await publication.status(actor, loser.sessionId)).toMatchObject({ state: "sealed", revisionId: loser.revisionId })
    expect(await storedBytes(store, { artifactId: loser.artifactId, revisionId: loser.revisionId, kind: "resource", path })).toEqual(winner === a ? right.bytes : left.bytes)
  })

  it("reconciles a lost reply and rejects changed parameters without replacing bytes", async () => {
    const { publication, store } = await setup()
    const first = await documentCommand("replay", path, "unchanged")
    const session = await publication.begin(actor, first.command)
    await publication.upload(actor, session.sessionId, path, body(first.bytes))
    const again = await publication.begin(actor, first.command)
    expect(again.sessionId).toBe(session.sessionId)
    await publication.upload(actor, session.sessionId, path, body(first.bytes))
    await expect(publication.begin(actor, { ...first.command, expectedContentVersion: 1 })).rejects.toThrow()
    await publication.seal(actor, session.sessionId)
    const receipt = await publication.commit(actor, session.sessionId)
    expect(await publication.commit(actor, session.sessionId)).toEqual(receipt)
    expect(await publication.status(actor, session.sessionId)).toMatchObject({ state: "committed", revisionId: receipt.revisionId })
    expect(await storedBytes(store, { artifactId: session.artifactId, revisionId: session.revisionId, kind: "resource", path })).toEqual(first.bytes)
  })

  it("keeps the old revision readable after incomplete and bad-checksum uploads", async () => {
    const { publication, store, read } = await setup()
    const first = await documentCommand("old", path, "old bytes")
    const initial = await publishDocument(publication, actor, first.command, first.bytes)
    const next = await update(initial.receipt, first.pageId, "incomplete", "valid new bytes")
    const session = await publication.begin(actor, next.command)
    await expect(publication.seal(actor, session.sessionId)).rejects.toThrow()
    await expect(publication.upload(actor, session.sessionId, path, body((await content("wrong payload")).bytes))).rejects.toThrow()
    await expect(publication.seal(actor, session.sessionId)).rejects.toThrow()
    expect(await visible(read)).toMatchObject({ kind: "allow", plan: { revisionId: initial.receipt.revisionId } })
    expect(await storedBytes(store, { artifactId: initial.session.artifactId, revisionId: initial.session.revisionId, kind: "resource", path })).toEqual(first.bytes)
  })

  it("materializes unchanged base bytes server-side and preserves private visibility", async () => {
    const { publication, store, deps } = await setup()
    const first = await documentCommand("base", path, "same bytes")
    const initial = await publishDocument(publication, actor, first.command, first.bytes)
    const next = await update(initial.receipt, first.pageId, "copy", "same bytes", "base")
    const session = await publication.begin(actor, next.command)
    expect(session.files).toContainEqual({ path, source: "base", stored: false })
    await publication.materialize(actor, session.sessionId, path)
    await publication.seal(actor, session.sessionId)
    const receipt = await publication.commit(actor, session.sessionId)
    expect(receipt.revisionId).not.toBe(initial.receipt.revisionId)
    expect(await storedBytes(store, { artifactId: session.artifactId, revisionId: session.revisionId, kind: "resource", path })).toEqual(first.bytes)
    expect(await readPagePolicy(deps, actor, first.pageId)).toMatchObject({ visibility: "private" })
  })

  it("refuses commit after a policy change, without changing the active revision", async () => {
    const { publication, deps, read } = await setup()
    const first = await documentCommand("acl-old", path, "old")
    const initial = await publishDocument(publication, actor, first.command, first.bytes)
    const next = await update(initial.receipt, first.pageId, "acl-new", "new")
    const session = await publication.begin(actor, next.command)
    await publication.upload(actor, session.sessionId, path, body(next.bytes))
    await publication.seal(actor, session.sessionId)
    await setVisibility(deps, actor, { pageId: first.pageId, artifactId: initial.receipt.artifactId, expectedPolicyEpoch: 0, visibility: "public" })
    await expect(publication.commit(actor, session.sessionId)).rejects.toThrow()
    expect(await visible(read)).toMatchObject({ kind: "allow", plan: { revisionId: initial.receipt.revisionId } })
    expect(await readPagePolicy(deps, actor, first.pageId)).toMatchObject({ visibility: "public", policyEpoch: 1 })
  })

  it("restores the original page privately without reviving its former share", async () => {
    const { publication, deps, read } = await setup()
    const first = await documentCommand("restore-original", path, "original")
    const initial = await publishDocument(publication, actor, first.command, first.bytes)
    const grant = await share(deps, actor, { pageId: first.pageId, artifactId: initial.receipt.artifactId, expectedPolicyEpoch: 0, mode: "follow_active" })
    const removed = await publication.unpublish(actor, { idempotencyKey: "remove", artifactId: initial.receipt.artifactId, expectedContentVersion: initial.receipt.contentVersion })
    const restored = await publication.restore(actor, { idempotencyKey: "restore", artifactId: initial.receipt.artifactId, revisionId: initial.session.revisionId, expectedContentVersion: removed.contentVersion })
    expect(restored.pages).toEqual(expect.arrayContaining([expect.objectContaining({ pageId: first.pageId })]))
    expect(await readPagePolicy(deps, actor, first.pageId)).toMatchObject({ pageId: first.pageId, visibility: "private", grant: null })
    expect(await decideRead(env.DB, read, { kind: "share", route, candidates: [path] }, { ...anonymous, shareKey: grant.key }, null)).toEqual({ kind: "deny", reason: "not_found" })
  })
  it("protects active and base-copy revisions, then collects only after closure and retention", async () => {
    const { publication, deps, store, time } = await setup()
    const first = await documentCommand("gc-base", path, "base bytes")
    const initial = await publishDocument(publication, actor, first.command, first.bytes)
    const ref = { artifactId: initial.session.artifactId, revisionId: initial.session.revisionId }
    const resource = { ...ref, kind: "resource" as const, path }
    await expect(collectRevision(collection(deps), ref)).rejects.toThrow()
    expect(await storedBytes(store, resource)).toEqual(first.bytes)
    const next = await update(initial.receipt, first.pageId, "gc-copy", "base bytes", "base")
    const longSession = new PublicationService({ ...deps, publication: { ...deps.publication, sessionTtlMs: 2_000_000 } })
    const staged = await longSession.begin(actor, next.command)
    await publication.unpublish(actor, { idempotencyKey: "gc-remove", artifactId: ref.artifactId, expectedContentVersion: initial.receipt.contentVersion })
    time.advance(900_001)
    await expect(collectRevision(collection(deps), ref)).rejects.toThrow()
    expect(await storedBytes(store, resource)).toEqual(first.bytes)
    await longSession.abort(actor, staged.sessionId)
    await expect(collectRevision(collection(deps), ref)).rejects.toThrow()
    expect(await storedBytes(store, resource)).toEqual(first.bytes)
    time.advance(1001)
    expect(await collectRevision(collection(deps), ref)).toBe("purged")
    expect(await storedBytes(store, resource)).toBeNull()
    expect(await collectRevision(collection(deps), ref)).toBe("already_purged")
    await expect(publication.restore(actor, { idempotencyKey: "gc-restore", artifactId: ref.artifactId, revisionId: ref.revisionId, expectedContentVersion: initial.receipt.contentVersion + 1 })).rejects.toThrow()
  })
  it.each(["role", "principal"] as const)("refuses a %s revoked after staging, even with a freshly authenticated actor", async (revocation) => {
    const { publication, deps, read } = await setup()
    const first = await documentCommand(`revoke-base-${revocation}`, path, "old")
    const initial = await publishDocument(publication, actor, first.command, first.bytes)
    const person = await authenticatedActor(`publisher-${revocation}`)
    const role = await assignRole(deps, actor, { targetPrincipalId: person.principalId, expectedTargetAuthorityEpoch: 0, role: "publisher", scope: { kind: "installation" } })
    const publisher = await authenticatedActor(`publisher-${revocation}`)
    const next = await update(initial.receipt, first.pageId, `revoke-next-${revocation}`, "new")
    const session = await publication.begin(publisher, next.command)
    await publication.upload(publisher, session.sessionId, path, body(next.bytes))
    await publication.seal(publisher, session.sessionId)
    if (revocation === "role") {
      await revokeRole(deps, actor, { targetPrincipalId: person.principalId, expectedTargetAuthorityEpoch: 1, roleGrantId: role.roleGrantId })
    } else {
      await disablePrincipal(deps, actor, { targetPrincipalId: person.principalId, expectedTargetAuthorityEpoch: 1 })
    }
    const refreshed = await authenticatedActor(`publisher-${revocation}`)
    await expect(publication.commit(refreshed, session.sessionId)).rejects.toThrow()
    expect(await visible(read)).toMatchObject({ kind: "allow", plan: { revisionId: initial.receipt.revisionId } })
  })
  it("keeps a pinned revision until its grant ends, even after retention expires", async () => {
    const { publication, deps, store, time } = await setup()
    const first = await documentCommand("pinned-base", path, "old pinned bytes")
    const initial = await publishDocument(publication, actor, first.command, first.bytes)
    const grant = await share(deps, actor, { pageId: first.pageId, artifactId: initial.receipt.artifactId, expectedPolicyEpoch: 0, mode: "pinned", revisionId: initial.session.revisionId })
    const next = await update(initial.receipt, first.pageId, "pinned-next", "new bytes")
    const command = { ...next.command, pages: next.command.pages.map(page => ({ ...page, expectedPolicyEpoch: 1 })) }
    await publishDocument(publication, actor, command, next.bytes)
    time.advance(900_001)
    const ref = { artifactId: initial.session.artifactId, revisionId: initial.session.revisionId }
    const resource = { ...ref, kind: "resource" as const, path }
    await expect(collectRevision(collection(deps), ref)).rejects.toThrow()
    expect(await storedBytes(store, resource)).toEqual(first.bytes)
    await revokeShare(deps, actor, { pageId: first.pageId, artifactId: ref.artifactId, expectedPolicyEpoch: 1, grantId: grant.grantId })
    expect(await collectRevision(collection(deps), ref)).toBe("purged")
    expect(await storedBytes(store, resource)).toBeNull()
  })

  it("does not let a page-scoped publisher widen a two-page publication", async () => {
    const { publication, deps, read } = await setup()
    const first = await documentCommand("multi-base", path, "first")
    const secondPath = "/a/other/index.html"
    const second = await content("second")
    const secondPage = newId("pg")
    const command: BeginCommand = { ...first.command, files: [...first.command.files, { path: secondPath, kind: "document", sha256: second.sha256, size: second.size, contentType: "text/html", source: "client" }], pages: [...first.command.pages, { pageId: secondPage, disposition: "new", documentPath: secondPath, metadata: {}, expectedPolicyEpoch: null }] }
    const session = await publication.begin(actor, command)
    await publication.upload(actor, session.sessionId, path, body(first.bytes))
    await publication.upload(actor, session.sessionId, secondPath, body(second.bytes))
    await publication.seal(actor, session.sessionId)
    const initial = await publication.commit(actor, session.sessionId)
    const person = await authenticatedActor("scoped-publisher")
    await assignRole(deps, actor, { targetPrincipalId: person.principalId, expectedTargetAuthorityEpoch: 0, role: "publisher", scope: { kind: "page", pageId: first.pageId } })
    const scoped = await authenticatedActor("scoped-publisher")
    const next: BeginCommand = { ...command, idempotencyKey: "multi-scoped", artifactId: initial.artifactId, expectedRevisionId: initial.revisionId, expectedContentVersion: initial.contentVersion, pages: command.pages.map(page => ({ ...page, disposition: "keep", expectedPolicyEpoch: 0 })) }
    await expect((async () => {
      const staged = await publication.begin(scoped, next)
      await publication.upload(scoped, staged.sessionId, path, body(first.bytes))
      await publication.upload(scoped, staged.sessionId, secondPath, body(second.bytes))
      await publication.seal(scoped, staged.sessionId)
      await publication.commit(scoped, staged.sessionId)
    })()).rejects.toThrow()
    expect(await visible(read)).toMatchObject({ kind: "allow", plan: { revisionId: initial.revisionId } })
    expect(await readPagePolicy(deps, actor, secondPage)).toMatchObject({ visibility: "private" })
  })
  it("rejects a manifest whose declared page has no document without changing the old read", async () => {
    const { publication, read, store } = await setup()
    const first = await documentCommand("manifest-base", path, "good")
    const initial = await publishDocument(publication, actor, first.command, first.bytes)
    const next = await update(initial.receipt, first.pageId, "false-manifest", "bad")
    await expect((async () => {
      const staged = await publication.begin(actor, { ...next.command, files: [] })
      await publication.seal(actor, staged.sessionId)
      await publication.commit(actor, staged.sessionId)
    })()).rejects.toThrow()
    expect(await visible(read)).toMatchObject({ kind: "allow", plan: { revisionId: initial.receipt.revisionId } })
    expect(await storedBytes(store, { artifactId: initial.session.artifactId, revisionId: initial.session.revisionId, kind: "resource", path })).toEqual(first.bytes)
  })

  it("rejects a competing artefact claiming an occupied route without disturbing its owner", async () => {
    const { publication, read, store } = await setup()
    const first = await documentCommand("route-owner", path, "owner bytes")
    const initial = await publishDocument(publication, actor, first.command, first.bytes)
    const competing = await documentCommand("route-contender", path, "contender bytes")
    await expect((async () => {
      const staged = await publication.begin(actor, competing.command)
      await publication.upload(actor, staged.sessionId, path, body(competing.bytes))
      await publication.seal(actor, staged.sessionId)
      await publication.commit(actor, staged.sessionId)
    })()).rejects.toThrow()
    expect(await visible(read)).toMatchObject({ kind: "allow", plan: { revisionId: initial.receipt.revisionId, artifactId: initial.receipt.artifactId } })
    expect(await storedBytes(store, { artifactId: initial.session.artifactId, revisionId: initial.session.revisionId, kind: "resource", path })).toEqual(first.bytes)
  })
  it("serializes restore against collection without activating missing bytes", async () => {
    const { publication, deps, store, time, read } = await setup()
    const first = await documentCommand("race-base", path, "race bytes")
    const initial = await publishDocument(publication, actor, first.command, first.bytes)
    const removed = await publication.unpublish(actor, { idempotencyKey: "race-remove", artifactId: initial.receipt.artifactId, expectedContentVersion: initial.receipt.contentVersion })
    time.advance(900_001)
    const ref = { artifactId: initial.session.artifactId, revisionId: initial.session.revisionId }
    const results = await Promise.allSettled([
      publication.restore(actor, { idempotencyKey: "race-restore", ...ref, expectedContentVersion: removed.contentVersion }),
      collectRevision(collection(deps), ref),
    ])
    const resource = { ...ref, kind: "resource" as const, path }
    if (results[0].status === "fulfilled") {
      expect(results[1].status).toBe("rejected")
      expect(await visible(read)).toMatchObject({ kind: "allow", plan: { revisionId: ref.revisionId } })
      expect(await storedBytes(store, resource)).toEqual(first.bytes)
    } else {
      expect(results[1]).toMatchObject({ status: "fulfilled", value: "purged" })
      expect(await storedBytes(store, resource)).toBeNull()
      expect(await visible(read)).not.toMatchObject({ kind: "allow" })
    }
  })
  it("serializes a late pinned grant against collection without granting deleted bytes", async () => {
    const { publication, deps, store, time, read } = await setup()
    const first = await documentCommand("pin-race-base", path, "pin race bytes")
    const initial = await publishDocument(publication, actor, first.command, first.bytes)
    const next = await update(initial.receipt, first.pageId, "pin-race-next", "new active bytes")
    const active = await publishDocument(publication, actor, next.command, next.bytes)
    time.advance(900_001)
    const ref = { artifactId: initial.session.artifactId, revisionId: initial.session.revisionId }
    const [pin, purge] = await Promise.allSettled([
      share(deps, actor, { artifactId: ref.artifactId, pageId: first.pageId, expectedPolicyEpoch: 0, mode: "pinned", revisionId: ref.revisionId }),
      collectRevision(collection(deps), ref),
    ])
    const resource = { ...ref, kind: "resource" as const, path }
    if (pin.status === "fulfilled") {
      expect(purge.status).toBe("rejected")
      expect(await storedBytes(store, resource)).toEqual(first.bytes)
      expect(await decideRead(env.DB, read, { kind: "share", route, candidates: [path] }, { ...anonymous, shareKey: pin.value.key }, null)).toMatchObject({ kind: "allow", plan: { revisionId: ref.revisionId } })
    } else {
      expect(purge).toMatchObject({ status: "fulfilled", value: "purged" })
      expect(await storedBytes(store, resource)).toBeNull()
      expect(await readPagePolicy(deps, actor, first.pageId)).toMatchObject({ visibility: "private", grant: null })
    }
    expect(await visible(read)).toMatchObject({ kind: "allow", plan: { revisionId: active.session.revisionId } })
  })
})
