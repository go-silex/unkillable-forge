import { beforeAll, describe, expect, it } from "vitest"
import { authenticate, type AccessVerifier, type JwksSource } from "../../domains/catalogue/identity"

const now = 1_800_000_000
const verifier: AccessVerifier = { teamDomain: "team.cloudflareaccess.com", audiences: ["read-audience"], surface: "read" }
let signingKey: CryptoKey
let jwks: JwksSource

function b64(data: Uint8Array): string {
  return btoa(String.fromCharCode(...data)).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_")
}
function json(value: unknown): string { return b64(new TextEncoder().encode(JSON.stringify(value))) }
async function jwt(claims: Record<string, unknown> = {}, header: Record<string, unknown> = {}): Promise<string> {
  const input = `${json({ alg: "RS256", kid: "one", ...header })}.${json({ iss: "https://team.cloudflareaccess.com", aud: "read-audience", sub: "person", exp: now + 300, ...claims })}`
  const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", signingKey, new TextEncoder().encode(input))
  return `${input}.${b64(new Uint8Array(signature))}`
}
function request(token: string, cookie?: string): Request {
  return new Request("https://forge.example.test/", { headers: { "Cf-Access-Jwt-Assertion": token, ...(cookie ? { Cookie: `CF_Authorization=${cookie}` } : {}) } })
}

beforeAll(async () => {
  const keys = await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"])
  signingKey = keys.privateKey
  const publicKey = await crypto.subtle.exportKey("jwk", keys.publicKey)
  jwks = async () => [{ ...publicKey, kid: "one", alg: "RS256", use: "sig" }]
})

describe("Access identity assurance", () => {
  it("verifies a signed identity and accepts an issuer trailing slash and array audience", async () => {
    const token = await jwt({ iss: "https://team.cloudflareaccess.com/", aud: ["other", "read-audience"] })
    expect(await authenticate(request(token), verifier, jwks, now)).toMatchObject({ subject: "person", audience: "read-audience", surface: "read" })
  })
  it("rejects unsupported algorithms, unknown keys, and altered signed claims", async () => {
    expect(await authenticate(request(await jwt({}, { alg: "HS256" })), verifier, jwks, now)).toBeNull()
    expect(await authenticate(request(await jwt({}, { kid: "missing" })), verifier, jwks, now)).toBeNull()
    const token = await jwt()
    const [header, , signature] = token.split(".")
    expect(await authenticate(request(`${header}.${json({ iss: "https://team.cloudflareaccess.com", aud: "read-audience", sub: "attacker", exp: now + 300 })}.${signature}`), verifier, jwks, now)).toBeNull()
  })
  it("tries trusted keys when kid is absent", async () => {
    expect(await authenticate(request(await jwt({}, { kid: undefined })), verifier, jwks, now)).toMatchObject({ subject: "person" })
    expect(await authenticate(request(await jwt({ exp: now - 30 })), verifier, jwks, now)).not.toBeNull()
    expect(await authenticate(request(await jwt({ nbf: now + 30 })), verifier, jwks, now)).not.toBeNull()
  })
  it("enforces expiration, not-before and their skew", async () => {
    expect(await authenticate(request(await jwt({ exp: now - 31 })), verifier, jwks, now)).toBeNull()
    expect(await authenticate(request(await jwt({ exp: now - 29 })), verifier, jwks, now)).not.toBeNull()
    expect(await authenticate(request(await jwt({ nbf: now + 31 })), verifier, jwks, now)).toBeNull()
    expect(await authenticate(request(await jwt({ nbf: now + 29 })), verifier, jwks, now)).not.toBeNull()
    expect(await authenticate(request(await jwt({ exp: undefined })), verifier, jwks, now)).toBeNull()
  })
  it("enforces issuer, surface audiences and a management subject", async () => {
    expect(await authenticate(request(await jwt({ iss: "https://other.cloudflareaccess.com" })), verifier, jwks, now)).toBeNull()
    const manage: AccessVerifier = { ...verifier, audiences: ["manage-audience"], surface: "manage" }
    expect(await authenticate(request(await jwt()), manage, jwks, now)).toBeNull()
    expect(await authenticate(request(await jwt({ aud: "manage-audience", sub: "" })), manage, jwks, now)).toBeNull()
    expect(await authenticate(request(await jwt({ sub: "" })), verifier, jwks, now)).toMatchObject({ subject: null, surface: "read" })
    expect(await authenticate(request(await jwt({ aud: "manage-audience" })), manage, jwks, now)).toMatchObject({ surface: "manage" })
  })
  it("fails closed on JWKS failure and gives the header precedence over the cookie", async () => {
    const good = await jwt()
    expect(await authenticate(request(good), verifier, async () => { throw new Error("offline") }, now)).toBeNull()
    expect(await authenticate(request("invalid", good), verifier, jwks, now)).toBeNull()
    const cookieRequest = new Request("https://forge.example.test/", { headers: { Cookie: `CF_Authorization=${good}` } })
    expect(await authenticate(cookieRequest, verifier, jwks, now)).toMatchObject({ subject: "person" })
  })
})
