import { env } from "cloudflare:workers"
import { beforeEach, describe, expect, it } from "vitest"
import { assignRole, readPagePolicy, revokeRole, share } from "../../domains/catalogue/commands"
import { newId } from "../../domains/catalogue/ids"
import { documentRouteOf } from "../../domains/catalogue/revision-paths"
import { canonicalUrl } from "../../domains/catalogue/routing/grammar"
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
    await expect(readPagePolicy(deps, refreshed, droppedPage)).rejects.toMatchObject({ code: "forbidden" })
    expect(await decideRead(env.DB, read, { kind: "share", route: { kind: "subtree", slug: "dropped" }, candidates: [droppedPath] }, { ...anonymous, shareKey: grant.key }, null)).toEqual({ kind: "deny", reason: "not_found" })
    expect(await storedBytes(store, { artifactId: initial.artifactId, revisionId: initial.revisionId, kind: "resource", path: droppedPath })).toEqual(dropped.bytes)
    expect(await decideRead(env.DB, read, { kind: "page", route: { kind: "subtree", slug: "unrelated" }, candidates: ["/a/unrelated/index.html"], fragmentPath: null }, { ...anonymous, team: teamIdentity }, null)).toMatchObject({ kind: "allow", plan: { revisionId: independentResult.session.revisionId } })
  })
  it("refuses a retained legacy-corrupt zero-page revision without activating it or restoring its grant", async () => {
    const time = clock(10_000)
    const { manage, read } = await configs()
    const store = new RevisionStore(env.REVISION_BYTES, instanceId)
    const deps: PublicationDeps = { db: env.DB, config: manage, jwks, now: time.now, store, publication: { sessionTtlMs: 60_000, maxUploadTimeoutMs: 1000, retainMs: 900_000, marginMs: 1000, manageClockSkewMs: 0, readClockSkewMs: 0 } }
    const publication = new PublicationService(deps)
    const original = await documentCommand("zero-page-original", droppedPath, "retained bytes")
    const initial = await publishDocument(publication, actor, original.command, original.bytes)
    const grant = await share(deps, actor, { pageId: original.pageId, artifactId: initial.session.artifactId, expectedPolicyEpoch: 0, mode: "follow_active" })
    const removed = await publication.unpublish(actor, { idempotencyKey: "zero-page-unpublish", artifactId: initial.session.artifactId, expectedContentVersion: initial.receipt.contentVersion })
    // Fault injection in isolated D1: corrected public APIs cannot create this legacy-corrupt revision.
    await env.DB.prepare("DELETE FROM revision_pages WHERE revision_id = ?").bind(initial.session.revisionId).run()
    await expect(publication.restore(actor, { idempotencyKey: "zero-page-restore", artifactId: initial.session.artifactId, revisionId: initial.session.revisionId, expectedContentVersion: removed.contentVersion })).rejects.toMatchObject({ code: "invalid_state", detail: "revision_without_page" })
    expect(await env.DB.prepare("SELECT active_revision_id, content_version FROM artifacts WHERE artifact_id = ?").bind(initial.session.artifactId).first()).toEqual({ active_revision_id: null, content_version: removed.contentVersion })
    expect(await storedBytes(store, { artifactId: initial.session.artifactId, revisionId: initial.session.revisionId, kind: "resource", path: droppedPath })).toEqual(original.bytes)
    expect(await decideRead(env.DB, read, { kind: "share", route: { kind: "subtree", slug: "dropped" }, candidates: [droppedPath] }, { ...anonymous, shareKey: grant.key }, null)).toEqual({ kind: "deny", reason: "not_found" })
  })
  it.each(["subtree", "tree"] as const)("refuses %s route drift and restores the historical route after unpublishing", async (grammar) => {
    const time = clock(10_000)
    const { manage, read } = await configs()
    const store = new RevisionStore(env.REVISION_BYTES, instanceId)
    const deps: PublicationDeps = { db: env.DB, config: manage, jwks, now: time.now, store, publication: { sessionTtlMs: 60_000, maxUploadTimeoutMs: 1000, retainMs: 900_000, marginMs: 1000, manageClockSkewMs: 0, readClockSkewMs: 0 } }
    const publication = new PublicationService(deps)
    const oldPath = grammar === "subtree" ? "/a/old/index.html" : "/docs/old.html"
    const newPath = grammar === "subtree" ? "/a/new/index.html" : "/docs/new.html"
    const oldRoute = documentRouteOf(oldPath)
    const newRoute = documentRouteOf(newPath)
    if (!oldRoute || !newRoute) throw new Error("test paths must have valid Catalogue routes")
    const original = await documentCommand("move-original", oldPath, "original page bytes")
    const initial = await publishDocument(publication, actor, original.command, original.bytes)
    const grant = await share(deps, actor, { pageId: original.pageId, artifactId: initial.session.artifactId, expectedPolicyEpoch: 0, mode: "follow_active" })
    const removed = await publication.unpublish(actor, { idempotencyKey: "move-unpublish", artifactId: initial.session.artifactId, expectedContentVersion: initial.receipt.contentVersion })
    expect(await readPagePolicy(deps, actor, original.pageId)).toBeNull()

    const movedContent = await content("new page bytes")
    const command: BeginCommand = { idempotencyKey: "move-restore-page", artifactId: initial.session.artifactId, expectedRevisionId: null, expectedContentVersion: removed.contentVersion, files: [{ path: newPath, kind: "document", sha256: movedContent.sha256, size: movedContent.size, contentType: "text/html", source: "client" }], pages: [{ pageId: original.pageId, disposition: "restore", documentPath: newPath, metadata: {}, expectedPolicyEpoch: 2 }], edges: [] }
    const moved = await publication.begin(actor, command)
    await publication.upload(actor, moved.sessionId, newPath, body(movedContent.bytes))
    expect(await publication.seal(actor, moved.sessionId)).toMatchObject({ state: "sealed" })
    const receipt = await publication.commit(actor, moved.sessionId)
    expect(receipt).toMatchObject({ artifactId: initial.session.artifactId, revisionId: moved.revisionId, contentVersion: removed.contentVersion + 1, pages: [{ pageId: original.pageId, url: canonicalUrl(newRoute) }] })

    const page = { kind: "page" as const, route: newRoute, candidates: [newPath], fragmentPath: null }
    const oldPage = { kind: "page" as const, route: oldRoute, candidates: [oldPath], fragmentPath: null }
    const team = { ...anonymous, team: teamIdentity }
    const policy = await readPagePolicy(deps, actor, original.pageId)
    expect(policy).toMatchObject({ pageId: original.pageId, artifactId: initial.session.artifactId, visibility: "private", policyEpoch: 3, grant: null, contentVersion: receipt.contentVersion })
    expect(await decideRead(env.DB, read, page, team, null)).toMatchObject({ kind: "allow", plan: { revisionId: moved.revisionId, resource: { path: newPath } } })
    expect(await decideRead(env.DB, read, oldPage, team, canonicalUrl(oldRoute))).toEqual({ kind: "deny", reason: "not_found" })
    expect(await decideRead(env.DB, read, page, anonymous, null)).toEqual({ kind: "deny", reason: "login_required" })

    await expect(publication.restore(actor, { idempotencyKey: "move-historical-restore", artifactId: initial.session.artifactId, revisionId: initial.session.revisionId, expectedContentVersion: receipt.contentVersion })).rejects.toMatchObject({ code: "invalid_state", detail: "restore_path_changed" })
    expect(await publication.status(actor, moved.sessionId)).toMatchObject({ state: "committed", revisionId: moved.revisionId })
    expect(await readPagePolicy(deps, actor, original.pageId)).toEqual(policy)
    expect(await decideRead(env.DB, read, page, team, null)).toMatchObject({ kind: "allow", plan: { revisionId: moved.revisionId, resource: { path: newPath } } })
    expect(await decideRead(env.DB, read, oldPage, team, canonicalUrl(oldRoute))).toEqual({ kind: "deny", reason: "not_found" })
    expect(await decideRead(env.DB, read, page, anonymous, null)).toEqual({ kind: "deny", reason: "login_required" })
    expect(await decideRead(env.DB, read, { kind: "share", route: newRoute, candidates: [newPath] }, { ...anonymous, shareKey: grant.key }, null)).toEqual({ kind: "deny", reason: "not_found" })
    expect(await storedBytes(store, { artifactId: initial.session.artifactId, revisionId: initial.session.revisionId, kind: "resource", path: oldPath })).toEqual(original.bytes)
    expect(await storedBytes(store, { artifactId: moved.artifactId, revisionId: moved.revisionId, kind: "resource", path: newPath })).toEqual(movedContent.bytes)

    const released = await publication.unpublish(actor, { idempotencyKey: "move-remedy-unpublish", artifactId: moved.artifactId, expectedContentVersion: receipt.contentVersion })
    expect(released).toMatchObject({ revisionId: null, contentVersion: receipt.contentVersion + 1 })
    const restored = await publication.restore(actor, { idempotencyKey: "move-remedy-restore", artifactId: moved.artifactId, revisionId: initial.session.revisionId, expectedContentVersion: released.contentVersion })
    expect(restored).toMatchObject({ revisionId: initial.session.revisionId, contentVersion: released.contentVersion + 1, pages: [{ pageId: original.pageId, url: canonicalUrl(oldRoute) }] })
    expect(await readPagePolicy(deps, actor, original.pageId)).toMatchObject({ pageId: original.pageId, visibility: "private", policyEpoch: 5, grant: null, contentVersion: restored.contentVersion })
    expect(await decideRead(env.DB, read, oldPage, team, null)).toMatchObject({ kind: "allow", plan: { revisionId: initial.session.revisionId, resource: { path: oldPath } } })
    expect(await decideRead(env.DB, read, page, team, canonicalUrl(newRoute))).toEqual({ kind: "deny", reason: "not_found" })
    expect(await decideRead(env.DB, read, oldPage, anonymous, null)).toEqual({ kind: "deny", reason: "login_required" })
    expect(await decideRead(env.DB, read, { kind: "share", route: oldRoute, candidates: [oldPath] }, { ...anonymous, shareKey: grant.key }, null)).toEqual({ kind: "deny", reason: "not_found" })
    expect(await storedBytes(store, { artifactId: initial.session.artifactId, revisionId: initial.session.revisionId, kind: "resource", path: oldPath })).toEqual(original.bytes)
    expect(await storedBytes(store, { artifactId: moved.artifactId, revisionId: moved.revisionId, kind: "resource", path: newPath })).toEqual(movedContent.bytes)
  })
  it("rejects keep for a tombstoned page at begin without creating a session or audit event", async () => {
    const time = clock(10_000)
    const { manage, read } = await configs()
    const store = new RevisionStore(env.REVISION_BYTES, instanceId)
    const deps: PublicationDeps = { db: env.DB, config: manage, jwks, now: time.now, store, publication: { sessionTtlMs: 60_000, maxUploadTimeoutMs: 1000, retainMs: 900_000, marginMs: 1000, manageClockSkewMs: 0, readClockSkewMs: 0 } }
    const publication = new PublicationService(deps)
    const path = "/a/keep-tombstone/index.html"
    const original = await documentCommand("keep-tombstone-original", path, "retained")
    const initial = await publishDocument(publication, actor, original.command, original.bytes)
    expect(await readPagePolicy(deps, actor, original.pageId)).toMatchObject({ policyEpoch: 0, visibility: "private" })
    const removed = await publication.unpublish(actor, { idempotencyKey: "keep-tombstone-remove", artifactId: initial.session.artifactId, expectedContentVersion: initial.receipt.contentVersion })
    expect(removed).toMatchObject({ revisionId: null, contentVersion: initial.receipt.contentVersion + 1 })
    expect(await readPagePolicy(deps, actor, original.pageId)).toBeNull()
    const tombstone = await env.DB.prepare("SELECT policy_epoch, tombstoned_at FROM pages WHERE page_id = ?").bind(original.pageId).first<{ policy_epoch: number; tombstoned_at: number | null }>()
    expect(tombstone).toMatchObject({ policy_epoch: 1, tombstoned_at: expect.any(Number) })
    if (!tombstone) throw new Error("unpublished page has no tombstone")
    const before = await env.DB.prepare("SELECT (SELECT count(*) FROM publication_sessions) AS sessions, (SELECT count(*) FROM mutation_events) AS events, (SELECT count(*) FROM publication_events) AS publications").first()
    const artifactBefore = await env.DB.prepare("SELECT active_revision_id, content_version FROM artifacts WHERE artifact_id = ?").bind(initial.session.artifactId).first()
    expect(artifactBefore).toEqual({ active_revision_id: null, content_version: removed.contentVersion })
    const command: BeginCommand = { idempotencyKey: "keep-tombstone-attempt", artifactId: initial.session.artifactId, expectedRevisionId: null, expectedContentVersion: removed.contentVersion, files: original.command.files, pages: [{ pageId: original.pageId, disposition: "keep", documentPath: path, metadata: {}, expectedPolicyEpoch: tombstone.policy_epoch }], edges: [] }

    await expect(publication.begin(actor, command)).rejects.toMatchObject({ code: "not_found" })
    expect(await env.DB.prepare("SELECT (SELECT count(*) FROM publication_sessions) AS sessions, (SELECT count(*) FROM mutation_events) AS events, (SELECT count(*) FROM publication_events) AS publications").first()).toEqual(before)
    expect(await env.DB.prepare("SELECT active_revision_id, content_version FROM artifacts WHERE artifact_id = ?").bind(initial.session.artifactId).first()).toEqual(artifactBefore)
    expect(await readPagePolicy(deps, actor, original.pageId)).toBeNull()
    expect(await decideRead(env.DB, read, { kind: "page", route: { kind: "subtree", slug: "keep-tombstone" }, candidates: [path], fragmentPath: null }, { ...anonymous, team: teamIdentity }, null)).toEqual({ kind: "deny", reason: "not_found" })
    expect(await storedBytes(store, { artifactId: initial.session.artifactId, revisionId: initial.session.revisionId, kind: "resource", path })).toEqual(original.bytes)
  })
})
