import { beforeEach, describe, expect, it, vi } from "vitest"
import worker from "../../adapters/http/manageWorker"
import { runtimeFor } from "../../adapters/http/manage-config"
import { admitImportSelection, inspectImportChunk, type ImportApproval } from "../../domains/catalogue/import"
import { authenticateImportRead, authenticateManage, type ImportReadContext } from "../../domains/catalogue/principals"
import { disablePrincipal, revokeRole } from "../../domains/catalogue/commands"
import { principalId } from "./fixtures/catalogue"
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

  it("strictly accepts the optional apply cursor without relaxing authorization", async () => {
    const doc = await documentCommand("import-apply-cursor", "/a/import-apply-cursor/index.html", "synthetic")
    const selection = { version: 1, inventoryId: "synthetic", selectionId: "selection", planId: "plan", command: doc.command }
    const jwt = await signed("unknown-import-user")
    const before = await snapshot()
    for (const value of [
      { op: "apply", selection },
      { op: "apply", selection, cursor: null },
      { op: "apply", selection, cursor: "opaque" },
    ]) expect((await call(jwt, value)).status).toBe(403)
    for (const cursor of [1, {}, "x".repeat(16385)]) {
      expect((await call(jwt, { op: "apply", selection, cursor })).status).toBe(400)
    }
    expect((await call(jwt, { op: "apply", selection, cursor: null, extra: true })).status).toBe(400)
    expect(await snapshot()).toEqual(before)
  })

  it("allows an existing admin but refuses unknown, disabled and revoked principals without writes", async () => {
    const fixture = await syntheticImport()
    const input = { op: "dry_run", selection: fixture.selection, cursor: null }
    const jwt = await signed()
    let before = await snapshot()
    const allowed = await fixture.call(jwt, input)
    expect(allowed.status).toBe(200)
    expect((await allowed.json() as { result: { state: string } }).result.state).toBe("checking")
    expect(await snapshot()).toEqual(before)
    expect((await fixture.call(await signed("unknown-import-user"), input)).status).toBe(403)
    expect(await snapshot()).toEqual(before)
    await env.DB.batch([
      env.DB.prepare("INSERT INTO principals (principal_id, issuer, subject, created_at) VALUES (?, 'https://team.cloudflareaccess.com', 'import-publisher', 1)").bind(`pr_${"b".repeat(26)}`),
      env.DB.prepare("INSERT INTO role_grants (role_grant_id, principal_id, role, scope_kind, origin, granted_at) VALUES (?, ?, 'publisher', 'installation', 'bootstrap', 1)").bind(`rg_${"b".repeat(26)}`, `pr_${"b".repeat(26)}`),
    ])
    before = await snapshot()
    expect((await fixture.call(await signed("import-publisher"), input)).status).toBe(403)
    expect(await snapshot()).toEqual(before)

    const runtime = await runtimeFor(fixture.bindings)
    if (!runtime) throw new Error("test runtime unavailable")
    const operator = await authenticateManage(request(path, "POST", jwt), runtime.deps)
    if (!operator) throw new Error("test admin unavailable")
    const disabledId = `pr_${"d".repeat(26)}`, revokedId = `pr_${"e".repeat(26)}`, revokedRole = `rg_${"e".repeat(26)}`
    await env.DB.batch([
      env.DB.prepare("INSERT INTO principals (principal_id, issuer, subject, created_at) VALUES (?, 'https://team.cloudflareaccess.com', 'disabled-import-admin', 1)").bind(disabledId),
      env.DB.prepare("INSERT INTO principals (principal_id, issuer, subject, created_at) VALUES (?, 'https://team.cloudflareaccess.com', 'revoked-import-admin', 1)").bind(revokedId),
      env.DB.prepare("INSERT INTO role_grants (role_grant_id, principal_id, role, scope_kind, origin, granted_at) VALUES (?, ?, 'admin', 'installation', 'bootstrap', 1)").bind(`rg_${"d".repeat(26)}`, disabledId),
      env.DB.prepare("INSERT INTO role_grants (role_grant_id, principal_id, role, scope_kind, origin, granted_at) VALUES (?, ?, 'admin', 'installation', 'bootstrap', 1)").bind(revokedRole, revokedId),
    ])
    await disablePrincipal(runtime.deps, operator, { targetPrincipalId: disabledId, expectedTargetAuthorityEpoch: 0 })
    before = await snapshot()
    expect((await fixture.call(await signed("disabled-import-admin"), input)).status).toBe(403)
    expect(await snapshot()).toEqual(before)
    await revokeRole(runtime.deps, operator, { targetPrincipalId: revokedId, expectedTargetAuthorityEpoch: 0, roleGrantId: revokedRole })
    before = await snapshot()
    expect((await fixture.call(await signed("revoked-import-admin"), input)).status).toBe(403)
    expect(await snapshot()).toEqual(before)
  })

  it("binds continuation to its signature, operation, administrator and authority epoch", async () => {
    const fixture = await syntheticImport()
    const jwt = await signed()
    await env.DB.batch([
      env.DB.prepare("INSERT INTO principals (principal_id, issuer, subject, created_at) VALUES (?, 'https://team.cloudflareaccess.com', 'other-admin', 1)").bind(`pr_${"c".repeat(26)}`),
      env.DB.prepare("INSERT INTO role_grants (role_grant_id, principal_id, role, scope_kind, origin, granted_at) VALUES (?, ?, 'admin', 'installation', 'bootstrap', 1)").bind(`rg_${"c".repeat(26)}`, `pr_${"c".repeat(26)}`),
    ])
    const before = await snapshot()
    const initial = await fixture.call(jwt, { op: "dry_run", selection: fixture.selection, cursor: null })
    expect(initial.status).toBe(200)
    const result = (await initial.json() as { result: { state: string; nextCursor: string } }).result
    expect(result.state).toBe("checking")
    const cursor = result.nextCursor
    expect(typeof cursor).toBe("string")
    const forged = `${cursor.slice(0, -1)}${cursor.endsWith("0") ? "1" : "0"}`
    expect((await fixture.call(jwt, { op: "dry_run", selection: fixture.selection, cursor: forged })).status).toBe(409)
    expect((await fixture.call(jwt, { op: "apply", selection: fixture.selection, cursor })).status).toBe(409)
    expect((await fixture.call(await signed("other-admin"), { op: "dry_run", selection: fixture.selection, cursor })).status).toBe(409)
    expect(await snapshot()).toEqual(before)
    await env.DB.prepare("UPDATE principals SET authority_epoch = authority_epoch + 1 WHERE principal_id = ?").bind(principalId).run()
    const afterEpoch = await snapshot()
    expect((await fixture.call(jwt, { op: "dry_run", selection: fixture.selection, cursor })).status).toBe(409)
    expect(await snapshot()).toEqual(afterEpoch)
  })

  it("refuses a continuation after its original identity expires even with a fresh token", async () => {
    const fixture = await syntheticImport()
    let now = Date.now()
    const clock = vi.spyOn(Date, "now").mockImplementation(() => now)
    try {
      const shortJwt = await signed("admin", { exp: Math.floor(now / 1000) + 60 })
      const freshJwt = await signed()
      const before = await snapshot()
      const initial = await fixture.call(shortJwt, { op: "dry_run", selection: fixture.selection, cursor: null })
      expect(initial.status).toBe(200)
      const result = (await initial.json() as { result: { state: string; nextCursor: string } }).result
      expect(result.state).toBe("checking")
      now += 61000
      expect((await fixture.call(freshJwt, { op: "dry_run", selection: fixture.selection, cursor: result.nextCursor })).status).toBe(409)
      expect(await snapshot()).toEqual(before)
    } finally { clock.mockRestore() }
  })

  it("rejects forged read authority and rechecks a minted context after revocation", async () => {
    const fixture = await syntheticImport()
    const runtime = await runtimeFor(fixture.bindings)
    if (!runtime) throw new Error("test runtime unavailable")
    const targetId = `pr_${"f".repeat(26)}`, targetRole = `rg_${"f".repeat(26)}`
    await env.DB.batch([
      env.DB.prepare("INSERT INTO principals (principal_id, issuer, subject, created_at) VALUES (?, 'https://team.cloudflareaccess.com', 'context-admin', 1)").bind(targetId),
      env.DB.prepare("INSERT INTO role_grants (role_grant_id, principal_id, role, scope_kind, origin, granted_at) VALUES (?, ?, 'admin', 'installation', 'bootstrap', 1)").bind(targetRole, targetId),
    ])
    const operator = await authenticateManage(request(path, "POST", await signed()), runtime.deps)
    if (!operator) throw new Error("test admin unavailable")
    const context = await authenticateImportRead(request(path, "POST", await signed("context-admin")), runtime.deps)
    await expect(admitImportSelection(fixture.selection, fixture.inventory, fixture.approval as ImportApproval, runtime.deps, {} as ImportReadContext)).rejects.toMatchObject({ code: "unauthenticated" })
    const admitted = await admitImportSelection(fixture.selection, fixture.inventory, fixture.approval as ImportApproval, runtime.deps, context)
    await revokeRole(runtime.deps, operator, { targetPrincipalId: targetId, expectedTargetAuthorityEpoch: 0, roleGrantId: targetRole })
    const before = await snapshot()
    await expect(inspectImportChunk(runtime.deps, admitted, null, "one")).rejects.toMatchObject({ code: "forbidden" })
    await expect(admitImportSelection(fixture.selection, fixture.inventory, fixture.approval as ImportApproval, runtime.deps, context)).rejects.toMatchObject({ code: "forbidden" })
    expect(await snapshot()).toEqual(before)
  })
})
