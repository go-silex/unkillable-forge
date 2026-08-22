import { afterEach, describe, expect, it, vi } from "vitest"
import type { ForgeEnv } from "@functions/_lib/access"
import { upsertShortlink } from "@functions/_lib/shlink"
import { mockKv } from "./helpers/kv"

const env: ForgeEnv = {
  SHARES: mockKv(),
  ASSETS: { fetch: vi.fn() } as unknown as Fetcher,
  SHLINK_API_KEY: "test-api-key",
  SHLINK_API_URL: "https://short.example/rest/v3/short-urls/",
}

function response(status: number, shortUrl?: string): Response {
  return new Response(JSON.stringify(shortUrl ? { shortUrl } : {}), {
    status,
    headers: { "content-type": "application/json" },
  })
}

describe("upsertShortlink", () => {
  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it("updates the deterministic alias when it already exists", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      response(200, "https://s.example/f-demo-deck"),
    )
    vi.stubGlobal("fetch", fetchMock)

    await expect(
      upsertShortlink(env, "https://forge.example/s/demo-deck/new-key/", "demo-deck"),
    ).resolves.toBe("https://s.example/f-demo-deck")

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock).toHaveBeenCalledWith(
      "https://short.example/rest/v3/short-urls/f-demo-deck",
      expect.objectContaining({ method: "PATCH" }),
    )
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({
      longUrl: "https://forge.example/s/demo-deck/new-key/",
    })
  })

  it("creates the deterministic alias only after PATCH returns 404", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(response(404))
      .mockResolvedValueOnce(response(200, "https://s.example/f-demo-deck"))
    vi.stubGlobal("fetch", fetchMock)

    await expect(
      upsertShortlink(env, "https://forge.example/s/demo-deck/key/", "demo-deck"),
    ).resolves.toBe("https://s.example/f-demo-deck")

    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(fetchMock.mock.calls[1][0]).toBe(
      "https://short.example/rest/v3/short-urls",
    )
    expect(fetchMock.mock.calls[1][1].method).toBe("POST")
    expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toEqual({
      longUrl: "https://forge.example/s/demo-deck/key/",
      customSlug: "f-demo-deck",
      findIfExists: true,
    })
  })

  it("retries PATCH when a concurrent create claims the alias", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(response(404))
      .mockResolvedValueOnce(response(409))
      .mockResolvedValueOnce(response(200, "https://s.example/f-demo-deck"))
    vi.stubGlobal("fetch", fetchMock)

    await expect(
      upsertShortlink(env, "https://forge.example/s/demo-deck/key/", "demo-deck"),
    ).resolves.toBe("https://s.example/f-demo-deck")

    expect(fetchMock).toHaveBeenCalledTimes(3)
    expect(fetchMock.mock.calls[2][1].method).toBe("PATCH")
  })

  it("does not create after authentication or server errors", async () => {
    const fetchMock = vi.fn().mockResolvedValue(response(401))
    vi.stubGlobal("fetch", fetchMock)

    await expect(
      upsertShortlink(env, "https://forge.example/s/demo-deck/key/", "demo-deck"),
    ).resolves.toBeUndefined()
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it("does not retry PATCH when creation fails for a non-conflict reason", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(response(404))
      .mockResolvedValueOnce(response(401))
    vi.stubGlobal("fetch", fetchMock)

    await expect(
      upsertShortlink(env, "https://forge.example/s/demo-deck/key/", "demo-deck"),
    ).resolves.toBeUndefined()
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it("is disabled when Shlink configuration is incomplete", async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal("fetch", fetchMock)

    await expect(
      upsertShortlink(
        { ...env, SHLINK_API_KEY: undefined },
        "https://forge.example/s/demo-deck/key/",
        "demo-deck",
      ),
    ).resolves.toBeUndefined()
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
