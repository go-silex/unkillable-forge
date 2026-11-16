import { env } from "cloudflare:workers"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { assignRole, readPagePolicy, revokeRole, setVisibility } from "../../domains/catalogue/commands"
import { accessJwksSource, authenticate, isVerifiedIdentity } from "../../domains/catalogue/identity"
import { authenticateManage } from "../../domains/catalogue/principals"
import { actor, artifactId, bootstrap, configs, jwks, manageRequest, pageFixture, pageId } from "./fixtures/catalogue"

// This binding controls only the isolated test project's outbound fixture; it does
// not replace native fetch, Catalogue verification, the guard, crypto, or D1.
const fixture = (env as typeof env & { NATIVE_JWKS_FIXTURE: Fetcher }).NATIVE_JWKS_FIXTURE
let publicJwk: JsonWebKey

async function resetFixture(mode: "success" | "redirect") {
  const response = await fixture.fetch("http://fixture/reset", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jwk: publicJwk, mode }),
  })
  expect(response.status).toBe(200)
}

async function fixtureState() {
  const response = await fixture.fetch("http://fixture/state")
  expect(response.status).toBe(200)
  return await response.json() as { jwksCalls: number; redirectTargetCalls: number; deniedCalls: number }
}

beforeEach(async () => {
  await bootstrap()
  await pageFixture()
  const keys = await jwks("team.cloudflareaccess.com")
  publicJwk = keys[0]
  await resetFixture("success")
})

afterEach(async () => {
  if (publicJwk) await resetFixture("success")
})

describe.sequential("native Access JWKS outbound policy", () => {
  it("refreshes a cached Access key set when a valid rotated signing key appears", async () => {
    const verifier = { teamDomain: "team.cloudflareaccess.com", audiences: ["manager"], surface: "manage" } as const
    const cached = accessJwksSource()
    const first = await authenticate(await manageRequest(), verifier, cached, 10)
    expect(isVerifiedIdentity(first)).toBe(true)
    expect((await fixtureState()).jwksCalls).toBe(1)

    const keys = await crypto.subtle.generateKey(
      { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
      true, ["sign", "verify"],
    )
    const rotated = { ...await crypto.subtle.exportKey("jwk", keys.publicKey), kid: "rotated", alg: "RS256", use: "sig" }
    const response = await fixture.fetch("http://fixture/reset", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jwk: rotated, mode: "success" }),
    })
    expect(response.status).toBe(200)
    const encode = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_")
    const json = (value: unknown) => encode(new TextEncoder().encode(JSON.stringify(value)))
    const input = `${json({ alg: "RS256", kid: "rotated" })}.${json({ iss: "https://team.cloudflareaccess.com", aud: "manager", sub: "rotated-person", exp: 2_000_000_000 })}`
    const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", keys.privateKey, new TextEncoder().encode(input))
    const token = `${input}.${encode(new Uint8Array(signature))}`
    const request = () => new Request("https://manage.example.test/", { headers: { "Cf-Access-Jwt-Assertion": token } })

    const fresh = await authenticate(request(), verifier, accessJwksSource(), 10)
    expect(isVerifiedIdentity(fresh)).toBe(true)
    expect(fresh).toMatchObject({ subject: "rotated-person", audience: "manager", surface: "manage" })
    const refreshed = await authenticate(request(), verifier, cached, 10)
    expect(isVerifiedIdentity(refreshed)).toBe(true)
    expect(refreshed).toMatchObject({ subject: "rotated-person", audience: "manager", surface: "manage" })
    expect(await fixtureState()).toEqual({ jwksCalls: 2, redirectTargetCalls: 0, deniedCalls: 0 })
  })

  it("coalesces unknown kids and throttles failed refreshes without weakening cached verification", async () => {
    const verifier = { teamDomain: "team.cloudflareaccess.com", audiences: ["manager"], surface: "manage" } as const
    let hold = false
    let calls = 0
    let release!: () => void
    let signalStarted!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const started = new Promise<void>(resolve => { signalStarted = resolve })
    const fetcher: typeof fetch = async (input, init) => {
      calls++
      if (hold) {
        signalStarted()
        await gate
      }
      return fetch(input, init)
    }
    const cached = accessJwksSource(fetcher)
    const good = await manageRequest()
    const token = good.headers.get("Cf-Access-Jwt-Assertion")!
    const [header, payload, signature] = token.split(".")
    const request = (jwt: string) => new Request("https://manage.example.test/", { headers: { "Cf-Access-Jwt-Assertion": jwt } })
    expect(isVerifiedIdentity(await authenticate(request(token), verifier, cached, 10))).toBe(true)
    const alteredPayload = btoa(JSON.stringify({ iss: "https://team.cloudflareaccess.com", aud: "manager", sub: "attacker", exp: 2_000_000_000 })).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_")
    expect(await authenticate(request(`${header}.${alteredPayload}.${signature}`), verifier, cached, 10)).toBeNull()
    expect(calls).toBe(1)

    await resetFixture("redirect")
    hold = true
    const attempts = Array.from({ length: 12 }, (_, index) => {
      const unknown = btoa(JSON.stringify({ alg: "RS256", kid: `unknown-${index}` })).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_")
      return authenticate(request(`${unknown}.${payload}.${signature}`), verifier, cached, 10)
    })
    await started
    expect(calls).toBe(2)
    release()
    expect(await Promise.all(attempts)).toEqual(Array(12).fill(null))
    const another = btoa(JSON.stringify({ alg: "RS256", kid: "another" })).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_")
    expect(await authenticate(request(`${another}.${payload}.${signature}`), verifier, cached, 10)).toBeNull()
    expect(isVerifiedIdentity(await authenticate(request(token), verifier, cached, 10))).toBe(true)
    expect(calls).toBe(2)
    expect(await fixtureState()).toEqual({ jwksCalls: 1, redirectTargetCalls: 0, deniedCalls: 0 })
  })

  it("retries after cooldown and never authenticates with expired keys after a failed fetch", async () => {
    const verifier = { teamDomain: "team.cloudflareaccess.com", audiences: ["manager"], surface: "manage" } as const
    let clock = 100_000
    const cached = accessJwksSource(fetch, () => clock)
    const good = await manageRequest()
    const token = good.headers.get("Cf-Access-Jwt-Assertion")!
    const [, payload, signature] = token.split(".")
    const unknown = btoa(JSON.stringify({ alg: "RS256", kid: "unknown" })).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_")
    const request = (jwt: string) => new Request("https://manage.example.test/", { headers: { "Cf-Access-Jwt-Assertion": jwt } })
    const missing = `${unknown}.${payload}.${signature}`
    expect(isVerifiedIdentity(await authenticate(request(token), verifier, cached, 10))).toBe(true)
    expect(await authenticate(request(missing), verifier, cached, 10)).toBeNull()
    expect(await authenticate(request(missing), verifier, cached, 10)).toBeNull()
    expect((await fixtureState()).jwksCalls).toBe(2)
    clock += 30_000
    expect(await authenticate(request(missing), verifier, cached, 10)).toBeNull()
    expect((await fixtureState()).jwksCalls).toBe(3)

    clock += 60 * 60 * 1000
    await resetFixture("redirect")
    expect(await authenticate(request(token), verifier, cached, 10)).toBeNull()
    expect(await authenticate(request(token), verifier, cached, 10)).toBeNull()
    expect(await fixtureState()).toEqual({ jwksCalls: 1, redirectTargetCalls: 0, deniedCalls: 0 })
  })

  it("authenticates a signed assertion and authorizes a guarded visibility change", async () => {
    const deps = { db: env.DB, config: (await configs()).manage, jwks: accessJwksSource(), now: () => 10 }
    const nativeActor = await authenticateManage(await manageRequest(), deps)
    expect(nativeActor).not.toBeNull()
    if (!nativeActor) throw new Error("Native JWKS did not authenticate the signed identity")
    await setVisibility(deps, nativeActor, { artifactId, pageId, expectedPolicyEpoch: 0, visibility: "public" })
    expect(await readPagePolicy(deps, nativeActor, pageId)).toMatchObject({ visibility: "public", policyEpoch: 1 })
    expect(await fixtureState()).toEqual({ jwksCalls: 1, redirectTargetCalls: 0, deniedCalls: 0 })
  })

  it("reuses cached keys but mints fresh authority after a role is revoked", async () => {
    const deps = { db: env.DB, config: (await configs()).manage, jwks: accessJwksSource(), now: () => 10 }
    const admin = await authenticateManage(await manageRequest(), deps)
    const initial = await authenticateManage(await manageRequest("native-publisher"), deps)
    if (!admin || !initial) throw new Error("Native JWKS did not authenticate fixture identities")
    const grant = await assignRole(deps, admin, { targetPrincipalId: initial.principalId, expectedTargetAuthorityEpoch: 0, role: "publisher", scope: { kind: "installation" } })
    const granted = await authenticateManage(await manageRequest("native-publisher"), deps)
    if (!granted) throw new Error("Native publisher could not authenticate")
    await setVisibility(deps, granted, { artifactId, pageId, expectedPolicyEpoch: 0, visibility: "public" })
    await revokeRole(deps, admin, { targetPrincipalId: initial.principalId, expectedTargetAuthorityEpoch: 1, roleGrantId: grant.roleGrantId })
    const revoked = await authenticateManage(await manageRequest("native-publisher"), deps)
    if (!revoked) throw new Error("Revoked principal could not authenticate")
    await expect(setVisibility(deps, revoked, { artifactId, pageId, expectedPolicyEpoch: 1, visibility: "private" })).rejects.toMatchObject({ code: "forbidden" })
    expect(await readPagePolicy(deps, admin, pageId)).toMatchObject({ visibility: "public", policyEpoch: 1 })
    expect(await fixtureState()).toEqual({ jwksCalls: 1, redirectTargetCalls: 0, deniedCalls: 0 })
  })

  it("rejects a JWKS redirect even when the target would serve the same valid signing key", async () => {
    const config = (await configs()).manage
    const directDeps = { db: env.DB, config, jwks: accessJwksSource(), now: () => 10 }
    const directActor = await authenticateManage(await manageRequest(), directDeps)
    expect(directActor).not.toBeNull()
    await resetFixture("redirect")
    const deps = { db: env.DB, config, jwks: accessJwksSource(), now: () => 10 }
    const before = await readPagePolicy(deps, actor, pageId)
    const events = await env.DB.prepare("SELECT count(*) AS n FROM mutation_events").first()
    const subject = "redirect-unseen-principal"
    const principals = () => env.DB.prepare("SELECT count(*) AS n FROM principals WHERE subject = ?").bind(subject).first()
    expect(await principals()).toEqual({ n: 0 })
    expect(await authenticateManage(await manageRequest(subject), deps)).toBeNull()
    expect(await principals()).toEqual({ n: 0 })
    expect(await readPagePolicy(deps, actor, pageId)).toEqual(before)
    expect(await env.DB.prepare("SELECT count(*) AS n FROM mutation_events").first()).toEqual(events)
    expect(await fixtureState()).toEqual({ jwksCalls: 1, redirectTargetCalls: 0, deniedCalls: 0 })
  })
})
