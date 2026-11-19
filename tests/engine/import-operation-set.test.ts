import { describe, expect, it } from "vitest"
import worker from "../../adapters/http/manageWorker"
import type { ApprovedImportInventory, ImportOperation, ImportSelection } from "../../domains/catalogue/import"
import { newId } from "../../domains/catalogue/ids"
import { shortlinkDestinationDigest } from "../../domains/catalogue/shortlinks"
import { importResult, syntheticImport } from "./fixtures/import"
import { content } from "./fixtures/publication"
import { env, request, setupHttp, signed } from "./fixtures/manage-http"

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

describe("native import operation set", () => {
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
