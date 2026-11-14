import { env } from "cloudflare:workers"
import { beforeEach, expect, it } from "vitest"
import { assignRole } from "../../domains/catalogue/commands"
import { newId } from "../../domains/catalogue/ids"
import type { ManageActor } from "../../domains/catalogue/principals"
import { decideRead } from "../../domains/catalogue/read"
import { PublicationService } from "../../domains/publication"
import type { BeginCommand, PublicationDeps, PublicationFile } from "../../domains/publication/types"
import { RevisionStore } from "../../domains/store/revision-store"
import { actor, authenticatedActor, bootstrap, configs, instanceId, jwks, teamIdentity } from "./fixtures/catalogue"
import { body, clock, content, documentCommand, observeD1, storedBytes } from "./fixtures/publication"

beforeEach(async () => { await bootstrap() })

it("publishes, reuses and restores more than one native R2 inventory page of real files", async () => {
  const time = clock(10_000), config = await configs()
  const store = new RevisionStore(env.REVISION_BYTES, instanceId)
  const deps: PublicationDeps = { db: env.DB, config: config.manage, jwks, now: time.now, store, publication: { sessionTtlMs: 3_600_000, maxUploadTimeoutMs: 30_000, retainMs: 900_000, marginMs: 30_000, manageClockSkewMs: 0, readClockSkewMs: 0 } }
  const publication = new PublicationService(deps)
  const path = "/a/many/index.html"
  const document = await documentCommand("many-original", path, "many document")
  const asset = await content("shared test bytes")
  const assets: PublicationFile[] = Array.from({ length: 1004 }, (_, index) => ({ path: `/a/many/asset-${String(index).padStart(4, "0")}.js`, kind: "asset", sha256: asset.sha256, size: asset.size, contentType: "application/javascript", source: "client" }))
  const command: BeginCommand = { ...document.command, files: [...document.command.files, ...assets], edges: assets.map(file => ({ ownerPageId: document.pageId, path: file.path, providerArtifactId: null })) }
  const initial = await publication.begin(actor, command)
  await publication.upload(actor, initial.sessionId, path, body(document.bytes))
  for (const file of assets) await publication.upload(actor, initial.sessionId, file.path, body(asset.bytes))
  await publication.seal(actor, initial.sessionId)
  const first = await publication.commit(actor, initial.sessionId)
  expect(first).toMatchObject({ revisionId: initial.revisionId, contentVersion: 1 })
  const ref = { artifactId: initial.artifactId, revisionId: initial.revisionId }
  const firstPage = await store.listRevision(ref, null)
  expect(firstPage.cursor).not.toBeNull()
  if (!firstPage.cursor) throw new Error("native R2 inventory did not paginate")
  expect((await store.listRevision(ref, firstPage.cursor)).objects.length).toBeGreaterThan(0)

  const update: BeginCommand = { ...command, idempotencyKey: "many-base-reuse", artifactId: initial.artifactId, expectedRevisionId: initial.revisionId, expectedContentVersion: first.contentVersion, files: command.files.map(file => ({ ...file, source: "base" })), pages: [{ ...command.pages[0], disposition: "keep", expectedPolicyEpoch: 0 }] }
  // D1 documents 50 queries per Free-plan invocation; batch counts as one.
  // This proxy forwards every operation to the actual local D1 binding.
  const observed = observeD1(env.DB)
  const staged = await new PublicationService({ ...deps, db: observed.db }).begin(actor, update)
  expect(observed.calls()).toBeLessThanOrEqual(50)
  for (const file of update.files) expect(await publication.materialize(actor, staged.sessionId, file.path)).toMatchObject({ path: file.path, stored: true, state: "open" })
  expect((await publication.status(actor, staged.sessionId)).files.every(file => file.stored)).toBe(true)
  await publication.seal(actor, staged.sessionId)
  const second = await publication.commit(actor, staged.sessionId)
  expect(second).toMatchObject({ revisionId: staged.revisionId, contentVersion: 2 })
  for (const file of update.files) {
    const expected = file.path === path ? document.bytes : asset.bytes
    expect(await storedBytes(store, { artifactId: staged.artifactId, revisionId: staged.revisionId, kind: "resource", path: file.path })).toEqual(expected)
  }
  const restored = await publication.restore(actor, { idempotencyKey: "many-restore", artifactId: initial.artifactId, revisionId: initial.revisionId, expectedContentVersion: second.contentVersion })
  expect(restored).toMatchObject({ revisionId: initial.revisionId, contentVersion: 3 })
  expect(await decideRead(env.DB, config.read, { kind: "page", route: { kind: "subtree", slug: "many" }, candidates: [path], fragmentPath: null }, { team: teamIdentity, shareKey: null, shareCookie: null, pinnedProof: null, nowSeconds: 1 }, null)).toMatchObject({ kind: "allow", plan: { revisionId: initial.revisionId } })
  for (const file of command.files) {
    const expected = file.path === path ? document.bytes : asset.bytes
    expect(await storedBytes(store, { ...ref, kind: "resource", path: file.path })).toEqual(expected)
  }
}, 900_000)

it("bounds real transfer audit growth equally for one and 32 scoped pages", async () => {
  const time = clock(10_000), config = await configs()
  const store = new RevisionStore(env.REVISION_BYTES, instanceId)
  const deps: PublicationDeps = { db: env.DB, config: config.manage, jwks, now: time.now, store, publication: { sessionTtlMs: 3_600_000, maxUploadTimeoutMs: 30_000, retainMs: 900_000, marginMs: 30_000, manageClockSkewMs: 0, readClockSkewMs: 0 } }
  const publication = new PublicationService(deps)
  const data = await content("audit witness bytes")
  const deltas: number[] = []
  const staged: { pageCount: number; actor: ManageActor; artifactId: string; revisionId: string; sessionId: string; files: readonly PublicationFile[]; pageId: string }[] = []

  for (const pageCount of [1, 32]) {
    const prefix = `/audit-${pageCount}`
    const pageIds = Array.from({ length: pageCount }, () => newId("pg"))
    const files: PublicationFile[] = Array.from({ length: 64 }, (_, index) => {
      const document = index < pageCount
      return { path: document ? `${prefix}/page-${index}.html` : `${prefix}/asset-${index}.js`, kind: document ? "document" : "asset", sha256: data.sha256, size: data.size, contentType: document ? "text/html" : "application/javascript", source: "client" }
    })
    const command: BeginCommand = {
      idempotencyKey: `audit-original-${pageCount}`,
      artifactId: null, expectedRevisionId: null, expectedContentVersion: 0,
      files,
      pages: pageIds.map((pageId, index) => ({ pageId, disposition: "new", documentPath: files[index].path, metadata: {}, expectedPolicyEpoch: null })),
      edges: files.filter(file => file.kind === "asset").map(file => ({ ownerPageId: pageIds[0], path: file.path, providerArtifactId: null })),
    }
    const initial = await publication.begin(actor, command)
    for (const file of files) await publication.upload(actor, initial.sessionId, file.path, body(data.bytes))
    await publication.seal(actor, initial.sessionId)
    const first = await publication.commit(actor, initial.sessionId)
    expect(first).toMatchObject({ revisionId: initial.revisionId, contentVersion: 1 })

    const subject = `audit-scoped-${pageCount}`
    const person = await authenticatedActor(subject)
    for (let index = 0; index < pageIds.length; index++) {
      await assignRole(deps, actor, { targetPrincipalId: person.principalId, expectedTargetAuthorityEpoch: index, role: "publisher", scope: { kind: "page", pageId: pageIds[index] } })
    }
    const publisher = await authenticatedActor(subject)
    const update: BeginCommand = { ...command, idempotencyKey: `audit-update-${pageCount}`, artifactId: initial.artifactId, expectedRevisionId: initial.revisionId, expectedContentVersion: first.contentVersion, files: files.map((file, index) => ({ ...file, source: index % 2 === 0 ? "base" : "client" })), pages: command.pages.map(page => ({ ...page, disposition: "keep", expectedPolicyEpoch: 0 })) }
    const session = await publication.begin(publisher, update)
    const before = await env.DB.prepare("SELECT count(*) AS n FROM mutation_events").first<{ n: number }>()
    if (!before) throw new Error("audit count unavailable before transfers")
    for (const file of update.files) {
      const result = file.source === "base"
        ? await publication.materialize(publisher, session.sessionId, file.path)
        : await publication.upload(publisher, session.sessionId, file.path, body(data.bytes))
      expect(result).toMatchObject({ sessionId: session.sessionId, path: file.path, stored: true, state: "open" })
    }
    const after = await env.DB.prepare("SELECT count(*) AS n FROM mutation_events").first<{ n: number }>()
    if (!after) throw new Error("audit count unavailable after transfers")
    deltas.push(after.n - before.n)
    staged.push({ pageCount, actor: publisher, artifactId: session.artifactId, revisionId: session.revisionId, sessionId: session.sessionId, files: update.files, pageId: pageIds[0] })
  }

  expect(deltas).toEqual([128, 128])
  expect(await env.DB.prepare("SELECT count(*) AS n FROM publication_assertions").first()).toEqual({ n: 0 })
  for (const run of staged) {
    expect((await publication.status(run.actor, run.sessionId)).files.every(file => file.stored)).toBe(true)
    await publication.seal(run.actor, run.sessionId)
    const receipt = await publication.commit(run.actor, run.sessionId)
    expect(receipt).toMatchObject({ artifactId: run.artifactId, revisionId: run.revisionId, contentVersion: 2 })
    expect(receipt.pages).toHaveLength(run.pageCount)
    expect(receipt.pages).toEqual(expect.arrayContaining([expect.objectContaining({ pageId: run.pageId })]))
    for (const file of run.files) expect(await storedBytes(store, { artifactId: run.artifactId, revisionId: run.revisionId, kind: "resource", path: file.path })).toEqual(data.bytes)
    const pagePath = run.files[0].path
    expect(await decideRead(env.DB, config.read, { kind: "page", route: { kind: "tree_page", pageRef: pagePath.slice(1) }, candidates: [pagePath], fragmentPath: null }, { team: teamIdentity, shareKey: null, shareCookie: null, pinnedProof: null, nowSeconds: 1 }, null)).toMatchObject({ kind: "allow", plan: { revisionId: run.revisionId } })
  }
  expect(await env.DB.prepare("SELECT count(*) AS n FROM publication_assertions").first()).toEqual({ n: 0 })
}, 300_000)
