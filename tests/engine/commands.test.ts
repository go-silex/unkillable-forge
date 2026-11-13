import { env } from "cloudflare:workers"
import { beforeEach, describe, expect, it } from "vitest"
import { assignRole, disablePrincipal, importShare, readPagePolicy, revealShare, revokeRole, revokeShare, rotateShare, setVisibility, share } from "../../domains/catalogue/commands"
import { shareKeyDigests } from "../../domains/catalogue/share-secrets"
import { actor, artifactId, authenticatedActor, bootstrap, configs, jwks, pageFixture, pageId } from "./fixtures/catalogue"

beforeEach(async () => { await bootstrap(); await pageFixture() })
const target = { pageId, artifactId, expectedPolicyEpoch: 0 }
const otherPrincipal = `pr_${"b".repeat(26)}`

describe("policy commands", () => {
  it("mints, reveals, rotates and revokes without persisting plaintext", async () => {
    const config = (await configs()).manage
    const deps = { db: env.DB, config, jwks, now: () => 10 }
    const minted = await share(deps, actor, { ...target, mode: "follow_active" })
    expect(minted.key).toMatch(/^[A-Za-z0-9_-]{24}$/)
    expect(await revealShare(deps, actor, { ...target, expectedPolicyEpoch: 1, grantId: minted.grantId })).toEqual({ key: minted.key })
    const unchanged = await share(deps, actor, { ...target, expectedPolicyEpoch: 1, mode: "follow_active" })
    expect(unchanged).toMatchObject({ grantId: minted.grantId, key: null, policyEpoch: 1 })
    const rotated = await rotateShare(deps, actor, { ...target, expectedPolicyEpoch: 1, grantId: minted.grantId })
    expect(rotated.key).not.toBe(minted.key)
    const old = await env.DB.prepare("SELECT sealed_key, revoked_reason FROM share_grants WHERE grant_id = ?").bind(minted.grantId).first()
    expect(old).toEqual({ sealed_key: null, revoked_reason: "rotated" })
    await revokeShare(deps, actor, { ...target, expectedPolicyEpoch: 2, grantId: rotated.grantId })
    expect(await readPagePolicy(deps, actor, pageId)).toMatchObject({ visibility: "private", policyEpoch: 3, grant: null })
    for (const table of ["instance_meta", "principals", "role_grants", "artifacts", "pages", "revisions", "revision_resources", "revision_pages", "mounts", "routes", "resource_owners", "share_grants", "mutation_events"]) {
      const rows = await env.DB.prepare(`SELECT * FROM ${table}`).all()
      expect(JSON.stringify(rows.results)).not.toContain(minted.key)
      expect(JSON.stringify(rows.results)).not.toContain(rotated.key)
    }
  })
  it("imports the exact historical key and erases the seal when visibility changes", async () => {
    const config = (await configs()).manage
    const deps = { db: env.DB, config, jwks, now: () => 12 }
    const historical = "legacy_Key-12345678"
    const imported = await importShare(deps, actor, { ...target, key: historical, mode: "follow_active" })
    const [expected] = await shareKeyDigests(config.shareVerifierKeys, config.instanceId, historical)
    const grant = await env.DB.prepare("SELECT key_kid, key_hmac, sealed_key FROM share_grants WHERE grant_id = ?").bind(imported.grantId).first<{ key_kid: string; key_hmac: string; sealed_key: string }>()
    expect(grant).toMatchObject({ key_kid: expected.kid, key_hmac: expected.hmac })
    expect(grant?.sealed_key).not.toContain(historical)
    expect(grant!.sealed_key.length).toBeLessThanOrEqual(512)
    expect(await revealShare(deps, actor, { ...target, expectedPolicyEpoch: 1, grantId: imported.grantId })).toEqual({ key: historical })
    await setVisibility(deps, actor, { ...target, expectedPolicyEpoch: 1, visibility: "public" })
    expect(await env.DB.prepare("SELECT sealed_key, revoked_reason FROM share_grants WHERE grant_id = ?").bind(imported.grantId).first()).toEqual({ sealed_key: null, revoked_reason: "visibility" })
  })
  it("cannot reveal when the manage surface has no seal key", async () => {
    const config = { ...(await configs()).manage, shareSealKey: null }
    const deps = { db: env.DB, config, jwks, now: () => 10 }
    const minted = await share(deps, actor, { ...target, mode: "follow_active" })
    expect(minted.revealable).toBe(false)
    await expect(revealShare(deps, actor, { ...target, expectedPolicyEpoch: 1, grantId: minted.grantId })).rejects.toMatchObject({ code: "invalid_state" })
  })
  it("enforces publisher scope when reading policy and after revocation", async () => {
    const deps = { db: env.DB, config: (await configs()).manage, jwks, now: () => 10 }
    await env.DB.prepare("INSERT INTO principals (principal_id, issuer, subject, created_at) VALUES (?, 'https://team.cloudflareaccess.com', 'publisher', 1)").bind(otherPrincipal).run()
    const role = await assignRole(deps, actor, { targetPrincipalId: otherPrincipal, expectedTargetAuthorityEpoch: 0, role: "publisher", scope: { kind: "page", pageId } })
    const publisher = await authenticatedActor("publisher")
    expect(await readPagePolicy(deps, publisher, pageId)).toMatchObject({ pageId, visibility: "private" })
    await expect(readPagePolicy(deps, { ...publisher }, pageId)).rejects.toMatchObject({ code: "unauthenticated" })
    await expect(readPagePolicy(deps, publisher, `pg_${"c".repeat(26)}`)).rejects.toMatchObject({ code: "forbidden" })
    await revokeRole(deps, actor, { targetPrincipalId: otherPrincipal, expectedTargetAuthorityEpoch: 1, roleGrantId: role.roleGrantId })
    await expect(setVisibility(deps, publisher, { ...target, visibility: "public" })).rejects.toMatchObject({ code: "conflict" })
    await expect(readPagePolicy(deps, await authenticatedActor("publisher"), pageId)).rejects.toMatchObject({ code: "forbidden" })
    await disablePrincipal(deps, actor, { targetPrincipalId: otherPrincipal, expectedTargetAuthorityEpoch: 2 })
    await expect(setVisibility(deps, await authenticatedActor("publisher"), { ...target, visibility: "public" })).rejects.toMatchObject({ code: "unauthenticated" })
  })
  it("rolls back a conflicting second import without replacing the existing grant", async () => {
    const deps = { db: env.DB, config: (await configs()).manage, jwks, now: () => 10 }
    const first = await importShare(deps, actor, { ...target, key: "first_key123", mode: "follow_active" })
    const before = await env.DB.prepare("SELECT count(*) AS n FROM mutation_events").first()
    await expect(importShare(deps, actor, { ...target, expectedPolicyEpoch: 1, key: "second_key123", mode: "follow_active" })).rejects.toMatchObject({ code: "conflict" })
    expect(await readPagePolicy(deps, actor, pageId)).toMatchObject({ visibility: "shared", policyEpoch: 1, grant: { grantId: first.grantId } })
    expect(await env.DB.prepare("SELECT count(*) AS n FROM share_grants WHERE revoked_at IS NULL").first()).toEqual({ n: 1 })
    expect(await env.DB.prepare("SELECT count(*) AS n FROM mutation_events").first()).toEqual(before)
  })
})
