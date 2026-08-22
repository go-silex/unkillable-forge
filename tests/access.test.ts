import { afterEach, describe, expect, it, vi } from "vitest"
import {
  activateShare,
  clearArtifactAuth,
  getVisibility,
  revokeShare,
  type ForgeEnv,
  verifyAccessJwt,
} from "@functions/_lib/access"
import { failingKvAfter, mockKv } from "./helpers/kv"
import { generateTestJwtKeys, installJwksFetch, signJwt } from "./helpers/jwt"

const envBase: ForgeEnv = {
  SHARES: mockKv(),
  ASSETS: { fetch: vi.fn() } as unknown as Fetcher,
  CF_ACCESS_TEAM_DOMAIN: "team.example.com",
  CF_ACCESS_AUD: "aud-one,aud-two",
}

describe("getVisibility", () => {
  it("returns private when vis and share keys are absent", async () => {
    const kv = mockKv()
    await expect(getVisibility(kv, "demo-deck")).resolves.toBe("private")
  })

  it("returns explicit vis when vis key is set", async () => {
    const kv = mockKv({ "vis:demo-deck": "public" })
    await expect(getVisibility(kv, "demo-deck")).resolves.toBe("public")
  })

  it("does not infer shared from orphan share key (fail-closed)", async () => {
    const kv = mockKv({ "share:demo-deck": "secret-key-only" })
    await expect(getVisibility(kv, "demo-deck")).resolves.toBe("private")
  })
})

describe("KV mutation order and compensation", () => {
  afterEach(() => vi.restoreAllMocks())

  it("activateShare rolls back share key when vis write fails", async () => {
    const kv = failingKvAfter({}, "vis:demo-deck")
    await expect(activateShare(kv, "demo-deck", "k1")).rejects.toThrow(
      /kv_put_failed:vis:demo-deck/,
    )
    await expect(kv.get("share:demo-deck")).resolves.toBeNull()
    await expect(kv.get("vis:demo-deck")).resolves.toBeNull()
  })

  it("revokeShare stays private when share delete fails (fail-closed)", async () => {
    const kv = failingKvAfter(
      { "share:demo-deck": "k1", "vis:demo-deck": "shared" },
      "share:demo-deck",
    )
    await expect(revokeShare(kv, "demo-deck")).rejects.toThrow(
      /kv_delete_failed:share:demo-deck/,
    )
    await expect(kv.get("vis:demo-deck")).resolves.toBe("private")
    await expect(kv.get("share:demo-deck")).resolves.toBe("k1")
  })

  it("clearArtifactAuth surfaces partial failure instead of swallowing", async () => {
    const kv = failingKvAfter(
      { "share:demo-deck": "k1", "vis:demo-deck": "shared" },
      "share:demo-deck",
    )
    await expect(clearArtifactAuth(kv, "demo-deck")).rejects.toThrow(
      /kv_delete_failed:share:demo-deck/,
    )
  })
})

describe("verifyAccessJwt claims", () => {
  const keys = generateTestJwtKeys()

  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it("rejects expired tokens (exp)", async () => {
    installJwksFetch([keys.publicJwk])
    const token = signJwt(keys.privateKeyPem, {
      exp: Math.floor(Date.now() / 1000) - 120,
      iss: "https://team.example.com",
      aud: "aud-one",
    })
    await expect(verifyAccessJwt(token, envBase)).resolves.toBe(false)
  })

  it("rejects wrong issuer (iss)", async () => {
    installJwksFetch([keys.publicJwk])
    const token = signJwt(keys.privateKeyPem, {
      exp: Math.floor(Date.now() / 1000) + 3600,
      iss: "https://evil.example.com",
      aud: "aud-one",
    })
    await expect(verifyAccessJwt(token, envBase)).resolves.toBe(false)
  })

  it("rejects wrong audience (aud)", async () => {
    installJwksFetch([keys.publicJwk])
    const token = signJwt(keys.privateKeyPem, {
      exp: Math.floor(Date.now() / 1000) + 3600,
      iss: "https://team.example.com",
      aud: "not-in-list",
    })
    await expect(verifyAccessJwt(token, envBase)).resolves.toBe(false)
  })

  it("rejects not-yet-valid tokens (nbf)", async () => {
    installJwksFetch([keys.publicJwk])
    const token = signJwt(keys.privateKeyPem, {
      exp: Math.floor(Date.now() / 1000) + 7200,
      nbf: Math.floor(Date.now() / 1000) + 3600,
      iss: "https://team.example.com",
      aud: "aud-one",
    })
    await expect(verifyAccessJwt(token, envBase)).resolves.toBe(false)
  })

  it("accepts valid exp/iss/aud/nbf with matching signature", async () => {
    installJwksFetch([keys.publicJwk])
    const now = Math.floor(Date.now() / 1000)
    const token = signJwt(keys.privateKeyPem, {
      exp: now + 3600,
      nbf: now - 60,
      iss: "https://team.example.com",
      aud: "aud-two",
    })
    await expect(verifyAccessJwt(token, envBase)).resolves.toBe(true)
  })
})
