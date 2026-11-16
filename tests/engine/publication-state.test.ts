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
async function sealedNewSibling(disposition: "keep" | "drop") {
  const { deps, publication } = await setup()
  const p = await documentCommand("sealed-existing", "/a/sealed-existing/index.html", "existing")
  const initial = await publishDocument(publication, actor, p.command, p.bytes)
  const principal = `pr_${"b".repeat(26)}`
  await env.DB.batch([
    env.DB.prepare("INSERT INTO principals (principal_id,issuer,subject,created_at) VALUES (?,'https://team.cloudflareaccess.com','sealed-scoped',1)").bind(principal),
    env.DB.prepare("INSERT INTO role_grants (role_grant_id,principal_id,role,scope_kind,scope_page_id,origin,granted_at,granted_by) VALUES (?,?,'publisher','page',?,'granted',1,?)").bind(`rg_${"b".repeat(26)}`, principal, p.pageId, actor.principalId),
  ])
  const scoped = await authenticatedActor("sealed-scoped")
  const q = await documentCommand("sealed-sibling", "/a/sealed-sibling/index.html", "new document")
  const asset = await content("new asset")
  const assetPath = "/a/sealed-sibling/data.js"
  const pPage = disposition === "keep"
    ? { ...p.command.pages[0], disposition: "keep" as const, expectedPolicyEpoch: 0 }
    : { pageId: p.pageId, disposition: "drop" as const, documentPath: null, metadata: null, expectedPolicyEpoch: 0 }
  const command: BeginCommand = {
    idempotencyKey: `sealed-${disposition}`, artifactId: initial.session.artifactId,
    expectedRevisionId: initial.session.revisionId, expectedContentVersion: initial.receipt.contentVersion,
    files: [
      ...(disposition === "keep" ? [{ ...p.command.files[0], source: "base" as const }] : []),
      q.command.files[0], { path: assetPath, kind: "asset", sha256: asset.sha256, size: asset.size, contentType: "application/javascript", source: "client" },
    ],
    pages: [pPage, { ...q.command.pages[0], metadata: { title: "New sibling" } }],
    edges: [{ ownerPageId: q.pageId, path: assetPath, providerArtifactId: null }],
  }
  const candidate = await publication.begin(actor, command)
  if (disposition === "keep") await publication.materialize(actor, candidate.sessionId, p.command.files[0].path)
  await publication.upload(actor, candidate.sessionId, q.command.files[0].path, body(q.bytes))
  await publication.upload(actor, candidate.sessionId, assetPath, body(asset.bytes))
  await publication.seal(actor, candidate.sessionId)
  return { deps, scoped, p, q, assetPath, candidate, initial }
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
  it.each(["keep", "drop"] as const)("omits a sealed %s plus new sibling from page-scoped revision inventory", async disposition => {
    const { deps, scoped, candidate, initial } = await sealedNewSibling(disposition)
    const inventory = await readRevisions(deps, scoped, { artifactId: candidate.artifactId })
    expect(inventory.revisions.map(revision => revision.revisionId)).toContain(initial.session.revisionId)
    expect(inventory.revisions.map(revision => revision.revisionId)).not.toContain(candidate.revisionId)
  })

  it.each(["keep", "drop"] as const)("denies page-scoped manifest access to a sealed %s plus new sibling", async disposition => {
    const { deps, scoped, candidate } = await sealedNewSibling(disposition)
    for (const section of ["files", "pages", "edges"] as const) {
      await expect(readManifest(deps, scoped, { artifactId: candidate.artifactId, revisionId: candidate.revisionId, section })).rejects.toMatchObject({ code: "forbidden" })
    }
  })

  it.each(["keep", "drop"] as const)("returns the complete sealed %s plus new sibling manifest to an installation publisher", async disposition => {
    const { deps, p, q, assetPath, candidate } = await sealedNewSibling(disposition)
    const target = { artifactId: candidate.artifactId, revisionId: candidate.revisionId }
    const pages = await readManifest(deps, actor, { ...target, section: "pages" })
    expect(pages.revision.previouslyActivated).toBe(false)
    expect(pages.items).toEqual(expect.arrayContaining([{ pageId: q.pageId, documentPath: q.command.pages[0].documentPath, metadata: { title: "New sibling" } }]))
    expect(pages.items).toHaveLength(disposition === "keep" ? 2 : 1)
    if (disposition === "keep") expect(pages.items).toEqual(expect.arrayContaining([{ pageId: p.pageId, documentPath: p.command.pages[0].documentPath, metadata: {} }]))
    else expect(pages.items).not.toEqual(expect.arrayContaining([expect.objectContaining({ pageId: p.pageId })]))
    const edges = await readManifest(deps, actor, { ...target, section: "edges" })
    expect(edges.items).toEqual([{ ownerPageId: q.pageId, path: assetPath, providerArtifactId: candidate.artifactId }])
    const files = await readManifest(deps, actor, { ...target, section: "files" })
    expect(files.items).toEqual(expect.arrayContaining([expect.objectContaining({ path: q.command.files[0].path }), expect.objectContaining({ path: assetPath })]))
  })

  it("reads complete metadata for a sealed new artefact without activating its page", async () => {
    const { deps, publication } = await setup()
    const q = await documentCommand("sealed-new", "/a/sealed-new/index.html", "new page")
    const asset = await content("new asset"), path = "/a/sealed-new/a.js"
    const command: BeginCommand = {
      ...q.command,
      files: [...q.command.files, { path, kind: "asset", sha256: asset.sha256, size: asset.size, contentType: "application/javascript", source: "client" }],
      pages: [{ ...q.command.pages[0], metadata: { title: "New artefact" } }],
      edges: [{ ownerPageId: q.pageId, path, providerArtifactId: null }],
    }
    const session = await publication.begin(actor, command)
    await publication.upload(actor, session.sessionId, command.files[0].path, body(q.bytes))
    await publication.upload(actor, session.sessionId, path, body(asset.bytes))
    await publication.seal(actor, session.sessionId)
    const target = { artifactId: session.artifactId, revisionId: session.revisionId }
    const state = await readArtifactState(deps, actor, target)
    expect(state).toMatchObject({ activeRevisionId: null, contentVersion: 0, pages: [] })
    const pages = await readManifest(deps, actor, { ...target, section: "pages" })
    expect(pages.revision.previouslyActivated).toBe(false)
    expect(pages.items).toEqual([{ pageId: q.pageId, documentPath: q.command.pages[0].documentPath, metadata: { title: "New artefact" } }])
    expect((await readManifest(deps, actor, { ...target, section: "edges" })).items).toEqual([{ ownerPageId: q.pageId, path, providerArtifactId: session.artifactId }])
  })

  it("returns only authorized tombstones after real unpublication without granting empty or unrelated scope", async () => {
    const { deps, publication } = await setup()
    const { a, b, session, receipt } = await multiPage(publication)
    const other = await documentCommand("unrelated", "/a/unrelated/index.html", "unrelated")
    await publishDocument(publication, actor, other.command, other.bytes)
    const p = `pr_${"b".repeat(26)}`, unrelated = `pr_${"c".repeat(26)}`, roleless = `pr_${"d".repeat(26)}`
    await env.DB.batch([
      env.DB.prepare("INSERT INTO principals (principal_id,issuer,subject,created_at) VALUES (?,'https://team.cloudflareaccess.com','tombstone-scoped',1)").bind(p),
      env.DB.prepare("INSERT INTO principals (principal_id,issuer,subject,created_at) VALUES (?,'https://team.cloudflareaccess.com','tombstone-unrelated',1)").bind(unrelated),
      env.DB.prepare("INSERT INTO principals (principal_id,issuer,subject,created_at) VALUES (?,'https://team.cloudflareaccess.com','tombstone-roleless',1)").bind(roleless),
      env.DB.prepare("INSERT INTO role_grants (role_grant_id,principal_id,role,scope_kind,scope_page_id,origin,granted_at,granted_by) VALUES (?,?,'publisher','page',?,'granted',1,?)").bind(`rg_${"b".repeat(26)}`, p, a.pageId, actor.principalId),
      env.DB.prepare("INSERT INTO role_grants (role_grant_id,principal_id,role,scope_kind,scope_page_id,origin,granted_at,granted_by) VALUES (?,?,'publisher','page',?,'granted',1,?)").bind(`rg_${"c".repeat(26)}`, unrelated, other.pageId, actor.principalId),
    ])
    const scoped = await authenticatedActor("tombstone-scoped")
    const outsider = await authenticatedActor("tombstone-unrelated")
    const noRole = await authenticatedActor("tombstone-roleless")
    const target = { artifactId: session.artifactId }
    await expect(readArtifactState(deps, scoped, target)).rejects.toMatchObject({ code: "forbidden" })
    const unpublished = await publication.unpublish(actor, { idempotencyKey: "unpublish-state", artifactId: session.artifactId, expectedContentVersion: receipt.contentVersion })
    const expected = (pageId: string) => ({ pageId, artifactId: session.artifactId, visibility: "private", policyEpoch: 1, tombstoned: true, route: null })
    const global = await readArtifactState(deps, actor, target)
    expect(global).toMatchObject({ activeRevisionId: null, contentVersion: unpublished.contentVersion })
    expect(global.pages).toEqual(expect.arrayContaining([expected(a.pageId), expected(b.pageId)]))
    expect(global.pages).toHaveLength(2)
    const visible = await readArtifactState(deps, scoped, target)
    expect(visible).toMatchObject({ activeRevisionId: null, contentVersion: unpublished.contentVersion })
    expect(visible.pages).toEqual([expected(a.pageId)])
    await expect(readArtifactState(deps, outsider, target)).rejects.toMatchObject({ code: "forbidden" })
    await expect(readArtifactState(deps, noRole, target)).rejects.toMatchObject({ code: "forbidden" })
    const empty = `ar_${"z".repeat(26)}`
    await env.DB.prepare("INSERT INTO artifacts (artifact_id,origin,created_at) VALUES (?,'published',1)").bind(empty).run()
    expect((await readArtifactState(deps, actor, { artifactId: empty })).pages).toEqual([])
    await expect(readArtifactState(deps, scoped, { artifactId: empty })).rejects.toMatchObject({ code: "forbidden" })
  })
})
