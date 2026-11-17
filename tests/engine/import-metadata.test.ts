import { describe, expect, it } from "vitest"
import { revokeShare } from "../../domains/catalogue/commands"
import { shareKeyDigests } from "../../domains/catalogue/share-secrets"
import { newId } from "../../domains/catalogue/ids"
import { shortlinkDestinationDigest } from "../../domains/catalogue/shortlinks"
import { actor, configs, jwks } from "./fixtures/catalogue"
import { importResult, syntheticImport } from "./fixtures/import"
import { env, setupHttp, signed } from "./fixtures/manage-http"

setupHttp()
const key = "synthetic-original-key"

async function complete(fixture: { call: (jwt: string, value: unknown) => Promise<Response>; selection: unknown }, jwt: string) {
  for (let i = 0; i < 32; i++) {
    const response = await fixture.call(jwt, { op: "apply", selection: fixture.selection })
    const text = await response.clone().text()
    expect(text).not.toContain(key)
    const result = await importResult(response)
    if (result.state === "committed") return result
    expect(result.state).toBe("staging")
  }
  throw new Error("synthetic import did not complete")
}

describe("synthetic selected import metadata", () => {
  it("preserves the original share verifier and shortlink without rotating or duplicating either, and refuses replay after revoke", async () => {
    const destination = `https://forge.example.test/s/synthetic-import/${key}/`
    const digest = await shortlinkDestinationDigest(destination)
    const grantId = newId("gr")
    const fixture = await syntheticImport(pageId => [
      { kind: "page_policy", policy: { operationId: "synthetic-policy", sourcePageId: "source-page", pageId, grantId, expectedPolicyEpoch: null, visibility: { captured: true, value: "shared", metadataV: "shared", expiresAt: null }, share: { captured: true, key, expiresAt: null } } },
      { kind: "shortlink", operationId: "synthetic-link", mapping: { mappingId: "synthetic-mapping", providerOrigin: "https://links.example.test", providerId: "provider-1", shortDomain: "links.example.test", shortCode: "original", shortUrl: "https://links.example.test/original", pageId, grantId, destination, source: "imported", observedAt: 1, destinationDigest: digest } },
    ])
    const jwt = await signed()
    const first = await complete(fixture, jwt)
    await complete(fixture, jwt)
    const grants = await env.DB.prepare("SELECT grant_id, key_hmac, revoked_at FROM share_grants WHERE page_id = ?").bind(fixture.pageId).all<{ grant_id: string; key_hmac: string; revoked_at: number | null }>()
    expect(grants.results).toHaveLength(1)
    expect(grants.results[0].key_hmac).toBe((await shareKeyDigests((await configs()).manage.shareVerifierKeys, "test-forge", key))[0].hmac)
    const links = await env.DB.prepare("SELECT provider_origin, provider_id, short_domain, short_code, short_url, destination, destination_digest FROM shortlink_mappings").all()
    expect(links.results).toEqual([{ provider_origin: "https://links.example.test", provider_id: "provider-1", short_domain: "links.example.test", short_code: "original", short_url: "https://links.example.test/original", destination, destination_digest: digest }])
    const deps = { db: env.DB, config: (await configs()).manage, jwks, now: Date.now }
    const policy = await env.DB.prepare("SELECT policy_epoch FROM pages WHERE page_id = ?").bind(fixture.pageId).first<{ policy_epoch: number }>()
    if (!policy) throw new Error("missing imported page")
    await revokeShare(deps, actor, { pageId: fixture.pageId, artifactId: first.publication.artifactId, expectedPolicyEpoch: policy.policy_epoch, grantId: grants.results[0].grant_id })
    const replay = await fixture.call(jwt, { op: "apply", selection: fixture.selection })
    expect(replay.status).toBe(409)
    expect(await env.DB.prepare("SELECT count(*) AS n FROM share_grants WHERE page_id = ? AND revoked_at IS NULL").bind(fixture.pageId).first()).toEqual({ n: 0 })
    expect(await env.DB.prepare("SELECT count(*) AS n FROM shortlink_mappings").first()).toEqual({ n: 1 })
  })

  it("does not commit publication or receipts when an imported alias conflicts", async () => {
    const fixture = await syntheticImport(pageId => [
      { kind: "page_policy", policy: { operationId: "synthetic-public", sourcePageId: "source-page", pageId, grantId: null, expectedPolicyEpoch: null, visibility: { captured: true, value: "public", metadataV: "public", expiresAt: null }, share: { captured: true, key: null, expiresAt: null } } },
      { kind: "alias", operationId: "synthetic-alias", aliasKind: "redirect_exact", path: "/legacy", to: "/a/synthetic-import/", status: 302, targetPageId: pageId },
    ], 9)
    const jwt = await signed()
    const staged = await importResult(await fixture.call(jwt, { op: "apply", selection: fixture.selection }))
    expect(staged.state).toBe("staging")
    // Inject the competing metadata only after a real import session has staged bytes.
    await env.DB.prepare("INSERT INTO routes (kind,route_key,redirect_to,redirect_status,created_at) VALUES ('redirect_exact','/legacy','/other',302,1)").run()
    let failed = false
    for (let i = 0; i < 32; i++) {
      const response = await fixture.call(jwt, { op: "apply", selection: fixture.selection })
      if (response.status !== 200) { failed = true; break }
      const result = await importResult(response)
      if (result.state === "blocked") { failed = true; break }
      expect(result.state).toBe("staging")
    }
    expect(failed).toBe(true)
    expect(await env.DB.prepare("SELECT count(*) AS n FROM artifacts WHERE active_revision_id IS NOT NULL").first()).toEqual({ n: 0 })
    expect(await env.DB.prepare("SELECT count(*) AS n FROM pages WHERE page_id = ?").bind(fixture.pageId).first()).toEqual({ n: 0 })
    expect(await env.DB.prepare("SELECT count(*) AS n FROM publication_imports").first()).toEqual({ n: 0 })
    expect(await env.DB.prepare("SELECT count(*) AS n FROM catalogue_import_operations").first()).toEqual({ n: 0 })
    expect(await env.DB.prepare("SELECT redirect_to FROM routes WHERE kind = 'redirect_exact' AND route_key = '/legacy'").first()).toEqual({ redirect_to: "/other" })
  })
})
