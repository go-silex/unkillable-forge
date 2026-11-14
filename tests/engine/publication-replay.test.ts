import { env } from "cloudflare:workers"
import { beforeEach, describe, expect, it } from "vitest"
import { assignRole, revokeRole } from "../../domains/catalogue/commands"
import type { ReadInstanceConfig } from "../../domains/catalogue/instance-config"
import { decideRead } from "../../domains/catalogue/read"
import { PublicationService } from "../../domains/publication"
import type { PublicationDeps } from "../../domains/publication/types"
import { RevisionStore } from "../../domains/store/revision-store"
import { actor, authenticatedActor, bootstrap, configs, instanceId, jwks, teamIdentity } from "./fixtures/catalogue"
import { body, clock, content, documentCommand, publishDocument, storedBytes } from "./fixtures/publication"

beforeEach(async () => { await bootstrap() })
const path = "/a/concurrent/index.html"

async function setup() {
  const time = clock(10_000), config = await configs()
  const store = new RevisionStore(env.REVISION_BYTES, instanceId)
  const deps: PublicationDeps = { db: env.DB, config: config.manage, jwks, now: time.now, store, publication: { sessionTtlMs: 60_000, maxUploadTimeoutMs: 1000, retainMs: 900_000, marginMs: 1000, manageClockSkewMs: 0, readClockSkewMs: 0 } }
  return { publication: new PublicationService(deps), deps, store, read: config.read }
}

async function selected(read: ReadInstanceConfig) {
  return decideRead(env.DB, read, { kind: "page", route: { kind: "subtree", slug: "concurrent" }, candidates: [path], fragmentPath: null }, { team: teamIdentity, shareKey: null, shareCookie: null, pinnedProof: null, nowSeconds: 1 }, null)
}

describe("overlapping publication retries", () => {
  it("reconciles concurrent begin, seal, commit, unpublish and restore with one transition each", async () => {
    const { publication, store, read } = await setup()
    const input = await documentCommand("overlap-begin", path, "one immutable body")
    const [first, second] = await Promise.all([publication.begin(actor, input.command), publication.begin(actor, input.command)])
    expect(second).toEqual(first)
    expect(await publication.upload(actor, first.sessionId, path, body(input.bytes))).toMatchObject({ sessionId: first.sessionId, path, stored: true, state: "open" })
    const seals = await Promise.all([publication.seal(actor, first.sessionId), publication.seal(actor, first.sessionId)])
    expect(seals[0]).toEqual(seals[1])
    expect(seals[0]).toMatchObject({ state: "sealed", revisionId: first.revisionId })
    expect(await publication.upload(actor, first.sessionId, path, body(input.bytes))).toMatchObject({ sessionId: first.sessionId, path, stored: true, state: "sealed" })
    const commits = await Promise.all([publication.commit(actor, first.sessionId), publication.commit(actor, first.sessionId)])
    expect(commits[0]).toEqual(commits[1])
    expect(commits[0]).toMatchObject({ revisionId: first.revisionId, contentVersion: 1 })
    expect(await publication.upload(actor, first.sessionId, path, body(input.bytes))).toMatchObject({ sessionId: first.sessionId, path, stored: true, state: "committed" })
    expect(await selected(read)).toMatchObject({ kind: "allow", plan: { revisionId: first.revisionId } })
    const remove = { idempotencyKey: "overlap-remove", artifactId: first.artifactId, expectedContentVersion: 1 }
    const removals = await Promise.all([publication.unpublish(actor, remove), publication.unpublish(actor, remove)])
    expect(removals[0]).toEqual(removals[1])
    expect(removals[0]).toMatchObject({ revisionId: null, contentVersion: 2 })
    const restore = { idempotencyKey: "overlap-restore", artifactId: first.artifactId, revisionId: first.revisionId, expectedContentVersion: 2 }
    const restores = await Promise.all([publication.restore(actor, restore), publication.restore(actor, restore)])
    expect(restores[0]).toEqual(restores[1])
    expect(restores[0]).toMatchObject({ revisionId: first.revisionId, contentVersion: 3 })
    expect(await selected(read)).toMatchObject({ kind: "allow", plan: { revisionId: first.revisionId } })
    expect(await storedBytes(store, { artifactId: first.artifactId, revisionId: first.revisionId, kind: "resource", path })).toEqual(input.bytes)
  })

  it("does not replay a completed commit after its publisher loses authority", async () => {
    const { publication, deps, store, read } = await setup()
    const person = await authenticatedActor("overlap-publisher")
    const role = await assignRole(deps, actor, { targetPrincipalId: person.principalId, expectedTargetAuthorityEpoch: 0, role: "publisher", scope: { kind: "installation" } })
    const publisher = await authenticatedActor("overlap-publisher")
    const input = await documentCommand("overlap-authority", path, "private")
    const session = await publication.begin(publisher, input.command)
    await publication.upload(publisher, session.sessionId, path, body(input.bytes))
    await publication.seal(publisher, session.sessionId)
    const [one, two] = await Promise.all([publication.commit(publisher, session.sessionId), publication.commit(publisher, session.sessionId)])
    expect(one).toEqual(two)
    await revokeRole(deps, actor, { targetPrincipalId: person.principalId, expectedTargetAuthorityEpoch: 1, roleGrantId: role.roleGrantId })
    const refreshed = await authenticatedActor("overlap-publisher")
    await expect(publication.commit(refreshed, session.sessionId)).rejects.toMatchObject({ code: "forbidden" })
    expect(await selected(read)).toMatchObject({ kind: "allow", plan: { revisionId: session.revisionId } })
    expect(await storedBytes(store, { artifactId: session.artifactId, revisionId: session.revisionId, kind: "resource", path })).toEqual(input.bytes)
  })

  it("rechecks authority after an in-flight upload before recording or publishing it", async () => {
    const { publication, deps, store, read } = await setup()
    const original = await documentCommand("inflight-original", path, "previous bytes")
    const initial = await publishDocument(publication, actor, original.command, original.bytes)
    const person = await authenticatedActor("inflight-publisher")
    const role = await assignRole(deps, actor, { targetPrincipalId: person.principalId, expectedTargetAuthorityEpoch: 0, role: "publisher", scope: { kind: "installation" } })
    const publisher = await authenticatedActor("inflight-publisher")
    const file = await content("gated payload")
    const command = { ...original.command, idempotencyKey: "inflight", artifactId: initial.session.artifactId, expectedRevisionId: initial.session.revisionId, expectedContentVersion: initial.receipt.contentVersion, files: [{ ...original.command.files[0], size: file.size, sha256: file.sha256 }], pages: [{ ...original.command.pages[0], disposition: "keep" as const, expectedPolicyEpoch: 0 }] }
    const session = await publication.begin(publisher, command)
    let release!: () => void, started!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const entered = new Promise<void>(resolve => { started = resolve })
    const stream = new ReadableStream<Uint8Array>({ async pull(controller) { started(); await gate; controller.enqueue(file.bytes); controller.close() } }, { highWaterMark: 0 })
    const upload = publication.upload(publisher, session.sessionId, path, stream)
    await entered
    await revokeRole(deps, actor, { targetPrincipalId: person.principalId, expectedTargetAuthorityEpoch: 1, roleGrantId: role.roleGrantId })
    release()
    await expect(upload).rejects.toMatchObject({ code: "conflict" })
    const refreshed = await authenticatedActor("inflight-publisher")
    await expect(publication.seal(refreshed, session.sessionId)).rejects.toMatchObject({ code: "conflict" })
    expect(await selected(read)).toMatchObject({ kind: "allow", plan: { revisionId: initial.session.revisionId } })
    expect(await storedBytes(store, { artifactId: initial.session.artifactId, revisionId: initial.session.revisionId, kind: "resource", path })).toEqual(original.bytes)
  })
  it("denies a previously successful overlapping restore receipt after the publisher is revoked", async () => {
    const { publication, deps, store, read } = await setup()
    const person = await authenticatedActor("restore-replay-publisher")
    const role = await assignRole(deps, actor, { targetPrincipalId: person.principalId, expectedTargetAuthorityEpoch: 0, role: "publisher", scope: { kind: "installation" } })
    const publisher = await authenticatedActor("restore-replay-publisher")
    const input = await documentCommand("restore-replay-original", path, "retained")
    const initial = await publishDocument(publication, publisher, input.command, input.bytes)
    const removed = await publication.unpublish(publisher, { idempotencyKey: "restore-replay-remove", artifactId: initial.session.artifactId, expectedContentVersion: initial.receipt.contentVersion })
    const command = { idempotencyKey: "restore-replay", artifactId: initial.session.artifactId, revisionId: initial.session.revisionId, expectedContentVersion: removed.contentVersion }
    const [one, two] = await Promise.all([publication.restore(publisher, command), publication.restore(publisher, command)])
    expect(one).toEqual(two)
    expect(one).toMatchObject({ revisionId: initial.session.revisionId, contentVersion: removed.contentVersion + 1 })
    await revokeRole(deps, actor, { targetPrincipalId: person.principalId, expectedTargetAuthorityEpoch: 1, roleGrantId: role.roleGrantId })
    const refreshed = await authenticatedActor("restore-replay-publisher")
    await expect(publication.restore(refreshed, command)).rejects.toMatchObject({ code: "forbidden" })
    expect(await selected(read)).toMatchObject({ kind: "allow", plan: { revisionId: initial.session.revisionId } })
    expect(await storedBytes(store, { artifactId: initial.session.artifactId, revisionId: initial.session.revisionId, kind: "resource", path })).toEqual(input.bytes)
  })
})
