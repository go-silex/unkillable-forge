/* Roxabi keyed page shares: functions/s/[[path]].ts and functions/_lib/share-unfurl.ts, revision 9c7dda4fd6427dde7da5f474a4519fffefe3ba6a (MIT). */
import { env } from "cloudflare:workers"
import { beforeEach, describe, expect, it } from "vitest"
import { importShare, revokeShare, setVisibility } from "../../domains/catalogue/commands"
import { resolveRead } from "../../domains/catalogue/resolve"
import { decideRead, type ReadCredentials, type ReadSubject } from "../../domains/catalogue/read"
import { actor, artifactId, bootstrap, configs, digest, mountedSubdocument, pageFixture, pageId, revisionId } from "./fixtures/catalogue"

beforeEach(async () => { await bootstrap(); await pageFixture() })

describe("read entry point", () => {
  it("enforces private, public and shared subtree decisions with query preserved in login", async () => {
    const { read, manage } = await configs()
    const deps = { db: env.DB, config: read, jwks: async () => [], nowSeconds: () => 1000 }
    const policy = { db: env.DB, config: manage, now: () => 10 }
    const open = (path: string) => resolveRead(new Request(`https://forge.example.test${path}`), deps)
    expect(await open("/a/sample/?view=1")).toEqual({ kind: "login", location: "/login?next=%2Fa%2Fsample%2F%3Fview%3D1" })
    expect(await open("/a/unknown/")).toMatchObject({ kind: "login" })
    await setVisibility(policy, actor, { pageId, artifactId, expectedPolicyEpoch: 0, visibility: "public" })
    expect(await open("/a/sample/")).toMatchObject({ kind: "serve", plan: { authority: { basis: "public" } } })
    const grant = await importShare(policy, actor, { pageId, artifactId, expectedPolicyEpoch: 1, key: "original_key123", mode: "follow_active" })
    expect(await open("/a/sample/")).toMatchObject({ kind: "deny", status: 404 })
    expect(await open("/s/sample/original_key123/")).toMatchObject({ kind: "serve", plan: { authority: { basis: "share_key" } } })
    expect(await open("/s/sample/?k=original_key123")).toMatchObject({ kind: "serve" })
    expect(await open("/s/sample/wrong_key123/")).toMatchObject({ kind: "deny", status: 404 })
    await revokeShare(policy, actor, { pageId, artifactId, expectedPolicyEpoch: 2, grantId: grant.grantId })
    expect(await open("/s/sample/original_key123/")).toMatchObject({ kind: "deny", status: 404 })
  })
  it("fails closed for internal paths and unknown hosts even when a shell is configured", async () => {
    const read = (await configs()).read
    const deps = { db: env.DB, config: read, jwks: async () => [], nowSeconds: () => 1000 }
    expect(await resolveRead(new Request("https://unknown.example.test/login"), deps)).toMatchObject({ kind: "deny", status: 403 })
    expect(await resolveRead(new Request("https://forge.example.test/manifest.json"), deps)).toMatchObject({ kind: "deny", status: 404 })
    expect(await resolveRead(new Request("https://forge.example.test/login?next=%2Fa%2Fsample"), deps)).toMatchObject({ kind: "shell", path: "/login" })
    const redirectRead = { ...read, login: "redirect-access-login" as const }
    expect(await resolveRead(new Request("https://forge.example.test/login?next=%2Fa%2Fsample"), { ...deps, config: redirectRead })).toMatchObject({ kind: "redirect", status: 302, location: "https://team.cloudflareaccess.com/cdn-cgi/access/login/forge.example.test?redirect_url=https%3A%2F%2Fforge.example.test%2Fa%2Fsample" })
  })
  it("uses the observed OS-3 public subtree canonical forms", async () => {
    const { read, manage } = await configs()
    await setVisibility({ db: env.DB, config: manage, now: () => 10 }, actor, { pageId, artifactId, expectedPolicyEpoch: 0, visibility: "public" })
    const deps = { db: env.DB, config: read, jwks: async () => [], nowSeconds: () => 1000 }
    expect(await resolveRead(new Request("https://forge.example.test/a/sample"), deps)).toMatchObject({ kind: "redirect", status: 308, location: "/a/sample/" })
    expect(await resolveRead(new Request("https://forge.example.test/a/sample/"), deps)).toMatchObject({ kind: "serve", plan: { resource: { path: "/a/sample/index.html" } } })
    expect(await resolveRead(new Request("https://forge.example.test/a/sample/index.html"), deps)).toMatchObject({ kind: "redirect", status: 308, location: "/a/sample/" })
    expect(await resolveRead(new Request("https://forge.example.test/a/sample/index"), deps)).toMatchObject({ kind: "redirect", status: 308, location: "/a/sample/" })
  })
  it("uses the observed OS-2 one-level share forms", async () => {
    const { read, manage } = await configs()
    await mountedSubdocument("/a/sample/child.html")
    await importShare({ db: env.DB, config: manage, now: () => 10 }, actor, { pageId, artifactId, expectedPolicyEpoch: 0, key: "original_key123", mode: "follow_active" })
    const deps = { db: env.DB, config: read, jwks: async () => [], nowSeconds: () => 1000 }
    const prefix = "https://forge.example.test/s/sample/original_key123/child"
    expect(await resolveRead(new Request(`${prefix}.html`), deps)).toMatchObject({ kind: "serve", plan: { resource: { path: "/a/sample/child.html" }, cache: "no-store" } })
    for (const suffix of ["", "/", "/index.html"]) {
      expect(await resolveRead(new Request(`${prefix}${suffix}`), deps)).toMatchObject({ kind: "deny", status: 404 })
    }
  })
  it("confines deep share candidates to the requested subtree, not a sibling document", async () => {
    const { read, manage } = await configs()
    const otherArtifact = `ar_${"b".repeat(26)}`
    const otherRevision = `rv_${"b".repeat(26)}`
    const otherPage = `pg_${"b".repeat(26)}`
    await pageFixture({ artifact: otherArtifact, revision: otherRevision, page: otherPage, route: { kind: "subtree", slug: "other" }, visibility: "public" })
    await env.DB.prepare("INSERT INTO revision_resources (revision_id,path,kind,object_key,sha256,size,content_type) VALUES (?, '/a/other/index.html', 'document', 'other-document', ?, 1, 'text/html')").bind(revisionId, digest).run()
    await mountedSubdocument("/a/sample/deep/child.html")
    await importShare({ db: env.DB, config: manage, now: () => 10 }, actor, { pageId, artifactId, expectedPolicyEpoch: 0, key: "original_key123", mode: "follow_active" })
    const credentials: ReadCredentials = { team: null, shareKey: "original_key123", shareCookie: null, pinnedProof: null }
    const subject: ReadSubject = { kind: "share", route: { kind: "subtree", slug: "sample" }, candidates: ["/a/other/index.html"] }
    expect(await decideRead(env.DB, read, subject, credentials, null)).toEqual({ kind: "deny", reason: "not_found" })
    const deps = { db: env.DB, config: read, jwks: async () => [], nowSeconds: () => 1000 }
    expect(await resolveRead(new Request("https://forge.example.test/s/sample/original_key123/deep/child.html"), deps)).toMatchObject({ kind: "serve", plan: { resource: { path: "/a/sample/deep/child.html" } } })
    expect(await resolveRead(new Request("https://forge.example.test/s/sample/original_key123/deep/other/index.html"), deps)).toMatchObject({ kind: "deny", status: 404 })
  })
})
