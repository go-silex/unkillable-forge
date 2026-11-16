import { env } from "cloudflare:workers"
import { beforeEach, describe, expect, it } from "vitest"
import { activePinnedGrantSql } from "../../domains/catalogue/artifact-pages"
import { assignRole, importShare, rotateShare, share } from "../../domains/catalogue/commands"
import type { ReadInstanceConfig } from "../../domains/catalogue/instance-config"
import { decideRead, type ReadCredentials } from "../../domains/catalogue/read"
import { PublicationService } from "../../domains/publication"
import type { BeginCommand, PublicationDeps } from "../../domains/publication/types"
import { RevisionStore } from "../../domains/store/revision-store"
import { actor, artifactId, authenticatedActor, bootstrap, configs, digest, instanceId, jwks, pageFixture, pageId, revisionId, syntheticCommitHistory } from "./fixtures/catalogue"
import { body, clock, content, documentCommand, observeD1, publishDocument, storedBytes } from "./fixtures/publication"

const path = "/a/sample/index.html"
const route = { kind: "subtree" as const, slug: "sample" }
const anonymous: ReadCredentials = { team: null, shareKey: null, shareCookie: null, pinnedProof: null, nowSeconds: 1 }
beforeEach(async () => { await bootstrap() })

async function setup() {
  const time = clock(10_000)
  const { manage, read } = await configs()
  const store = new RevisionStore(env.REVISION_BYTES, instanceId)
  const deps: PublicationDeps = { db: env.DB, config: manage, jwks, now: time.now, store, publication: { sessionTtlMs: 60_000, maxUploadTimeoutMs: 1000, retainMs: 900_000, marginMs: 1000, manageClockSkewMs: 0, readClockSkewMs: 0 } }
  const publication = new PublicationService(deps)
  const first = await documentCommand("base", path, "base bytes")
  const initial = await publishDocument(publication, actor, first.command, first.bytes)
  const file = await content("candidate bytes")
  const command: BeginCommand = { idempotencyKey: "candidate", artifactId: initial.receipt.artifactId, expectedRevisionId: initial.receipt.revisionId, expectedContentVersion: initial.receipt.contentVersion, files: [{ path, kind: "document", sha256: file.sha256, size: file.size, contentType: "text/html", source: "client" }], pages: [{ pageId: first.pageId, disposition: "keep", documentPath: path, metadata: {}, expectedPolicyEpoch: 0 }], edges: [] }
  const candidate = await publication.begin(actor, command)
  await publication.upload(actor, candidate.sessionId, path, body(file.bytes))
  await publication.seal(actor, candidate.sessionId)
  expect(await storedBytes(store, { artifactId: candidate.artifactId, revisionId: candidate.revisionId, kind: "resource", path })).toEqual(file.bytes)
  return { deps, publication, read, store, first, initial, candidate, bytes: file.bytes }
}

async function snapshot(page: string) {
  return {
    grants: (await env.DB.prepare("SELECT * FROM share_grants WHERE page_id = ? ORDER BY grant_id").bind(page).all()).results,
    page: await env.DB.prepare("SELECT visibility, policy_epoch FROM pages WHERE page_id = ?").bind(page).first(),
    mutations: await env.DB.prepare("SELECT count(*) AS n FROM mutation_events").first(),
    publications: await env.DB.prepare("SELECT count(*) AS n FROM publication_events").first(),
  }
}
async function pinned(revision: string) {
  return (await env.DB.prepare(`SELECT ${activePinnedGrantSql("?1")} AS pinned`).bind(revision).first<{ pinned: number }>())?.pinned
}
async function readKey(read: ReadInstanceConfig, key: string | null) {
  return decideRead(env.DB, read, { kind: "share", route, candidates: [path] }, { ...anonymous, shareKey: key }, null)
}

describe("committed-only pinned grant admission", () => {
  it.each([["admin", "sealed"], ["admin", "aborted"], ["scoped", "sealed"], ["scoped", "aborted"]] as const)("rejects a real %s pin of a %s candidate without effects", async (authority, state) => {
    const s = await setup()
    const person = await authenticatedActor("publisher")
    await assignRole(s.deps, actor, { targetPrincipalId: person.principalId, expectedTargetAuthorityEpoch: 0, role: "publisher", scope: { kind: "page", pageId: s.first.pageId } })
    const caller = authority === "admin" ? actor : await authenticatedActor("publisher")
    if (state === "aborted") await s.publication.abort(actor, s.candidate.sessionId)
    const before = await snapshot(s.first.pageId)
    expect(before.grants).toEqual([])
    await expect(share(s.deps, caller, { pageId: s.first.pageId, artifactId: s.candidate.artifactId, expectedPolicyEpoch: 0, mode: "pinned", revisionId: s.candidate.revisionId })).rejects.toEqual(expect.objectContaining({ code: "invalid_state" }))
    expect(await snapshot(s.first.pageId)).toEqual(before)
    expect(await pinned(s.candidate.revisionId)).toBe(0)
  })

  it("admits the same real candidate after commit and serves its stored bytes", async () => {
    const s = await setup()
    const target = { pageId: s.first.pageId, artifactId: s.candidate.artifactId, expectedPolicyEpoch: 0, mode: "pinned" as const, revisionId: s.candidate.revisionId }
    const before = await snapshot(s.first.pageId)
    await expect(share(s.deps, actor, target)).rejects.toMatchObject({ code: "invalid_state" })
    expect(await snapshot(s.first.pageId)).toEqual(before)
    expect(await pinned(s.candidate.revisionId)).toBe(0)
    await s.publication.commit(actor, s.candidate.sessionId)
    const grant = await share(s.deps, actor, target)
    const decision = await readKey(s.read, grant.key)
    expect(decision).toMatchObject({ kind: "allow", plan: { revisionId: s.candidate.revisionId } })
    if (decision.kind !== "allow") throw new Error("share key was not admitted")
    expect(await storedBytes(s.store, { artifactId: s.candidate.artifactId, revisionId: decision.plan.revisionId, kind: "resource", path })).toEqual(s.bytes)
  })

  it.each(["explicit", "legacy carry"] as const)("refuses %s candidate rotation without destroying the old key", async mode => {
    const s = await setup()
    const target = { pageId: s.first.pageId, artifactId: s.candidate.artifactId }
    const old = await share(s.deps, actor, { ...target, expectedPolicyEpoch: 0, mode: "follow_active" })
    if (mode === "legacy carry") {
      // Legacy/corruption policy fixture: preserve an already existing candidate pin; not a native publication.
      await env.DB.prepare("UPDATE share_grants SET mode = 'pinned', pinned_revision_id = ? WHERE grant_id = ?").bind(s.candidate.revisionId, old.grantId).run()
    }
    const before = await snapshot(s.first.pageId)
    const pinBefore = await pinned(s.candidate.revisionId)
    expect(pinBefore).toBe(mode === "explicit" ? 0 : 1)
    expect(await readKey(s.read, old.key)).toMatchObject({ kind: "allow" })
    await expect(rotateShare(s.deps, actor, { ...target, expectedPolicyEpoch: 1, grantId: old.grantId, ...(mode === "explicit" ? { next: { mode: "pinned" as const, revisionId: s.candidate.revisionId } } : {}) })).rejects.toMatchObject({ code: "invalid_state" })
    expect(await snapshot(s.first.pageId)).toEqual(before)
    expect(await pinned(s.candidate.revisionId)).toBe(pinBefore)
    expect(await readKey(s.read, old.key)).toMatchObject({ kind: "allow" })
  })

  it.each(["committed", "candidate"] as const)("rejects an invalid runtime pinned import of a %s revision before D1", async which => {
    const s = await setup()
    const revision = which === "committed" ? s.initial.session.revisionId : s.candidate.revisionId
    const before = await snapshot(s.first.pageId)
    const observed = observeD1(env.DB)
    await expect(importShare({ ...s.deps, db: observed.db }, actor, { pageId: s.first.pageId, artifactId: s.candidate.artifactId, expectedPolicyEpoch: 0, key: "validkey123456789", mode: "pinned", revisionId: revision } as never)).rejects.toEqual(expect.objectContaining({ code: "invalid_state" }))
    expect(observed.calls()).toBe(0)
    expect(await snapshot(s.first.pageId)).toEqual(before)
    expect(await pinned(revision)).toBe(0)
  })

  it.each(["active published", "inactive imported"] as const)("does not treat %s policy metadata as commit history", async kind => {
    await pageFixture()
    const revision = kind === "active published" ? revisionId : `rv_${"b".repeat(26)}`
    if (kind === "inactive imported") await env.DB.prepare("INSERT INTO revisions (revision_id,artifact_id,origin,manifest_sha256,manifest_object_key,sealed_at) VALUES (?,?,'imported',?,'imported',2)").bind(revision, artifactId, digest).run()
    const deps = { db: env.DB, config: (await configs()).manage, jwks, now: () => 10 }
    const before = await snapshot(pageId)
    await expect(share(deps, actor, { pageId, artifactId, expectedPolicyEpoch: 0, mode: "pinned", revisionId: revision })).rejects.toMatchObject({ code: "invalid_state" })
    expect(await snapshot(pageId)).toEqual(before)
    expect(await pinned(revision)).toBe(0)
  })

  it.each(["wrong instance", "wrong artifact", "exact"] as const)("matches the exact synthetic policy history triple: %s", async variant => {
    await pageFixture()
    // Wrong-instance/artifact rows are deliberately synthetic corruption, not native Publication output.
    await syntheticCommitHistory({ revision: revisionId, artifact: variant === "wrong artifact" ? `ar_${"b".repeat(26)}` : artifactId, instance: variant === "wrong instance" ? "other-instance" : instanceId, at: 1 })
    const deps = { db: env.DB, config: (await configs()).manage, jwks, now: () => 10 }
    const before = await snapshot(pageId)
    const operation = share(deps, actor, { pageId, artifactId, expectedPolicyEpoch: 0, mode: "pinned", revisionId })
    if (variant === "exact") {
      await expect(operation).resolves.toMatchObject({ mode: "pinned" })
      expect(await pinned(revisionId)).toBe(1)
    } else {
      await expect(operation).rejects.toMatchObject({ code: "invalid_state" })
      expect(await snapshot(pageId)).toEqual(before)
      expect(await pinned(revisionId)).toBe(0)
    }
  })

  it("preserves authority and stale-epoch precedence over candidate state", async () => {
    const s = await setup()
    const other = await documentCommand("other", "/a/other/index.html", "other")
    await publishDocument(s.publication, actor, other.command, other.bytes)
    const person = await authenticatedActor("other-publisher")
    await assignRole(s.deps, actor, { targetPrincipalId: person.principalId, expectedTargetAuthorityEpoch: 0, role: "publisher", scope: { kind: "page", pageId: other.pageId } })
    const scoped = await authenticatedActor("other-publisher")
    const target = { pageId: s.first.pageId, artifactId: s.candidate.artifactId, expectedPolicyEpoch: 0, mode: "pinned" as const, revisionId: s.candidate.revisionId }
    const before = await snapshot(s.first.pageId)
    await expect(share(s.deps, scoped, target)).rejects.toEqual(expect.objectContaining({ code: "forbidden" }))
    await expect(share(s.deps, actor, { ...target, expectedPolicyEpoch: 1 })).rejects.toEqual(expect.objectContaining({ code: "conflict" }))
    expect(await snapshot(s.first.pageId)).toEqual(before)
    expect(await pinned(s.candidate.revisionId)).toBe(0)
  })

  it.each(["follow_active", "pinned"] as const)("rotates a %s grant to a committed revision", async mode => {
    const s = await setup()
    const target = { pageId: s.first.pageId, artifactId: s.candidate.artifactId }
    const old = await share(s.deps, actor, { ...target, expectedPolicyEpoch: 0, ...(mode === "pinned" ? { mode, revisionId: s.initial.session.revisionId } : { mode }) })
    const next = await rotateShare(s.deps, actor, { ...target, expectedPolicyEpoch: 1, grantId: old.grantId, next: { mode: "pinned", revisionId: s.initial.session.revisionId } })
    expect(await readKey(s.read, old.key)).toMatchObject({ kind: "deny" })
    expect(await readKey(s.read, next.key)).toMatchObject({ kind: "allow", plan: { revisionId: s.initial.session.revisionId } })
  })
})
