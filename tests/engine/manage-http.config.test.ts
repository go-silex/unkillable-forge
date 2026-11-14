import { applyD1Migrations } from "cloudflare:test"
import { describe, expect, it } from "vitest"
import worker from "../../adapters/http/manageWorker"
import { manageHttpBindings } from "./fixtures/manage-http-bindings"
import { command, env, request, setupHttp, signed, status } from "./fixtures/manage-http"
import { documentCommand } from "./fixtures/publication"

setupHttp()
const configured = () => ({ ...manageHttpBindings, DB: env.DB, REVISION_BYTES: env.REVISION_BYTES })

describe("manage runtime configuration", () => {
  it("fails closed on missing, malformed, unsafe and constructor-invalid settings", async () => {
    const jwt = await signed()
    const publication = JSON.parse(manageHttpBindings.FORGE_PUBLICATION_OPTIONS)
    const transport = JSON.parse(manageHttpBindings.FORGE_MANAGE_TRANSPORT)
    const cases: Record<string, unknown>[] = [
      { DB: undefined }, { REVISION_BYTES: undefined }, { REVISION_BYTES: {} },
      { FORGE_INSTANCE: "{" }, { FORGE_SHARE_VERIFIER_KEYS: "[]" },
      { FORGE_PUBLICATION_OPTIONS: undefined }, { FORGE_PUBLICATION_OPTIONS: "{" },
      { FORGE_PUBLICATION_OPTIONS: publication }, { FORGE_PUBLICATION_OPTIONS: JSON.stringify({ ...publication, maxUploadTimeoutMs: 2147483648 }) },
      { FORGE_PUBLICATION_OPTIONS: JSON.stringify({ ...publication, extra: 1 }) },
      { FORGE_PUBLICATION_OPTIONS: JSON.stringify({ ...publication, sessionTtlMs: undefined }) },
      { FORGE_PUBLICATION_OPTIONS: JSON.stringify({ ...publication, sessionTtlMs: "1" }) },
      { FORGE_PUBLICATION_OPTIONS: JSON.stringify({ ...publication, retainMs: 1 }) },
      { FORGE_PUBLICATION_OPTIONS: JSON.stringify({ ...publication, marginMs: 1 }) },
      { FORGE_PUBLICATION_OPTIONS: JSON.stringify({ ...publication, sessionTtlMs: Number.MAX_SAFE_INTEGER + 1 }) },
      { FORGE_MANAGE_TRANSPORT: undefined }, { FORGE_MANAGE_TRANSPORT: "{" },
      { FORGE_MANAGE_TRANSPORT: transport }, { FORGE_MANAGE_TRANSPORT: JSON.stringify({ ...transport, commandReadTimeoutMs: 2147483648 }) },
      { FORGE_MANAGE_TRANSPORT: JSON.stringify({ ...transport, extra: true }) },
      { FORGE_MANAGE_TRANSPORT: JSON.stringify({ ...transport, maxUploadBytes: undefined }) },
      { FORGE_MANAGE_TRANSPORT: JSON.stringify({ ...transport, maxUploadBytes: Number.MAX_SAFE_INTEGER + 1 }) },
      { FORGE_MANAGE_TRANSPORT: JSON.stringify({ ...transport, maxJsonDepth: "16" }) },
      { FORGE_MANAGE_TRANSPORT: JSON.stringify({ ...transport, maxJsonDepth: 65 }) },
      { FORGE_MANAGE_TRANSPORT: JSON.stringify({ ...transport, maxUploadBytes: 0 }) },
    ]
    for (const change of cases) {
      const response = await worker.fetch(request("/api/publication", "POST", jwt, '{}', { "Content-Type": "application/json" }), { ...configured(), ...change })
      expect(response.status).toBe(503)
      expect(response.headers.get("cache-control")).toBe("no-store")
      expect(await response.json()).toEqual({ ok: false, error: { code: "configuration_error" } })
    }
  })

  it("does not fall back from an empty or foreign primary and confines sessions to each instance", async () => {
    const jwt = await signed()
    const doc = await documentCommand("instance-isolation", "/a/isolation/index.html", "isolation")
    const session = await status(await command(jwt, { op: "begin", command: doc.command }))
    const requestStatus = () => request("/api/publication", "POST", jwt, JSON.stringify({ op: "status", sessionId: session.sessionId }), { "Content-Type": "application/json" })
    const empty = await worker.fetch(requestStatus(), { ...configured(), DB: env.EMPTY_DB })
    expect(empty.status).toBe(503)
    await applyD1Migrations(env.OTHER_DB, env.TEST_MIGRATIONS)
    await env.OTHER_DB.batch([
      env.OTHER_DB.prepare("INSERT INTO instance_meta (singleton, instance_id, contract_version, created_at) VALUES (1, ?, 1, 1)").bind("other-forge"),
      env.OTHER_DB.prepare("INSERT INTO principals (principal_id, issuer, subject, created_at) VALUES (?, 'https://team.cloudflareaccess.com', 'admin', 1)").bind(`pr_${"b".repeat(26)}`),
      env.OTHER_DB.prepare("INSERT INTO role_grants (role_grant_id, principal_id, role, scope_kind, origin, granted_at) VALUES (?, ?, 'admin', 'installation', 'bootstrap', 1)").bind(`rg_${"b".repeat(26)}`, `pr_${"b".repeat(26)}`),
    ])
    const foreign = await worker.fetch(requestStatus(), { ...configured(), DB: env.OTHER_DB })
    expect(foreign.status).toBe(503)
    const instance = { ...JSON.parse(manageHttpBindings.FORGE_INSTANCE), instanceId: "other-forge" }
    const otherBindings = { ...configured(), DB: env.OTHER_DB, FORGE_INSTANCE: JSON.stringify(instance) }
    const other = await worker.fetch(requestStatus(), otherBindings)
    expect(other.status).toBe(404)
    expect(await other.json()).toEqual({ ok: false, error: { code: "not_found" } })
    const secondDoc = await documentCommand("independent-second-instance", "/a/second/index.html", "other")
    const second = await status(await worker.fetch(request("/api/publication", "POST", jwt, JSON.stringify({ op: "begin", command: secondDoc.command }), { "Content-Type": "application/json" }), otherBindings))
    expect(second.sessionId).not.toBe(session.sessionId)
    const ownStatus = await worker.fetch(request("/api/publication", "POST", jwt, JSON.stringify({ op: "status", sessionId: second.sessionId }), { "Content-Type": "application/json" }), otherBindings)
    expect(await status(ownStatus)).toMatchObject({ sessionId: second.sessionId, state: "open" })
    expect(await status(await command(jwt, { op: "status", sessionId: session.sessionId }))).toMatchObject({ sessionId: session.sessionId })
  })
  it("rejects a foreign-instance session in the same primary database", async () => {
    const jwt = await signed()
    const doc = await documentCommand("foreign-session-marker", "/a/session-marker/index.html", "owned")
    const session = await status(await command(jwt, { op: "begin", command: doc.command }))
    const lookup = () => command(jwt, { op: "status", sessionId: session.sessionId })
    expect(await status(await lookup())).toMatchObject({ sessionId: session.sessionId, state: "open" })
    // Simulate a foreign session row in the same real primary; leave the instance marker untouched.
    await env.DB.prepare("UPDATE publication_sessions SET instance_id = ? WHERE session_id = ?").bind("other-forge", session.sessionId).run()
    const denied = await lookup()
    expect(denied.status).toBe(404)
    expect(await denied.json()).toEqual({ ok: false, error: { code: "not_found" } })
    await env.DB.prepare("UPDATE publication_sessions SET instance_id = ? WHERE session_id = ?").bind("test-forge", session.sessionId).run()
    expect(await status(await lookup())).toMatchObject({ sessionId: session.sessionId, state: "open" })
  })
})
