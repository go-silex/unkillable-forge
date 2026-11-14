import { env, exports } from "cloudflare:workers"
import { afterAll, beforeAll, beforeEach, expect, vi } from "vitest"
import { bootstrap } from "./catalogue"
import type { PublicationReceipt, PublicationStatus } from "../../../domains/publication/types"

const origin = "https://manage.example.test"
const certs = "https://team.cloudflareaccess.com/cdn-cgi/access/certs"
let signingKey: CryptoKey
const encode = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_")

// A key is shared for the entire file because the real JWKS source caches keys.
export function setupHttp() {
  beforeAll(async () => {
    const keys = await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"])
    signingKey = keys.privateKey
    const publicKey = { ...await crypto.subtle.exportKey("jwk", keys.publicKey), kid: "http-test", alg: "RS256", use: "sig" }
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = input instanceof Request ? input.url : String(input)
      if (url !== certs) throw new Error("Unexpected outbound request")
      return Response.json({ keys: [publicKey] })
    })
  })
  beforeEach(async () => { await bootstrap() })
  afterAll(() => vi.unstubAllGlobals())
}

export async function signed(subject = "admin", claims: Record<string, unknown> = {}): Promise<string> {
  const header = encode(new TextEncoder().encode(JSON.stringify({ alg: "RS256", kid: "http-test" })))
  const payload = encode(new TextEncoder().encode(JSON.stringify({ iss: "https://team.cloudflareaccess.com", aud: "manager", sub: subject, exp: Math.floor(Date.now() / 1000) + 3600, ...claims })))
  const input = `${header}.${payload}`
  const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", signingKey, new TextEncoder().encode(input))
  return `${input}.${encode(new Uint8Array(signature))}`
}

export function request(path: string, method: string, assertion: string | null, body?: BodyInit | null, extra: HeadersInit = {}): Request {
  const headers = new Headers(extra)
  if (assertion) headers.set("Cf-Access-Jwt-Assertion", assertion)
  return new Request(`${origin}${path}`, { method, headers, body })
}

export function dispatch(req: Request): Promise<Response> {
  return exports.default.fetch(req)
}

export function command(assertion: string, value: unknown): Promise<Response> {
  return dispatch(request("/api/publication", "POST", assertion, JSON.stringify(value), { "Content-Type": "application/json" }))
}

export function upload(assertion: string, sessionId: string, path: string, bytes: Uint8Array<ArrayBuffer>): Promise<Response> {
  const query = new URLSearchParams({ sessionId, path })
  return dispatch(request(`/api/publication/upload?${query}`, "PUT", assertion, bytes, { "Content-Type": "application/octet-stream" }))
}

export async function success<T>(response: Response): Promise<T> {
  expect(response.status).toBe(200)
  expect(response.headers.get("cache-control")).toBe("no-store")
  expect(response.headers.get("x-content-type-options")).toBe("nosniff")
  expect(response.headers.get("referrer-policy")).toBe("no-referrer")
  expect(response.headers.get("content-security-policy")).toBe("default-src 'none'; frame-ancestors 'none'")
  expect(response.headers.get("access-control-allow-origin")).toBeNull()
  expect(response.headers.get("set-cookie")).toBeNull()
  const payload = await response.json() as { ok: boolean; result: T }
  expect(payload.ok).toBe(true)
  return payload.result
}
export async function status(response: Response) {
  const result = await success<PublicationStatus>(response)
  expect(Object.keys(result).sort()).toEqual(["artifactId", "baseRevisionId", "expiresAt", "files", "revisionId", "sessionId", "state"])
  for (const file of result.files) expect(Object.keys(file).sort()).toEqual(["path", "source", "stored"])
  return result
}
export async function receipt(response: Response) {
  const result = await success<PublicationReceipt>(response)
  expect(Object.keys(result).sort()).toEqual(["artifactId", "contentVersion", "pages", "revisionId"])
  for (const page of result.pages) expect(Object.keys(page).sort()).toEqual(["pageId", "url"])
  return result
}
export { env }
