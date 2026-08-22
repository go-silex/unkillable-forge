import { describe, expect, it, vi } from "vitest"
import { onRequest } from "@functions/s/[[path]]"
import { mockKv } from "./helpers/kv"

function shareContext(path: string, store: Record<string, string> = {}) {
  const kv = mockKv(store)
  const assetsFetch = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input)
    if (url.includes("/a/demo-deck/index.html")) {
      return new Response("<html>ok</html>", { status: 200 })
    }
    return new Response("missing", { status: 404 })
  })
  return {
    assetsFetch,
    request: new Request(`https://forge.example.com${path}`),
    env: { SHARES: kv, ASSETS: { fetch: assetsFetch } },
    next: vi.fn(),
    params: {},
    waitUntil: vi.fn(),
    passThroughOnException: vi.fn(),
    data: {},
  }
}

describe("/s share route", () => {
  it("serves asset when vis is shared and key matches", async () => {
    const ctx = shareContext("/s/demo-deck/good-key/", {
      "vis:demo-deck": "shared",
      "share:demo-deck": "good-key",
    })
    const res = await onRequest(ctx as never)
    expect(res.status).toBe(200)
    expect(res.headers.get("x-forge-share")).toBe("1")
  })

  it("returns 404 for wrong share key", async () => {
    const ctx = shareContext("/s/demo-deck/wrong-key/", {
      "vis:demo-deck": "shared",
      "share:demo-deck": "good-key",
    })
    const res = await onRequest(ctx as never)
    expect(res.status).toBe(404)
  })

  it("returns 404 when vis is not shared", async () => {
    const ctx = shareContext("/s/demo-deck/good-key/", {
      "vis:demo-deck": "private",
      "share:demo-deck": "good-key",
    })
    const res = await onRequest(ctx as never)
    expect(res.status).toBe(404)
  })

  it("rejects dot-segment path traversal before ASSETS.fetch", async () => {
    const ctx = shareContext("/s/demo-deck/good-key/..%2f..%2fsecret", {
      "vis:demo-deck": "shared",
      "share:demo-deck": "good-key",
    })
    const res = await onRequest(ctx as never)
    expect(res.status).toBe(404)
    expect(ctx.assetsFetch).not.toHaveBeenCalled()
  })

  it("rejects encoded separators in slug segment", async () => {
    const ctx = shareContext("/s/demo%2fdeck/good-key/", {
      "vis:demo-deck": "shared",
      "share:demo-deck": "good-key",
    })
    const res = await onRequest(ctx as never)
    expect(res.status).toBe(404)
  })
})
