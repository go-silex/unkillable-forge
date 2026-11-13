/* Roxabi ownership and cookie behavior: functions/_middleware.ts and functions/s/[[path]].ts, revision 9c7dda4fd6427dde7da5f474a4519fffefe3ba6a (MIT). */
import { env } from "cloudflare:workers"
import { beforeEach, describe, expect, it } from "vitest"
import { importShare, ownershipStatements, retirePageStatements, rotateShare, setAlias, setVisibility } from "../../domains/catalogue/commands"
import { executeGuarded } from "../../domains/catalogue/guard"
import { decideRead, type ReadCredentials, type ReadSubject } from "../../domains/catalogue/read"
import { listCatalogue } from "../../domains/catalogue/catalogue-list"
import { actor, artifactId, bootstrap, configs, digest, instanceId, pageFixture, pageId, principalId, revisionId } from "./fixtures/catalogue"

const anonymous: ReadCredentials = { team: null, shareKey: null, shareCookie: null, pinnedProof: null }
const team: ReadCredentials = { ...anonymous, team: { issuer: "https://team.cloudflareaccess.com", subject: "reader", email: null, audience: "reader", surface: "read", expiresAt: 2_000_000_000 } }
const page: ReadSubject = { kind: "page", route: { kind: "tree_page", pageRef: "docs/page.html" }, candidates: ["/docs/page.html"], fragmentPath: null }
const resource: ReadSubject = { kind: "resource", path: "/shared/app.js" }
const otherArtifact = `ar_${"b".repeat(26)}`
const otherRevision = `rv_${"b".repeat(26)}`
const otherPage = `pg_${"b".repeat(26)}`

beforeEach(async () => { await bootstrap(); await pageFixture({ route: { kind: "tree_page", pageRef: "docs/page.html" } }) })

describe("primary D1 read decisions", () => {
  it("fails closed for an empty or mismatched instance and real missing schema", async () => {
    const read = (await configs()).read
    expect(await decideRead(env.DB, { ...read, instanceId: "other-instance" }, page, anonymous, null)).toEqual({ kind: "deny", reason: "instance_mismatch" })
    expect(await decideRead(env.EMPTY_DB, read, page, anonymous, null)).toEqual({ kind: "deny", reason: "unavailable" })
    await env.DB.prepare("DELETE FROM instance_meta").run()
    expect(await decideRead(env.DB, read, page, anonymous, null)).toEqual({ kind: "deny", reason: "instance_mismatch" })
  })
  it("limits private pages to team and public catalogue to public pages", async () => {
    const { read, manage } = await configs()
    expect(await decideRead(env.DB, read, page, anonymous, null)).toEqual({ kind: "deny", reason: "login_required" })
    expect(await decideRead(env.DB, read, page, team, null)).toMatchObject({ kind: "allow", plan: { revisionId, authority: { basis: "team" } } })
    expect(await listCatalogue(env.DB, read, "anonymous", { after: null, limit: 20 })).toEqual([])
    expect(await listCatalogue(env.DB, read, "team", { after: null, limit: 20 })).toMatchObject([{ pageId, visibility: "private" }])
    await setVisibility({ db: env.DB, config: manage, now: () => 10 }, actor, { pageId, artifactId, expectedPolicyEpoch: 0, visibility: "public" })
    expect(await decideRead(env.DB, read, page, anonymous, null)).toMatchObject({ kind: "allow", plan: { authority: { basis: "public" } } })
    const entries = await listCatalogue(env.DB, read, "anonymous", { after: null, limit: 20 })
    expect(entries).toMatchObject([{ pageId }])
    expect(JSON.stringify(entries)).not.toContain(principalId)
  })
  it("checks the current grant for each cookie read, including rotation and visibility changes", async () => {
    const { read, manage } = await configs()
    const deps = { db: env.DB, config: manage, now: () => 10 }
    const imported = await importShare(deps, actor, { pageId, artifactId, expectedPolicyEpoch: 0, key: "historical_123", mode: "follow_active" })
    const cookie = { ...anonymous, shareCookie: { pageRef: "docs/page.html", key: "historical_123" } }
    expect(await decideRead(env.DB, read, page, cookie, null)).toMatchObject({ kind: "allow", plan: { authority: { basis: "share_cookie" } } })
    const rotated = await rotateShare(deps, actor, { pageId, artifactId, expectedPolicyEpoch: 1, grantId: imported.grantId })
    expect(await decideRead(env.DB, read, page, cookie, null)).toEqual({ kind: "deny", reason: "login_required" })
    const newCookie = { ...anonymous, shareCookie: { pageRef: "docs/page.html", key: rotated.key! } }
    expect(await decideRead(env.DB, read, page, newCookie, null)).toMatchObject({ kind: "allow" })
    await setVisibility(deps, actor, { pageId, artifactId, expectedPolicyEpoch: 2, visibility: "private" })
    expect(await decideRead(env.DB, read, page, newCookie, null)).toEqual({ kind: "deny", reason: "login_required" })
  })
  it("does not let team assurance bypass a share key or use a key for another page", async () => {
    const { read, manage } = await configs()
    const deps = { db: env.DB, config: manage, now: () => 10 }
    await pageFixture({ artifact: otherArtifact, revision: otherRevision, page: otherPage, route: { kind: "tree_page", pageRef: "other/page.html" } })
    await importShare(deps, actor, { pageId, artifactId, expectedPolicyEpoch: 0, key: "first_key123", mode: "follow_active" })
    await importShare(deps, actor, { pageId: otherPage, artifactId: otherArtifact, expectedPolicyEpoch: 0, key: "second_key123", mode: "follow_active" })
    const subject: ReadSubject = { kind: "share", route: { kind: "tree_page", pageRef: "docs/page.html" }, candidates: ["/docs/page.html"] }
    expect(await decideRead(env.DB, read, subject, { ...team, shareKey: "second_key123" }, null)).toEqual({ kind: "deny", reason: "not_found" })
    expect(await decideRead(env.DB, read, subject, { ...team, shareKey: "first_key123" }, null)).toMatchObject({ kind: "allow", plan: { authority: { basis: "share_key" } } })
  })
  it("opens cross-artefact assets only through an active public or cookie owner", async () => {
    const { read, manage } = await configs()
    await pageFixture({ artifact: otherArtifact, revision: otherRevision, page: otherPage, route: { kind: "tree_page", pageRef: "other/page.html" } })
    await env.DB.batch([
      env.DB.prepare("INSERT INTO revision_resources (revision_id,path,kind,object_key,sha256,size,content_type) VALUES (?, '/shared/app.js', 'asset', 'asset-object', ?, 1, 'application/javascript')").bind(otherRevision, digest),
      env.DB.prepare("INSERT INTO mounts (path,artifact_id,revision_id,kind) VALUES ('/shared/app.js',?,?,'asset')").bind(otherArtifact, otherRevision),
      env.DB.prepare("INSERT INTO revision_resources (revision_id,path,kind,object_key,sha256,size,content_type) VALUES (?, '/orphan.js', 'asset', 'orphan-object', ?, 1, 'application/javascript')").bind(otherRevision, digest),
      env.DB.prepare("INSERT INTO mounts (path,artifact_id,revision_id,kind) VALUES ('/orphan.js',?,?,'asset')").bind(otherArtifact, otherRevision),
      ...ownershipStatements(env.DB, revisionId, [{ ownerPageId: pageId, path: "/shared/app.js" }]),
    ])
    expect(await decideRead(env.DB, read, resource, anonymous, null)).toEqual({ kind: "deny", reason: "not_found" })
    const deps = { db: env.DB, config: manage, now: () => 10 }
    await setVisibility(deps, actor, { pageId, artifactId, expectedPolicyEpoch: 0, visibility: "public" })
    expect(await decideRead(env.DB, read, resource, anonymous, null)).toMatchObject({ kind: "allow", plan: { artifactId: otherArtifact, revisionId: otherRevision, authority: { basis: "public_owner" } } })
    expect(await decideRead(env.DB, read, { kind: "resource", path: "/orphan.js" }, anonymous, null)).toEqual({ kind: "deny", reason: "not_found" })
    expect(await decideRead(env.DB, read, { kind: "resource", path: "/other/page.html" }, anonymous, null)).toEqual({ kind: "deny", reason: "not_found" })
    await expect(env.DB.prepare("UPDATE mounts SET kind = 'fragment' WHERE path = '/docs/page.html'").run()).rejects.toThrow()
  })
  it("opens a shared cross-artefact resource only while its owner cookie is valid", async () => {
    const { read, manage } = await configs()
    await pageFixture({ artifact: otherArtifact, revision: otherRevision, page: otherPage, route: { kind: "tree_page", pageRef: "other/page.html" } })
    await env.DB.batch([
      env.DB.prepare("INSERT INTO revision_resources (revision_id,path,kind,object_key,sha256,size,content_type) VALUES (?, '/shared/app.js', 'asset', 'asset-object', ?, 1, 'application/javascript')").bind(otherRevision, digest),
      env.DB.prepare("INSERT INTO mounts (path,artifact_id,revision_id,kind) VALUES ('/shared/app.js',?,?,'asset')").bind(otherArtifact, otherRevision),
      ...ownershipStatements(env.DB, revisionId, [{ ownerPageId: pageId, path: "/shared/app.js" }]),
    ])
    const deps = { db: env.DB, config: manage, now: () => 10 }
    const grant = await importShare(deps, actor, { pageId, artifactId, expectedPolicyEpoch: 0, key: "historical_123", mode: "follow_active" })
    const cookie = { ...anonymous, shareCookie: { pageRef: "docs/page.html", key: "historical_123" } }
    expect(await decideRead(env.DB, read, resource, cookie, null)).toMatchObject({ kind: "allow", plan: { artifactId: otherArtifact, authority: { basis: "share_cookie" } } })
    await rotateShare(deps, actor, { pageId, artifactId, expectedPolicyEpoch: 1, grantId: grant.grantId })
    expect(await decideRead(env.DB, read, resource, cookie, null)).toEqual({ kind: "deny", reason: "not_found" })
  })
  it("resolves aliases only for team with a live target and stops after retirement", async () => {
    const { read, manage } = await configs()
    const deps = { db: env.DB, config: manage, now: () => 10 }
    await setAlias(deps, actor, { op: "put", kind: "redirect_exact", key: "/old", to: "/docs/page", status: 301, targetPageId: pageId })
    const missing: ReadSubject = { kind: "resource", path: "/old" }
    expect(await decideRead(env.DB, read, missing, anonymous, "/old")).toEqual({ kind: "deny", reason: "not_found" })
    expect(await decideRead(env.DB, read, missing, team, "/old")).toMatchObject({ kind: "alias", status: 301, location: "/docs/page" })
    await setVisibility(deps, actor, { pageId, artifactId, expectedPolicyEpoch: 0, visibility: "public" })
    expect(await decideRead(env.DB, read, missing, anonymous, "/old")).toEqual({ kind: "deny", reason: "not_found" })
    expect(await decideRead(env.DB, read, missing, team, "/old")).toMatchObject({ kind: "alias", status: 301 })
    await executeGuarded(env.DB, instanceId, [{ action: "unpublish", actor: { principalId, surface: "manage", expectedAuthorityEpoch: 0 }, pageId, artifactId, expectedPolicyEpoch: 1, expectedContentVersion: 0, requestDigest: digest, occurredAt: 11 }], retirePageStatements(env.DB, { pageId, actorPrincipalId: principalId, at: 11 }))
    expect(await decideRead(env.DB, read, missing, anonymous, "/old")).toEqual({ kind: "deny", reason: "not_found" })
    expect(await decideRead(env.DB, read, missing, team, "/old")).toEqual({ kind: "deny", reason: "not_found" })
  })
  it("invalidates a share cookie on unpublish", async () => {
    const { read, manage } = await configs()
    const deps = { db: env.DB, config: manage, now: () => 10 }
    await importShare(deps, actor, { pageId, artifactId, expectedPolicyEpoch: 0, key: "historical_123", mode: "follow_active" })
    const cookie = { ...anonymous, shareCookie: { pageRef: "docs/page.html", key: "historical_123" } }
    expect(await decideRead(env.DB, read, page, cookie, null)).toMatchObject({ kind: "allow" })
    await executeGuarded(env.DB, instanceId, [{ action: "unpublish", actor: { principalId, surface: "manage", expectedAuthorityEpoch: 0 }, pageId, artifactId, expectedPolicyEpoch: 1, expectedContentVersion: 0, requestDigest: digest, occurredAt: 11 }], retirePageStatements(env.DB, { pageId, actorPrincipalId: principalId, at: 11 }))
    expect(await decideRead(env.DB, read, page, cookie, null)).toEqual({ kind: "deny", reason: "login_required" })
  })
  it("prefers exact aliases and otherwise preserves the suffix of a prefix alias", async () => {
    const { read, manage } = await configs()
    const deps = { db: env.DB, config: manage, now: () => 10 }
    await setVisibility(deps, actor, { pageId, artifactId, expectedPolicyEpoch: 0, visibility: "public" })
    await setAlias(deps, actor, { op: "put", kind: "redirect_prefix", key: "/legacy/", to: "/new/", status: 308, targetPageId: pageId })
    await setAlias(deps, actor, { op: "put", kind: "redirect_exact", key: "/legacy/special", to: "/special", status: 301, targetPageId: pageId })
    expect(await decideRead(env.DB, read, { kind: "resource", path: "/legacy/special" }, team, "/legacy/special")).toEqual({ kind: "alias", status: 301, location: "/special" })
    expect(await decideRead(env.DB, read, { kind: "resource", path: "/legacy/nested/file.js" }, team, "/legacy/nested/file.js")).toEqual({ kind: "alias", status: 308, location: "/new/nested/file.js" })
    expect(await decideRead(env.DB, read, { kind: "resource", path: "/legacy/nested/file.js" }, anonymous, "/legacy/nested/file.js")).toEqual({ kind: "deny", reason: "not_found" })
  })
  it("allows a targetless legacy alias only to team readers", async () => {
    const { read, manage } = await configs()
    const deps = { db: env.DB, config: manage, now: () => 10 }
    await importShare(deps, actor, { pageId, artifactId, expectedPolicyEpoch: 0, key: "historical_123", mode: "follow_active" })
    await setAlias(deps, actor, { op: "put", kind: "redirect_exact", key: "/legacy-static", to: "/landing", status: 302, targetPageId: null })
    const subject: ReadSubject = { kind: "resource", path: "/legacy-static" }
    expect(await decideRead(env.DB, read, subject, team, "/legacy-static")).toEqual({ kind: "alias", status: 302, location: "/landing" })
    expect(await decideRead(env.DB, read, subject, anonymous, "/legacy-static")).toEqual({ kind: "deny", reason: "not_found" })
    expect(await decideRead(env.DB, read, subject, { ...anonymous, shareCookie: { pageRef: "docs/page.html", key: "historical_123" } }, "/legacy-static")).toEqual({ kind: "deny", reason: "not_found" })
  })
})
