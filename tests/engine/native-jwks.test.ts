import { env } from "cloudflare:workers"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { assignRole, readPagePolicy, revokeRole, setVisibility } from "../../domains/catalogue/commands"
import { accessJwksSource } from "../../domains/catalogue/identity"
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
