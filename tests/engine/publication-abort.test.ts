import { env } from "cloudflare:workers"
import { beforeEach, describe, expect, it } from "vitest"
import { assignRole, disablePrincipal, revokeRole } from "../../domains/catalogue/commands"
import type { ManageActor } from "../../domains/catalogue/principals"
import { PublicationService } from "../../domains/publication"
import { collectRevision } from "../../domains/publication/collection"
import type { BeginCommand, PublicationDeps } from "../../domains/publication/types"
import { RevisionStore } from "../../domains/store/revision-store"
import { actor, authenticatedActor, bootstrap, configs, instanceId, jwks } from "./fixtures/catalogue"
import { body, clock, content, documentCommand, publishDocument, storedBytes } from "./fixtures/publication"

const path = "/a/abort-owner/index.html"
beforeEach(async () => { await bootstrap() })

async function setup() {
  const time = clock(10_000)
  const store = new RevisionStore(env.REVISION_BYTES, instanceId)
  const deps: PublicationDeps = { db: env.DB, config: (await configs()).manage, jwks, now: time.now, store, publication: { sessionTtlMs: 2_000_000, maxUploadTimeoutMs: 1000, retainMs: 900_000, marginMs: 1000, manageClockSkewMs: 0, readClockSkewMs: 0 } }
  return { publication: new PublicationService(deps), deps, store, time }
}

async function stagedUpdate(publication: PublicationService, publisher: ManageActor, base: { artifactId: string; revisionId: string; contentVersion: number; pageId: string }) {
  const file = await content("staged bytes")
  const command: BeginCommand = { idempotencyKey: "abort-staged", artifactId: base.artifactId, expectedRevisionId: base.revisionId, expectedContentVersion: base.contentVersion, files: [{ path, kind: "document", sha256: file.sha256, size: file.size, contentType: "text/html", source: "client" }], pages: [{ pageId: base.pageId, disposition: "keep", documentPath: path, metadata: {}, expectedPolicyEpoch: 0 }], edges: [] }
  const session = await publication.begin(publisher, command)
  await publication.upload(publisher, session.sessionId, path, body(file.bytes))
  await publication.seal(publisher, session.sessionId)
  return { session, file }
}

describe("publication session abort authority", () => {
  it("lets a scoped publisher close its stale own draft after another actor tombstones the page", async () => {
    const { publication, deps, store } = await setup()
    const first = await documentCommand("abort-original", path, "old bytes")
    const initial = await publishDocument(publication, actor, first.command, first.bytes)
    const person = await authenticatedActor("draft-owner")
    await assignRole(deps, actor, { targetPrincipalId: person.principalId, expectedTargetAuthorityEpoch: 0, role: "publisher", scope: { kind: "page", pageId: first.pageId } })
    const publisher = await authenticatedActor("draft-owner")
    const draft = await stagedUpdate(publication, publisher, { artifactId: initial.session.artifactId, revisionId: initial.session.revisionId, contentVersion: initial.receipt.contentVersion, pageId: first.pageId })
    const stranger = await authenticatedActor("another-principal")
    await publication.abort(stranger, draft.session.sessionId)
    expect(await publication.status(publisher, draft.session.sessionId)).toMatchObject({ state: "sealed" })
    await publication.unpublish(actor, { idempotencyKey: "abort-unpublish", artifactId: initial.session.artifactId, expectedContentVersion: initial.receipt.contentVersion })
    await publication.abort(publisher, draft.session.sessionId)
    await publication.abort(publisher, draft.session.sessionId)
    expect(await publication.status(publisher, draft.session.sessionId)).toMatchObject({ state: "closed" })
    await expect(publication.commit(publisher, draft.session.sessionId)).rejects.toThrow()
    expect(await storedBytes(store, { artifactId: draft.session.artifactId, revisionId: draft.session.revisionId, kind: "resource", path })).toEqual(draft.file.bytes)
  })

  it.each([["role", "old"], ["role", "refreshed"], ["principal", "old"], ["principal", "refreshed"]] as const)("allows the %s-revoked owner with %s handle to close, not publish", async (revocation, handle) => {
    const { publication, deps, store, time } = await setup()
    const first = await documentCommand(`abort-original-${revocation}`, path, "old")
    const initial = await publishDocument(publication, actor, first.command, first.bytes)
    const person = await authenticatedActor(`abort-${revocation}`)
    const grant = await assignRole(deps, actor, { targetPrincipalId: person.principalId, expectedTargetAuthorityEpoch: 0, role: "publisher", scope: { kind: "page", pageId: first.pageId } })
    const owner = await authenticatedActor(`abort-${revocation}`)
    const draft = await stagedUpdate(publication, owner, { artifactId: initial.session.artifactId, revisionId: initial.session.revisionId, contentVersion: initial.receipt.contentVersion, pageId: first.pageId })
    if (revocation === "role") await revokeRole(deps, actor, { targetPrincipalId: person.principalId, expectedTargetAuthorityEpoch: 1, roleGrantId: grant.roleGrantId })
    else await disablePrincipal(deps, actor, { targetPrincipalId: person.principalId, expectedTargetAuthorityEpoch: 1 })
    const refreshed = await authenticatedActor(`abort-${revocation}`)
    const stranger = await authenticatedActor(`abort-stranger-${revocation}`)
    time.advance(900_001)
    await publication.abort(stranger, draft.session.sessionId)
    const ref = { artifactId: draft.session.artifactId, revisionId: draft.session.revisionId }
    const maintenance = { db: deps.db, store, now: time.now, retainMs: 900_000, marginMs: 1000, maxUploadTimeoutMs: 1000, manageClockSkewMs: 0, readClockSkewMs: 0 }
    await expect(collectRevision(maintenance, ref)).rejects.toThrow()
    await publication.abort(handle === "old" ? owner : refreshed, draft.session.sessionId)
    await expect(publication.commit(refreshed, draft.session.sessionId)).rejects.toThrow()
    await expect(publication.status(refreshed, draft.session.sessionId)).rejects.toThrow()
    time.advance(1001)
    expect(await collectRevision(maintenance, ref)).toBe("purged")
    expect(await storedBytes(store, { ...ref, kind: "resource", path })).toBeNull()
  })

  it("rejects a fabricated actor before closing another actor's session", async () => {
    const { publication } = await setup()
    const first = await documentCommand("abort-forgery", path, "bytes")
    const draft = await publication.begin(actor, first.command)
    await expect(publication.abort({ ...actor } as ManageActor, draft.sessionId)).rejects.toThrow()
    expect(await publication.status(actor, draft.sessionId)).toMatchObject({ state: "open" })
  })
  it("refuses to close a session when the primary belongs to a different instance", async () => {
    const { publication } = await setup()
    const first = await documentCommand("abort-wrong-instance", path, "bytes")
    const draft = await publication.begin(actor, first.command)
    // The primary instance marker has no public mutation API: simulate a misbound database.
    await env.DB.prepare("UPDATE instance_meta SET instance_id = ? WHERE singleton = 1").bind("other-forge").run()
    await expect(publication.abort(actor, draft.sessionId)).rejects.toMatchObject({ code: "instance_mismatch" })
    expect(await env.DB.prepare("SELECT closed_at FROM publication_sessions WHERE session_id = ?").bind(draft.sessionId).first()).toEqual({ closed_at: null })
  })
})
