import { env } from "cloudflare:workers"
import { beforeEach, describe, expect, it } from "vitest"
import { PublicationService } from "../../domains/publication"
import { collectRevision } from "../../domains/publication/collection"
import { readArtifactState, readManifest, readRevisions } from "../../domains/publication/state"
import type { BeginCommand, PublicationDeps } from "../../domains/publication/types"
import { RevisionStore } from "../../domains/store/revision-store"
import { actor, authenticatedActor, bootstrap, configs, instanceId, jwks } from "./fixtures/catalogue"
import { body, clock, content, documentCommand, publishDocument } from "./fixtures/publication"

beforeEach(async () => { await bootstrap() })

async function setup() {
  const time = clock(10_000), store = new RevisionStore(env.REVISION_BYTES, instanceId)
  const options = { sessionTtlMs: 60_000, maxUploadTimeoutMs: 1000, retainMs: 900_000, marginMs: 1000, manageClockSkewMs: 0, readClockSkewMs: 0 }
  const deps: PublicationDeps = { db: env.DB, config: (await configs()).manage, jwks, now: time.now, store, publication: options }
  return { deps, time, store, options, publication: new PublicationService(deps) }
}

async function multiPage(publication: PublicationService) {
  const a = await documentCommand("state-a", "/a/state-a/index.html", "first")
  const b = await documentCommand("state-b", "/a/state-b/index.html", "second")
  const asset = await content("asset")
  const paths = ["/a/state-a/a.js", "/a/state-a/b.js"]
  const command: BeginCommand = {
    ...a.command,
    files: [...a.command.files, ...b.command.files, ...paths.map(path => ({ path, kind: "asset" as const, sha256: asset.sha256, size: asset.size, contentType: "application/javascript", source: "client" as const }))],
    pages: [...a.command.pages, ...b.command.pages],
    edges: paths.map(path => ({ ownerPageId: a.pageId, path, providerArtifactId: null })),
  }
  const session = await publication.begin(actor, command)
  await publication.upload(actor, session.sessionId, a.command.files[0].path, body(a.bytes))
  await publication.upload(actor, session.sessionId, b.command.files[0].path, body(b.bytes))
  for (const path of paths) await publication.upload(actor, session.sessionId, path, body(asset.bytes))
  await publication.seal(actor, session.sessionId)
  const receipt = await publication.commit(actor, session.sessionId)
  return { a, b, asset, paths, command, session, receipt }
}

describe("publication state", () => {
  it("reconstructs every file, page and ownership edge through keyset pages on a fresh client", async () => {
    const { deps, publication } = await setup()
    const { a, b, asset, paths, session, receipt } = await multiPage(publication)
    const target = { artifactId: session.artifactId }
    expect(await readArtifactState(deps, actor, target)).toMatchObject({ ...target, activeRevisionId: session.revisionId, contentVersion: receipt.contentVersion, pages: expect.arrayContaining([expect.objectContaining({ pageId: a.pageId }), expect.objectContaining({ pageId: b.pageId })]) })
    for (const section of ["files", "pages", "edges"] as const) {
      let cursor: string | null = null
      const items: unknown[] = []
      do {
        const page = await readManifest(deps, actor, { ...target, section, limit: 1, cursor })
        expect(page).toMatchObject({ activeRevisionId: session.revisionId, revision: { revisionId: session.revisionId, previouslyActivated: true, retention: "retained" } })
        items.push(...page.items)
        cursor = page.nextCursor
      } while (cursor !== null)
      if (section === "files") expect(items).toEqual([
        ...paths.map(path => ({ path, kind: "asset", sha256: asset.sha256, size: asset.size, contentType: "application/javascript" })),
        { path: a.command.files[0].path, kind: "document", sha256: a.command.files[0].sha256, size: a.bytes.length, contentType: "text/html" },
        { path: b.command.files[0].path, kind: "document", sha256: b.command.files[0].sha256, size: b.bytes.length, contentType: "text/html" },
      ])
      if (section === "pages") expect(items).toEqual([
        { pageId: a.pageId, documentPath: a.command.files[0].path, metadata: {} },
        { pageId: b.pageId, documentPath: b.command.files[0].path, metadata: {} },
      ].sort((x, y) => x.pageId.localeCompare(y.pageId)))
      if (section === "edges") expect(items).toEqual(paths.map(path => ({ ownerPageId: a.pageId, path, providerArtifactId: session.artifactId })))
    }
  })

  it("rechecks policy and actor authority on each page and rejects cursor reuse after drift", async () => {
    const { deps, publication } = await setup()
    const { a, session } = await multiPage(publication)
    const target = { artifactId: session.artifactId }
    const first = await readManifest(deps, actor, { ...target, section: "files", limit: 1 })
    expect(first.nextCursor).not.toBeNull()
    await expect(readManifest(deps, actor, { ...target, section: "pages", cursor: first.nextCursor })).rejects.toMatchObject({ code: "conflict" })
    await env.DB.prepare("UPDATE pages SET visibility='public', policy_epoch=policy_epoch+1 WHERE page_id=?").bind(a.pageId).run()
    await expect(readManifest(deps, actor, { ...target, section: "files", cursor: first.nextCursor })).rejects.toMatchObject({ code: "conflict" })
    const fresh = await readManifest(deps, actor, { ...target, section: "files", limit: 1 })
    await env.DB.prepare("UPDATE principals SET authority_epoch=authority_epoch+1 WHERE principal_id=?").bind(actor.principalId).run()
    await expect(readManifest(deps, actor, { ...target, section: "files", cursor: fresh.nextCursor })).rejects.toMatchObject({ code: "conflict" })
    await env.DB.prepare("UPDATE principals SET status='disabled', disabled_at=2 WHERE principal_id=?").bind(actor.principalId).run()
    await expect(readArtifactState(deps, actor, target)).rejects.toMatchObject({ code: "unauthenticated" })
  })

  it("requires authority over every live page and rechecks a revoked grant", async () => {
    const { deps, publication } = await setup()
    const { a, b, session } = await multiPage(publication)
    const principal = `pr_${"b".repeat(26)}`, grantA = `rg_${"b".repeat(26)}`, grantB = `rg_${"c".repeat(26)}`
    await env.DB.batch([
      env.DB.prepare("INSERT INTO principals (principal_id,issuer,subject,created_at) VALUES (?,'https://team.cloudflareaccess.com','state-publisher',1)").bind(principal),
      env.DB.prepare("INSERT INTO role_grants (role_grant_id,principal_id,role,scope_kind,scope_page_id,origin,granted_at,granted_by) VALUES (?,?,'publisher','page',?,'granted',1,?)").bind(grantA, principal, a.pageId, actor.principalId),
    ])
    const scoped = await authenticatedActor("state-publisher"), target = { artifactId: session.artifactId }
    await expect(readManifest(deps, scoped, { ...target, section: "files" })).rejects.toMatchObject({ code: "forbidden" })
    await env.DB.prepare("INSERT INTO role_grants (role_grant_id,principal_id,role,scope_kind,scope_page_id,origin,granted_at,granted_by) VALUES (?,?,'publisher','page',?,'granted',1,?)").bind(grantB, principal, b.pageId, actor.principalId).run()
    const first = await readManifest(deps, scoped, { ...target, section: "files", limit: 1 })
    expect(first.nextCursor).not.toBeNull()
    await env.DB.prepare("UPDATE role_grants SET revoked_at=3, revoked_by=? WHERE role_grant_id=?").bind(actor.principalId, grantB).run()
    await expect(readManifest(deps, scoped, { ...target, section: "files", cursor: first.nextCursor })).rejects.toMatchObject({ code: "forbidden" })
    await expect(readRevisions(deps, scoped, target)).rejects.toMatchObject({ code: "forbidden" })
  })

  it("distinguishes native commit from sealed-only revision and invalidates cursors on activation", async () => {
    const { deps, publication } = await setup()
    const input = await documentCommand("state-initial", "/a/state-history/index.html", "original")
    const initial = await publishDocument(publication, actor, input.command, input.bytes)
    const next = await content("next")
    const command: BeginCommand = { ...input.command, idempotencyKey: "state-next", artifactId: initial.session.artifactId, expectedRevisionId: initial.session.revisionId, expectedContentVersion: initial.receipt.contentVersion, files: [{ ...input.command.files[0], sha256: next.sha256, size: next.size }], pages: [{ ...input.command.pages[0], disposition: "keep", expectedPolicyEpoch: 0 }] }
    const staged = await publication.begin(actor, command)
    await publication.upload(actor, staged.sessionId, command.files[0].path, body(next.bytes))
    await publication.seal(actor, staged.sessionId)
    const target = { artifactId: staged.artifactId }
    expect((await readManifest(deps, actor, { ...target, revisionId: staged.revisionId, section: "files" })).revision).toMatchObject({ previouslyActivated: false, retention: "retained" })
    expect((await readManifest(deps, actor, { ...target, revisionId: initial.session.revisionId, section: "files" })).revision).toMatchObject({ previouslyActivated: true, retention: "retained" })
    const first = await readRevisions(deps, actor, { ...target, limit: 1 })
    expect(first.nextCursor).not.toBeNull()
    const second = await readRevisions(deps, actor, { ...target, limit: 1, cursor: first.nextCursor })
    expect([...first.revisions, ...second.revisions]).toEqual(expect.arrayContaining([expect.objectContaining({ revisionId: staged.revisionId, previouslyActivated: false }), expect.objectContaining({ revisionId: initial.session.revisionId, previouslyActivated: true })]))
    await publication.commit(actor, staged.sessionId)
    await expect(readRevisions(deps, actor, { ...target, cursor: first.nextCursor })).rejects.toMatchObject({ code: "conflict" })
    expect((await readManifest(deps, actor, { ...target, section: "files" })).revision).toMatchObject({ revisionId: staged.revisionId, previouslyActivated: true })
  })

  it("reports purged history but refuses its manifest and invalidates inventory cursors", async () => {
    const { deps, publication, time, store, options } = await setup()
    const input = await documentCommand("state-purge", "/a/state-purge/index.html", "original")
    const first = await publishDocument(publication, actor, input.command, input.bytes)
    const next = await content("new")
    const update: BeginCommand = { ...input.command, idempotencyKey: "state-purge-next", artifactId: first.session.artifactId, expectedRevisionId: first.session.revisionId, expectedContentVersion: first.receipt.contentVersion, files: [{ ...input.command.files[0], sha256: next.sha256, size: next.size }], pages: [{ ...input.command.pages[0], disposition: "keep", expectedPolicyEpoch: 0 }] }
    await publishDocument(publication, actor, update, next.bytes)
    const target = { artifactId: first.session.artifactId }
    const inventory = await readRevisions(deps, actor, { ...target, limit: 1 })
    expect(inventory.nextCursor).not.toBeNull()
    time.advance(900_001)
    expect(await collectRevision({ db: env.DB, store, now: time.now, ...options }, { ...target, revisionId: first.session.revisionId })).toBe("purged")
    await expect(readRevisions(deps, actor, { ...target, cursor: inventory.nextCursor })).rejects.toMatchObject({ code: "conflict" })
    const after = await readRevisions(deps, actor, target)
    expect(after.revisions).toEqual(expect.arrayContaining([expect.objectContaining({ revisionId: first.session.revisionId, previouslyActivated: true, retention: "purged", discardedAt: expect.any(Number), purgedAt: expect.any(Number) })]))
    await expect(readManifest(deps, actor, { ...target, revisionId: first.session.revisionId, section: "files" })).rejects.toMatchObject({ code: "not_found" })
  })

  it("does not grant an empty artefact by vacuous page scope", async () => {
    const { deps } = await setup()
    const empty = `ar_${"c".repeat(26)}`, principal = `pr_${"b".repeat(26)}`
    await env.DB.batch([
      env.DB.prepare("INSERT INTO artifacts (artifact_id,origin,created_at) VALUES (?,'published',1)").bind(empty),
      env.DB.prepare("INSERT INTO principals (principal_id,issuer,subject,created_at) VALUES (?,'https://team.cloudflareaccess.com','scoped-state',1)").bind(principal),
    ])
    const scoped = await authenticatedActor("scoped-state")
    expect(await readArtifactState(deps, actor, { artifactId: empty })).toMatchObject({ activeRevisionId: null, pages: [] })
    expect((await readRevisions(deps, actor, { artifactId: empty })).revisions).toEqual([])
    await expect(readArtifactState(deps, scoped, { artifactId: empty })).rejects.toMatchObject({ code: "forbidden" })
    await expect(readRevisions(deps, scoped, { artifactId: empty })).rejects.toMatchObject({ code: "forbidden" })
  })
})
