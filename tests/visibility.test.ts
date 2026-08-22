import { afterEach, describe, expect, it, vi } from "vitest"
import type { ForgeEnv } from "@functions/_lib/access"
import { onRequestPost } from "@functions/api/visibility"
import { generateTestJwtKeys, signJwt } from "./helpers/jwt"
import { mockKv } from "./helpers/kv"

const keys = generateTestJwtKeys()

function contextFor(env: ForgeEnv, visibility: "public" | "shared" | "private") {
  const now = Math.floor(Date.now() / 1000)
  const token = signJwt(keys.privateKeyPem, {
    exp: now + 3600,
    iss: "https://visibility-team.example.com",
    aud: "visibility-aud",
  })
  const request = new Request("https://forge.example.com/api/visibility", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: "https://forge.example.com",
      "Cf-Access-Jwt-Assertion": token,
    },
    body: JSON.stringify({ slug: "demo-deck", visibility }),
  })
  return {
    request,
    env,
    params: {},
    data: {},
    functionPath: "/api/visibility",
    waitUntil: vi.fn(),
    next: vi.fn(),
  } as unknown as EventContext<ForgeEnv, string, Record<string, unknown>>
}

describe("visibility shortlinks", () => {
  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it("upserts f-<slug> to the public /a/ URL and returns it for copying", async () => {
    const kv = mockKv({
      "vis:demo-deck": "shared",
      "share:demo-deck": "old-secret-key",
    })
    const env: ForgeEnv = {
      SHARES: kv,
      ASSETS: {
        fetch: vi.fn().mockResolvedValue(new Response("", { status: 200 })),
      } as unknown as Fetcher,
      CF_ACCESS_TEAM_DOMAIN: "visibility-team.example.com",
      CF_ACCESS_AUD: "visibility-aud",
      PUBLIC_HOST: "forge.example.com",
      SHLINK_API_KEY: "test-api-key",
      SHLINK_API_URL: "https://s.example/rest/v3/short-urls",
    }
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.includes("/cdn-cgi/access/certs")) {
        return new Response(JSON.stringify({ keys: [keys.publicJwk] }), {
          status: 200,
        })
      }
      if (
        url === "https://s.example/rest/v3/short-urls/f-demo-deck" &&
        init?.method === "PATCH"
      ) {
        expect(JSON.parse(String(init.body))).toEqual({
          longUrl: "https://forge.example.com/a/demo-deck/",
        })
        return new Response(
          JSON.stringify({ shortUrl: "https://s.example/f-demo-deck" }),
          { status: 200 },
        )
      }
      return new Response("not found", { status: 404 })
    })
    vi.stubGlobal("fetch", fetchMock)

    const response = await onRequestPost(contextFor(env, "public"))
    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({
      slug: "demo-deck",
      visibility: "public",
      shareUrl: null,
      shortUrl: "https://s.example/f-demo-deck",
    })
    await expect(kv.get("vis:demo-deck")).resolves.toBe("public")
    await expect(kv.get("share:demo-deck")).resolves.toBeNull()
  })
})
