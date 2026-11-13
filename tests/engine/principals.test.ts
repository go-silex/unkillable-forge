import { env } from "cloudflare:workers"
import { beforeEach, describe, expect, it } from "vitest"
import { disablePrincipal } from "../../domains/catalogue/commands"
import { resolveActor } from "../../domains/catalogue/principals"
import type { VerifiedIdentity } from "../../domains/catalogue/identity"
import { actor, bootstrap, configs } from "./fixtures/catalogue"

const identity: VerifiedIdentity = { issuer: "https://team.cloudflareaccess.com", subject: "new-person", email: "person@example.test", audience: "manager", surface: "manage", expiresAt: 2_000_000_000 }
beforeEach(async () => { await bootstrap() })

describe("management principal registration", () => {
  it("registers once without roles and does not reactivate disabled principals", async () => {
    const deps = { db: env.DB, config: (await configs()).manage, now: () => 10 }
    const first = await resolveActor(deps, identity)
    expect(first).toMatchObject({ status: "active", authorityEpoch: 0, roles: [] })
    expect(await resolveActor(deps, { ...identity, email: "changed@example.test" })).toMatchObject({ principalId: first!.principalId, authorityEpoch: 0, roles: [] })
    expect(await env.DB.prepare("SELECT count(*) AS n FROM principals WHERE issuer = ? AND subject = ?").bind(identity.issuer, identity.subject).first()).toEqual({ n: 1 })
    await disablePrincipal(deps, actor, { targetPrincipalId: first!.principalId, expectedTargetAuthorityEpoch: 0 })
    expect(await resolveActor(deps, identity)).toMatchObject({ principalId: first!.principalId, status: "disabled", authorityEpoch: 1, roles: [] })
  })
  it("never registers read identities or identities without a subject", async () => {
    const deps = { db: env.DB, config: (await configs()).manage, now: () => 10 }
    expect(await resolveActor(deps, { ...identity, surface: "read" })).toBeNull()
    expect(await resolveActor(deps, { ...identity, subject: null })).toBeNull()
    expect(await env.DB.prepare("SELECT count(*) AS n FROM principals WHERE subject = 'new-person'").first()).toEqual({ n: 0 })
  })
  it("refuses a different instance without registering a principal", async () => {
    const config = { ...(await configs()).manage, instanceId: "other-instance" }
    await expect(resolveActor({ db: env.DB, config, now: () => 10 }, identity)).rejects.toMatchObject({ code: "instance_mismatch" })
    expect(await env.DB.prepare("SELECT count(*) AS n FROM principals WHERE subject = 'new-person'").first()).toEqual({ n: 0 })
  })
})
