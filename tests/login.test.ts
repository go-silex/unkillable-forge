/**
 * Login round-trip. A refused private read must come back to the page it asked
 * for once Cloudflare Access has issued the JWT, never to another origin, and
 * /login must never redirect an unverified visitor onward (that was a loop).
 */
import { afterAll, describe, expect, it, vi } from "vitest"
import type { ForgeEnv } from "@functions/_lib/access"
import { onRequest } from "@functions/_middleware"
import { generateTestJwtKeys, installJwksFetch, signJwt } from "./helpers/jwt"
import { mockKv } from "./helpers/kv"

const keys = generateTestJwtKeys()
installJwksFetch([keys.publicJwk])
afterAll(() => vi.unstubAllGlobals())

function ctxFor(path: string, team = false) {
  const headers = new Headers()
  if (team) {
    const now = Math.floor(Date.now() / 1000)
    headers.set(
      "Cf-Access-Jwt-Assertion",
      signJwt(keys.privateKeyPem, {
        exp: now + 3600,
        iss: "https://login-team.example.com",
        aud: "login-aud",
      }),
    )
  }
  const env: ForgeEnv = {
    SHARES: mockKv(),
    ASSETS: { fetch: vi.fn() } as unknown as Fetcher,
    CF_ACCESS_TEAM_DOMAIN: "login-team.example.com",
    CF_ACCESS_AUD: "login-aud",
  }
  return {
    request: new Request(`https://forge.example.com${path}`, { headers }),
    env,
    params: {},
    data: {},
    waitUntil: vi.fn(),
    next: vi.fn(async () => new Response("login page", { status: 200 })),
  }
}

describe("login round-trip", () => {
  it("sends a refused private read to login carrying the page it asked for", async () => {
    const res = await onRequest(ctxFor("/a/demo-deck/notes.html?v=2") as never)
    expect(res.status).toBe(302)
    expect(res.headers.get("location")).toBe("/login?next=%2Fa%2Fdemo-deck%2Fnotes.html%3Fv%3D2")
  })

  it("returns a freshly authenticated visitor to that page", async () => {
    const ctx = ctxFor("/login?next=%2Fa%2Fdemo-deck%2Fnotes.html%3Fv%3D2", true)
    const res = await onRequest(ctx as never)
    expect(res.status).toBe(302)
    expect(res.headers.get("location")).toBe("/a/demo-deck/notes.html?v=2")
    expect(ctx.next).not.toHaveBeenCalled()
  })

  it("sends an authenticated visitor with no target to the catalogue", async () => {
    for (const path of ["/login", "/login.html", "/login?next=%2Flogin%3Fnext%3D%252Fa%252Fx%252F"]) {
      const res = await onRequest(ctxFor(path, true) as never)
      expect(res.status, path).toBe(302)
      expect(res.headers.get("location"), path).toBe("/")
    }
  })

  it("never forwards to another origin", async () => {
    const evil = [
      "//evil.tld/x",
      "https://evil.tld/x",
      "/\\evil.tld/x",
      "/\t/evil.tld/x",
      "/\n/evil.tld/x",
      "https://forge.example.com//evil.tld/x",
    ]
    for (const raw of evil) {
      const res = await onRequest(ctxFor(`/login?next=${encodeURIComponent(raw)}`, true) as never)
      expect(res.status, JSON.stringify(raw)).toBe(302)
      expect(res.headers.get("location"), JSON.stringify(raw)).toBe("/")
    }
  })

  it("serves the login page, without redirecting, when the JWT is missing or rejected", async () => {
    const ctx = ctxFor("/login?next=%2Fa%2Fdemo-deck%2F")
    ctx.request.headers.set("Cookie", "CF_Authorization=not-a-jwt")
    const res = await onRequest(ctx as never)
    expect(res.status).toBe(200)
    expect(ctx.next).toHaveBeenCalled()
  })
})
