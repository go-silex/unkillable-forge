import { beforeEach, describe, expect, it } from "vitest"
import worker from "../../adapters/http/manageWorker"
import { syntheticImport } from "./fixtures/import"
import { env, request, setupHttp, signed } from "./fixtures/manage-http"
import { documentCommand } from "./fixtures/publication"

setupHttp()

// Each test has a real pinned synthetic inventory; authentication tests never read it.
let bindings: Record<string, unknown>
beforeEach(async () => { bindings = (await syntheticImport()).bindings })
const path = "/api/maintenance/import"
const call = (assertion: string | null, value: unknown, headers: HeadersInit = {}) => worker.fetch(request(path, "POST", assertion, JSON.stringify(value), { "Content-Type": "application/json", ...headers }), bindings)

async function snapshot() {
  const [principals, sessions, events, objects] = await Promise.all([
    env.DB.prepare("SELECT count(*) AS n FROM principals").first(),
    env.DB.prepare("SELECT count(*) AS n FROM publication_sessions").first(),
    env.DB.prepare("SELECT count(*) AS n FROM mutation_events").first(),
    env.REVISION_BYTES.list(),
  ])
  return { principals, sessions, events, objects: objects.objects.map(({ key, version }) => ({ key, version })) }
}

describe("synthetic import HTTP security", () => {
  it("requires Access on the actual maintenance mount without registering a principal", async () => {
    const doc = await documentCommand("import-http-auth", "/a/import-http/index.html", "synthetic")
    const selection = { version: 1, inventoryId: "synthetic", selectionId: "selection", planId: "plan", command: doc.command }
    const before = await snapshot()
    for (const token of [null, await signed("intruder", { aud: "reader" }), "bad"]) {
      const response = await call(token, { op: "dry_run", selection, cursor: null })
      expect(response.status).toBe(401)
      expect(response.headers.get("cache-control")).toBe("no-store")
      expect(response.headers.get("access-control-allow-origin")).toBeNull()
      expect(response.headers.get("set-cookie")).toBeNull()
    }
    expect(await snapshot()).toEqual(before)
  })

  it("rejects cross-origin requests before identity registration", async () => {
    const before = await snapshot()
    const response = await call(await signed("import-origin-witness"), {}, { Origin: "https://evil.example.test", Cookie: "irrelevant=1" })
    expect(response.status).toBe(403)
    expect(await snapshot()).toEqual(before)
  })

  it("rejects unrecognized operations and caller-supplied approval or source references", async () => {
    const doc = await documentCommand("import-http-strict", "/a/import-strict/index.html", "synthetic")
    const selection = { version: 1, inventoryId: "synthetic", selectionId: "selection", planId: "plan", command: doc.command }
    const jwt = await signed()
    const before = await snapshot()
    for (const value of [
      { op: "operation", checkpoint: {}, operation: {} },
      { op: "apply", selection: { ...selection, historical: false } },
      { op: "apply", selection: { ...selection, objectKey: "caller-controlled" } },
      { op: "dry_run", selection, cursor: null, approval: "caller-controlled" },
    ]) {
      const response = await call(jwt, value)
      expect(response.status).toBe(400)
      expect(response.headers.get("cache-control")).toBe("no-store")
      expect(await response.text()).not.toContain("caller-controlled")
    }
    expect(await snapshot()).toEqual(before)
  })
})
