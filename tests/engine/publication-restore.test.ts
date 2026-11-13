import { env } from "cloudflare:workers"
import { beforeEach, describe, expect, it } from "vitest"
import { assignRole, readPagePolicy, revokeRole, share } from "../../domains/catalogue/commands"
import { newId } from "../../domains/catalogue/ids"
import { decideRead, type ReadCredentials } from "../../domains/catalogue/read"
import { PublicationService } from "../../domains/publication"
import type { BeginCommand, PublicationDeps } from "../../domains/publication/types"
import { RevisionStore } from "../../domains/store/revision-store"
import { actor, authenticatedActor, bootstrap, configs, instanceId, jwks, teamIdentity } from "./fixtures/catalogue"
import { body, clock, content, documentCommand, publishDocument, storedBytes } from "./fixtures/publication"

const firstPath = "/a/kept/index.html"
const droppedPath = "/a/dropped/index.html"
const anonymous: ReadCredentials = { team: null, shareKey: null, shareCookie: null, pinnedProof: null, nowSeconds: 1 }
beforeEach(async () => { await bootstrap() })

describe("multi-page publication restore", () => {
  it("restores a dropped page under its original ID, privately, without reviving its share or role", async () => {
    const time = clock(10_000)
    const { manage, read } = await configs()
    const store = new RevisionStore(env.REVISION_BYTES, instanceId)
    const deps: PublicationDeps = { db: env.DB, config: manage, jwks, now: time.now, store, publication: { sessionTtlMs: 60_000, maxUploadTimeoutMs: 1000, retainMs: 900_000, marginMs: 1000, manageClockSkewMs: 0, readClockSkewMs: 0 } }
    const publication = new PublicationService(deps)
    const first = await documentCommand("multi-restore-original", firstPath, "kept old")
    const dropped = await content("dropped old")
    const droppedPage = newId("pg")
    const original: BeginCommand = { ...first.command, files: [...first.command.files, { path: droppedPath, kind: "document", sha256: dropped.sha256, size: dropped.size, contentType: "text/html", source: "client" }], pages: [...first.command.pages, { pageId: droppedPage, disposition: "new", documentPath: droppedPath, metadata: {}, expectedPolicyEpoch: null }] }
    const initial = await publication.begin(actor, original)
    await publication.upload(actor, initial.sessionId, firstPath, body(first.bytes))
    await publication.upload(actor, initial.sessionId, droppedPath, body(dropped.bytes))
    await publication.seal(actor, initial.sessionId)
    const initialReceipt = await publication.commit(actor, initial.sessionId)
    const independent = await documentCommand("unrelated-artifact", "/a/unrelated/index.html", "unrelated")
    const independentResult = await publishDocument(publication, actor, independent.command, independent.bytes)
    const grant = await share(deps, actor, { pageId: droppedPage, artifactId: initial.artifactId, expectedPolicyEpoch: 0, mode: "follow_active" })
    const person = await authenticatedActor("former-page-publisher")
    const role = await assignRole(deps, actor, { targetPrincipalId: person.principalId, expectedTargetAuthorityEpoch: 0, role: "publisher", scope: { kind: "page", pageId: droppedPage } })
    await revokeRole(deps, actor, { targetPrincipalId: person.principalId, expectedTargetAuthorityEpoch: 1, roleGrantId: role.roleGrantId })
    const afterDrop: BeginCommand = { idempotencyKey: "multi-drop", artifactId: initial.artifactId, expectedRevisionId: initial.revisionId, expectedContentVersion: initialReceipt.contentVersion, files: first.command.files, pages: [{ ...first.command.pages[0], disposition: "keep", expectedPolicyEpoch: 0 }, { pageId: droppedPage, disposition: "drop", documentPath: null, metadata: null, expectedPolicyEpoch: 1 }], edges: [] }
    const update = await publication.begin(actor, afterDrop)
    await publication.upload(actor, update.sessionId, firstPath, body(first.bytes))
    await publication.seal(actor, update.sessionId)
    const updated = await publication.commit(actor, update.sessionId)
    expect(await readPagePolicy(deps, actor, droppedPage)).toBeNull()
    const restored = await publication.restore(actor, { idempotencyKey: "multi-restore", artifactId: initial.artifactId, revisionId: initial.revisionId, expectedContentVersion: updated.contentVersion })
    expect(restored.pages).toEqual(expect.arrayContaining([expect.objectContaining({ pageId: first.pageId }), expect.objectContaining({ pageId: droppedPage })]))
    expect(await readPagePolicy(deps, actor, droppedPage)).toMatchObject({ pageId: droppedPage, visibility: "private", grant: null })
    const refreshed = await authenticatedActor("former-page-publisher")
    await expect(readPagePolicy(deps, refreshed, droppedPage)).rejects.toThrow()
    expect(await decideRead(env.DB, read, { kind: "share", route: { kind: "subtree", slug: "dropped" }, candidates: [droppedPath] }, { ...anonymous, shareKey: grant.key }, null)).toEqual({ kind: "deny", reason: "not_found" })
    expect(await storedBytes(store, { artifactId: initial.artifactId, revisionId: initial.revisionId, kind: "resource", path: droppedPath })).toEqual(dropped.bytes)
    expect(await decideRead(env.DB, read, { kind: "page", route: { kind: "subtree", slug: "unrelated" }, candidates: ["/a/unrelated/index.html"], fragmentPath: null }, { ...anonymous, team: teamIdentity }, null)).toMatchObject({ kind: "allow", plan: { revisionId: independentResult.session.revisionId } })
  })
})
