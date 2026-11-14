import { describe, expect, it } from "vitest"
import worker from "../../adapters/http/manageWorker"
import { manageHttpBindings } from "./fixtures/manage-http-bindings"
import { assignRole, disablePrincipal, readPagePolicy, revokeRole, setVisibility, share } from "../../domains/catalogue/commands"
import { newId } from "../../domains/catalogue/ids"
import { decideRead } from "../../domains/catalogue/read"
import { RevisionStore } from "../../domains/store/revision-store"
import type { BeginCommand, PublicationReceipt, PublicationStatus } from "../../domains/publication/types"
import { actor, authenticatedActor, configs, instanceId, jwks, teamIdentity } from "./fixtures/catalogue"
import { content, documentCommand, storedBytes } from "./fixtures/publication"
import { command, dispatch, env, receipt, request, setupHttp, signed, status, upload, uploaded } from "./fixtures/manage-http"

setupHttp()
const path = "/a/http/index.html"
const deps = async () => ({ db: env.DB, config: (await configs()).manage, jwks, now: Date.now })
const store = () => new RevisionStore(env.REVISION_BYTES, instanceId)
async function selected() {
  return decideRead(env.DB, (await configs()).read, { kind: "page", route: { kind: "subtree", slug: "http" }, candidates: [path], fragmentPath: null }, { team: teamIdentity, shareKey: null, shareCookie: null, pinnedProof: null, nowSeconds: 1 }, null)
}
async function publish(jwt: string, key = "first", text = "old") {
  const doc = await documentCommand(key, path, text)
  const session = await status(await command(jwt, { op: "begin", command: doc.command }))
  await uploaded(await upload(jwt, session.sessionId, path, doc.bytes), session.sessionId, path)
  await status(await command(jwt, { op: "seal", sessionId: session.sessionId }))
  const result = await receipt(await command(jwt, { op: "commit", sessionId: session.sessionId }))
  return { ...doc, session, result }
}
async function update(first: { command: BeginCommand; session: PublicationStatus; result: PublicationReceipt }, key: string, text: string): Promise<{ command: BeginCommand; bytes: Uint8Array<ArrayBuffer> }> {
  const next = await content(text)
  return { bytes: next.bytes, command: { ...first.command, idempotencyKey: key, artifactId: first.session.artifactId, expectedRevisionId: first.session.revisionId, expectedContentVersion: first.result.contentVersion, files: [{ ...first.command.files[0], size: next.size, sha256: next.sha256 }], pages: [{ ...first.command.pages[0], disposition: "keep", expectedPolicyEpoch: 0 }] } }
}

describe("actual manage Worker publication", () => {
  it("publishes through the main service binding, preserves private reads and stored bytes", async () => {
    const jwt = await signed()
    const first = await publish(jwt)
    expect(first.result.pages).toEqual([{ pageId: first.pageId, url: "/a/http/" }])
    expect(await status(await command(jwt, { op: "status", sessionId: first.session.sessionId }))).toMatchObject({ state: "committed" })
    expect(await selected()).toMatchObject({ kind: "allow", plan: { revisionId: first.session.revisionId } })
    expect(await readPagePolicy(await deps(), actor, first.pageId)).toMatchObject({ visibility: "private" })
    expect(await storedBytes(store(), { artifactId: first.session.artifactId, revisionId: first.session.revisionId, kind: "resource", path })).toEqual(first.bytes)
  })
  it("publishes two pages and materializes a base asset in the next revision", async () => {
    const jwt = await signed()
    const first = await documentCommand("multi-first", path, "first page")
    const second = await documentCommand("multi-second", "/a/http-two/index.html", "second page")
    const asset = await content("shared asset")
    const assetPath = "/a/http/shared.js"
    const fragment = await content("<p>fragment</p>")
    const fragmentPath = "/a/http/fragment.html"
    const original: BeginCommand = { ...first.command, files: [...first.command.files, ...second.command.files, { path: assetPath, kind: "asset", size: asset.size, sha256: asset.sha256, contentType: "application/javascript", source: "client" }, { path: fragmentPath, kind: "fragment", size: fragment.size, sha256: fragment.sha256, contentType: "text/html", source: "client" }], pages: [...first.command.pages, ...second.command.pages], edges: [{ ownerPageId: first.pageId, path: assetPath, providerArtifactId: null }, { ownerPageId: first.pageId, path: fragmentPath, providerArtifactId: null }] }
    const session = await status(await command(jwt, { op: "begin", command: original }))
    await uploaded(await upload(jwt, session.sessionId, path, first.bytes), session.sessionId, path)
    await uploaded(await upload(jwt, session.sessionId, "/a/http-two/index.html", second.bytes), session.sessionId, "/a/http-two/index.html")
    await uploaded(await upload(jwt, session.sessionId, assetPath, asset.bytes), session.sessionId, assetPath)
    await uploaded(await upload(jwt, session.sessionId, fragmentPath, fragment.bytes), session.sessionId, fragmentPath)
    await status(await command(jwt, { op: "seal", sessionId: session.sessionId }))
    const initial = await receipt(await command(jwt, { op: "commit", sessionId: session.sessionId }))
    expect(initial.pages.map(page => page.pageId).sort()).toEqual([first.pageId, second.pageId].sort())
    expect(await readPagePolicy(await deps(), actor, first.pageId)).toMatchObject({ visibility: "private" })
    expect(await readPagePolicy(await deps(), actor, second.pageId)).toMatchObject({ visibility: "private" })
    await setVisibility(await deps(), actor, { artifactId: session.artifactId, pageId: first.pageId, expectedPolicyEpoch: 0, visibility: "public" })
    const next: BeginCommand = { ...original, idempotencyKey: "multi-base", artifactId: session.artifactId, expectedRevisionId: session.revisionId, expectedContentVersion: initial.contentVersion, files: original.files.map(file => ({ ...file, source: "base" })), pages: original.pages.map(page => ({ ...page, disposition: "keep", expectedPolicyEpoch: page.pageId === first.pageId ? 1 : 0 })) }
    const nextSession = await status(await command(jwt, { op: "begin", command: next }))
    for (const file of next.files) await uploaded(await command(jwt, { op: "materialize", sessionId: nextSession.sessionId, path: file.path }), nextSession.sessionId, file.path)
    await status(await command(jwt, { op: "seal", sessionId: nextSession.sessionId }))
    await receipt(await command(jwt, { op: "commit", sessionId: nextSession.sessionId }))
    expect(await storedBytes(store(), { artifactId: session.artifactId, revisionId: nextSession.revisionId, kind: "resource", path: assetPath })).toEqual(asset.bytes)
    expect(await storedBytes(store(), { artifactId: session.artifactId, revisionId: nextSession.revisionId, kind: "resource", path: fragmentPath })).toEqual(fragment.bytes)
    expect(await selected()).toMatchObject({ kind: "allow", plan: { revisionId: nextSession.revisionId } })
    expect(await readPagePolicy(await deps(), actor, first.pageId)).toMatchObject({ visibility: "public" })
    const anonymous = { team: null, shareKey: null, shareCookie: null, pinnedProof: null, nowSeconds: 1 }
    for (const resourcePath of [assetPath, fragmentPath]) {
      expect(await decideRead(env.DB, (await configs()).read, { kind: "resource", path: resourcePath }, anonymous, null)).toMatchObject({ kind: "allow", plan: { revisionId: nextSession.revisionId, resource: { path: resourcePath } } })
    }
    expect(await decideRead(env.DB, (await configs()).read, { kind: "page", route: { kind: "subtree", slug: "http-two" }, candidates: ["/a/http-two/index.html"], fragmentPath: null }, anonymous, null)).toMatchObject({ kind: "deny" })
    expect(await readPagePolicy(await deps(), actor, second.pageId)).toMatchObject({ visibility: "private" })
    for (const [slug, resourcePath, bytes] of [["http", path, first.bytes], ["http-two", "/a/http-two/index.html", second.bytes]] as const) {
      const decision = await decideRead(env.DB, (await configs()).read, { kind: "page", route: { kind: "subtree", slug }, candidates: [resourcePath], fragmentPath: null }, { team: teamIdentity, shareKey: null, shareCookie: null, pinnedProof: null, nowSeconds: 1 }, null)
      expect(decision).toMatchObject({ kind: "allow", plan: { revisionId: nextSession.revisionId, resource: { path: resourcePath } } })
      expect(await storedBytes(store(), { artifactId: session.artifactId, revisionId: nextSession.revisionId, kind: "resource", path: resourcePath })).toEqual(bytes)
    }
  })


  it("does not reveal foreign or partially scoped artefacts to a page-scoped publisher", async () => {
    const admin = await signed()
    const x = await documentCommand("oracle-x", path, "page X")
    const z = await documentCommand("oracle-z", "/a/oracle-z/index.html", "page Z")
    const mixed: BeginCommand = { ...x.command, files: [...x.command.files, ...z.command.files], pages: [...x.command.pages, ...z.command.pages] }
    const mixedSession = await status(await command(admin, { op: "begin", command: mixed }))
    await uploaded(await upload(admin, mixedSession.sessionId, path, x.bytes), mixedSession.sessionId, path)
    await uploaded(await upload(admin, mixedSession.sessionId, "/a/oracle-z/index.html", z.bytes), mixedSession.sessionId, "/a/oracle-z/index.html")
    await status(await command(admin, { op: "seal", sessionId: mixedSession.sessionId }))
    const mixedReceipt = await receipt(await command(admin, { op: "commit", sessionId: mixedSession.sessionId }))

    const y = await documentCommand("oracle-y", "/a/oracle-y/index.html", "page Y")
    const ySession = await status(await command(admin, { op: "begin", command: y.command }))
    await uploaded(await upload(admin, ySession.sessionId, "/a/oracle-y/index.html", y.bytes), ySession.sessionId, "/a/oracle-y/index.html")
    await status(await command(admin, { op: "seal", sessionId: ySession.sessionId }))
    const yReceipt = await receipt(await command(admin, { op: "commit", sessionId: ySession.sessionId }))

    const person = await authenticatedActor("scoped-oracle")
    await assignRole(await deps(), actor, { targetPrincipalId: person.principalId, expectedTargetAuthorityEpoch: 0, role: "publisher", scope: { kind: "page", pageId: x.pageId } })
    const jwt = await signed("scoped-oracle")
    const onlyX = { ...x.command, files: x.command.files, pages: [{ ...x.command.pages[0], disposition: "keep" as const, expectedPolicyEpoch: 0 }] }
    const attempts: BeginCommand[] = [
      { ...onlyX, idempotencyKey: "foreign-existing", artifactId: ySession.artifactId, expectedRevisionId: ySession.revisionId, expectedContentVersion: yReceipt.contentVersion },
      { ...onlyX, idempotencyKey: "foreign-absent", artifactId: newId("ar"), expectedRevisionId: ySession.revisionId, expectedContentVersion: yReceipt.contentVersion },
      { ...onlyX, idempotencyKey: "partial-scope", artifactId: mixedSession.artifactId, expectedRevisionId: mixedSession.revisionId, expectedContentVersion: mixedReceipt.contentVersion },
    ]
    const beforeSessions = await env.DB.prepare("SELECT count(*) AS n FROM publication_sessions").first()
    const beforeEvents = await env.DB.prepare("SELECT count(*) AS n FROM mutation_events").first()
    for (const candidate of attempts) {
      const denied = await command(jwt, { op: "begin", command: candidate })
      expect(denied.status).toBe(403)
      expect(await denied.json()).toEqual({ ok: false, error: { code: "forbidden" } })
    }
    expect(await env.DB.prepare("SELECT count(*) AS n FROM publication_sessions").first()).toEqual(beforeSessions)
    expect(await env.DB.prepare("SELECT count(*) AS n FROM mutation_events").first()).toEqual(beforeEvents)
    expect(await selected()).toMatchObject({ kind: "allow", plan: { revisionId: mixedSession.revisionId } })
    const yDecision = await decideRead(env.DB, (await configs()).read, { kind: "page", route: { kind: "subtree", slug: "oracle-y" }, candidates: ["/a/oracle-y/index.html"], fragmentPath: null }, { team: teamIdentity, shareKey: null, shareCookie: null, pinnedProof: null, nowSeconds: 1 }, null)
    expect(yDecision).toMatchObject({ kind: "allow", plan: { revisionId: ySession.revisionId } })
    expect(await storedBytes(store(), { artifactId: ySession.artifactId, revisionId: ySession.revisionId, kind: "resource", path: "/a/oracle-y/index.html" })).toEqual(y.bytes)

    await assignRole(await deps(), actor, { targetPrincipalId: person.principalId, expectedTargetAuthorityEpoch: 1, role: "publisher", scope: { kind: "page", pageId: z.pageId } })
    const whole: BeginCommand = { ...mixed, idempotencyKey: "whole-scope-control", artifactId: mixedSession.artifactId, expectedRevisionId: mixedSession.revisionId, expectedContentVersion: mixedReceipt.contentVersion, pages: mixed.pages.map(page => ({ ...page, disposition: "keep", expectedPolicyEpoch: 0 })) }
    const accepted = await status(await command(jwt, { op: "begin", command: whole }))
    expect(accepted).toMatchObject({ artifactId: mixedSession.artifactId, baseRevisionId: mixedSession.revisionId, state: "open" })
  })

  it("allows only one of two independently authenticated writers to promote the same base", async () => {
    const admin = await signed()
    const one = await documentCommand("race-base", path, "base one")
    const two = await documentCommand("race-second", "/a/race-two/index.html", "base two")
    const baseCommand: BeginCommand = { ...one.command, files: [...one.command.files, ...two.command.files], pages: [...one.command.pages, ...two.command.pages] }
    const base = await status(await command(admin, { op: "begin", command: baseCommand }))
    await uploaded(await upload(admin, base.sessionId, path, one.bytes), base.sessionId, path)
    await uploaded(await upload(admin, base.sessionId, "/a/race-two/index.html", two.bytes), base.sessionId, "/a/race-two/index.html")
    await status(await command(admin, { op: "seal", sessionId: base.sessionId }))
    const baseReceipt = await receipt(await command(admin, { op: "commit", sessionId: base.sessionId }))
    const first = { command: baseCommand, session: base, result: baseReceipt }
    for (const name of ["writer-one", "writer-two"]) {
      const person = await authenticatedActor(name)
      await assignRole(await deps(), actor, { targetPrincipalId: person.principalId, expectedTargetAuthorityEpoch: 0, role: "publisher", scope: { kind: "installation" } })
    }
    const tokens = await Promise.all([signed("writer-one"), signed("writer-two")])
    const updates = await Promise.all([update(first, "writer-one-update", "one"), update(first, "writer-two-update", "two")])
    const secondUpdates = await Promise.all([content("one second"), content("two second")])
    for (let i = 0; i < 2; i++) {
      updates[i].command = { ...updates[i].command, files: [...updates[i].command.files, { ...two.command.files[0], size: secondUpdates[i].size, sha256: secondUpdates[i].sha256 }], pages: [...updates[i].command.pages, { ...two.command.pages[0], disposition: "keep", expectedPolicyEpoch: 0 }] }
    }
    const sessions: PublicationStatus[] = []
    for (let i = 0; i < 2; i++) {
      const session = await status(await command(tokens[i], { op: "begin", command: updates[i].command }))
      sessions.push(session)
      await uploaded(await upload(tokens[i], session.sessionId, path, updates[i].bytes), session.sessionId, path)
      await uploaded(await upload(tokens[i], session.sessionId, "/a/race-two/index.html", secondUpdates[i].bytes), session.sessionId, "/a/race-two/index.html")
      await status(await command(tokens[i], { op: "seal", sessionId: session.sessionId }))
    }
    const responses = await Promise.all(sessions.map((session, i) => command(tokens[i], { op: "commit", sessionId: session.sessionId })))
    expect(responses.map(r => r.status).sort()).toEqual([200, 409])
    const winner = responses.findIndex(r => r.status === 200)
    const loser = 1 - winner
    expect(await selected()).toMatchObject({ kind: "allow", plan: { revisionId: sessions[winner].revisionId } })
    expect(await storedBytes(store(), { artifactId: first.session.artifactId, revisionId: sessions[winner].revisionId, kind: "resource", path })).toEqual(updates[winner].bytes)
    expect(await storedBytes(store(), { artifactId: first.session.artifactId, revisionId: sessions[loser].revisionId, kind: "resource", path })).toEqual(updates[loser].bytes)
    const secondDecision = await decideRead(env.DB, (await configs()).read, { kind: "page", route: { kind: "subtree", slug: "race-two" }, candidates: ["/a/race-two/index.html"], fragmentPath: null }, { team: teamIdentity, shareKey: null, shareCookie: null, pinnedProof: null, nowSeconds: 1 }, null)
    expect(secondDecision).toMatchObject({ kind: "allow", plan: { revisionId: sessions[winner].revisionId, resource: { path: "/a/race-two/index.html" } } })
    for (const i of [winner, loser]) expect(await storedBytes(store(), { artifactId: base.artifactId, revisionId: sessions[i].revisionId, kind: "resource", path: "/a/race-two/index.html" })).toEqual(secondUpdates[i].bytes)
    expect(await status(await command(tokens[loser], { op: "status", sessionId: sessions[loser].sessionId }))).toMatchObject({ state: "sealed" })
  })

  it("recovers lost begin, upload and commit replies without replacing bytes", async () => {
    const jwt = await signed()
    const doc = await documentCommand("lost-reply", path, "immutable")
    const lose = async (operation: Promise<Response>) => { await operation; throw new Error("client lost response") }
    await expect(lose(command(jwt, { op: "begin", command: doc.command }))).rejects.toThrow("client lost response")
    const session = await status(await command(jwt, { op: "begin", command: doc.command }))
    await expect(lose(upload(jwt, session.sessionId, path, doc.bytes))).rejects.toThrow("client lost response")
    expect(await status(await command(jwt, { op: "status", sessionId: session.sessionId }))).toMatchObject({ files: [{ path, stored: true }] })
    const ref = { artifactId: session.artifactId, revisionId: session.revisionId, kind: "resource" as const, path }
    const before = await store().head(ref)
    await uploaded(await upload(jwt, session.sessionId, path, doc.bytes), session.sessionId, path)
    expect(await store().head(ref)).toEqual(before)
    await status(await command(jwt, { op: "seal", sessionId: session.sessionId }))
    await expect(lose(command(jwt, { op: "commit", sessionId: session.sessionId }))).rejects.toThrow("client lost response")
    expect(await status(await command(jwt, { op: "status", sessionId: session.sessionId }))).toMatchObject({ state: "committed" })
    const first = await receipt(await command(jwt, { op: "commit", sessionId: session.sessionId }))
    expect(await receipt(await command(jwt, { op: "commit", sessionId: session.sessionId }))).toEqual(first)
    expect(first.contentVersion).toBe(1)
    const changed = { ...doc.command, pages: [{ ...doc.command.pages[0], metadata: { title: "different valid metadata" } }] }
    expect((await command(jwt, { op: "begin", command: changed })).status).toBe(409)
  })

  it("revokes a disabled writer immediately but permits the owner to abort", async () => {
    const admin = await signed()
    const first = await publish(admin)
    const person = await authenticatedActor("disabled-writer")
    await assignRole(await deps(), actor, { targetPrincipalId: person.principalId, expectedTargetAuthorityEpoch: 0, role: "publisher", scope: { kind: "installation" } })
    const jwt = await signed("disabled-writer")
    const next = await update(first, "disabled-update", "new")
    const session = await status(await command(jwt, { op: "begin", command: next.command }))
    await disablePrincipal(await deps(), actor, { targetPrincipalId: person.principalId, expectedTargetAuthorityEpoch: 1 })
    expect((await upload(jwt, session.sessionId, path, next.bytes)).status).toBe(409)
    expect((await command(jwt, { op: "status", sessionId: session.sessionId })).status).toBe(409)
    const commit = await command(jwt, { op: "commit", sessionId: session.sessionId })
    expect(commit.status).toBe(401)
    expect(await commit.json()).toEqual({ ok: false, error: { code: "unauthenticated" } })
    expect(await env.DB.prepare("SELECT closed_at FROM publication_sessions WHERE session_id = ?").bind(session.sessionId).first()).toEqual({ closed_at: null })
    expect(await (await command(jwt, { op: "abort", sessionId: session.sessionId })).json()).toEqual({ ok: true, result: null })
    const closed = await env.DB.prepare("SELECT closed_at FROM publication_sessions WHERE session_id = ?").bind(session.sessionId).first<{ closed_at: number | null }>()
    expect(typeof closed?.closed_at).toBe("number")
    expect((await command(jwt, { op: "status", sessionId: session.sessionId })).status).toBe(409)
    const closedCommit = await command(jwt, { op: "commit", sessionId: session.sessionId })
    expect(closedCommit.status).toBe(401)
    expect(await closedCommit.json()).toEqual({ ok: false, error: { code: "unauthenticated" } })
    expect(await selected()).toMatchObject({ kind: "allow", plan: { revisionId: first.session.revisionId } })
    expect(await storedBytes(store(), { artifactId: first.session.artifactId, revisionId: first.session.revisionId, kind: "resource", path })).toEqual(first.bytes)
  })

  it.each(["upload", "seal", "commit"] as const)("refuses %s and status after a current publisher role is revoked", async phase => {
    const first = await publish(await signed())
    const person = await authenticatedActor(`revoked-${phase}`)
    const grant = await assignRole(await deps(), actor, { targetPrincipalId: person.principalId, expectedTargetAuthorityEpoch: 0, role: "publisher", scope: { kind: "installation" } })
    const jwt = await signed(`revoked-${phase}`)
    const next = await update(first, `revoked-${phase}`, "new")
    const session = await status(await command(jwt, { op: "begin", command: next.command }))
    if (phase !== "upload") await uploaded(await upload(jwt, session.sessionId, path, next.bytes), session.sessionId, path)
    if (phase === "commit") await status(await command(jwt, { op: "seal", sessionId: session.sessionId }))
    await revokeRole(await deps(), actor, { targetPrincipalId: person.principalId, expectedTargetAuthorityEpoch: 1, roleGrantId: grant.roleGrantId })
    const response = phase === "upload" ? await upload(jwt, session.sessionId, path, next.bytes) : await command(jwt, { op: phase, sessionId: session.sessionId })
    expect(response.status).toBe(phase === "commit" ? 403 : 409)
    expect(await response.json()).toEqual({ ok: false, error: { code: phase === "commit" ? "forbidden" : "conflict" } })
    expect((await command(jwt, { op: "status", sessionId: session.sessionId })).status).toBe(409)
    expect(await (await command(jwt, { op: "abort", sessionId: session.sessionId })).json()).toEqual({ ok: true, result: null })
    expect(await selected()).toMatchObject({ kind: "allow", plan: { revisionId: first.session.revisionId } })
    expect(await storedBytes(store(), { artifactId: first.session.artifactId, revisionId: first.session.revisionId, kind: "resource", path })).toEqual(first.bytes)
  })

  it("makes a stranger abort indistinguishable from unknown without closing the owner session", async () => {
    const owner = await signed()
    const first = await publish(owner)
    const next = await update(first, "owner-draft", "draft")
    const session = await status(await command(owner, { op: "begin", command: next.command }))
    const stranger = await signed("stranger")
    const attempted = await command(stranger, { op: "abort", sessionId: session.sessionId })
    const unknown = await command(stranger, { op: "abort", sessionId: `ps_${"a".repeat(26)}` })
    expect(attempted.status).toBe(200)
    expect(await attempted.json()).toEqual(await unknown.json())
    expect(await status(await command(owner, { op: "status", sessionId: session.sessionId }))).toMatchObject({ state: "open" })
    await uploaded(await upload(owner, session.sessionId, path, next.bytes), session.sessionId, path)
    await status(await command(owner, { op: "seal", sessionId: session.sessionId }))
    await receipt(await command(owner, { op: "commit", sessionId: session.sessionId }))
    expect(await selected()).toMatchObject({ kind: "allow", plan: { revisionId: session.revisionId } })
  })

  it("reauthorizes committed receipt replay after role revocation", async () => {
    const person = await authenticatedActor("receipt-writer")
    const grant = await assignRole(await deps(), actor, { targetPrincipalId: person.principalId, expectedTargetAuthorityEpoch: 0, role: "publisher", scope: { kind: "installation" } })
    const jwt = await signed("receipt-writer")
    const first = await publish(jwt, "receipt-publisher")
    expect(await receipt(await command(jwt, { op: "commit", sessionId: first.session.sessionId }))).toEqual(first.result)
    await revokeRole(await deps(), actor, { targetPrincipalId: person.principalId, expectedTargetAuthorityEpoch: 1, roleGrantId: grant.roleGrantId })
    expect((await command(jwt, { op: "status", sessionId: first.session.sessionId })).status).toBe(409)
    const replay = await command(jwt, { op: "commit", sessionId: first.session.sessionId })
    expect(replay.status).toBe(403)
    expect(await replay.json()).toEqual({ ok: false, error: { code: "forbidden" } })
    expect(await selected()).toMatchObject({ kind: "allow", plan: { revisionId: first.session.revisionId } })
    expect(await storedBytes(store(), { artifactId: first.session.artifactId, revisionId: first.session.revisionId, kind: "resource", path })).toEqual(first.bytes)
  })

  it.each(["not_sealed", "session_closed", "session_expired"] as const)("returns exact %s before revision I/O", async expected => {
    const jwt = await signed()
    const first = await publish(jwt)
    const next = await update(first, `state-${expected}`, "next")
    const session = await status(await command(jwt, { op: "begin", command: next.command }))
    if (expected === "session_closed") {
      await uploaded(await upload(jwt, session.sessionId, path, next.bytes), session.sessionId, path)
      await status(await command(jwt, { op: "seal", sessionId: session.sessionId }))
      expect(await (await command(jwt, { op: "abort", sessionId: session.sessionId })).json()).toEqual({ ok: true, result: null })
    }
    if (expected === "session_expired") {
      await uploaded(await upload(jwt, session.sessionId, path, next.bytes), session.sessionId, path)
      await status(await command(jwt, { op: "seal", sessionId: session.sessionId }))
      await env.DB.prepare("UPDATE publication_sessions SET created_at = 1, expires_at = 2 WHERE session_id = ?").bind(session.sessionId).run()
    }
    const response = await command(jwt, { op: "commit", sessionId: session.sessionId })
    expect(response.status).toBe(expected === "session_expired" ? 410 : 409)
    expect(await response.json()).toEqual({ ok: false, error: { code: expected } })
    expect(await selected()).toMatchObject({ kind: "allow", plan: { revisionId: first.session.revisionId } })
    expect(await storedBytes(store(), { artifactId: first.session.artifactId, revisionId: first.session.revisionId, kind: "resource", path })).toEqual(first.bytes)
  })

  it("acknowledges a verified PUT after seal and commit only with fresh authority", async () => {
    const person = await authenticatedActor("retry-publisher")
    const grant = await assignRole(await deps(), actor, { targetPrincipalId: person.principalId, expectedTargetAuthorityEpoch: 0, role: "publisher", scope: { kind: "installation" } })
    const jwt = await signed("retry-publisher")
    const doc = await documentCommand("sealed-retry", path, "immutable retry")
    const session = await status(await command(jwt, { op: "begin", command: doc.command }))
    await uploaded(await upload(jwt, session.sessionId, path, doc.bytes), session.sessionId, path)
    const ref = { artifactId: session.artifactId, revisionId: session.revisionId, kind: "resource" as const, path }
    const original = await store().head(ref)
    await status(await command(jwt, { op: "seal", sessionId: session.sessionId }))
    await uploaded(await upload(jwt, session.sessionId, path, doc.bytes), session.sessionId, path, "sealed")
    expect(await store().head(ref)).toEqual(original)
    await receipt(await command(jwt, { op: "commit", sessionId: session.sessionId }))
    await uploaded(await upload(jwt, session.sessionId, path, doc.bytes), session.sessionId, path, "committed")
    expect(await store().head(ref)).toEqual(original)
    await revokeRole(await deps(), actor, { targetPrincipalId: person.principalId, expectedTargetAuthorityEpoch: 1, roleGrantId: grant.roleGrantId })
    const denied = await upload(jwt, session.sessionId, path, doc.bytes)
    expect(denied.status).toBe(409)
    expect(await denied.json()).toEqual({ ok: false, error: { code: "conflict" } })
    expect(await store().head(ref)).toEqual(original)
    expect(await storedBytes(store(), ref)).toEqual(doc.bytes)
  })

  it.each([["short", "ne"], ["long", "new!"], ["checksum", "bad"]] as const)("rejects %s bytes as integrity failure and permits exact retry", async (_kind, invalidBytes) => {
    const jwt = await signed()
    const first = await publish(jwt)
    const next = await update(first, "bad-checksum", "new")
    const malformed = await command(jwt, { op: "begin", command: { ...next.command, idempotencyKey: "missing-document", files: [] } })
    expect(malformed.status).toBe(422)
    expect(await malformed.json()).toEqual({ ok: false, error: { code: "invalid_state" } })
    const session = await status(await command(jwt, { op: "begin", command: next.command }))
    const incomplete = await command(jwt, { op: "seal", sessionId: session.sessionId })
    expect(incomplete.status).toBe(409)
    expect(await incomplete.json()).toEqual({ ok: false, error: { code: "upload_incomplete" } })
    const bad = await upload(jwt, session.sessionId, path, new TextEncoder().encode(invalidBytes))
    expect(bad.status).toBe(422)
    expect(await bad.json()).toEqual({ ok: false, error: { code: "integrity_error" } })
    expect(await status(await command(jwt, { op: "status", sessionId: session.sessionId }))).toMatchObject({ files: [{ path, stored: false }] })
    expect(await store().head({ artifactId: session.artifactId, revisionId: session.revisionId, kind: "resource", path })).toBeNull()
    expect(await selected()).toMatchObject({ kind: "allow", plan: { revisionId: first.session.revisionId } })
    expect(await storedBytes(store(), { artifactId: first.session.artifactId, revisionId: first.session.revisionId, kind: "resource", path })).toEqual(first.bytes)
    await uploaded(await upload(jwt, session.sessionId, path, next.bytes), session.sessionId, path)
    await status(await command(jwt, { op: "seal", sessionId: session.sessionId }))
    await receipt(await command(jwt, { op: "commit", sessionId: session.sessionId }))
    expect(await selected()).toMatchObject({ kind: "allow", plan: { revisionId: session.revisionId } })
    expect(await storedBytes(store(), { artifactId: session.artifactId, revisionId: session.revisionId, kind: "resource", path })).toEqual(next.bytes)
  })

  it("enforces the configured upload cap on declared and streamed bytes without changing the active revision", async () => {
    const jwt = await signed()
    const first = await publish(jwt)
    const next = await update(first, "upload-cap", "12345678")
    const transport = { ...JSON.parse(manageHttpBindings.FORGE_MANAGE_TRANSPORT), maxUploadBytes: 8 }
    const bindings = { ...manageHttpBindings, FORGE_MANAGE_TRANSPORT: JSON.stringify(transport), DB: env.DB, REVISION_BYTES: env.REVISION_BYTES }
    const call = (value: unknown) => worker.fetch(request("/api/publication", "POST", jwt, JSON.stringify(value), { "Content-Type": "application/json" }), bindings)
    const oversized = { ...next.command, idempotencyKey: "declared-too-large", files: [{ ...next.command.files[0], size: 9 }] }
    const rejected = await call({ op: "begin", command: oversized })
    expect(rejected.status).toBe(413)
    expect(await rejected.json()).toEqual({ ok: false, error: { code: "payload_too_large" } })
    const session = await status(await call({ op: "begin", command: next.command }))
    const query = new URLSearchParams({ sessionId: session.sessionId, path })
    const bytes = new TextEncoder().encode("123456789")
    const stream = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(bytes); controller.close() } })
    const response = await worker.fetch(new Request(`https://manage.example.test/api/publication/upload?${query}`, { method: "PUT", headers: { "Content-Type": "application/octet-stream", "Cf-Access-Jwt-Assertion": jwt }, body: stream }), bindings)
    expect(response.status).toBe(413)
    expect(await response.json()).toEqual({ ok: false, error: { code: "payload_too_large" } })
    expect(await status(await call({ op: "status", sessionId: session.sessionId }))).toMatchObject({ files: [{ path, stored: false }] })
    expect(await selected()).toMatchObject({ kind: "allow", plan: { revisionId: first.session.revisionId } })
    expect(await storedBytes(store(), { artifactId: first.session.artifactId, revisionId: first.session.revisionId, kind: "resource", path })).toEqual(first.bytes)
    await uploaded(await worker.fetch(request(`/api/publication/upload?${query}`, "PUT", jwt, next.bytes, { "Content-Type": "application/octet-stream" }), bindings), session.sessionId, path)
    await status(await command(jwt, { op: "seal", sessionId: session.sessionId }))
    await receipt(await command(jwt, { op: "commit", sessionId: session.sessionId }))
    expect(await selected()).toMatchObject({ kind: "allow", plan: { revisionId: session.revisionId } })
  })

  it("round-trips an empty asset with Unicode, plus and literal percent in its selector", async () => {
    const jwt = await signed()
    const doc = await documentCommand("selector-bytes", path, "document")
    const empty = await content("")
    const assetPath = "/a/http/été+100%done.txt"
    const manifest: BeginCommand = { ...doc.command, files: [...doc.command.files, { path: assetPath, kind: "asset", sha256: empty.sha256, size: 0, contentType: "text/plain", source: "client" }], edges: [{ ownerPageId: doc.pageId, path: assetPath, providerArtifactId: null }] }
    const session = await status(await command(jwt, { op: "begin", command: manifest }))
    await uploaded(await upload(jwt, session.sessionId, path, doc.bytes), session.sessionId, path)
    const wrongQuery = `sessionId=${encodeURIComponent(session.sessionId)}&path=${encodeURIComponent(assetPath).replace("%2B", "+")}`
    const wrong = await dispatch(request(`/api/publication/upload?${wrongQuery}`, "PUT", jwt, null, { "Content-Type": "application/octet-stream" }))
    expect(wrong.status).toBe(404)
    expect(await status(await command(jwt, { op: "status", sessionId: session.sessionId }))).toMatchObject({ files: expect.arrayContaining([expect.objectContaining({ path: assetPath, stored: false })]) })
    const query = new URLSearchParams({ sessionId: session.sessionId, path: assetPath })
    await uploaded(await dispatch(request(`/api/publication/upload?${query}`, "PUT", jwt, null, { "Content-Type": "application/octet-stream" })), session.sessionId, assetPath)
    expect(await status(await command(jwt, { op: "status", sessionId: session.sessionId }))).toMatchObject({ files: expect.arrayContaining([expect.objectContaining({ path: assetPath, stored: true })]) })
    await status(await command(jwt, { op: "seal", sessionId: session.sessionId }))
    await receipt(await command(jwt, { op: "commit", sessionId: session.sessionId }))
    expect(await storedBytes(store(), { artifactId: session.artifactId, revisionId: session.revisionId, kind: "resource", path: assetPath })).toEqual(empty.bytes)
  })

  it("streams a 7,997,944-byte synthetic resource, not a largest-approved-capacity proof", async () => {
    const jwt = await signed()
    const doc = await documentCommand("large-synthetic", path, "document")
    const bytes = new Uint8Array(7_997_944).fill(97)
    const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))
    const sha256 = Array.from(hash, byte => byte.toString(16).padStart(2, "0")).join("")
    const assetPath = "/a/http/large.bin"
    const manifest: BeginCommand = { ...doc.command, files: [...doc.command.files, { path: assetPath, kind: "asset", sha256, size: bytes.byteLength, contentType: "application/octet-stream", source: "client" }], edges: [{ ownerPageId: doc.pageId, path: assetPath, providerArtifactId: null }] }
    const session = await status(await command(jwt, { op: "begin", command: manifest }))
    await uploaded(await upload(jwt, session.sessionId, path, doc.bytes), session.sessionId, path)
    await uploaded(await upload(jwt, session.sessionId, assetPath, bytes), session.sessionId, assetPath)
    await status(await command(jwt, { op: "seal", sessionId: session.sessionId }))
    await receipt(await command(jwt, { op: "commit", sessionId: session.sessionId }))
    const stored = await storedBytes(store(), { artifactId: session.artifactId, revisionId: session.revisionId, kind: "resource", path: assetPath })
    expect(stored?.byteLength).toBe(bytes.byteLength)
    expect(stored !== null && stored.every((byte, index) => byte === bytes[index])).toBe(true)
  }, 15_000)

  it("returns the owned upload deadline code for a stalled authenticated producer", async () => {
    const jwt = await signed()
    const first = await publish(jwt)
    const next = await update(first, "owned-upload-deadline", "new bytes")
    const options = { ...JSON.parse(manageHttpBindings.FORGE_PUBLICATION_OPTIONS), maxUploadTimeoutMs: 100 }
    const bindings = { ...manageHttpBindings, FORGE_PUBLICATION_OPTIONS: JSON.stringify(options), DB: env.DB, REVISION_BYTES: env.REVISION_BYTES }
    const session = await status(await worker.fetch(request("/api/publication", "POST", jwt, JSON.stringify({ op: "begin", command: next.command }), { "Content-Type": "application/json" }), bindings))
    const stream = new ReadableStream<Uint8Array>({ pull() { return new Promise(() => {}) } }, { highWaterMark: 0 })
    const query = new URLSearchParams({ sessionId: session.sessionId, path })
    const req = new Request(`https://manage.example.test/api/publication/upload?${query}`, { method: "PUT", headers: { "Content-Type": "application/octet-stream", "Cf-Access-Jwt-Assertion": jwt }, body: stream })
    const response = await worker.fetch(req, bindings)
    expect(response.status).toBe(408)
    expect(await response.json()).toEqual({ ok: false, error: { code: "request_timeout" } })
    expect(await status(await command(jwt, { op: "status", sessionId: session.sessionId }))).toMatchObject({ files: [{ path, stored: false }] })
    expect(await selected()).toMatchObject({ kind: "allow", plan: { revisionId: first.session.revisionId } })
    expect(await storedBytes(store(), { artifactId: first.session.artifactId, revisionId: first.session.revisionId, kind: "resource", path })).toEqual(first.bytes)
    await uploaded(await upload(jwt, session.sessionId, path, next.bytes), session.sessionId, path)
    await status(await command(jwt, { op: "seal", sessionId: session.sessionId }))
    await receipt(await command(jwt, { op: "commit", sessionId: session.sessionId }))
  })

  it("rechecks primary authority after an in-flight PUT loses its publisher role", async () => {
    const first = await publish(await signed())
    const person = await authenticatedActor("inflight-writer")
    const grant = await assignRole(await deps(), actor, { targetPrincipalId: person.principalId, expectedTargetAuthorityEpoch: 0, role: "publisher", scope: { kind: "installation" } })
    const jwt = await signed("inflight-writer")
    const next = await update(first, "inflight-revocation", "gated bytes")
    const session = await status(await command(jwt, { op: "begin", command: next.command }))
    let release!: () => void
    let reached!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const entered = new Promise<void>(resolve => { reached = resolve })
    let pulls = 0
    const stream = new ReadableStream<Uint8Array>({
      async pull(controller) {
        if (pulls++ === 0) { controller.enqueue(next.bytes.subarray(0, 1)); return }
        reached()
        await gate
        controller.enqueue(next.bytes.subarray(1))
        controller.close()
      },
    }, { highWaterMark: 0 })
    const query = new URLSearchParams({ sessionId: session.sessionId, path })
    const req = new Request(`https://manage.example.test/api/publication/upload?${query}`, { method: "PUT", headers: { "Content-Type": "application/octet-stream", "Cf-Access-Jwt-Assertion": jwt }, body: stream })
    const pending = worker.fetch(req, { ...manageHttpBindings, DB: env.DB, REVISION_BYTES: env.REVISION_BYTES })
    await entered
    try {
      await revokeRole(await deps(), actor, { targetPrincipalId: person.principalId, expectedTargetAuthorityEpoch: 1, roleGrantId: grant.roleGrantId })
    } finally {
      release()
    }
    const response = await pending
    expect(response.status).toBe(409)
    expect(await response.json()).toEqual({ ok: false, error: { code: "conflict" } })
    expect((await command(jwt, { op: "status", sessionId: session.sessionId })).status).toBe(409)
    expect(await env.DB.prepare("SELECT stored_at FROM publication_files WHERE session_id = ? AND path = ?").bind(session.sessionId, path).first()).toEqual({ stored_at: null })
    expect(await selected()).toMatchObject({ kind: "allow", plan: { revisionId: first.session.revisionId } })
    expect(await storedBytes(store(), { artifactId: first.session.artifactId, revisionId: first.session.revisionId, kind: "resource", path })).toEqual(first.bytes)
  })

  it("does not track an upload whose producer errors and accepts a retry", async () => {
    const jwt = await signed()
    const first = await publish(jwt)
    const next = await update(first, "producer-error", "replacement")
    const session = await status(await command(jwt, { op: "begin", command: next.command }))
    let pulls = 0
    const stream = new ReadableStream<Uint8Array>({ pull(controller) { if (pulls++ === 0) controller.enqueue(next.bytes.subarray(0, 1)); else controller.error(new Error("synthetic interruption")) } })
    const query = new URLSearchParams({ sessionId: session.sessionId, path })
    const req = new Request(`https://manage.example.test/api/publication/upload?${query}`, { method: "PUT", headers: { "Content-Type": "application/octet-stream", "Cf-Access-Jwt-Assertion": jwt }, body: stream })
    const response = await worker.fetch(req, { ...manageHttpBindings, DB: env.DB, REVISION_BYTES: env.REVISION_BYTES })
    expect(response.status).toBe(408)
    expect(await status(await command(jwt, { op: "status", sessionId: session.sessionId }))).toMatchObject({ files: [{ path, stored: false }] })
    expect(await selected()).toMatchObject({ kind: "allow", plan: { revisionId: first.session.revisionId } })
    await uploaded(await upload(jwt, session.sessionId, path, next.bytes), session.sessionId, path)
    await status(await command(jwt, { op: "seal", sessionId: session.sessionId }))
    await receipt(await command(jwt, { op: "commit", sessionId: session.sessionId }))
    expect(await storedBytes(store(), { artifactId: session.artifactId, revisionId: session.revisionId, kind: "resource", path })).toEqual(next.bytes)
  })

  it("resumes after a request signal interrupts a stalled producer", async () => {
    const jwt = await signed()
    const first = await publish(jwt)
    const next = await update(first, "interrupted", "resumed")
    const session = await status(await command(jwt, { op: "begin", command: next.command }))
    const abort = new AbortController()
    const stream = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(next.bytes.subarray(0, 1)) } })
    const query = new URLSearchParams({ sessionId: session.sessionId, path })
    const req = new Request(`https://manage.example.test/api/publication/upload?${query}`, { method: "PUT", headers: { "Content-Type": "application/octet-stream", "Cf-Access-Jwt-Assertion": jwt }, body: stream, signal: abort.signal })
    const pending = worker.fetch(req, { ...manageHttpBindings, DB: env.DB, REVISION_BYTES: env.REVISION_BYTES })
    abort.abort()
    expect((await pending).status).toBe(408)
    expect(await status(await command(jwt, { op: "status", sessionId: session.sessionId }))).toMatchObject({ files: [{ path, stored: false }] })
    expect(await selected()).toMatchObject({ kind: "allow", plan: { revisionId: first.session.revisionId } })
    await uploaded(await upload(jwt, session.sessionId, path, next.bytes), session.sessionId, path)
    await status(await command(jwt, { op: "seal", sessionId: session.sessionId }))
    await receipt(await command(jwt, { op: "commit", sessionId: session.sessionId }))
    expect(await selected()).toMatchObject({ kind: "allow", plan: { revisionId: session.revisionId } })
    expect(await storedBytes(store(), { artifactId: session.artifactId, revisionId: session.revisionId, kind: "resource", path })).toEqual(next.bytes)
  })

  it("unpublishes and restores retained bytes without resurrecting a share", async () => {
    const jwt = await signed()
    const first = await publish(jwt)
    const grant = await share(await deps(), actor, { pageId: first.pageId, artifactId: first.session.artifactId, expectedPolicyEpoch: 0, mode: "follow_active" })
    const removed = await receipt(await command(jwt, { op: "unpublish", command: { idempotencyKey: "http-remove", artifactId: first.session.artifactId, expectedContentVersion: first.result.contentVersion } }))
    const restored = await receipt(await command(jwt, { op: "restore", command: { idempotencyKey: "http-restore", artifactId: first.session.artifactId, revisionId: first.session.revisionId, expectedContentVersion: removed.contentVersion } }))
    expect(restored.pages).toEqual(expect.arrayContaining([expect.objectContaining({ pageId: first.pageId })]))
    expect(await readPagePolicy(await deps(), actor, first.pageId)).toMatchObject({ visibility: "private", grant: null })
    expect(await decideRead(env.DB, (await configs()).read, { kind: "share", route: { kind: "subtree", slug: "http" }, candidates: [path] }, { team: null, shareKey: grant.key, shareCookie: null, pinnedProof: null, nowSeconds: 1 }, null)).toEqual({ kind: "deny", reason: "not_found" })
    expect(await storedBytes(store(), { artifactId: first.session.artifactId, revisionId: first.session.revisionId, kind: "resource", path })).toEqual(first.bytes)
  })
})
