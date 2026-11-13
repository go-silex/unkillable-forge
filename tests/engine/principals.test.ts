import { env } from "cloudflare:workers"
import { beforeEach, describe, expect, it } from "vitest"
import { disablePrincipal, readPagePolicy, setVisibility } from "../../domains/catalogue/commands"
import { authenticateManage } from "../../domains/catalogue/principals"
import { actor, artifactId, bootstrap, configs, jwks, manageRequest, pageFixture, pageId } from "./fixtures/catalogue"

beforeEach(async () => { await bootstrap() })

describe("management principal authentication", () => {
  it("registers a signed manage identity once without roles and does not reactivate it", async () => {
    const deps = { db: env.DB, config: (await configs()).manage, jwks, now: () => 10 }
    const first = await authenticateManage(await manageRequest("new-person"), deps)
    expect(first).toMatchObject({ status: "active", authorityEpoch: 0, roles: [] })
    expect(await authenticateManage(await manageRequest("new-person"), deps)).toMatchObject({ principalId: first!.principalId, authorityEpoch: 0, roles: [] })
    expect(await env.DB.prepare("SELECT count(*) AS n FROM principals WHERE subject = 'new-person'").first()).toEqual({ n: 1 })
    await disablePrincipal(deps, actor, { targetPrincipalId: first!.principalId, expectedTargetAuthorityEpoch: 0 })
    expect(await authenticateManage(await manageRequest("new-person"), deps)).toMatchObject({ principalId: first!.principalId, status: "disabled", authorityEpoch: 1, roles: [] })
  })
  it("does not upgrade a signed read-audience JWT or register an empty subject", async () => {
    const deps = { db: env.DB, config: (await configs()).manage, jwks, now: () => 10 }
    expect(await authenticateManage(await manageRequest("new-person", "reader"), deps)).toBeNull()
    expect(await authenticateManage(await manageRequest("", "manager"), deps)).toBeNull()
    expect(await authenticateManage(new Request("https://manage.example.test/", { headers: { "Cf-Access-Jwt-Assertion": "invalid" } }), deps)).toBeNull()
    expect(await env.DB.prepare("SELECT count(*) AS n FROM principals WHERE subject = 'new-person'").first()).toEqual({ n: 0 })
  })
  it("refuses a different instance without registering a principal", async () => {
    const config = { ...(await configs()).manage, instanceId: "other-instance" }
    await expect(authenticateManage(await manageRequest("new-person"), { db: env.DB, config, jwks, now: () => 10 })).rejects.toMatchObject({ code: "instance_mismatch" })
    expect(await env.DB.prepare("SELECT count(*) AS n FROM principals WHERE subject = 'new-person'").first()).toEqual({ n: 0 })
  })
  it("rejects expired and cloned handles before any policy access", async () => {
    await pageFixture()
    const config = (await configs()).manage
    const expired = { db: env.DB, config, jwks, now: () => actor.expiresAt * 1000 }
    await expect(readPagePolicy(expired, actor, pageId)).rejects.toMatchObject({ code: "unauthenticated" })
    await expect(setVisibility(expired, actor, { pageId, artifactId, expectedPolicyEpoch: 0, visibility: "public" })).rejects.toMatchObject({ code: "unauthenticated" })
    await expect(readPagePolicy({ ...expired, db: env.EMPTY_DB, now: () => 10 }, { ...actor }, pageId)).rejects.toMatchObject({ code: "unauthenticated" })
    await expect(readPagePolicy({ ...expired, db: env.EMPTY_DB }, actor, pageId)).rejects.toMatchObject({ code: "unauthenticated" })
    await expect(readPagePolicy({ db: env.EMPTY_DB, config: { ...config, instanceId: "other-instance" }, jwks, now: () => 10 }, actor, pageId)).rejects.toMatchObject({ code: "unauthenticated" })
    expect(await env.DB.prepare("SELECT visibility FROM pages WHERE page_id = ?").bind(pageId).first()).toEqual({ visibility: "private" })
  })
})
