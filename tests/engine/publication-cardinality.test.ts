import { env } from "cloudflare:workers"
import { beforeEach, expect, it } from "vitest"
import { assignRole, disablePrincipal, revokeRole, setVisibility } from "../../domains/catalogue/commands"
import { executeGuarded, PolicyError } from "../../domains/catalogue/guard"
import { newId } from "../../domains/catalogue/ids"
import type { ManageActor } from "../../domains/catalogue/principals"
import { decideRead } from "../../domains/catalogue/read"
import { PublicationService } from "../../domains/publication"
import { collectRevision } from "../../domains/publication/collection"
import type { BeginCommand, PublicationDeps, PublicationFile } from "../../domains/publication/types"
import { RevisionStore } from "../../domains/store/revision-store"
import { actor, authenticatedActor, bootstrap, configs, digest, instanceId, jwks, pageFixture, teamIdentity } from "./fixtures/catalogue"
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
  const writeWitness: number[][][] = []
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
    const observed = observeD1(env.DB)
    const batches: D1Result[][] = []
    const measured = new Proxy(observed.db, {
      get(target, property) {
        if (property === "batch") return async (statements: D1PreparedStatement[]) => {
          const result = await target.batch(statements)
          batches.push(result)
          return result
        }
        return Reflect.get(target, property, target)
      },
    })
    const measuredPublication = new PublicationService({ ...deps, db: measured })
    const perFile: number[][] = []
    const session = await publication.begin(publisher, update)
    const before = await env.DB.prepare("SELECT count(*) AS n FROM mutation_events").first<{ n: number }>()
    if (!before) throw new Error("audit count unavailable before transfers")
    for (const file of update.files) {
      batches.length = 0
      const result = file.source === "base"
        ? await measuredPublication.materialize(publisher, session.sessionId, file.path)
        : await measuredPublication.upload(publisher, session.sessionId, file.path, body(data.bytes))
      expect(result).toMatchObject({ sessionId: session.sessionId, path: file.path, stored: true, state: "open" })
      const writeBatches = batches.map(batch => {
        for (const row of batch) {
          expect(typeof row.meta.rows_written).toBe("number")
          expect(typeof row.meta.size_after).toBe("number")
        }
        return batch.reduce((sum, row) => sum + row.meta.rows_written, 0)
      }).filter(writes => writes > 0)
      expect(writeBatches).toHaveLength(2)
      perFile.push(writeBatches)
    }
    writeWitness.push(perFile)
    const after = await env.DB.prepare("SELECT count(*) AS n FROM mutation_events").first<{ n: number }>()
    if (!after) throw new Error("audit count unavailable after transfers")
    deltas.push(after.n - before.n)
    staged.push({ pageCount, actor: publisher, artifactId: session.artifactId, revisionId: session.revisionId, sessionId: session.sessionId, files: update.files, pageId: pageIds[0] })
  }

  expect(deltas).toEqual([128, 128])
  expect(writeWitness[1]).toEqual(writeWitness[0])
  expect(await env.DB.prepare("SELECT count(*) AS n FROM publication_assertions").first()).toEqual({ n: 0 })
  for (const run of staged) {
    expect((await publication.status(run.actor, run.sessionId)).files.every(file => file.stored)).toBe(true)
    const countAudit = async () => (await env.DB.prepare("SELECT count(*) AS n FROM mutation_events").first<{ n: number }>())!.n
    const beforeSeal = await countAudit()
    await publication.seal(run.actor, run.sessionId)
    expect((await countAudit()) - beforeSeal).toBe(2 * run.pageCount)
    expect(await env.DB.prepare("SELECT count(*) AS n FROM publication_assertions").first()).toEqual({ n: 0 })
    const beforeCommit = await countAudit()
    const receipt = await publication.commit(run.actor, run.sessionId)
    expect((await countAudit()) - beforeCommit).toBe(run.pageCount)
    expect(await env.DB.prepare("SELECT count(*) AS n FROM publication_assertions").first()).toEqual({ n: 0 })
    expect(receipt).toMatchObject({ artifactId: run.artifactId, revisionId: run.revisionId, contentVersion: 2 })
    expect(receipt.pages).toHaveLength(run.pageCount)
    expect(receipt.pages).toEqual(expect.arrayContaining([expect.objectContaining({ pageId: run.pageId })]))
    for (const file of run.files) expect(await storedBytes(store, { artifactId: run.artifactId, revisionId: run.revisionId, kind: "resource", path: file.path })).toEqual(data.bytes)
    const pagePath = run.files[0].path
    expect(await decideRead(env.DB, config.read, { kind: "page", route: { kind: "tree_page", pageRef: pagePath.slice(1) }, candidates: [pagePath], fragmentPath: null }, { team: teamIdentity, shareKey: null, shareCookie: null, pinnedProof: null, nowSeconds: 1 }, null)).toMatchObject({ kind: "allow", plan: { revisionId: run.revisionId } })
  }
  expect(await env.DB.prepare("SELECT count(*) AS n FROM publication_assertions").first()).toEqual({ n: 0 })
}, 300_000)

it.each(["revoke", "disable", "assign", "retire", "visibility", "collect"] as const)(
  "keeps the unselected page's %s race safe before and after Store",
  async change => {
    for (const phase of ["before", "after"] as const) {
      const time = clock(10_000), config = await configs()
      const store = new RevisionStore(env.REVISION_BYTES, instanceId)
      const deps: PublicationDeps = { db: env.DB, config: config.manage, jwks, now: time.now, store, publication: { sessionTtlMs: 3_600_000, maxUploadTimeoutMs: 30_000, retainMs: 900_000, marginMs: 30_000, manageClockSkewMs: 0, readClockSkewMs: 0 } }
      const publication = new PublicationService(deps)
      const data = await content("scoped race document")
      const ids = [newId("pg"), newId("pg")].sort()
      const files: PublicationFile[] = ids.map((_, i) => ({ path: `/race-${change}-${phase}/page-${i}.html`, kind: "document", sha256: data.sha256, size: data.size, contentType: "text/html", source: "client" }))
      const command: BeginCommand = {
        idempotencyKey: `initial-${change}-${phase}`, artifactId: null, expectedRevisionId: null, expectedContentVersion: 0, files, edges: [],
        pages: ids.map((pageId, i) => ({ pageId, disposition: "new", documentPath: files[i].path, metadata: { i }, expectedPolicyEpoch: null })),
      }
      const initial = await publication.begin(actor, command)
      for (const file of files) await publication.upload(actor, initial.sessionId, file.path, body(data.bytes))
      await publication.seal(actor, initial.sessionId)
      await publication.commit(actor, initial.sessionId)
      const subject = `scoped-${change}-${phase}`
      const person = await authenticatedActor(subject)
      await assignRole(deps, actor, { targetPrincipalId: person.principalId, expectedTargetAuthorityEpoch: 0, role: "publisher", scope: { kind: "page", pageId: ids[0] } })
      const grant = await assignRole(deps, actor, { targetPrincipalId: person.principalId, expectedTargetAuthorityEpoch: 1, role: "publisher", scope: { kind: "page", pageId: ids[1] } })
      const scoped = await authenticatedActor(subject)
      const update: BeginCommand = {
        ...command, idempotencyKey: `update-${change}-${phase}`, artifactId: initial.artifactId, expectedRevisionId: initial.revisionId, expectedContentVersion: 1,
        pages: command.pages.map(page => ({ ...page, disposition: "keep", expectedPolicyEpoch: 0 })),
      }
      const session = await publication.begin(scoped, update)
      let rivalSession: string | null = null
      if (change === "retire") {
        const rival = await publication.begin(actor, {
          ...update, idempotencyKey: `rival-${phase}`, files: [{ ...files[0], source: "base" }],
          pages: [{ ...update.pages[0] }, { ...update.pages[1], disposition: "drop", documentPath: null, metadata: null }],
        })
        await publication.materialize(actor, rival.sessionId, files[0].path)
        await publication.seal(actor, rival.sessionId)
        rivalSession = rival.sessionId
      }
      let release!: () => void, arrive!: () => void
      const reached = new Promise<void>(resolve => { arrive = resolve })
      const gate = new Promise<void>(resolve => { release = resolve })
      let batchCount = 0
      const observed = observeD1(env.DB)
      const gatedDb = new Proxy(observed.db, {
        get(target, property) {
          if (property === "batch") return async (statements: D1PreparedStatement[]) => {
            const result = await target.batch(statements)
            if (phase === "before" && ++batchCount === 2) {
              expect(result).toHaveLength(3)
              arrive()
              await gate
            }
            return result
          }
          return Reflect.get(target, property, target)
        },
      })
      const gatedStore = new Proxy(store, {
        get(target, property) {
          if (property === "put") return async (...args: Parameters<RevisionStore["put"]>) => {
            const result = await target.put(...args)
            if (phase === "after") { arrive(); await gate }
            return result
          }
          const value = Reflect.get(target, property, target)
          return typeof value === "function" ? value.bind(target) : value
        },
      })
      const running = new PublicationService({ ...deps, db: gatedDb, store: gatedStore }).upload(scoped, session.sessionId, files[0].path, body(data.bytes))
        .then(value => ({ value, error: null }), error => ({ value: null, error }))
      try {
        await Promise.race([reached, running.then(() => { throw new Error("transfer finished before the race barrier") })])
        if (change === "revoke") await revokeRole(deps, actor, { targetPrincipalId: scoped.principalId, expectedTargetAuthorityEpoch: 2, roleGrantId: grant.roleGrantId })
        if (change === "disable") await disablePrincipal(deps, actor, { targetPrincipalId: scoped.principalId, expectedTargetAuthorityEpoch: 2 })
        if (change === "assign") await assignRole(deps, actor, { targetPrincipalId: scoped.principalId, expectedTargetAuthorityEpoch: 2, role: "publisher", scope: { kind: "installation" } })
        if (change === "visibility") await setVisibility(deps, actor, { pageId: ids[1], artifactId: initial.artifactId, expectedPolicyEpoch: 0, visibility: "public" })
        if (change === "retire") {
          if (!rivalSession) throw new Error("missing sealed rival")
          await publication.commit(actor, rivalSession)
        }
        if (change === "collect") {
          await expect(collectRevision({ db: env.DB, store, now: time.now, ...deps.publication }, { artifactId: initial.artifactId, revisionId: initial.revisionId })).rejects.toThrow(/discard_revision_active/)
          expect(await env.DB.prepare("SELECT revision_id FROM revision_discards WHERE revision_id = ?").bind(initial.revisionId).first()).toBeNull()
        }
        const epoch = await env.DB.prepare("SELECT authority_epoch, status FROM principals WHERE principal_id = ?").bind(scoped.principalId).first()
        expect(epoch).toEqual({ authority_epoch: change === "revoke" || change === "disable" || change === "assign" ? 3 : 2, status: change === "disable" ? "disabled" : "active" })
        const snapshot = async () => ({
          artifact: await env.DB.prepare("SELECT active_revision_id,content_version FROM artifacts WHERE artifact_id = ?").bind(initial.artifactId).first(),
          pages: (await env.DB.prepare("SELECT page_id,visibility,policy_epoch,tombstoned_at FROM pages WHERE artifact_id = ? ORDER BY page_id").bind(initial.artifactId).all()).results,
          routes: (await env.DB.prepare("SELECT kind,route_key,page_id FROM routes WHERE artifact_id = ? ORDER BY route_key").bind(initial.artifactId).all()).results,
          mounts: (await env.DB.prepare("SELECT path,revision_id FROM mounts WHERE artifact_id = ? ORDER BY path").bind(initial.artifactId).all()).results,
        })
        const before = await snapshot()
        expect(before.artifact).toMatchObject({ content_version: change === "retire" ? 2 : 1 })
        const count = await env.DB.prepare("SELECT count(*) AS n FROM mutation_events").first<{ n: number }>()
        release()
        const outcome = await running
        if (change === "visibility" || change === "collect") expect(outcome.value).toMatchObject({ stored: true, path: files[0].path })
        else {
          expect(outcome.error).toBeInstanceOf(PolicyError)
          expect(outcome.error).toMatchObject({ code: change === "disable" ? "unauthenticated" : "conflict" })
        }
        expect(await snapshot()).toEqual(before)
        const file = await env.DB.prepare("SELECT stored_at,object_key,object_version FROM publication_files WHERE session_id = ? AND path = ?").bind(session.sessionId, files[0].path).first<{ stored_at: number | null; object_key: string | null; object_version: string | null }>()
        if (change === "visibility" || change === "collect") expect(file?.stored_at).not.toBeNull()
        else expect(file).toEqual({ stored_at: null, object_key: null, object_version: null })
        expect(await env.DB.prepare("SELECT count(*) AS n FROM publication_assertions").first()).toEqual({ n: 0 })
        const after = await env.DB.prepare("SELECT count(*) AS n FROM mutation_events").first<{ n: number }>()
        expect(after!.n - count!.n).toBe(change === "visibility" || change === "collect" ? (phase === "before" ? 2 : 1) : 0)
        // A completed private R2 put may remain orphaned after a post-Store refusal.
        const bytes = await storedBytes(store, { artifactId: session.artifactId, revisionId: session.revisionId, kind: "resource", path: files[0].path })
        expect(bytes).toEqual(phase === "after" || change === "visibility" || change === "collect" ? data.bytes : null)
      } finally {
        release()
        await running
      }
    }
  }, 300_000)

it("keeps real namespace claim reads linear as revision inventory grows", async () => {
  const config = await configs()
  const foreignRoutes = 64
  // Performance-only metadata world: pageFixture creates complete, FK-valid
  // catalogue rows. This is not a byte-integrity or authorization proof.
  for (let i = 0; i < foreignRoutes; i++) {
    await pageFixture({ artifact: newId("ar"), revision: newId("rv"), page: newId("pg"), route: { kind: "subtree", slug: `perf-foreign-${i}` } })
  }
  const target = { artifact: newId("ar"), revision: newId("rv"), page: newId("pg") }
  await pageFixture({ ...target, route: { kind: "tree_page", pageRef: "perf-target/index.html" } })
  const observed = observeD1(env.DB)
  const reads: number[] = []
  let lastBatch: D1Result[] = []
  const measured = new Proxy(observed.db, {
    get(targetDb, property) {
      if (property === "batch") return async (statements: D1PreparedStatement[]) => {
        const result = await targetDb.batch(statements)
        lastBatch = result
        return result
      }
      return Reflect.get(targetDb, property, targetDb)
    },
  })
  const deps = { db: measured, config: config.manage, jwks, now: () => 10 }
  const small = 128, large = 512
  for (const count of [small, large]) {
    const revision = newId("rv")
    await env.DB.batch([
      env.DB.prepare("INSERT INTO revisions (revision_id,artifact_id,origin,manifest_sha256,manifest_object_key,sealed_at) VALUES (?,?,'published',?,'perf-manifest',2)").bind(revision, target.artifact, digest),
      env.DB.prepare("INSERT INTO revision_resources (revision_id,path,kind,object_key,sha256,size,content_type) SELECT ?1,'/perf-target/resource-' || value || '.js','asset','perf',?2,1,'application/javascript' FROM json_each(?3)")
        .bind(revision, digest, JSON.stringify(Array.from({ length: count }, (_, i) => i))),
    ])
    await executeGuarded(deps, actor, [{
      action: "publish", pageId: target.page, artifactId: target.artifact, revisionId: revision,
      expectedPolicyEpoch: 0, expectedContentVersion: 0, requestDigest: digest, occurredAt: 10,
    }], [])
    expect(lastBatch).toHaveLength(1)
    const read = lastBatch[0].meta.rows_read
    expect(typeof read).toBe("number")
    expect(read).toBeGreaterThan(0)
    reads.push(read)
  }
  // With routes fixed at 64, range seeks + revision scans are O(N + routes).
  // Budget 12 additional rows per resource; the old cross-product scans about
  // 64 rows per resource, so its growth exceeds this independently of offset.
  expect(reads[1] - reads[0]).toBeLessThan(12 * (large - small))
}, 300_000)
