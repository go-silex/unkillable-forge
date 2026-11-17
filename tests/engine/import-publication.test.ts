import { describe, expect, it, vi } from "vitest"
import { RevisionStore } from "../../domains/store/revision-store"
import { newId } from "../../domains/catalogue/ids"
import { instanceId, pageFixture } from "./fixtures/catalogue"
import { env, setupHttp, signed } from "./fixtures/manage-http"
import { importResult, syntheticImport } from "./fixtures/import"
import { content, storedBytes } from "./fixtures/publication"

setupHttp()

async function snapshot() {
  const tables = await env.DB.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' ORDER BY name").all<{ name: string }>()
  const rows = await Promise.all(tables.results.map(async ({ name }) => [name, (await env.DB.prepare(`SELECT * FROM \"${name.replace(/\"/g, '\"\"')}\"`).all()).results]))
  const objects = await env.REVISION_BYTES.list()
  return { rows, objects: objects.objects.map(({ key, version }) => ({ key, version })) }
}

async function advance(call: (jwt: string, body: unknown) => Promise<Response>, jwt: string, selection: unknown, op: "dry_run" | "apply", initial: string | null = null) {
  let cursor = initial
  for (let i = 0; i < 128; i++) {
    const response = await call(jwt, { op, selection, cursor })
    if (response.status !== 200) return response
    const result = (await response.clone().json() as { result: Record<string, any> }).result
    if (result.state !== "checking") return response
    cursor = result.nextCursor
  }
  throw new Error("import checking did not finish")
}

async function finish(call: (jwt: string, body: unknown) => Promise<Response>, jwt: string, selection: unknown, cursor: string | null = null) {
  for (let i = 0; i < 128; i++) {
    const result = await importResult(await advance(call, jwt, selection, "apply", cursor))
    if (result.state === "committed") return result
    expect(result.state).toBe("staging")
    cursor = result.nextCursor
  }
  throw new Error("synthetic import failed to finish")
}

async function firstCursor(call: (jwt: string, body: unknown) => Promise<Response>, jwt: string, selection: unknown, op: "dry_run" | "apply") {
  const result = await importResult(await call(jwt, { op, selection, cursor: null }))
  expect(result.state).toBe("checking")
  return result.nextCursor as string
}

describe("synthetic selected import through the real management endpoint", () => {
  it("dry-runs without any D1 write or R2 object version change", async () => {
    const fixture = await syntheticImport(undefined, 9)
    const jwt = await signed()
    const before = await snapshot()
    const first = await importResult(await fixture.call(jwt, { op: "dry_run", selection: fixture.selection, cursor: null }))
    expect(first.state).toBe("checking")
    const tampered = `${first.nextCursor.slice(0, -1)}${first.nextCursor.endsWith("0") ? "1" : "0"}`
    expect((await fixture.call(jwt, { op: "dry_run", selection: fixture.selection, cursor: tampered })).status).toBe(409)
    let cursor: string | null = first.nextCursor
    for (let i = 0; i < 32; i++) {
      const result = await importResult(await fixture.call(jwt, { op: "dry_run", selection: fixture.selection, cursor }))
      if (result.state === "ready") { expect(await snapshot()).toEqual(before); return }
      expect(result.state).toBe("checking")
      expect(typeof result.nextCursor).toBe("string")
      cursor = result.nextCursor
      expect(await snapshot()).toEqual(before)
    }
    throw new Error("dry-run did not finish within 32 bounded calls")
  })

  it("resumes the same publication and preserves bytes without duplicate artefacts on replay", async () => {
    const fixture = await syntheticImport(undefined, 9)
    const now = Date.now()
    const clock = vi.spyOn(Date, "now").mockReturnValue(now)
    const jwt = await signed("admin", { exp: Math.floor(now / 1000) + 60 })
    // The client stops after receiving this partial result, then resumes the same plan.
    const interrupted = await importResult(await advance(fixture.call, jwt, fixture.selection, "apply"))
    expect(interrupted.state).toBe("staging")
    expect(interrupted.session.files.some((file: { stored: boolean }) => file.stored)).toBe(true)
    expect(interrupted.session.files.some((file: { stored: boolean }) => !file.stored)).toBe(true)
    const forged = `${interrupted.nextCursor.slice(0, -1)}${interrupted.nextCursor.endsWith("0") ? "1" : "0"}`
    expect((await fixture.call(jwt, { op: "apply", selection: fixture.selection, cursor: forged })).status).toBe(409)
    const first = await finish(fixture.call, jwt, fixture.selection)
    expect((await fixture.call(jwt, { op: "apply", selection: fixture.selection, cursor: forged })).status).toBe(409)
    clock.mockReturnValue(now + 61000)
    try {
      const replay = await finish(fixture.call, await signed(), fixture.selection, interrupted.nextCursor)
      expect(replay.publication).toEqual(first.publication)
    } finally { clock.mockRestore() }
    expect(await env.DB.prepare("SELECT count(*) AS n FROM artifacts").first()).toEqual({ n: 1 })
    expect(await env.DB.prepare("SELECT content_version FROM artifacts").first()).toEqual({ content_version: 1 })
    expect(await env.DB.prepare("SELECT count(*) AS n FROM publication_events WHERE action='commit'").first()).toEqual({ n: 1 })
    expect(await env.DB.prepare("SELECT count(*) AS n FROM publication_imports").first()).toEqual({ n: 1 })
    const publication = first.publication
    const store = new RevisionStore(env.REVISION_BYTES, instanceId)
    expect(await storedBytes(store, { artifactId: publication.artifactId, revisionId: publication.revisionId, kind: "resource", path: fixture.command.files[0].path })).toEqual(fixture.bytes)
    for (const extra of fixture.extraBytes) expect(await storedBytes(store, { artifactId: publication.artifactId, revisionId: publication.revisionId, kind: "resource", path: extra.path })).toEqual(extra.bytes)
  })

  it("rejects a changed command under an already staged plan identity", async () => {
    const fixture = await syntheticImport(undefined, 9)
    const jwt = await signed()
    const staged = await importResult(await advance(fixture.call, jwt, fixture.selection, "apply"))
    expect(staged.state).toBe("staging")
    const changed = { ...fixture.selection, command: { ...fixture.selection.command, expectedContentVersion: 1 } }
    const response = await fixture.call(jwt, { op: "apply", selection: changed })
    expect(response.status).toBe(409)
    expect(await env.DB.prepare("SELECT count(*) AS n FROM artifacts WHERE active_revision_id IS NOT NULL").first()).toEqual({ n: 0 })
    expect(await env.DB.prepare("SELECT count(*) AS n FROM publication_imports").first()).toEqual({ n: 0 })
  })

  it("refuses changed source versions instead of importing replacement bytes", async () => {
    const fixture = await syntheticImport()
    await fixture.bindings.FORGE_IMPORT_SOURCE.put(fixture.sourceKey, "changed synthetic bytes")
    const jwt = await signed()
    const dryRun = await importResult(await advance(fixture.call, jwt, fixture.selection, "dry_run"))
    expect(dryRun.state).toBe("blocked")
    expect(dryRun.issues).toContainEqual({ code: "source_integrity", path: fixture.command.files[0].path })
    const apply = await importResult(await advance(fixture.call, jwt, fixture.selection, "apply"))
    expect(apply.state).toBe("blocked")
    expect(apply.issues).toContainEqual({ code: "source_integrity", path: fixture.command.files[0].path })
    expect(await env.DB.prepare("SELECT count(*) AS n FROM publication_sessions").first()).toEqual({ n: 1 })
    expect(await env.DB.prepare("SELECT count(*) AS n FROM artifacts WHERE active_revision_id IS NOT NULL").first()).toEqual({ n: 0 })
    expect(await env.DB.prepare("SELECT count(*) AS n FROM publication_imports").first()).toEqual({ n: 0 })
  })

  it("rejects a pinned source whose bytes disagree with its approved digest", async () => {
    const fixture = await syntheticImport()
    const sha256 = "0".repeat(64)
    const command = { ...fixture.selection.command, files: fixture.selection.command.files.map(file => ({ ...file, sha256 })) }
    const selection = { ...fixture.selection, command }
    const inventory = { ...fixture.inventory, command, files: fixture.inventory.files.map(file => ({ ...file, sha256 })) }
    const encoded = JSON.stringify(inventory)
    const object = await fixture.bindings.FORGE_IMPORT_SOURCE.put("synthetic/bad-digest-inventory.json", encoded)
    if (!object) throw new Error("Synthetic inventory upload failed")
    fixture.bindings.FORGE_IMPORT_INVENTORIES = JSON.stringify([{ ...fixture.approval, objectKey: object.key, objectVersion: object.version, sha256: (await content(encoded)).sha256 }])
    const jwt = await signed()
    const dryRun = await importResult(await advance(fixture.call, jwt, selection, "dry_run"))
    expect(dryRun.state).toBe("blocked")
    expect(dryRun.issues).toContainEqual({ code: "source_integrity", path: command.files[0].path })
    const apply = await importResult(await advance(fixture.call, jwt, selection, "apply"))
    expect(apply.state).toBe("blocked")
    expect(apply.issues).toContainEqual({ code: "source_integrity", path: command.files[0].path })
    expect(await env.DB.prepare("SELECT count(*) AS n FROM publication_sessions").first()).toEqual({ n: 1 })
    expect(await env.DB.prepare("SELECT count(*) AS n FROM artifacts WHERE active_revision_id IS NOT NULL").first()).toEqual({ n: 0 })
    expect(await env.DB.prepare("SELECT count(*) AS n FROM publication_imports").first()).toEqual({ n: 0 })
  })

  it("rejects cursors across operations, actors and authority epochs", async () => {
    const fixture = await syntheticImport()
    const jwt = await signed()
    const cursor = await firstCursor(fixture.call, jwt, fixture.selection, "apply")
    expect((await fixture.call(jwt, { op: "dry_run", selection: fixture.selection, cursor })).status).toBe(409)
    const tampered = `${cursor.slice(0, -1)}${cursor.endsWith("0") ? "1" : "0"}`
    expect((await fixture.call(jwt, { op: "apply", selection: fixture.selection, cursor: tampered })).status).toBe(409)
    const principal = newId("pr")
    await env.DB.prepare("INSERT INTO principals (principal_id,issuer,subject,created_at) VALUES (?,'https://team.cloudflareaccess.com','other',1)").bind(principal).run()
    await env.DB.prepare("INSERT INTO role_grants (role_grant_id,principal_id,role,scope_kind,origin,granted_at) VALUES (?,?,'admin','installation','bootstrap',1)").bind(newId("rg"), principal).run()
    expect((await fixture.call(await signed("other"), { op: "apply", selection: fixture.selection, cursor })).status).toBe(409)
    await env.DB.prepare("UPDATE principals SET authority_epoch=authority_epoch+1 WHERE subject='admin'").run()
    expect((await fixture.call(jwt, { op: "apply", selection: fixture.selection, cursor })).status).toBe(409)
  })

  it("rejects an expired cursor even with a fresh valid identity", async () => {
    const fixture = await syntheticImport()
    const now = Date.now()
    const clock = vi.spyOn(Date, "now").mockReturnValue(now)
    const shortJwt = await signed("admin", { exp: Math.floor(now / 1000) + 10 })
    const cursor = await firstCursor(fixture.call, shortJwt, fixture.selection, "apply")
    const dryCursor = await firstCursor(fixture.call, shortJwt, fixture.selection, "dry_run")
    clock.mockReturnValue(now + 11000)
    try {
      const freshJwt = await signed()
      expect((await fixture.call(freshJwt, { op: "apply", selection: fixture.selection, cursor })).status).toBe(409)
      expect((await fixture.call(freshJwt, { op: "dry_run", selection: fixture.selection, cursor: dryCursor })).status).toBe(409)
      expect(await env.DB.prepare("SELECT count(*) AS n FROM publication_sessions").first()).toEqual({ n: 0 })
      expect(await env.DB.prepare("SELECT count(*) AS n FROM publication_imports").first()).toEqual({ n: 0 })
    } finally { clock.mockRestore() }
  })

  it("does not report ready when a target route is occupied during continuation", async () => {
    const fixture = await syntheticImport()
    const jwt = await signed()
    let cursor: string | null = null
    let observedSourcePhase = false
    for (let i = 0; i < 128; i++) {
      const result = await importResult(await fixture.call(jwt, { op: "dry_run", selection: fixture.selection, cursor }))
      expect(result.state).toBe("checking")
      cursor = result.nextCursor
      const payload = cursor!.split(".")[0].replace(/-/g, "+").replace(/_/g, "/")
      const state = JSON.parse(atob(payload)) as { phase: string }
      if (state.phase === "source") { observedSourcePhase = true; break }
    }
    expect(observedSourcePhase).toBe(true)
    await pageFixture({ route: { kind: "subtree", slug: "synthetic-import" } })
    const response = await advance(fixture.call, jwt, fixture.selection, "dry_run", cursor)
    if (response.status === 200) expect((await importResult(response)).state).toBe("blocked")
    else expect(response.status).toBe(409)
  })
  it("resumes a selection exceeding 128 metadata entries", async () => {
    const fixture = await syntheticImport(undefined, 65)
    const jwt = await signed()
    let cursor: string | null = null
    let continuations = 0
    for (let i = 0; i < 64; i++) {
      const result = await importResult(await fixture.call(jwt, { op: "dry_run", selection: fixture.selection, cursor }))
      if (result.state === "ready") {
        expect(continuations).toBeGreaterThan(1)
        const committed = await finish(fixture.call, jwt, fixture.selection)
        expect(committed.state).toBe("committed")
        expect(await env.DB.prepare("SELECT count(*) AS n FROM publication_imports").first()).toEqual({ n: 1 })
        expect(await env.DB.prepare("SELECT count(*) AS n FROM revision_resources WHERE revision_id=?").bind(committed.publication.revisionId).first()).toEqual({ n: 66 })
        const last = fixture.extraBytes[fixture.extraBytes.length - 1]
        const store = new RevisionStore(env.REVISION_BYTES, instanceId)
        expect(await storedBytes(store, { artifactId: committed.publication.artifactId, revisionId: committed.publication.revisionId, kind: "resource", path: last.path })).toEqual(last.bytes)
        return
      }
      expect(result.state).toBe("checking")
      cursor = result.nextCursor
      continuations++
    }
    throw new Error("large dry-run did not finish within 64 bounded calls")
  }, 30000)

})
