/* Source-derived tree identity and canonical behavior: Roxabi functions/_middleware.ts and functions/_lib/assets.ts, revision 9c7dda4fd6427dde7da5f474a4519fffefe3ba6a (MIT); Cloudflare Pages route matching. Present-content production parity is not attested. */
import { env } from "cloudflare:workers"
import { beforeEach, describe, expect, it } from "vitest"
import { importShare, revokeShare, setVisibility } from "../../domains/catalogue/commands"
import { resolveRead } from "../../domains/catalogue/resolve"
import { actor, artifactId, bootstrap, configs, pageFixture, pageId, revisionId } from "./fixtures/catalogue"

const secondArtifact = `ar_${"b".repeat(26)}`
const secondRevision = `rv_${"b".repeat(26)}`
const secondPage = `pg_${"b".repeat(26)}`
const thirdArtifact = `ar_${"c".repeat(26)}`
const thirdRevision = `rv_${"c".repeat(26)}`
const thirdPage = `pg_${"c".repeat(26)}`
const fourthArtifact = `ar_${"d".repeat(26)}`
const fourthRevision = `rv_${"d".repeat(26)}`
const fourthPage = `pg_${"d".repeat(26)}`

beforeEach(async () => { await bootstrap() })

describe("source-derived tree route identity and canonical outcomes", () => {
  it("canonicalizes present public documents only to the matching page and keeps slash identities distinct", async () => {
    await pageFixture({ route: { kind: "tree_page", pageRef: "x/y.html" }, visibility: "public" })
    await pageFixture({ artifact: secondArtifact, revision: secondRevision, page: secondPage, route: { kind: "tree_page", pageRef: "d/index.html" }, visibility: "public" })
    const read = (await configs()).read
    const deps = { db: env.DB, config: read, jwks: async () => [], nowSeconds: () => 1000 }
    const open = (path: string) => resolveRead(new Request(`https://forge.example.test${path}`), deps)
    expect(await open("/x/y.html")).toEqual({ kind: "redirect", status: 308, location: "/x/y" })
    expect(await open("/x/y")).toMatchObject({ kind: "serve", plan: { revisionId, resource: { path: "/x/y.html" }, cache: "no-store" } })
    expect(await open("/d/index.html")).toEqual({ kind: "redirect", status: 308, location: "/d/" })
    expect(await open("/d/index")).toEqual({ kind: "redirect", status: 308, location: "/d/" })
    expect(await open("/d/")).toMatchObject({ kind: "serve", plan: { revisionId: secondRevision, resource: { path: "/d/index.html" }, cache: "no-store" } })
    expect(await open("/x/y/")).toMatchObject({ kind: "login" })
    expect(await open("/d")).toMatchObject({ kind: "login" })
    await pageFixture({ artifact: thirdArtifact, revision: thirdRevision, page: thirdPage, route: { kind: "tree_page", pageRef: "x/y/index.html" } })
    await pageFixture({ artifact: fourthArtifact, revision: fourthRevision, page: fourthPage, route: { kind: "tree_page", pageRef: "d.html" } })
    expect(await open("/x/y/")).toMatchObject({ kind: "login" })
    expect(await open("/d")).toMatchObject({ kind: "login" })
    const manage = (await configs()).manage
    await setVisibility({ db: env.DB, config: manage, now: () => 10 }, actor, { pageId: thirdPage, artifactId: thirdArtifact, expectedPolicyEpoch: 0, visibility: "public" })
    await setVisibility({ db: env.DB, config: manage, now: () => 10 }, actor, { pageId: fourthPage, artifactId: fourthArtifact, expectedPolicyEpoch: 0, visibility: "public" })
    expect(await open("/x/y/")).toMatchObject({ kind: "serve", plan: { revisionId: thirdRevision, resource: { path: "/x/y/index.html" } } })
    expect(await open("/x/y/index.html")).toEqual({ kind: "redirect", status: 308, location: "/x/y/" })
    expect(await open("/x/y/index")).toEqual({ kind: "redirect", status: 308, location: "/x/y/" })
    expect(await open("/d")).toMatchObject({ kind: "serve", plan: { revisionId: fourthRevision, resource: { path: "/d.html" } } })
  })
  it.each([
    ["x/y.html", "/x/y.html", "/x/y"],
    ["x/y.html", "/x/y", null],
    ["x/y/index.html", "/x/y/", null],
    ["x/y/index.html", "/x/y/index.html", "/x/y/"],
    ["x/y/index.html", "/x/y/index", "/x/y/"],
    ["d/index.html", "/d/index.html", "/d/"],
    ["d/index.html", "/d/index", "/d/"],
    ["d/index.html", "/d/", null],
    ["d.html", "/d", null],
  ] as [string, string, string | null][])("authorizes each private, shared or revoked %s route %s", async (pageRef, requested, destination) => {
    await pageFixture({ route: { kind: "tree_page", pageRef } })
    const { read, manage } = await configs()
    const deps = { db: env.DB, config: read, jwks: async () => [], nowSeconds: () => 1000 }
    const policy = { db: env.DB, config: manage, now: () => 10 }
    const request = (cookie?: string) => new Request(`https://forge.example.test${requested}`, cookie ? { headers: { Cookie: `forge_share=${encodeURIComponent(`${pageRef}|${cookie}`)}` } } : undefined)
    expect(await resolveRead(request(), deps)).toMatchObject({ kind: "login" })
    const grant = await importShare(policy, actor, { pageId, artifactId, expectedPolicyEpoch: 0, key: "historical_123", mode: "follow_active" })
    expect(await resolveRead(request(), deps)).toMatchObject({ kind: "login" })
    const authorized = await resolveRead(request("historical_123"), deps)
    if (destination === null) {
      expect(authorized).toMatchObject({ kind: "serve", plan: { resource: { path: `/${pageRef}` }, cache: "no-store" } })
    } else {
      expect(authorized).toEqual({ kind: "redirect", status: 308, location: destination })
    }
    await revokeShare(policy, actor, { pageId, artifactId, expectedPolicyEpoch: 1, grantId: grant.grantId })
    expect(await resolveRead(request("historical_123"), deps)).toMatchObject({ kind: "login" })
  })
  it("returns login for anonymous unknown routes and not-found for a verified team reader", async () => {
    const keys = await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"])
    const jwk = await crypto.subtle.exportKey("jwk", keys.publicKey)
    const base64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_")
    const header = base64(new TextEncoder().encode(JSON.stringify({ alg: "RS256", kid: "tree" })))
    const claims = base64(new TextEncoder().encode(JSON.stringify({ iss: "https://team.cloudflareaccess.com", aud: "reader", sub: "team-reader", exp: 2000 })))
    const unsigned = `${header}.${claims}`
    const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", keys.privateKey, new TextEncoder().encode(unsigned))
    const jwt = `${unsigned}.${base64(new Uint8Array(signature))}`
    const deps = { db: env.DB, config: (await configs()).read, jwks: async () => [{ ...jwk, kid: "tree" }], nowSeconds: () => 1000 }
    for (const path of ["/x/y.html", "/x/y", "/x/y/", "/d", "/d/"]) {
      expect(await resolveRead(new Request(`https://forge.example.test${path}`), deps)).toMatchObject({ kind: "login" })
      const request = new Request(`https://forge.example.test${path}`, { headers: { "Cf-Access-Jwt-Assertion": jwt } })
      expect(await resolveRead(request, deps)).toMatchObject({ kind: "deny", status: 404 })
    }
  })
})
