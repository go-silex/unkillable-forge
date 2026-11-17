import { describe, expect, it } from "vitest"
import { RevisionStore } from "../../domains/store/revision-store"
import { instanceId } from "./fixtures/catalogue"
import { env, setupHttp, signed } from "./fixtures/manage-http"
import { importResult, syntheticImport } from "./fixtures/import"
import { storedBytes } from "./fixtures/publication"

setupHttp()

async function snapshot() {
  const tables = await env.DB.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' ORDER BY name").all<{ name: string }>()
  const rows = await Promise.all(tables.results.map(async ({ name }) => [name, (await env.DB.prepare(`SELECT * FROM \"${name.replace(/\"/g, '\"\"')}\"`).all()).results]))
  const objects = await env.REVISION_BYTES.list()
  return { rows, objects: objects.objects.map(({ key, version }) => ({ key, version })) }
}

async function finish(call: (jwt: string, body: unknown) => Promise<Response>, jwt: string, selection: unknown) {
  for (let i = 0; i < 32; i++) {
    const result = await importResult(await call(jwt, { op: "apply", selection }))
    if (result.state === "committed") return result
    expect(result.state).toBe("staging")
  }
  throw new Error("synthetic import failed to finish within 32 bounded calls")
}

describe("synthetic selected import through the real management endpoint", () => {
  it("dry-runs without any D1 write or R2 object version change", async () => {
    const fixture = await syntheticImport(undefined, 9)
    const jwt = await signed()
    const before = await snapshot()
    let cursor: string | null = null
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
    const jwt = await signed()
    // The client stops after receiving this partial result, then resumes the same plan.
    const interrupted = await importResult(await fixture.call(jwt, { op: "apply", selection: fixture.selection }))
    expect(interrupted.state).toBe("staging")
    expect(interrupted.session.files.some((file: { stored: boolean }) => file.stored)).toBe(true)
    expect(interrupted.session.files.some((file: { stored: boolean }) => !file.stored)).toBe(true)
    const first = await finish(fixture.call, jwt, fixture.selection)
    const replay = await finish(fixture.call, jwt, fixture.selection)
    expect(replay.publication).toEqual(first.publication)
    expect(await env.DB.prepare("SELECT count(*) AS n FROM artifacts").first()).toEqual({ n: 1 })
    expect(await env.DB.prepare("SELECT count(*) AS n FROM publication_imports").first()).toEqual({ n: 1 })
    const publication = first.publication
    const store = new RevisionStore(env.REVISION_BYTES, instanceId)
    expect(await storedBytes(store, { artifactId: publication.artifactId, revisionId: publication.revisionId, kind: "resource", path: fixture.command.files[0].path })).toEqual(fixture.bytes)
    for (const extra of fixture.extraBytes) expect(await storedBytes(store, { artifactId: publication.artifactId, revisionId: publication.revisionId, kind: "resource", path: extra.path })).toEqual(extra.bytes)
  })

  it("rejects a changed command under an already staged plan identity", async () => {
    const fixture = await syntheticImport(undefined, 9)
    const jwt = await signed()
    const staged = await importResult(await fixture.call(jwt, { op: "apply", selection: fixture.selection }))
    expect(staged.state).toBe("staging")
    const changed = { ...fixture.selection, command: { ...fixture.selection.command, expectedContentVersion: 1 } }
    const response = await fixture.call(jwt, { op: "apply", selection: changed })
    expect(response.status).toBe(409)
    expect(await env.DB.prepare("SELECT count(*) AS n FROM artifacts WHERE active_revision_id IS NOT NULL").first()).toEqual({ n: 0 })
    expect(await env.DB.prepare("SELECT count(*) AS n FROM publication_imports").first()).toEqual({ n: 0 })
  })

  it("refuses changed source versions instead of importing replacement bytes", async () => {
    const fixture = await syntheticImport()
    await env.FORGE_IMPORT_SOURCE.put(fixture.sourceKey, "changed synthetic bytes")
    const response = await fixture.call(await signed(), { op: "apply", selection: fixture.selection })
    expect(response.status === 409 || response.status === 400 || (response.status === 200 && (await response.json() as { result: { state: string } }).result.state === "blocked")).toBe(true)
    expect(await env.DB.prepare("SELECT count(*) AS n FROM artifacts WHERE active_revision_id IS NOT NULL").first()).toEqual({ n: 0 })
    expect(await env.DB.prepare("SELECT count(*) AS n FROM publication_imports").first()).toEqual({ n: 0 })
  })
})
