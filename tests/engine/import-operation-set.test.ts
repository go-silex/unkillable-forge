import { describe, expect, it } from "vitest"
import worker from "../../adapters/http/manageWorker"
import type { ApprovedImportInventory, ImportOperation, ImportSelection } from "../../domains/catalogue/import"
import { newId } from "../../domains/catalogue/ids"
import { shortlinkDestinationDigest } from "../../domains/catalogue/shortlinks"
import { importResult, syntheticImport } from "./fixtures/import"
import { content } from "./fixtures/publication"
import { env, request, setupHttp, signed } from "./fixtures/manage-http"
import { pageFixture } from "./fixtures/catalogue"

setupHttp()

async function fixture() {
  const seed = await syntheticImport()
  const other = newId("pg")
  const document = { ...seed.selection.command.files[0], path: "/docs/other.html" }
  const image = { ...document, path: "/a/synthetic-import/cover.png", kind: "asset" as const, contentType: "image/png" }
  const image2 = { ...image, path: "/docs/cover.png" }
  const edges = [{ ownerPageId: other, path: image2.path, providerArtifactId: null }]
  const command = { ...seed.selection.command, files: [...seed.selection.command.files, document, image, image2], pages: [...seed.selection.command.pages, { pageId: other, disposition: "new" as const, documentPath: document.path, metadata: {}, expectedPolicyEpoch: null }], edges }
  const selection = { ...seed.selection, command }
  const source = seed.inventory.files[0]
  const inventory: ApprovedImportInventory = { ...seed.inventory, command, files: [...seed.inventory.files, ...[document, image, image2].map(file => ({ ...source, ...file }))], pageMappings: [...seed.inventory.pageMappings, { sourcePageId: "source-other", pageId: other, documentPath: document.path, route: document.path, ownershipEvidenceRef: "synthetic-other" }], edgeEvidence: edges.map(edge => ({ ...edge, evidenceRef: "synthetic-edge" })), operations: [...seed.inventory.operations, { kind: "page_policy", policy: { operationId: "other-policy", sourcePageId: "source-other", pageId: other, expectedPolicyEpoch: null, grantId: null, visibility: { captured: true, value: "private", metadataV: "private", expiresAt: null }, share: { captured: true, key: null, expiresAt: null } } }] }
  const destination = "https://forge.example.test/a/synthetic-import/"
  const mapping = { mappingId: "mapping-one", providerOrigin: "https://links.example.test", providerId: "provider-one", shortDomain: "links.example.test", shortCode: "one", shortUrl: "https://links.example.test/one", pageId: seed.pageId, grantId: null, destination, source: "imported" as const, observedAt: 1, destinationDigest: await shortlinkDestinationDigest(destination) }
  return { seed, other, image, image2, selection, inventory, mapping }
}

async function plan(f: { seed: { approval: Record<string, unknown>; bindings: Record<string, unknown> }; inventory: ApprovedImportInventory; selection: ImportSelection }, operations: ImportOperation[]) {
  const inventory = { ...f.inventory, operations }
  const encoded = JSON.stringify(inventory)
  const object = await env.FORGE_IMPORT_SOURCE.put(`synthetic/set-${crypto.randomUUID()}.json`, encoded)
  if (!object) throw new Error("inventory upload failed")
  const approval = { ...f.seed.approval, objectKey: object.key, objectVersion: object.version, sha256: (await content(encoded)).sha256 }
  const bindings = { ...f.seed.bindings, FORGE_IMPORT_INVENTORIES: JSON.stringify([approval]) }
  const jwt = await signed()
  let cursor: string | null = null
  for (let i = 0; i < 256; i++) {
    const response = await worker.fetch(request("/api/maintenance/import", "POST", jwt, JSON.stringify({ op: "dry_run", selection: f.selection, cursor }), { "Content-Type": "application/json" }), bindings)
    const result = await importResult(response)
    if (result.state !== "checking") return result
    cursor = result.nextCursor
  }
  throw new Error("dry run did not complete")
}

async function nativeOutcome(bindings: Record<string, unknown>, selection: ImportSelection) {
  const jwt = await signed()
  let cursor: string | null = null
  for (let i = 0; i < 256; i++) {
    const response = await worker.fetch(request("/api/maintenance/import", "POST", jwt, JSON.stringify({ op: "dry_run", selection, cursor }), { "Content-Type": "application/json" }), bindings)
    const envelope = await response.json() as { ok: boolean; result?: { state: string; nextCursor?: string; issues?: { code: string }[] }; error?: { code: string } }
    if (!envelope.ok || response.status !== 200) return { status: response.status, code: envelope.error?.code, state: null, issues: [] }
    if (envelope.result?.state !== "checking") return { status: response.status, code: null, state: envelope.result?.state, issues: envelope.result?.issues ?? [] }
    if (typeof envelope.result.nextCursor !== "string") throw new Error("missing native continuation")
    cursor = envelope.result.nextCursor
  }
  throw new Error("native dry run did not complete")
}

async function snapshot() {
  const tables = await env.DB.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' ORDER BY name").all<{ name: string }>()
  const rows = await Promise.all(tables.results.map(async ({ name }) => [name, (await env.DB.prepare(`SELECT * FROM "${name.replace(/"/g, '""')}"`).all()).results]))
  async function objects(bucket: R2Bucket) {
    const items: { key: string; version: string; size: number }[] = []
    let cursor: string | undefined
    do {
      const page = await bucket.list({ cursor })
      items.push(...page.objects.map(({ key, version, size }) => ({ key, version, size })))
      cursor = page.truncated ? page.cursor : undefined
    } while (cursor)
    return items
  }
  return { rows, source: await objects(env.FORGE_IMPORT_SOURCE), target: await objects(env.REVISION_BYTES) }
}

async function checkedPlan(f: { seed: { approval: Record<string, unknown>; bindings: Record<string, unknown> }; inventory: ApprovedImportInventory; selection: ImportSelection }, operations: readonly ImportOperation[], wireInventory?: unknown) {
  const encoded = JSON.stringify(wireInventory ?? { ...f.inventory, operations })
  if (encoded === undefined) throw new Error("inventory is not JSON-serializable")
  const object = await env.FORGE_IMPORT_SOURCE.put(`synthetic/set-${crypto.randomUUID()}.json`, encoded)
  if (!object) throw new Error("inventory upload failed")
  const approval = { ...f.seed.approval, objectKey: object.key, objectVersion: object.version, sha256: (await content(encoded)).sha256 }
  const bindings = { ...f.seed.bindings, FORGE_IMPORT_INVENTORIES: JSON.stringify([approval]) }
  const before = await snapshot()
  const result = await nativeOutcome(bindings, f.selection)
  expect(await snapshot()).toEqual(before)
  return result
}

function sharedOperations(f: Awaited<ReturnType<typeof fixture>>, policyGrant: string, mappingGrant: string): ImportOperation[] {
  const policies = f.inventory.operations.map(op => op.kind === "page_policy" && op.policy.pageId === f.seed.pageId
    ? { ...op, policy: { ...op.policy, grantId: policyGrant, visibility: { captured: true as const, value: "shared" as const, metadataV: "shared", expiresAt: null }, share: { captured: true as const, key: "synthetic-original-key", expiresAt: null } } }
    : op)
  return [{ kind: "shortlink", operationId: "synthetic-link", mapping: { ...f.mapping, grantId: mappingGrant } }, ...policies]
}

async function existingTarget(f: Awaited<ReturnType<typeof fixture>>) {
  const artifact = newId("ar"), revision = newId("rv")
  await pageFixture({ artifact, revision, page: f.seed.pageId, route: { kind: "subtree", slug: "synthetic-import" } })
  const command = { ...f.selection.command, artifactId: artifact, expectedRevisionId: revision, expectedContentVersion: 0, pages: f.selection.command.pages.map(page => page.pageId === f.seed.pageId ? { ...page, disposition: "keep" as const, expectedPolicyEpoch: 0 } : page) }
  return { ...f, selection: { ...f.selection, command }, inventory: { ...f.inventory, command } }
}

async function historicalGrant(page: string) {
  const grant = newId("gr")
  await env.DB.prepare("INSERT INTO share_grants (grant_id,page_id,key_kid,key_hmac,mode,origin,created_at,revoked_at,revoked_reason) VALUES (?,?,'test',?,'follow_active','imported',1,2,'revoked')").bind(grant, page, "a".repeat(64)).run()
  return grant
}

function existingPolicyEpoch(operations: readonly ImportOperation[], page: string): ImportOperation[] {
  return operations.map(op => op.kind === "page_policy" && op.policy.pageId === page ? { ...op, policy: { ...op.policy, expectedPolicyEpoch: 0 } } : op)
}

describe("native import operation set", () => {
  it("requires the explicit local sentinel in pinned tree-edge evidence", async () => {
    const f = await fixture()
    expect((await checkedPlan(f, f.inventory.operations)).state).toBe("ready")
    const edge = f.inventory.edgeEvidence[0]
    const { providerArtifactId: _providerArtifactId, ...incomplete } = edge
    const wireInventory = { ...f.inventory, edgeEvidence: [incomplete] }
    const result = await checkedPlan(f, f.inventory.operations, wireInventory)
    expect(result.status).toBe(200)
    expect(result.state).toBe("blocked")
    expect(result.issues).toContainEqual({ code: "selection_graph_mismatch" })
  })

  it("rejects unmapped or null-path live page mappings at admission", async () => {
    const f = await fixture()
    expect((await checkedPlan(f, f.inventory.operations)).state).toBe("ready")
    const mapping = f.inventory.pageMappings[0]
    const { documentPath: _documentPath, ...withoutPath } = mapping
    const unknownPage = { ...withoutPath, pageId: newId("pg") }
    const absentInventory = { ...f.inventory, pageMappings: [unknownPage, ...f.inventory.pageMappings.slice(1)] }
    const absent = await checkedPlan(f, f.inventory.operations, absentInventory)
    expect(absent.status).toBe(200)
    expect(absent.state).toBe("blocked")
    expect(absent.issues).toContainEqual({ code: "selection_graph_mismatch" })

    const command = { ...f.selection.command, pages: f.selection.command.pages.map(page => page.pageId === f.seed.pageId ? { ...page, documentPath: null } : page) }
    const selection = { ...f.selection, command }
    const wireInventory = { ...f.inventory, command, pageMappings: [{ ...mapping, documentPath: null }, ...f.inventory.pageMappings.slice(1)] }
    const nullPath = await checkedPlan({ ...f, selection }, f.inventory.operations, wireInventory)
    expect(nullPath.status).toBe(200)
    expect(nullPath.state).toBe("blocked")
    expect(nullPath.issues).toContainEqual({ code: "selection_graph_mismatch" })
  })

  it("checks the complete native ownership graph before target provider lookup", async () => {
    const f = await fixture()
    for (const reversed of [false, true]) {
      for (const scenario of ["subtree-local-inside", "tree-local-outside", "subtree-local-outside", "subtree-foreign-inside"] as const) {
        const edge = {
          ownerPageId: scenario === "tree-local-outside" ? f.other : f.seed.pageId,
          path: scenario === "tree-local-outside" || scenario === "subtree-local-outside" ? f.image2.path : f.image.path,
          providerArtifactId: scenario === "subtree-foreign-inside" ? newId("ar") : null,
        }
        const companion = { ownerPageId: f.other, path: f.image.path, providerArtifactId: null }
        const edges = reversed ? [companion, edge] : [edge, companion]
        const evidence = edges.map((value, index) => ({ ...value, evidenceRef: `synthetic-edge-${index}` }))
        const command = { ...f.selection.command, pages: reversed ? [...f.selection.command.pages].reverse() : f.selection.command.pages, files: reversed ? [...f.selection.command.files].reverse() : f.selection.command.files, edges }
        const inventory = { ...f.inventory, command, files: reversed ? [...f.inventory.files].reverse() : f.inventory.files, pageMappings: reversed ? [...f.inventory.pageMappings].reverse() : f.inventory.pageMappings, edgeEvidence: reversed ? [...evidence].reverse() : evidence }
        const result = await checkedPlan({ ...f, selection: { ...f.selection, command }, inventory }, inventory.operations)
        if (scenario === "subtree-local-inside" || scenario === "tree-local-outside") expect(result.state).toBe("ready")
        else {
          expect(result.state).toBe("blocked")
          expect(result.issues).toContainEqual({ code: "selection_graph_mismatch" })
        }
      }
    }
  }, 30000)

  it("treats null and explicit self provider as local for an existing artifact", async () => {
    const f = await existingTarget(await fixture())
    for (const providerArtifactId of [null, f.selection.command.artifactId]) {
      const edge = { ownerPageId: f.seed.pageId, path: f.image.path, providerArtifactId }
      const command = { ...f.selection.command, edges: [edge] }
      const inventory = { ...f.inventory, command, edgeEvidence: [{ ...edge, evidenceRef: "synthetic-edge" }] }
      const operations = existingPolicyEpoch(inventory.operations, f.seed.pageId)
      expect((await checkedPlan({ ...f, selection: { ...f.selection, command }, inventory }, operations)).state).toBe("ready")
    }
  })

  it("rejects a non-scalar provider ID in a pinned native shortlink", async () => {
    const f = await fixture()
    const link: ImportOperation = { kind: "shortlink", operationId: "invalid-provider", mapping: { ...f.mapping, providerId: "\ud800" } }
    expect(await checkedPlan(f, [...f.inventory.operations, link])).toEqual({ status: 422, code: "invalid_state", state: null, issues: [] })
  })

  it("refuses aliases whose literal source or destination cannot be stored", async () => {
    const f = await fixture()
    const alias = { kind: "alias" as const, operationId: "storage-alias", aliasKind: "redirect_exact" as const, path: "/old", to: "/archive", status: 301 as const, targetPageId: f.seed.pageId }
    for (const invalid of [{ ...alias, path: "/archive/%2541" }, { ...alias, to: "/archive/%2541" }]) {
      const result = await checkedPlan(f, [...f.inventory.operations, invalid])
      expect(result).toEqual({ status: 422, code: "invalid_state", state: null, issues: [] })
    }
    const safe = { ...alias, path: "/old/%41", to: "/archive/%41" }
    expect((await checkedPlan(f, [...f.inventory.operations, safe])).state).toBe("ready")
  })

  it("rejects numeric mapping IDs before D1 can coerce them into colliding text", async () => {
    const f = await fixture()
    const text: ImportOperation = { kind: "shortlink", operationId: "text-mapping", mapping: { ...f.mapping, mappingId: "7.5", shortCode: "text", shortUrl: "https://links.example.test/text" } }
    const numeric = { kind: "shortlink", operationId: "numeric-mapping", mapping: { ...f.mapping, mappingId: 7.5, shortCode: "numeric", shortUrl: "https://links.example.test/numeric" } } as unknown as ImportOperation
    const distinct: ImportOperation = { kind: "shortlink", operationId: "distinct-mapping", mapping: { ...f.mapping, mappingId: "other", shortCode: "numeric", shortUrl: "https://links.example.test/numeric" } }
    const duplicate: ImportOperation = { ...distinct, mapping: { ...distinct.mapping, mappingId: "7.5" } }
    const nonScalar: ImportOperation = { kind: "shortlink", operationId: "non-scalar-mapping", mapping: { ...f.mapping, mappingId: "\ud800" } }
    expect((await checkedPlan(f, [...f.inventory.operations, text])).state).toBe("ready")
    expect(await checkedPlan(f, [...f.inventory.operations, numeric])).toEqual({ status: 422, code: "invalid_state", state: null, issues: [] })
    expect(await checkedPlan(f, [...f.inventory.operations, nonScalar])).toEqual({ status: 422, code: "invalid_state", state: null, issues: [] })
    expect((await checkedPlan(f, [...f.inventory.operations, text, distinct])).state).toBe("ready")
    const collision = await checkedPlan(f, [...f.inventory.operations, text, duplicate])
    expect(collision.state).toBe("blocked")
    expect(collision.issues).toContainEqual({ code: "selection_graph_mismatch" })
    expect(await checkedPlan(f, [...f.inventory.operations, text, numeric])).toEqual({ status: 422, code: "invalid_state", state: null, issues: [] })
  })

  it("requires a shortlink grant to resolve to its own page across the complete proposed set", async () => {
    const f = await fixture()
    const proposed = newId("gr")
    const missing = newId("gr")
    const blocked = await checkedPlan(f, sharedOperations(f, proposed, missing))
    expect(blocked.state).toBe("blocked")
    expect(blocked.issues).toContainEqual({ code: "grant_conflict", pageId: f.seed.pageId })
    const operations = sharedOperations(f, proposed, proposed)
    const aliases: ImportOperation[] = Array.from({ length: 128 }, (_, i) => ({ kind: "alias", operationId: `grant-gap-${i}`, aliasKind: "redirect_exact", path: `/grant-gap-${i}`, to: "/new", status: 301, targetPageId: null }))
    expect((await checkedPlan(f, [operations[0], ...aliases, ...operations.slice(1)])).state).toBe("ready")
    expect((await checkedPlan(f, [{ kind: "shortlink", operationId: "null-link", mapping: f.mapping }, ...f.inventory.operations])).state).toBe("ready")
  })

  it("rejects malformed non-null and missing shortlink grant IDs before readiness", async () => {
    const f = await fixture()
    for (const grantId of ["", "gr_bad", "pg_aaaaaaaaaaaaaaaaaaaaaaaaaa", false, 0, undefined]) {
      const mapping = { ...f.mapping, grantId }
      const link = { kind: "shortlink", operationId: "malformed-grant-link", mapping } as unknown as ImportOperation
      const result = await checkedPlan(f, [link, ...f.inventory.operations])
      expect(result.state).toBe("blocked")
      expect(result.issues).toContainEqual({ code: "selection_graph_mismatch" })
    }
  })

  it("rejects a shortlink grant belonging to a different existing page", async () => {
    const existingPage = newId("pg")
    await pageFixture({ artifact: newId("ar"), revision: newId("rv"), page: existingPage, route: { kind: "subtree", slug: "existing-grant" } })
    const existingGrant = await historicalGrant(existingPage)
    const f = await existingTarget(await fixture())
    const operations = existingPolicyEpoch([{ kind: "shortlink", operationId: "synthetic-link", mapping: { ...f.mapping, grantId: existingGrant } }, ...f.inventory.operations], f.seed.pageId)
    const result = await checkedPlan(f, operations)
    expect(result.state).toBe("blocked")
    expect(result.issues).toContainEqual({ code: "grant_conflict", pageId: f.seed.pageId })
  })

  it("accepts an existing revoked same-page grant without a producing policy", async () => {
    const f = await existingTarget(await fixture())
    const existingGrant = await historicalGrant(f.seed.pageId)
    const operations = existingPolicyEpoch([{ kind: "shortlink", operationId: "synthetic-link", mapping: { ...f.mapping, grantId: existingGrant } }, ...f.inventory.operations], f.seed.pageId)
    expect((await checkedPlan(f, operations)).state).toBe("ready")
  })

  it("accepts independent claims without publishing", async () => {
    const f = await fixture()
    const before = await env.DB.prepare("SELECT count(*) AS n FROM publication_sessions").first()
    const p = { kind: "preview_selection" as const, operationId: "preview-one", pageId: f.seed.pageId, path: f.image.path }
    const link = { kind: "shortlink" as const, operationId: "link-one", mapping: f.mapping }
    const result = await plan(f, [...f.inventory.operations, p, { kind: "preview_selection", operationId: "preview-other", pageId: f.other, path: f.image2.path }, link, { ...link, operationId: "link-two", mapping: { ...f.mapping, mappingId: "mapping-two", shortCode: "two", shortUrl: "https://links.example.test/two", pageId: f.other } }])
    expect(result.state).toBe("ready")
    expect(await env.DB.prepare("SELECT count(*) AS n FROM publication_sessions").first()).toEqual(before)
  })

  it("blocks contradictory previews even across metadata windows", async () => {
    const f = await fixture()
    const aliases: ImportOperation[] = Array.from({ length: 128 }, (_, i) => ({ kind: "alias", operationId: `alias-${i}`, aliasKind: "redirect_exact", path: `/old-${i}`, to: "/new", status: 301, targetPageId: null }))
    const result = await plan(f, [...f.inventory.operations, { kind: "preview_selection", operationId: "first-preview", pageId: f.seed.pageId, path: f.image.path }, ...aliases, { kind: "preview_selection", operationId: "second-preview", pageId: f.seed.pageId, path: f.image2.path }])
    expect(result.state).toBe("blocked")
    expect(result.issues).toContainEqual({ code: "selection_graph_mismatch" })
  })

  it("blocks each independent durable-key collision before publication", async () => {
    const f = await fixture()
    const grantId = newId("gr")
    const policies: ImportOperation[] = f.inventory.operations.map(op => op.kind === "page_policy" ? { ...op, policy: { ...op.policy, grantId, visibility: { captured: true, value: "shared", metadataV: "shared", expiresAt: null }, share: { captured: true, key: "synthetic-original-key", expiresAt: null } } } : op)
    const link: ImportOperation = { kind: "shortlink", operationId: "link-one", mapping: f.mapping }
    const cases: ImportOperation[][] = [
      [...f.inventory.operations, link, { kind: "shortlink", operationId: "link-two", mapping: { ...f.mapping, mappingId: "mapping-two" } }],
      [...f.inventory.operations, link, { kind: "shortlink", operationId: "link-two", mapping: { ...f.mapping, shortCode: "two", shortUrl: "https://links.example.test/two" } }],
      [...f.inventory.operations, { kind: "alias", operationId: "alias-one", aliasKind: "redirect_exact", path: "/old", to: "/one", status: 301, targetPageId: null }, { kind: "alias", operationId: "alias-two", aliasKind: "redirect_exact", path: "/old", to: "/two", status: 301, targetPageId: null }],
      policies,
      [...f.inventory.operations, { ...link, mapping: { ...f.mapping, grantId } }, { kind: "shortlink", operationId: "link-two", mapping: { ...f.mapping, mappingId: "mapping-two", shortCode: "two", shortUrl: "https://links.example.test/two", pageId: f.other, grantId } }],
    ]
    const before = await env.DB.prepare("SELECT count(*) AS n FROM publication_sessions").first()
    for (const operations of cases) {
      const result = await plan(f, operations)
      expect(result.state).toBe("blocked")
      expect(result.issues).toContainEqual({ code: "selection_graph_mismatch" })
    }
    expect(await env.DB.prepare("SELECT count(*) AS n FROM publication_sessions").first()).toEqual(before)
  })

  it("rejects malformed grant IDs at native admission without the translator", async () => {
    const seed = await syntheticImport()
    const policy = (grantId: string): ImportOperation => ({
      kind: "page_policy",
      policy: { operationId: "shared-policy", sourcePageId: "source-page", pageId: seed.pageId, expectedPolicyEpoch: null, grantId, visibility: { captured: true, value: "shared", metadataV: "shared", expiresAt: null }, share: { captured: true, key: "synthetic-original-key", expiresAt: null } },
    })
    async function bindingsFor(grantId: string) {
      const encoded = JSON.stringify({ ...seed.inventory, operations: [policy(grantId)] })
      const object = await env.FORGE_IMPORT_SOURCE.put(`synthetic/native-grant-${crypto.randomUUID()}.json`, encoded)
      if (!object) throw new Error("inventory upload failed")
      const approval = { ...seed.approval, objectKey: object.key, objectVersion: object.version, sha256: (await content(encoded)).sha256 }
      return { ...seed.bindings, FORGE_IMPORT_INVENTORIES: JSON.stringify([approval]) }
    }
    const valid = await bindingsFor(newId("gr"))
    const before = await env.DB.prepare("SELECT count(*) AS n FROM publication_sessions").first()
    expect((await nativeOutcome(valid, seed.selection)).state).toBe("ready")
    expect((await nativeOutcome(valid, seed.selection)).state).toBe("ready")
    const invalid = await nativeOutcome(await bindingsFor("gr_not-a-valid-id"), seed.selection)
    expect(invalid.status).toBe(200)
    expect(invalid.state).toBe("blocked")
    expect(invalid.issues).toContainEqual({ code: "selection_graph_mismatch" })
    expect(await env.DB.prepare("SELECT count(*) AS n FROM publication_sessions").first()).toEqual(before)
  })

  it("rejects non-visible-ASCII plan bindings at native admission without the translator", async () => {
    const seed = await syntheticImport()
    const before = await env.DB.prepare("SELECT count(*) AS n FROM publication_sessions").first()
    expect((await nativeOutcome(seed.bindings, seed.selection)).state).toBe("ready")
    expect((await nativeOutcome(seed.bindings, seed.selection)).state).toBe("ready")
    for (const planId of ["plan with space", "plan\tcontrol", "plan-é"]) {
      const result = await nativeOutcome(seed.bindings, { ...seed.selection, planId })
      expect(result.status).toBe(200)
      expect(result.state).toBe("blocked")
      expect(result.issues).toContainEqual({ code: "selection_graph_mismatch" })
    }
    expect(await env.DB.prepare("SELECT count(*) AS n FROM publication_sessions").first()).toEqual(before)
  })

  it("rejects a non-scalar logical asset path through native planning", async () => {
    const seed = await syntheticImport()
    const path = "/a/synthetic-import/\ud800.css"
    const asset = { ...seed.selection.command.files[0], path, kind: "asset" as const, contentType: "text/css" }
    const command = { ...seed.selection.command, files: [...seed.selection.command.files, asset] }
    const selection = { ...seed.selection, command }
    const inventory = { ...seed.inventory, command, files: [...seed.inventory.files, { ...seed.inventory.files[0], path, kind: "asset" as const, contentType: "text/css" }] }
    const encoded = JSON.stringify(inventory)
    const object = await env.FORGE_IMPORT_SOURCE.put(`synthetic/native-scalar-${crypto.randomUUID()}.json`, encoded)
    if (!object) throw new Error("inventory upload failed")
    const approval = { ...seed.approval, objectKey: object.key, objectVersion: object.version, sha256: (await content(encoded)).sha256 }
    const bindings = { ...seed.bindings, FORGE_IMPORT_INVENTORIES: JSON.stringify([approval]) }
    const before = await env.DB.prepare("SELECT count(*) AS n FROM publication_sessions").first()
    expect((await nativeOutcome(seed.bindings, seed.selection)).state).toBe("ready")
    const result = await nativeOutcome(bindings, selection)
    expect(result.status).toBe(200)
    expect(result.state).toBe("blocked")
    expect(result.issues).toContainEqual({ code: "invalid_state" })
    expect(await env.DB.prepare("SELECT count(*) AS n FROM publication_sessions").first()).toEqual(before)
  })
})
