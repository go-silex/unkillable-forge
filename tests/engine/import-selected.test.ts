import { describe, expect, it } from "vitest"
import worker from "../../adapters/http/manageWorker"
import type { ImportOperation } from "../../domains/catalogue/import"
import { assignSourcePins, sealInventory, preflightSelection, projectTranslation, type Observation, type RepresentableUnit } from "../../scripts/forge-import-selected.mjs"
import { makeSelectedFixture, type SyntheticInput } from "./fixtures/import-selected.mjs"
import { env, request, setupHttp, signed } from "./fixtures/manage-http"
import { manageHttpBindings } from "./fixtures/manage-http-bindings"

setupHttp()

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

async function fixture(includeMissing = false, mutate?: (selected: { input: SyntheticInput; observations: Record<string, Observation>; files: Record<string, Uint8Array> }) => void) {
  const selected = await makeSelectedFixture({ includeMissing })
  mutate?.(selected)
  const preflight = await preflightSelection(selected.input)
  if (preflight.kind !== "prepared") throw new Error("fixture selector failed preflight")
  const observations: Record<string, Observation> = {}
  for (const read of preflight.reads) observations[read.path] = selected.observations[read.path]
  const authorizedKeys = new Map(preflight.reads.map(read => [read.path, read.sourceKey]))
  const translated = projectTranslation(await preflight.finish(observations))
  const approvals = []
  const units: RepresentableUnit[] = []
  const sourcePins: Record<string, { version: string }> = {}
  for (const unit of translated.units) {
    if (unit.status !== "representable") continue
    const pins = sourcePins
    for (const file of unit.inventory.files) {
      expect(file.sourceRef).toBe(authorizedKeys.get(file.path))
      if (!pins[file.sourceRef]) {
        const object = await env.FORGE_IMPORT_SOURCE.put(file.sourceRef, new Uint8Array(selected.files[file.path]))
        if (!object) throw new Error("source upload failed")
        pins[file.sourceRef] = { version: object.version }
      }
    }
    const pinned = assignSourcePins(unit, pins)
    if (!pinned.ok) throw new Error(`pinning failed: ${pinned.code}`)
    const object = await env.FORGE_IMPORT_SOURCE.put(unit.inventoryKey, new Uint8Array(pinned.bytes))
    if (!object) throw new Error("inventory upload failed")
    const hash = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new Uint8Array(pinned.bytes))), byte => byte.toString(16).padStart(2, "0")).join("")
    const sealed = sealInventory(pinned.unit, { key: object.key, version: object.version }, hash)
    if (!sealed.ok) throw new Error(`sealing failed: ${sealed.code}`)
    approvals.push(sealed.approval)
    units.push(sealed.unit)
  }
  const bindings = { ...manageHttpBindings, FORGE_MANAGE_TRANSPORT: JSON.stringify({ ...JSON.parse(manageHttpBindings.FORGE_MANAGE_TRANSPORT), ...selected.input.limits, maxInventoryBytes: undefined }), FORGE_IMPORT_SOURCE: env.FORGE_IMPORT_SOURCE, FORGE_IMPORT_INVENTORIES: JSON.stringify(approvals), DB: env.DB, REVISION_BYTES: env.REVISION_BYTES }
  async function plan(unit: (typeof units)[number]) {
    const jwt = await signed()
    let cursor: string | null = null
    let checks = 0
    for (let i = 0; i < 128; i++) {
      const body = { op: "dry_run", selection: unit.selection, cursor }
      const depth = (value: unknown): number => value !== null && typeof value === "object" ? 1 + Math.max(0, ...Object.values(value).map(depth)) : 0
      expect(new TextEncoder().encode(JSON.stringify(body)).length).toBeLessThanOrEqual(selected.input.limits.maxCommandBytes)
      expect(depth(body)).toBeLessThanOrEqual(selected.input.limits.maxJsonDepth)
      const begin = { op: "begin", command: unit.selection.command }
      expect(new TextEncoder().encode(JSON.stringify(begin)).length).toBeLessThanOrEqual(selected.input.limits.maxCommandBytes)
      expect(depth(begin)).toBeLessThanOrEqual(selected.input.limits.maxJsonDepth)
      const response = await worker.fetch(request("/api/maintenance/import", "POST", jwt, JSON.stringify(body), { "Content-Type": "application/json" }), bindings)
      expect(response.status).toBe(200)
      const envelope = await response.json() as { ok: boolean; result: { state: string; nextCursor?: string; issues?: unknown[]; warnings?: { code: string }[] } }
      expect(envelope.ok).toBe(true)
      if (envelope.result.state !== "checking") return { result: envelope.result, checks }
      checks++
      expect(typeof envelope.result.nextCursor).toBe("string")
      cursor = envelope.result.nextCursor ?? null
    }
    throw new Error("dry run did not terminate")
  }
  return { selected, translated, units, plan }
}

describe("selected fixture through native import admission", () => {
  it("retains graph and exact metadata and repeatedly plans without writes", async () => {
    const { translated, units, plan } = await fixture(true)
    expect(translated.compatibility.unsupported.some((item: { code: string }) => item.code === "or1_missing_document")).toBe(true)
    const tree = units.find(unit => unit.command.files.length >= 9)
    if (!tree) throw new Error("tree unit missing")
    const fragment = tree.command.files.filter((file: { kind: string }) => file.kind === "fragment")
    expect(fragment).toHaveLength(1)
    const fragmentEdges = tree.command.edges.filter(edge => edge.path === fragment[0].path)
    expect(fragmentEdges).toHaveLength(2)
    expect(new Set(fragmentEdges.map(edge => edge.ownerPageId)).size).toBe(2)
    expect(tree.inventory.pageMappings.some(mapping => mapping.documentPath === fragment[0].path)).toBe(false)
    expect(tree.inventory.operations.filter(op => op.kind === "page_policy")).toHaveLength(2)
    expect(tree.inventory.operations.some(op => op.kind === "preview_selection" && op.path === "/tree/preview.png")).toBe(true)
    const slug = units.find(unit => unit.command.files.some(file => file.kind === "subdocument"))
    if (!slug) throw new Error("slug unit missing")
    expect(slug.inventory.operations).toContainEqual(expect.objectContaining({ kind: "alias", aliasKind: "redirect_exact", path: "/legacy-sample", to: "/a/sample/", status: 301 }))
    expect(slug.inventory.operations).toContainEqual(expect.objectContaining({ kind: "shortlink", mapping: expect.objectContaining({ destination: "https://forge.example.test/s/sample/?k=syntheticSlugKey#section" }) }))
    const before = await snapshot()
    const first = await plan(tree)
    expect(first.checks).toBeGreaterThan(0)
    expect(first.result.state).toBe("ready")
    expect((await plan(tree)).result).toEqual(first.result)
    expect((await plan(slug)).result.state).toBe("ready")
    expect(await snapshot()).toEqual(before)
  })

  it("blocks an identical replacement with a different native version", async () => {
    const { selected, units, plan } = await fixture()
    const unit = units.find(item => item.command.files.length >= 9)
    if (!unit) throw new Error("tree unit missing")
    const file = unit.inventory.files[0]
    const replacement = await env.FORGE_IMPORT_SOURCE.put(file.sourceRef, new Uint8Array(selected.files[file.path]))
    expect(replacement?.version).not.toBe(file.sourceVersion)
    const before = await snapshot()
    const result = await plan(unit)
    expect(result.result.state).toBe("blocked")
    expect(result.result.issues).toContainEqual({ code: "source_integrity", path: file.path })
    expect(await snapshot()).toEqual(before)
  })
  it("blocks the entire slug when its nested selected member is missing, but plans the independent tree", async () => {
    const { translated, units, plan } = await fixture(false, selected => {
      selected.observations["/a/sample/nested/index.html"] = { state: "absent" }
    })
    expect(translated.units.find(unit => unit.sourceArtifactId === "slug:sample")?.status).toBe("blocked")
    expect(translated.accounting).toContainEqual(expect.objectContaining({ path: "/a/sample/nested/index.html", unitId: "slug:sample", disposition: "blocked" }))
    expect(units.some(unit => unit.sourceArtifactId === "slug:sample")).toBe(false)
    const tree = units.find(unit => unit.sourceArtifactId === "tree:synthetic")
    if (!tree) throw new Error("independent tree unit missing")
    const before = await snapshot()
    expect((await plan(tree)).result.state).toBe("ready")
    expect(await snapshot()).toEqual(before)
  })

  it("does not bind a stale shortlink to the current grant after restoring the nested member", async () => {
    const { translated, units, plan } = await fixture(false, selected => {
      selected.input.shortlinks[0].destination = "https://forge.example.test/s/sample/?k=staleSyntheticKey#section"
    })
    expect(translated.compatibility.unsupported).toContainEqual(expect.objectContaining({ code: "shortlink_destination_unverified", unitId: "slug:sample" }))
    expect(translated.units.find(unit => unit.sourceArtifactId === "slug:sample")?.status).toBe("blocked")
    expect(translated.compatibility.represented).not.toContainEqual(expect.objectContaining({ code: "shortlink_exact_destination", unitId: "slug:sample" }))
    expect(units.some(unit => unit.sourceArtifactId === "slug:sample")).toBe(false)
    const tree = units.find(unit => unit.sourceArtifactId === "tree:synthetic")
    if (!tree) throw new Error("independent tree unit missing")
    const before = await snapshot()
    expect((await plan(tree)).result.state).toBe("ready")
    expect(await snapshot()).toEqual(before)
  })

  it("admits array and CJK metadata within native limits", async () => {
    const metadata = ["東京", { title: "漢".repeat(3000) }]
    const { units, plan } = await fixture(false, selected => {
      selected.input.pages.find(page => page.sourcePageId === "tree/one.html")!.metadata = metadata
    })
    const tree = units.find(unit => unit.sourceArtifactId === "tree:synthetic")
    if (!tree) throw new Error("tree unit missing")
    expect(tree.command.pages.find(page => page.documentPath === "/tree/one.html")?.metadata).toEqual(metadata)
    const before = await snapshot()
    expect((await plan(tree)).result.state).toBe("ready")
    expect(await snapshot()).toEqual(before)
  })

  it("accepts an original slug preview through implicit subtree ownership without a tree edge", async () => {
    const path = "/a/sample/preview.png"
    const { units, plan } = await fixture(false, selected => {
      const original = selected.input.entries.find(entry => entry.path === "/tree/preview.png")
      if (!original) throw new Error("original PNG missing")
      selected.input.entries.push({ ...original, path, locator: { root: "capture", relative: path.slice(1) }, placement: { sourceArtifactId: "slug:sample", evidenceRef: "synthetic-placement" } })
      selected.observations[path] = selected.observations[original.path]
      selected.files[path] = selected.files[original.path]
      selected.input.previews.push({ sourcePageId: "sample", path, kind: "original" })
    })
    const slug = units.find(unit => unit.sourceArtifactId === "slug:sample")
    if (!slug) throw new Error("slug unit missing")
    expect(slug.command.edges.some(edge => edge.path === path)).toBe(false)
    expect(slug.inventory.operations).toContainEqual(expect.objectContaining({ kind: "preview_selection", path }))
    const before = await snapshot()
    expect((await plan(slug)).result.state).toBe("ready")
    expect(await snapshot()).toEqual(before)
  })

  it("preserves distinct exact and prefix alias identities through native admission", async () => {
    const { units, plan } = await fixture(false, selected => {
      for (const aliasKind of ["redirect_exact", "redirect_prefix"] as const) {
        selected.input.aliases.push({ aliasKind, path: "/legacy/", to: "/a/sample/", status: 301, targetSourcePageId: "sample", capturedBehavior: "team_fallback" })
      }
    })
    const slug = units.find(unit => unit.sourceArtifactId === "slug:sample")
    if (!slug) throw new Error("slug unit missing")
    const aliases = slug.inventory.operations.filter((op): op is Extract<ImportOperation, { kind: "alias" }> => op.kind === "alias" && op.path === "/legacy/")
    expect(aliases).toHaveLength(2)
    expect(new Set(aliases.map(alias => alias.operationId)).size).toBe(2)
    const before = await snapshot()
    expect((await plan(slug)).result.state).toBe("ready")
    expect(await snapshot()).toEqual(before)
  })

  it("requires the exact share key at a team alias destination", async () => {
    for (const [key, disposition] of [["wrongSyntheticKey", "rejected"], ["syntheticSlugKey", "represented"]] as const) {
      const { translated, units, plan } = await fixture(false, selected => {
        selected.input.aliases[0].to = `/s/sample/${key}/`
        selected.input.consumerUrls.push({ url: "https://forge.example.test/legacy-sample", purpose: "alias", targetSourcePageId: "sample", mappingRef: null })
      })
      expect(translated.census).toContainEqual(expect.objectContaining({ kind: "consumerUrl", ordinal: 0, disposition }))
      const unit = units.find(value => value.sourceArtifactId === (disposition === "represented" ? "slug:sample" : "tree:synthetic"))
      if (!unit) throw new Error("independent representable unit missing")
      const before = await snapshot()
      expect((await plan(unit)).result.state).toBe("ready")
      expect(await snapshot()).toEqual(before)
    }
  })

  it("does not let an excluded census name shadow an alias, but honors a real fragment", async () => {
    for (const primary of [false, true]) {
      const { translated, units, plan } = await fixture(false, selected => {
        const path = "/legacy-sample.html"
        if (primary) {
          const original = selected.input.entries.find(entry => entry.path === "/tree/fragment.html")
          if (!original) throw new Error("fragment missing")
          selected.input.entries.push({ ...original, path, locator: { root: "capture", relative: path.slice(1) } })
          selected.observations[path] = selected.observations[original.path]
          selected.files[path] = selected.files[original.path]
          selected.input.owners.push({ path, ownerSourcePageId: "tree/one.html", evidenceRef: "synthetic-edge-evidence", basis: "declared" })
        } else {
          selected.input.entries.push({ path, graphClass: "excluded", contentType: null, locator: { root: "capture", relative: path.slice(1) }, provenance: "synthetic-exclusion", expected: null, placement: null })
          selected.input.exclusions.push({ path, evidenceRef: "synthetic-exclusion", reason: "engine" })
        }
        selected.input.consumerUrls.push({ url: "https://forge.example.test/legacy-sample", purpose: "alias", targetSourcePageId: "sample", mappingRef: null })
      })
      expect(translated.census).toContainEqual(expect.objectContaining({ kind: "consumerUrl", ordinal: 0, disposition: primary ? "rejected" : "represented" }))
      const unit = units.find(value => value.sourceArtifactId === (primary ? "tree:synthetic" : "slug:sample"))
      if (!unit) throw new Error("independent representable unit missing")
      const before = await snapshot()
      expect((await plan(unit)).result.state).toBe("ready")
      expect(await snapshot()).toEqual(before)
    }
  })

  it("treats placed assets as primary over a team alias whether or not they have owners", async () => {
    for (const placement of ["excluded", "unowned", "owned"] as const) {
      const { translated, units, plan } = await fixture(false, selected => {
        const path = "/brand.css"
        selected.input.aliases[0].path = path
        selected.input.consumerUrls.push({ url: `https://forge.example.test${path}`, purpose: "alias", targetSourcePageId: "sample", mappingRef: null })
        if (placement === "excluded") {
          selected.input.entries.push({ path, graphClass: "excluded", contentType: null, locator: { root: "capture", relative: "brand.css" }, provenance: "synthetic-exclusion", expected: null, placement: null })
          selected.input.exclusions.push({ path, evidenceRef: "synthetic-exclusion", reason: "engine" })
        } else {
          const original = selected.input.entries.find(entry => entry.path === "/tree/asset0.css")
          if (!original) throw new Error("asset missing")
          selected.input.entries.push({ ...original, path, locator: { root: "capture", relative: "brand.css" } })
          selected.observations[path] = selected.observations[original.path]
          selected.files[path] = selected.files[original.path]
          if (placement === "owned") selected.input.owners.push({ path, ownerSourcePageId: "tree/one.html", evidenceRef: "synthetic-edge-evidence", basis: "declared" })
        }
      })
      expect(translated.census).toContainEqual(expect.objectContaining({ kind: "consumerUrl", ordinal: 0, disposition: placement === "excluded" ? "represented" : "rejected" }))
      const unit = units.find(value => value.sourceArtifactId === (placement === "excluded" ? "slug:sample" : "tree:synthetic"))
      if (!unit) throw new Error("representable unit missing")
      if (placement !== "excluded") expect(unit.command.files.some(file => file.path === "/brand.css")).toBe(true)
      const before = await snapshot()
      expect((await plan(unit)).result.state).toBe("ready")
      expect(await snapshot()).toEqual(before)
    }
  })

  it("does not count a recognized consumer as represented when its selected artifact is incomplete", async () => {
    const { translated, units, plan } = await fixture(false, selected => {
      selected.input.consumerUrls.push({ url: "https://forge.example.test/s/sample/?k=syntheticSlugKey", purpose: "share", targetSourcePageId: "sample", mappingRef: null })
      selected.observations["/a/sample/nested/index.html"] = { state: "absent" }
    })
    expect(translated.census).toContainEqual(expect.objectContaining({ kind: "consumerUrl", ordinal: 0, disposition: "rejected" }))
    expect(translated.compatibility.represented).not.toContainEqual(expect.objectContaining({ code: "consumer_url_represented", unitId: "slug:sample" }))
    const tree = units.find(unit => unit.sourceArtifactId === "tree:synthetic")
    if (!tree) throw new Error("independent tree unit missing")
    const before = await snapshot()
    expect((await plan(tree)).result.state).toBe("ready")
    expect(await snapshot()).toEqual(before)
  })

  it("requires the selected card image to be owned by its actual page", async () => {
    const path = "/tree/two.og.png"
    const { translated, units, plan } = await fixture(false, selected => {
      const original = selected.input.entries.find(entry => entry.path === "/tree/preview.png")
      if (!original) throw new Error("original PNG missing")
      selected.input.entries.push({ ...original, path, locator: { root: "capture", relative: path.slice(1) } })
      selected.observations[path] = selected.observations[original.path]
      selected.files[path] = selected.files[original.path]
      selected.input.owners.push({ path, ownerSourcePageId: "tree/one.html", evidenceRef: "synthetic-edge-evidence", basis: "declared" })
      selected.input.consumerUrls.push({ url: "https://forge.example.test/s/tree/two.og.png/syntheticTreeKey/", purpose: "card", targetSourcePageId: "tree/two.html", mappingRef: null })
    })
    expect(translated.census).toContainEqual(expect.objectContaining({ kind: "consumerUrl", ordinal: 0, disposition: "rejected" }))
    expect(translated.compatibility.represented).not.toContainEqual(expect.objectContaining({ code: "consumer_url_represented", unitId: "tree:synthetic" }))
    const slug = units.find(unit => unit.sourceArtifactId === "slug:sample")
    if (!slug) throw new Error("independent slug unit missing")
    const before = await snapshot()
    expect((await plan(slug)).result.state).toBe("ready")
    expect(await snapshot()).toEqual(before)
  })

  it("recognizes the selected page's winning original card without claiming HTTP proof", async () => {
    const path = "/tree/two.og.png"
    const { translated, units, plan } = await fixture(false, selected => {
      const original = selected.input.entries.find(entry => entry.path === "/tree/preview.png")
      if (!original) throw new Error("original PNG missing")
      selected.input.entries.push({ ...original, path, locator: { root: "capture", relative: path.slice(1) } })
      selected.observations[path] = selected.observations[original.path]
      selected.files[path] = selected.files[original.path]
      selected.input.owners.push({ path, ownerSourcePageId: "tree/two.html", evidenceRef: "synthetic-edge-evidence", basis: "declared" })
      selected.input.previews.push({ sourcePageId: "tree/two.html", path, kind: "original" })
      selected.input.consumerUrls.push({ url: "https://forge.example.test/s/tree/two.og.png/syntheticTreeKey/", purpose: "card", targetSourcePageId: "tree/two.html", mappingRef: null })
    })
    expect(translated.census).toContainEqual(expect.objectContaining({ kind: "consumerUrl", ordinal: 0, disposition: "represented" }))
    const tree = units.find(unit => unit.sourceArtifactId === "tree:synthetic")
    if (!tree) throw new Error("tree unit missing")
    const before = await snapshot()
    expect((await plan(tree)).result.state).toBe("ready")
    expect(await snapshot()).toEqual(before)
  })

  it("rejects an owned card candidate displaced by the selected original", async () => {
    const { translated, units, plan } = await fixture(false, selected => {
      const original = selected.input.entries.find(entry => entry.path === "/tree/preview.png")
      if (!original) throw new Error("original PNG missing")
      for (const path of ["/tree/two.og.png", "/tree/alternate.png"]) {
        selected.input.entries.push({ ...original, path, locator: { root: "capture", relative: path.slice(1) } })
        selected.observations[path] = selected.observations[original.path]
        selected.files[path] = selected.files[original.path]
        selected.input.owners.push({ path, ownerSourcePageId: "tree/two.html", evidenceRef: "synthetic-edge-evidence", basis: "declared" })
      }
      selected.input.previews.push({ sourcePageId: "tree/two.html", path: "/tree/alternate.png", kind: "original" })
      selected.input.consumerUrls.push({ url: "https://forge.example.test/s/tree/two.og.png/syntheticTreeKey/", purpose: "card", targetSourcePageId: "tree/two.html", mappingRef: null })
    })
    expect(translated.census).toContainEqual(expect.objectContaining({ kind: "consumerUrl", ordinal: 0, disposition: "rejected" }))
    const slug = units.find(unit => unit.sourceArtifactId === "slug:sample")
    if (!slug) throw new Error("independent slug unit missing")
    const before = await snapshot()
    expect((await plan(slug)).result.state).toBe("ready")
    expect(await snapshot()).toEqual(before)
  })

  it("projects a late pin failure consistently without demoting an independent unit", async () => {
    const { translated, units, plan } = await fixture(false, selected => {
      selected.input.consumerUrls.push({ url: "https://forge.example.test/s/sample/?k=syntheticSlugKey", purpose: "share", targetSourcePageId: "sample", mappingRef: null })
    })
    const projected = projectTranslation(translated, [{ kind: "unit", unitId: "slug:sample", code: "inventory_budget_exceeded" }])
    expect(projected.units.find(unit => unit.unitId === "slug:sample")?.status).toBe("blocked")
    expect(projected.census).toContainEqual(expect.objectContaining({ kind: "consumerUrl", ordinal: 0, disposition: "rejected" }))
    expect(projected.compatibility.represented.some(issue => issue.unitId === "slug:sample")).toBe(false)
    const tree = units.find(unit => unit.sourceArtifactId === "tree:synthetic")
    if (!tree) throw new Error("independent tree unit missing")
    const before = await snapshot()
    expect((await plan(tree)).result.state).toBe("ready")
    expect(await snapshot()).toEqual(before)
  })

  it("retains the native warning for an observed unknown visibility value", async () => {
    const { units, plan } = await fixture(false, selected => {
      selected.input.pages.find(page => page.sourcePageId === "tree/one.html")!.visibility = { state: "present", value: "synthetic-unrecognized", metadataV: null, expiresAt: null }
    })
    const tree = units.find(unit => unit.sourceArtifactId === "tree:synthetic")
    if (!tree) throw new Error("tree unit missing")
    const before = await snapshot()
    const result = await plan(tree)
    expect(result.result.state).toBe("ready")
    expect(result.result.warnings).toContainEqual(expect.objectContaining({ code: "unknown_visibility_private" }))
    expect(await snapshot()).toEqual(before)
  })

  it("keeps a root alias legal without treating its shell destination as the page", async () => {
    const configure = (selected: { input: SyntheticInput }) => {
      selected.input.reader.shellPaths.push("/")
      selected.input.aliases.push({ aliasKind: "redirect_exact", path: "/home", to: "/", status: 301, targetSourcePageId: "sample", capturedBehavior: "team_fallback" })
    }
    const legal = await fixture(false, configure)
    const slug = legal.units.find(unit => unit.sourceArtifactId === "slug:sample")
    if (!slug) throw new Error("slug unit missing")
    expect(slug.inventory.operations).toContainEqual(expect.objectContaining({ kind: "alias", path: "/home", to: "/" }))
    expect((await legal.plan(slug)).result.state).toBe("ready")
    const required = await fixture(false, selected => {
      configure(selected)
      selected.input.consumerUrls.push({ url: "https://forge.example.test/home", purpose: "alias", targetSourcePageId: "sample", mappingRef: null })
    })
    expect(required.translated.census).toContainEqual(expect.objectContaining({ kind: "consumerUrl", ordinal: 0, disposition: "rejected" }))
    expect(required.units.some(unit => unit.sourceArtifactId === "slug:sample")).toBe(false)
    const tree = required.units.find(unit => unit.sourceArtifactId === "tree:synthetic")
    if (!tree) throw new Error("independent tree unit missing")
    const before = await snapshot()
    expect((await required.plan(tree)).result.state).toBe("ready")
    expect(await snapshot()).toEqual(before)
  })

  it("does not certify a selected subtree stylesheet as a document", async () => {
    const path = "/a/sample/style.css"
    const { translated, units, plan } = await fixture(false, selected => {
      const original = selected.input.entries.find(entry => entry.path === "/tree/asset0.css")
      if (!original) throw new Error("synthetic stylesheet missing")
      selected.input.entries.push({ ...original, path, locator: { root: "capture", relative: path.slice(1) }, placement: { sourceArtifactId: "slug:sample", evidenceRef: "synthetic-placement" } })
      selected.observations[path] = selected.observations[original.path]
      selected.files[path] = selected.files[original.path]
      selected.input.consumerUrls.push({ url: `https://forge.example.test${path}`, purpose: "document", targetSourcePageId: "sample", mappingRef: null })
    })
    expect(translated.census).toContainEqual(expect.objectContaining({ kind: "consumerUrl", ordinal: 0, disposition: "rejected" }))
    expect(units.some(unit => unit.sourceArtifactId === "slug:sample")).toBe(false)
    const tree = units.find(unit => unit.sourceArtifactId === "tree:synthetic")
    if (!tree) throw new Error("independent tree unit missing")
    const before = await snapshot()
    expect((await plan(tree)).result.state).toBe("ready")
    expect(await snapshot()).toEqual(before)
  })

  it("projects a missing public document at reread as OR-1, unlike a missing stylesheet", async () => {
    const { selected, translated, units, plan } = await fixture()
    const documentOrdinal = selected.input.entries.findIndex(entry => entry.path === "/tree/one.html")
    const assetOrdinal = selected.input.entries.findIndex(entry => entry.path === "/tree/asset0.css")
    expect(documentOrdinal).toBeGreaterThanOrEqual(0)
    expect(assetOrdinal).toBeGreaterThanOrEqual(0)
    const missingDocument = projectTranslation(translated, [{ kind: "source", entryOrdinal: documentOrdinal, stage: "pin_reread", reason: "absent" }])
    expect(missingDocument.compatibility.unsupported).toContainEqual(expect.objectContaining({ code: "or1_missing_document", unitId: "tree:synthetic", path: "/tree/one.html", stage: "pin_reread", basis: "observed_absent" }))
    const missingAsset = projectTranslation(translated, [{ kind: "source", entryOrdinal: assetOrdinal, stage: "pin_reread", reason: "absent" }])
    expect(missingAsset.compatibility.unsupported).not.toContainEqual(expect.objectContaining({ code: "or1_missing_document", unitId: "tree:synthetic" }))
    const slug = units.find(unit => unit.sourceArtifactId === "slug:sample")
    if (!slug) throw new Error("independent slug unit missing")
    const before = await snapshot()
    expect((await plan(slug)).result.state).toBe("ready")
    expect(await snapshot()).toEqual(before)
  })
})
