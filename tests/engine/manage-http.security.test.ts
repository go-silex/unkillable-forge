import { describe, expect, it } from "vitest"
import worker from "../../adapters/http/manageWorker"
import { manageHttpBindings } from "./fixtures/manage-http-bindings"
import { command, dispatch, env, request, setupHttp, signed, status } from "./fixtures/manage-http"
import { documentCommand } from "./fixtures/publication"

setupHttp()

async function error(response: Response, status: number, code: string) {
  expect(response.status).toBe(status)
  expect(response.headers.get("cache-control")).toBe("no-store")
  expect(response.headers.get("x-content-type-options")).toBe("nosniff")
  expect(response.headers.get("referrer-policy")).toBe("no-referrer")
  expect(response.headers.get("content-security-policy")).toBe("default-src 'none'; frame-ancestors 'none'")
  expect(response.headers.get("content-type")).toBe("application/json; charset=utf-8")
  expect(response.headers.get("access-control-allow-origin")).toBeNull()
  expect(response.headers.get("set-cookie")).toBeNull()
  const text = await response.text()
  expect(new TextEncoder().encode(text).byteLength).toBeLessThan(512)
  expect(JSON.parse(text)).toEqual({ ok: false, error: { code } })
}

describe("manage HTTP security", () => {
  it("rejects bad browser origins before a valid unseen principal can self-register", async () => {
    const jwt = await signed("origin-witness")
    const count = async () => (await env.DB.prepare("SELECT count(*) AS n FROM principals WHERE subject = ?").bind("origin-witness").first<{ n: number }>())?.n
    expect(await count()).toBe(0)
    const sessions = await env.DB.prepare("SELECT count(*) AS n FROM publication_sessions").first()
    const objects = await env.REVISION_BYTES.list()
    const cases: HeadersInit[] = [
      { Cookie: "irrelevant=1" },
      { Cookie: "irrelevant=1", Origin: "https://forge.example.test" },
      { Cookie: "irrelevant=1", Origin: "null" },
      { Cookie: "irrelevant=1", Referer: "https://manage.example.test/" },
    ]
    for (const headers of cases) {
      const requestHeaders = new Headers(headers)
      requestHeaders.set("Content-Type", "application/json")
      await error(await dispatch(request("/api/publication", "POST", jwt, JSON.stringify({ op: "status", sessionId: "unknown" }), requestHeaders)), 403, "forbidden")
      expect(await count()).toBe(0)
      expect(await env.DB.prepare("SELECT count(*) AS n FROM publication_sessions").first()).toEqual(sessions)
      expect((await env.REVISION_BYTES.list()).objects).toEqual(objects.objects)
    }
    await command(jwt, { op: "status", sessionId: "unknown" })
    expect(await count()).toBe(1)
  })

  it("rejects wrong hosts, browser metadata, and preflight without CORS", async () => {
    const jwt = await signed()
    for (const host of ["forge.example.test", "alias.example.test", "test.workers.dev", "unknown.example.test", "manage.example.test:444"]) {
      const req = new Request(`https://${host}/api/publication`, { method: "POST", headers: { "Content-Type": "application/json", "Cf-Access-Jwt-Assertion": jwt }, body: "{}" })
      await error(await dispatch(req), 403, "forbidden")
    }
    await error(await dispatch(request("/api/publication", "POST", jwt, "{}", { "Content-Type": "application/json", "Sec-Fetch-Site": "cross-site" })), 403, "forbidden")
    const preflight = await dispatch(request("/api/publication", "OPTIONS", jwt))
    expect(preflight.status).toBe(405)
    expect(preflight.headers.get("allow")).toBe("POST")
    expect(preflight.headers.get("access-control-allow-origin")).toBeNull()
    const head = await dispatch(request("/api/publication", "HEAD", jwt))
    expect(head.status).toBe(405)
    expect(head.headers.get("allow")).toBe("POST")
    expect(await head.text()).toBe("")
    expect(head.headers.get("cache-control")).toBe("no-store")
    const wrongMethod = await dispatch(request("/api/publication/upload", "POST", jwt))
    expect(wrongMethod.status).toBe(405)
    expect(wrongMethod.headers.get("allow")).toBe("PUT")
  })

  it("requires Access assertions and never treats bearer or share cookies as manage credentials", async () => {
    const valid = await signed()
    const candidates = [await signed("x", { iss: "https://wrong.cloudflareaccess.com" }), await signed("x", { aud: "reader" }), await signed("x", { exp: 1 }), `${valid}broken`]
    for (const candidate of candidates) await error(await command(candidate, { op: "status", sessionId: "unknown" }), 401, "unauthenticated")
    await error(await dispatch(request("/api/publication", "POST", null, '{}', { "Content-Type": "application/json", Authorization: `Bearer ${valid}` })), 401, "unauthenticated")
    await error(await dispatch(request("/api/publication", "POST", null, '{}', { "Content-Type": "application/json", Origin: "https://manage.example.test", Cookie: "forge_share=page|key" })), 401, "unauthenticated")
    await error(await dispatch(request("/api/publication", "POST", "bad", '{}', { "Content-Type": "application/json", Origin: "https://manage.example.test", Cookie: `CF_Authorization=${valid}` })), 401, "unauthenticated")
    const { command: begin } = await documentCommand("unprivileged", "/a/unprivileged/index.html", "x")
    await error(await command(await signed("unprivileged"), { op: "begin", command: begin }), 403, "forbidden")
  })

  it("accepts exact-origin Access cookies and never reflects credentials or private claims", async () => {
    const jwt = await signed("admin", { email: "private-claim@example.test" })
    const response = await dispatch(request("/api/publication", "POST", null, JSON.stringify({ op: "status", sessionId: "unknown" }), { Origin: "https://manage.example.test", Cookie: `CF_Authorization=${jwt}`, "Content-Type": "application/json" }))
    expect(response.status).not.toBe(401)
    expect(response.status).not.toBe(403)
    const text = await response.text()
    expect(text).not.toContain(jwt)
    expect(text).not.toContain("private-claim-witness")
    expect(text).not.toContain("private-claim@example.test")
    expect(response.headers.get("set-cookie")).toBeNull()
  })

  it("strictly validates JSON envelopes, selectors, media and byte limits", async () => {
    const jwt = await signed()
    await error(await dispatch(request("/api/publication", "POST", jwt, JSON.stringify({ op: "status", sessionId: "unknown" }), { "Content-Type": "Application/JSON; charset=UTF-8", "Content-Encoding": "identity" })), 404, "not_found")
    for (const value of [null, [], 1, {}, { op: "status" }, { op: "status", sessionId: "x", extra: 1 }, { op: "unknown" }, { op: "begin", command: null }]) {
      await error(await command(jwt, value), 400, "invalid_request")
    }
    for (const raw of ["{", "1e999", JSON.stringify({ op: "status", sessionId: "x", nested: Array.from({ length: 1 }, () => 1) })]) {
      await error(await dispatch(request("/api/publication", "POST", jwt, raw, { "Content-Type": "application/json" })), 400, "invalid_request")
    }
    await error(await dispatch(request("/api/publication", "POST", jwt, "{}", { "Content-Type": "text/plain" })), 415, "unsupported_media_type")
    await error(await dispatch(request("/api/publication", "POST", jwt, "x".repeat(32769), { "Content-Type": "application/json" })), 413, "payload_too_large")
    for (const query of ["sessionId=x", "sessionId=x&path=a&path=b", "sessionId=x&sessionId=y&path=a", "sessionId=x&path=a&extra=1"]) {
      await error(await dispatch(request(`/api/publication/upload?${query}`, "PUT", jwt, "x", { "Content-Type": "application/octet-stream" })), 400, "invalid_request")
    }
    await error(await dispatch(request("/api/publication?unexpected=1", "POST", jwt, "{}", { "Content-Type": "application/json" })), 400, "invalid_request")
    await error(await dispatch(request("/api/publication/upload?sessionId=x&path=a", "PUT", jwt, "x", { "Content-Type": "application/octet-stream; charset=utf-8" })), 415, "unsupported_media_type")
    const bindings = { ...manageHttpBindings, DB: env.DB, REVISION_BYTES: env.REVISION_BYTES }
    const missing = request("/api/publication/upload?sessionId=x&path=a", "PUT", jwt, null, { "Content-Type": "application/octet-stream", "Content-Length": "1" })
    await error(await worker.fetch(missing, bindings), 400, "invalid_request")
  })
  it("bounds stalled command reads and rejects malformed UTF-8 after authentication", async () => {
    const jwt = await signed()
    const bindings = { ...manageHttpBindings, DB: env.DB, REVISION_BYTES: env.REVISION_BYTES }
    const headers = { "Content-Type": "application/json", "Cf-Access-Jwt-Assertion": jwt }
    const stalled = new ReadableStream<Uint8Array>({ pull() { return new Promise(() => {}) } })
    await error(await worker.fetch(new Request("https://manage.example.test/api/publication", { method: "POST", headers, body: stalled }), bindings), 408, "request_timeout")
    const interrupted = new ReadableStream<Uint8Array>({ start(controller) { controller.error(new Error("synthetic command interruption")) } })
    await error(await worker.fetch(new Request("https://manage.example.test/api/publication", { method: "POST", headers, body: interrupted }), bindings), 408, "request_timeout")
    await error(await worker.fetch(new Request("https://manage.example.test/api/publication", { method: "POST", headers, body: new Uint8Array([0xff]) }), bindings), 400, "invalid_request")
    let nested: unknown = null
    for (let i = 0; i < 18; i++) nested = [nested]
    await error(await command(jwt, nested), 400, "invalid_request")
    expect(await env.DB.prepare("SELECT count(*) AS n FROM publication_sessions").first()).toEqual({ n: 0 })
    expect((await env.REVISION_BYTES.list()).objects).toEqual([])
  })
  it("rejects an invalid assertion without consuming either request body", async () => {
    const bindings = { ...manageHttpBindings, DB: env.DB, REVISION_BYTES: env.REVISION_BYTES }
    for (const [url, method, type] of [
      ["https://manage.example.test/api/publication", "POST", "application/json"],
      ["https://manage.example.test/api/publication/upload?sessionId=x&path=y", "PUT", "application/octet-stream"],
    ]) {
      let reads = 0
      const stream = new ReadableStream<Uint8Array>({ pull(controller) { reads++; controller.enqueue(new Uint8Array([1])); controller.close() } }, { highWaterMark: 0 })
      const response = await worker.fetch(new Request(url, { method, headers: { "Content-Type": type, "Cf-Access-Jwt-Assertion": "invalid" }, body: stream }), bindings)
      await error(response, 401, "unauthenticated")
      expect(reads).toBe(0)
    }
  })
  it("enforces exact command-byte boundary on chunked bodies without Content-Length", async () => {
    const jwt = await signed()
    const bindings = { ...manageHttpBindings, DB: env.DB, REVISION_BYTES: env.REVISION_BYTES }
    const payload = JSON.stringify({ op: "status", sessionId: "unknown" })
    const make = (n: number) => {
      const bytes = new TextEncoder().encode(payload + " ".repeat(n - payload.length))
      const stream = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(bytes.subarray(0, 37)); controller.enqueue(bytes.subarray(37)); controller.close() } })
      return new Request("https://manage.example.test/api/publication", { method: "POST", headers: { "Content-Type": "application/json", "Cf-Access-Jwt-Assertion": jwt }, body: stream })
    }
    const before = await env.DB.prepare("SELECT count(*) AS n FROM publication_sessions").first()
    const objects = await env.REVISION_BYTES.list()
    await error(await worker.fetch(make(32768), bindings), 404, "not_found")
    await error(await worker.fetch(make(32769), bindings), 413, "payload_too_large")
    expect(await env.DB.prepare("SELECT count(*) AS n FROM publication_sessions").first()).toEqual(before)
    expect((await env.REVISION_BYTES.list()).objects).toEqual(objects.objects)
  })

  it("rejects all framing variants and malformed nested DTOs without creating sessions", async () => {
    const jwt = await signed()
    const doc = await documentCommand("framing", "/a/framing/index.html", "x")
    const invalid = [
      { op: "begin", command: { ...doc.command, missing: true } },
      { op: "begin", command: { ...doc.command, expectedRevisionId: undefined } },
      { op: "begin", command: { ...doc.command, expectedContentVersion: 1.5 } },
      { op: "begin", command: { ...doc.command, files: [null] } },
      { op: "begin", command: { ...doc.command, files: [{ ...doc.command.files[0], extra: true }] } },
      { op: "begin", command: { ...doc.command, pages: [[]] } },
      { op: "begin", command: { ...doc.command, edges: [false] } },
      { op: "restore", command: { idempotencyKey: "x", artifactId: "x", expectedContentVersion: 0 } },
    ]
    const before = await env.DB.prepare("SELECT count(*) AS n FROM publication_sessions").first()
    for (const value of invalid) await error(await command(jwt, value), 400, "invalid_request")
    const bindings = { ...manageHttpBindings, DB: env.DB, REVISION_BYTES: env.REVISION_BYTES }
    for (const [name, value, code, expected] of [
      ["Content-Type", "application/json; charset=latin-1", "unsupported_media_type", 415],
      ["Content-Type", "application/json; charset=utf-8; x=y", "unsupported_media_type", 415],
      ["Content-Encoding", "gzip", "unsupported_media_type", 415],
      ["Content-Length", "-1", "invalid_request", 400],
      ["Content-Length", "1, 2", "invalid_request", 400],
      ["Content-Length", "32769", "payload_too_large", 413],
    ] as const) {
      const headers = new Headers({ "Content-Type": "application/json", "Cf-Access-Jwt-Assertion": jwt })
      headers.set(name, value)
      await error(await worker.fetch(new Request("https://manage.example.test/api/publication", { method: "POST", headers, body: "{}" }), bindings), expected, code)
    }
    const withNumber = { ...doc.command, pages: [{ ...doc.command.pages[0], metadata: { number: 123456789 } }] }
    const nonfinite = JSON.stringify({ op: "begin", command: withNumber }).replace("123456789", "1e999")
    await error(await worker.fetch(new Request("https://manage.example.test/api/publication", { method: "POST", headers: { "Content-Type": "application/json", "Cf-Access-Jwt-Assertion": jwt }, body: nonfinite }), bindings), 400, "invalid_request")
    let deep: unknown = 0
    for (let i = 0; i < 18; i++) deep = [deep]
    await error(await command(jwt, { op: "begin", command: { ...doc.command, pages: [{ ...doc.command.pages[0], metadata: deep }] } }), 400, "invalid_request")
    expect(await env.DB.prepare("SELECT count(*) AS n FROM publication_sessions").first()).toEqual(before)
    expect((await env.REVISION_BYTES.list()).objects).toEqual([])
  })

  it("accepts maximum JSON nesting and rejects one additional object level", async () => {
    const jwt = await signed()
    const doc = await documentCommand("depth-boundary", "/a/depth/index.html", "depth")
    let metadata: unknown = 0
    for (let i = 0; i < 12; i++) metadata = [metadata]
    const atLimit = { ...doc.command, pages: [{ ...doc.command.pages[0], metadata }] }
    const session = await status(await command(jwt, { op: "begin", command: atLimit }))
    expect(session.state).toBe("open")
    const over = { ...doc.command, idempotencyKey: "depth-over", pages: [{ ...doc.command.pages[0], metadata: [metadata] }] }
    await error(await command(jwt, { op: "begin", command: over }), 400, "invalid_request")
    expect(await status(await command(jwt, { op: "status", sessionId: session.sessionId }))).toMatchObject({ state: "open" })
    expect((await env.REVISION_BYTES.list()).objects).toEqual([])
  })

  it("rejects host-header contradictions and all noncanonical browser origins", async () => {
    const jwt = await signed()
    const bindings = { ...manageHttpBindings, DB: env.DB, REVISION_BYTES: env.REVISION_BYTES }
    const body = JSON.stringify({ op: "status", sessionId: "unknown" })
    for (const origin of ["", "null", "https://forge.example.test", "https://manage.example.test:444", "http://manage.example.test", "https://manage.example.test, https://evil.example.test"]) {
      await error(await worker.fetch(request("/api/publication", "POST", jwt, body, { Origin: origin, "Content-Type": "application/json" }), bindings), 403, "forbidden")
    }
    for (const url of ["http://manage.example.test/api/publication", "https://manage.example.test:444/api/publication", "https://forge.example.test/api/publication"]) {
      const req = new Request(url, { method: "POST", headers: { Host: "manage.example.test", "X-Forwarded-Host": "manage.example.test", "Cf-Access-Jwt-Assertion": jwt, "Content-Type": "application/json" }, body })
      await error(await worker.fetch(req, bindings), 403, "forbidden")
    }
    await error(await worker.fetch(request("/api/publication", "POST", jwt, body, { Host: "other.example.test", "X-Forwarded-Host": "manage.example.test", "Content-Type": "application/json" }), bindings), 403, "forbidden")
    await error(await dispatch(request("/api/publication/", "POST", jwt, body, { "Content-Type": "application/json" })), 404, "not_found")
    for (const path of ["/api/admin", "/api/gc", "/api/publication/delete", "/api/publication/reveal"]) {
      await error(await dispatch(request(path, "POST", jwt, body, { "Content-Type": "application/json" })), 404, "not_found")
    }
  })
})
