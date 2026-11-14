import { env } from "cloudflare:workers"
import { beforeEach, describe, expect, it } from "vitest"
import { assignRole, claimPageStatements, disablePrincipal, retirePageStatements, revokeRole } from "../../domains/catalogue/commands"
import { executeGuarded, type GuardRequest } from "../../domains/catalogue/guard"
import { documentRouteOf, validateRevisionPaths } from "../../domains/catalogue/revision-paths"
import { actor, adminRoleId, artifactId, authenticatedActor, bootstrap, configs, digest, jwks, pageFixture, pageId, principalId, revisionId } from "./fixtures/catalogue"

const guard: GuardRequest = { action: "set_visibility", pageId, artifactId, expectedPolicyEpoch: 0, requestDigest: digest, occurredAt: 10 }
const effect = () => env.DB.prepare("UPDATE pages SET visibility = 'public' WHERE page_id = ?").bind(pageId)
beforeEach(async () => { await bootstrap(); await pageFixture() })

describe("transactional policy guard", () => {
  it("commits an authorized effect and audit event together", async () => {
    const deps = { db: env.DB, config: (await configs()).manage, jwks, now: () => 10 }
    await executeGuarded(deps, actor, [guard], [effect()])
    expect(await env.DB.prepare("SELECT visibility FROM pages WHERE page_id = ?").bind(pageId).first()).toEqual({ visibility: "public" })
    expect(await env.DB.prepare("SELECT action, verdict FROM mutation_events").first()).toEqual({ action: "set_visibility", verdict: "ok" })
  })
  it.each([
    ["missing page", { ...guard, pageId: `pg_${"b".repeat(26)}` }, "not_found"],
    ["stale policy", { ...guard, expectedPolicyEpoch: 1 }, "conflict"],
    ["stale content", { ...guard, action: "unpublish", expectedContentVersion: 1 }, "conflict"],
    ["stale target authority", { ...guard, action: "disable_principal", targetPrincipalId: principalId, expectedTargetAuthorityEpoch: 1 }, "conflict"],
    ["missing publish revision", { ...guard, action: "publish", expectedContentVersion: 0, revisionId: `rv_${"b".repeat(26)}` }, "not_found"],
    ["foreign pinned revision", { ...guard, action: "share", revisionId: `rv_${"b".repeat(26)}` }, "invalid_state"],
    ["last administrator", { ...guard, action: "revoke_role", targetPrincipalId: principalId, roleGrantId: adminRoleId, expectedTargetAuthorityEpoch: 0 }, "last_admin"],
  ] as [string, GuardRequest, string][])("rejects %s with no effect or audit event", async (_name, input, code) => {
    const deps = { db: env.DB, config: (await configs()).manage, jwks, now: () => 10 }
    await expect(executeGuarded(deps, actor, [input], [effect()])).rejects.toMatchObject({ code })
    expect(await env.DB.prepare("SELECT visibility, policy_epoch FROM pages WHERE page_id = ?").bind(pageId).first()).toEqual({ visibility: "private", policy_epoch: 0 })
    expect(await env.DB.prepare("SELECT count(*) AS n FROM mutation_events").first()).toEqual({ n: 0 })
  })
  it("rejects an unknown runtime action instead of treating it as authorized", async () => {
    const deps = { db: env.DB, config: (await configs()).manage, jwks, now: () => 10 }
    const unknown = { ...guard, action: "unknown" } as unknown as GuardRequest
    await expect(executeGuarded(deps, actor, [unknown], [effect()])).rejects.toMatchObject({ code: "forbidden" })
    expect(await env.DB.prepare("SELECT visibility FROM pages WHERE page_id = ?").bind(pageId).first()).toEqual({ visibility: "private" })
  })
  it("rejects publication into another artefact's reserved subtree even without a mount collision", async () => {
    const foreignArtifact = `ar_${"b".repeat(26)}`, foreignRevision = `rv_${"b".repeat(26)}`
    await env.DB.batch([
      env.DB.prepare("INSERT INTO artifacts (artifact_id,origin,created_at) VALUES (?,'published',1)").bind(foreignArtifact),
      env.DB.prepare("INSERT INTO revisions (revision_id,artifact_id,origin,manifest_sha256,manifest_object_key,sealed_at) VALUES (?,?,'published',?,'foreign',1)").bind(foreignRevision, foreignArtifact, digest),
      env.DB.prepare("INSERT INTO revision_resources (revision_id,path,kind,object_key,sha256,size,content_type) VALUES (?,'/a/sample/unmounted.js','asset','foreign',?,1,'application/javascript')").bind(foreignRevision, digest),
    ])
    const deps = { db: env.DB, config: (await configs()).manage, jwks, now: () => 10 }
    await expect(executeGuarded(deps, actor, [{ action: "create_page", pageId: `pg_${"b".repeat(26)}`, artifactId: foreignArtifact, revisionId: foreignRevision, requestDigest: digest, occurredAt: 10 }], [effect()])).rejects.toMatchObject({ code: "conflict" })
    expect(await env.DB.prepare("SELECT visibility FROM pages WHERE page_id = ?").bind(pageId).first()).toEqual({ visibility: "private" })
  })
  it("rejects appending ownership to an active revision without changing the page", async () => {
    const deps = { db: env.DB, config: (await configs()).manage, jwks, now: () => 10 }
    await expect(executeGuarded(deps, actor, [{ action: "stage", pageId, artifactId, revisionId, requestDigest: digest, occurredAt: 10 }], [effect()], { revisionId, edges: [{ ownerPageId: pageId, path: "/asset.js", providerArtifactId: artifactId }] })).rejects.toMatchObject({ code: "invalid_state" })
    expect(await env.DB.prepare("SELECT visibility FROM pages WHERE page_id = ?").bind(pageId).first()).toEqual({ visibility: "private" })
  })
  it("does not activate or pin a discarded revision", async () => {
    const discarded = `rv_${"d".repeat(26)}`
    await env.DB.batch([
      env.DB.prepare("INSERT INTO revisions (revision_id,artifact_id,origin,manifest_sha256,manifest_object_key,sealed_at) VALUES (?,?,'published',?,'discarded',2)").bind(discarded, artifactId, digest),
      env.DB.prepare("INSERT INTO revision_discards (revision_id,discarded_at,verdict) VALUES (?,3,'ok')").bind(discarded),
    ])
    const deps = { db: env.DB, config: (await configs()).manage, jwks, now: () => 10 }
    await expect(executeGuarded(deps, actor, [{ action: "publish", pageId, artifactId, revisionId: discarded, expectedPolicyEpoch: 0, expectedContentVersion: 0, requestDigest: digest, occurredAt: 10 }], [effect()])).rejects.toMatchObject({ code: "not_found" })
    await expect(executeGuarded(deps, actor, [{ action: "share", pageId, artifactId, revisionId: discarded, expectedPolicyEpoch: 0, requestDigest: digest, occurredAt: 10 }], [effect()])).rejects.toMatchObject({ code: "invalid_state" })
    expect(await env.DB.prepare("SELECT visibility FROM pages WHERE page_id = ?").bind(pageId).first()).toEqual({ visibility: "private" })
  })
  it("maps canonical documents to their route without admitting malformed paths", () => {
    expect(documentRouteOf("/a/sample/index.html")).toEqual({ kind: "subtree", slug: "sample" })
    expect(documentRouteOf("/docs/page.html")).toEqual({ kind: "tree_page", pageRef: "docs/page.html" })
    for (const path of ["/a/sample/sub/page.html", "/a/Bad/index.html", "/docs/../page.html", "/docs//page.html", "/api"]) expect(documentRouteOf(path)).toBeNull()
  })
  it("reports reserved, shell and foreign subtree paths against the primary", async () => {
    const deps = { db: env.DB, config: (await configs()).manage }
    const conflicts = await validateRevisionPaths(deps, { artifactId: `ar_${"b".repeat(26)}`, paths: ["/a/sample/file.js", "/a/unclaimed/file.js", "/api/private", "/login"], resultingSubtreeSlugs: [] })
    expect(conflicts).toEqual([
      { path: "/a/sample/file.js", reason: "foreign_subtree" },
      { path: "/a/unclaimed/file.js", reason: "reserved" },
      { path: "/api/private", reason: "reserved" },
      { path: "/login", reason: "shell" },
    ])
    await expect(validateRevisionPaths({ ...deps, config: { ...deps.config, instanceId: "different" } }, { artifactId, paths: [], resultingSubtreeSlugs: [] })).rejects.toMatchObject({ code: "instance_mismatch" })
  })
  it("reports a foreign mount under a newly claimed subtree", async () => {
    const foreign = `ar_${"b".repeat(26)}`, foreignRevision = `rv_${"b".repeat(26)}`
    await env.DB.batch([
      env.DB.prepare("INSERT INTO artifacts (artifact_id,origin,created_at) VALUES (?,'published',1)").bind(foreign),
      env.DB.prepare("INSERT INTO revisions (revision_id,artifact_id,origin,manifest_sha256,manifest_object_key,sealed_at) VALUES (?,?,'published',?,'foreign',1)").bind(foreignRevision, foreign, digest),
      env.DB.prepare("INSERT INTO revision_resources (revision_id,path,kind,object_key,sha256,size,content_type) VALUES (?,'/a/future/foreign.js','asset','foreign',?,1,'application/javascript')").bind(foreignRevision, digest),
      env.DB.prepare("INSERT INTO mounts (path,artifact_id,revision_id,kind) VALUES ('/a/future/foreign.js',?,?,'asset')").bind(foreign, foreignRevision),
    ])
    const deps = { db: env.DB, config: (await configs()).manage }
    expect(await validateRevisionPaths(deps, { artifactId, paths: ["/a/future/index.html"], resultingSubtreeSlugs: ["future"] })).toContainEqual({ path: "/a/future/foreign.js", reason: "foreign_subtree" })
  })
  it("rejects resources left under a dropped subtree but accepts a retained subtree", async () => {
    const deps = { db: env.DB, config: (await configs()).manage }
    const paths = ["/a/sample/file.js"]
    expect(await validateRevisionPaths(deps, { artifactId, paths, resultingSubtreeSlugs: [] })).toEqual([{ path: paths[0], reason: "dropped_subtree" }])
    expect(await validateRevisionPaths(deps, { artifactId, paths, resultingSubtreeSlugs: ["sample"] })).toEqual([])
  })
  it("validates all resulting subtrees across bounded query chunks", async () => {
    const deps = { db: env.DB, config: (await configs()).manage }
    const slugs = Array.from({ length: 900 }, (_, index) => `s${index}-${"a".repeat(90)}`)
    slugs.push("sample")
    const conflicts = await validateRevisionPaths(deps, { artifactId: `ar_${"b".repeat(26)}`, paths: ["/a/sample/file.js"], resultingSubtreeSlugs: slugs })
    expect(conflicts).toContainEqual({ path: "/a/sample/file.js", reason: "foreign_subtree" })
  })
  it("refuses forged actors at the page statement builders", async () => {
    const deps = { db: env.EMPTY_DB, config: (await configs()).manage, jwks, now: () => 10 }
    const forged = { ...actor }
    expect(() => claimPageStatements(deps, forged, { pageId, artifactId, route: { kind: "subtree", slug: "sample" }, at: 10 })).toThrowError(expect.objectContaining({ code: "unauthenticated" }))
    expect(() => retirePageStatements(deps, forged, { pageId, at: 10 })).toThrowError(expect.objectContaining({ code: "unauthenticated" }))
  })
  it("maps real D1 missing-schema and named guard failures", async () => {
    const config = (await configs()).manage
    await expect(executeGuarded({ db: env.EMPTY_DB, config, jwks, now: () => 10 }, actor, [guard], [])).rejects.toMatchObject({ code: "unavailable" })
    const statement = env.DB.prepare("INSERT INTO mutation_events (event_id,instance_id,action,actor_principal_id,actor_surface,request_digest,occurred_at,verdict) VALUES (?,?,?,?,?,?,?,'instance_mismatch')").bind(`ev_${"a".repeat(26)}`, config.instanceId, "stage", principalId, "manage", digest, 10)
    await expect(env.DB.batch([statement])).rejects.toThrow(/CHECK constraint failed: guard_instance_mismatch/)
    await env.DB.prepare("DELETE FROM instance_meta").run()
    await expect(executeGuarded({ db: env.DB, config, jwks, now: () => 10 }, actor, [guard], [effect()])).rejects.toMatchObject({ code: "instance_mismatch" })
  })
  it("rejects empty, duplicate, and multiple role guards before touching absent D1", async () => {
    const deps = { db: env.EMPTY_DB, config: (await configs()).manage, jwks, now: () => 10 }
    await expect(executeGuarded(deps, actor, [], [])).rejects.toMatchObject({ code: "invalid_state" })
    await expect(executeGuarded(deps, actor, [guard, guard], [])).rejects.toMatchObject({ code: "invalid_state" })
    const first: GuardRequest = { ...guard, action: "revoke_role", targetPrincipalId: principalId, roleGrantId: adminRoleId, expectedTargetAuthorityEpoch: 0 }
    const second: GuardRequest = { ...first, pageId: `pg_${"b".repeat(26)}`, targetPrincipalId: `pr_${"b".repeat(26)}` }
    await expect(executeGuarded(deps, actor, [first, second], [])).rejects.toMatchObject({ code: "invalid_state" })
    await expect(executeGuarded(deps, actor, [{ ...guard, action: "stage", revisionId }], [], { revisionId, edges: [{ ownerPageId: `pg_${"b".repeat(26)}`, path: "/asset.js", providerArtifactId: artifactId }] })).rejects.toMatchObject({ code: "invalid_state" })
    await expect(executeGuarded(deps, { ...actor }, [guard], [])).rejects.toMatchObject({ code: "unauthenticated" })
  })
  it("revalidates publisher page scope and revoked authority", async () => {
    const publisherId = `pr_${"b".repeat(26)}`
    await env.DB.prepare("INSERT INTO principals (principal_id,issuer,subject,created_at) VALUES (?, 'https://team.cloudflareaccess.com', 'publisher', 1)").bind(publisherId).run()
    const deps = { db: env.DB, config: (await configs()).manage, jwks, now: () => 10 }
    const role = await assignRole(deps, actor, { targetPrincipalId: publisherId, expectedTargetAuthorityEpoch: 0, role: "publisher", scope: { kind: "page", pageId } })
    const publisher = await authenticatedActor("publisher")
    await expect(executeGuarded(deps, publisher, [{ ...guard, action: "create_page", pageId: `pg_${"c".repeat(26)}` }], [])).rejects.toMatchObject({ code: "forbidden" })
    await expect(executeGuarded(deps, publisher, [{ ...guard, pageId: `pg_${"c".repeat(26)}` }], [])).rejects.toMatchObject({ code: "forbidden" })
    await revokeRole(deps, actor, { targetPrincipalId: publisherId, expectedTargetAuthorityEpoch: 1, roleGrantId: role.roleGrantId })
    await expect(executeGuarded(deps, publisher, [guard], [effect()])).rejects.toMatchObject({ code: "conflict" })
    expect(await env.DB.prepare("SELECT visibility FROM pages WHERE page_id = ?").bind(pageId).first()).toEqual({ visibility: "private" })
  })
  it("permits installation publishers to create and change pages but not assign roles", async () => {
    const publisherId = `pr_${"b".repeat(26)}`
    await env.DB.prepare("INSERT INTO principals (principal_id,issuer,subject,created_at) VALUES (?, 'https://team.cloudflareaccess.com', 'publisher', 1)").bind(publisherId).run()
    const deps = { db: env.DB, config: (await configs()).manage, jwks, now: () => 10 }
    await assignRole(deps, actor, { targetPrincipalId: publisherId, expectedTargetAuthorityEpoch: 0, role: "publisher", scope: { kind: "installation" } })
    const publisher = await authenticatedActor("publisher")
    await executeGuarded(deps, publisher, [{ ...guard, action: "create_page", pageId: `pg_${"c".repeat(26)}`, revisionId }], [])
    await executeGuarded(deps, publisher, [guard], [effect()])
    expect(await env.DB.prepare("SELECT visibility FROM pages WHERE page_id = ?").bind(pageId).first()).toEqual({ visibility: "public" })
    await expect(executeGuarded(deps, publisher, [{ ...guard, action: "assign_role", targetPrincipalId: publisherId, expectedTargetAuthorityEpoch: 1 }], [])).rejects.toMatchObject({ code: "forbidden" })
  })
  it("retains one administrator when two administrators concurrently disable each other", async () => {
    const other = `pr_${"b".repeat(26)}`
    await env.DB.batch([
      env.DB.prepare("INSERT INTO principals (principal_id,issuer,subject,created_at) VALUES (?, 'https://team.cloudflareaccess.com', 'other-admin', 1)").bind(other),
      env.DB.prepare("INSERT INTO role_grants (role_grant_id,principal_id,role,scope_kind,origin,granted_at) VALUES (?,?,'admin','installation','bootstrap',1)").bind(`rg_${"b".repeat(26)}`, other),
    ])
    const deps = { db: env.DB, config: (await configs()).manage, jwks, now: () => 10 }
    const otherActor = await authenticatedActor("other-admin")
    const results = await Promise.allSettled([
      disablePrincipal(deps, actor, { targetPrincipalId: other, expectedTargetAuthorityEpoch: 0 }),
      disablePrincipal(deps, otherActor, { targetPrincipalId: principalId, expectedTargetAuthorityEpoch: 0 }),
    ])
    expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1)
    const failure = results.find(result => result.status === "rejected")
    expect(failure?.status === "rejected" ? failure.reason.code : undefined).toBe("unauthenticated")
    expect(await env.DB.prepare("SELECT count(*) AS n FROM principals p JOIN role_grants g ON g.principal_id = p.principal_id WHERE p.status = 'active' AND g.role = 'admin' AND g.revoked_at IS NULL").first()).toEqual({ n: 1 })
  })
})

describe("revision-wide namespace guard", () => {
  const otherArtifact = `ar_${"b".repeat(26)}`, otherRevision = `rv_${"b".repeat(26)}`
  const otherPage = `pg_${"b".repeat(26)}`, secondPage = `pg_${"c".repeat(26)}`
  const candidate = `rv_${"c".repeat(26)}`
  const deps = async () => ({ db: env.DB, config: (await configs()).manage, jwks, now: () => 10 })
  const request = (action: GuardRequest["action"], page: string, artifact: string, revision: string): GuardRequest =>
    ({ action, pageId: page, artifactId: artifact, revisionId: revision, expectedPolicyEpoch: 0, expectedContentVersion: 0, requestDigest: digest, occurredAt: 10 })
  async function seedOther() {
    await pageFixture({ artifact: otherArtifact, revision: otherRevision, page: otherPage, route: { kind: "tree_page", pageRef: "other/page.html" } })
    const d = await deps()
    await env.DB.batch([
      env.DB.prepare("INSERT INTO revision_resources (revision_id,path,kind,object_key,sha256,size,content_type) VALUES (?,'/other/second.html','document','second',?,1,'text/html')").bind(otherRevision, digest),
      env.DB.prepare("INSERT INTO mounts (path,artifact_id,revision_id,kind) VALUES ('/other/second.html',?,?,'document')").bind(otherArtifact, otherRevision),
      ...claimPageStatements(d, actor, { pageId: secondPage, artifactId: otherArtifact, route: { kind: "tree_page", pageRef: "other/second.html" }, at: 1 }),
      env.DB.prepare("INSERT INTO revision_pages (revision_id,page_id,document_path,metadata_json) VALUES (?,?,'/other/second.html','{}')").bind(otherRevision, secondPage),
      env.DB.prepare("INSERT INTO revisions (revision_id,artifact_id,origin,manifest_sha256,manifest_object_key,sealed_at) VALUES (?,?,'published',?,'candidate',2)").bind(candidate, otherArtifact, digest),
    ])
  }
  async function resource(revision: string, path: string, kind: "asset" | "document" = "asset") {
    await env.DB.prepare("INSERT INTO revision_resources (revision_id,path,kind,object_key,sha256,size,content_type) VALUES (?,?,?,?,?,1,?)").bind(revision, path, kind, path, digest, kind === "document" ? "text/html" : "application/javascript").run()
  }
  async function mount(path: string, artifact: string, revision: string) {
    await resource(revision, path)
    await env.DB.prepare("INSERT INTO mounts (path,artifact_id,revision_id,kind) VALUES (?,?,?,'asset')").bind(path, artifact, revision).run()
  }
  it.each(["stage", "unpublish", "share"] as const)("checks the first claim after a %s guard, with atomic rollback", async action => {
    await seedOther()
    await mount("/public/collision.js", artifactId, revisionId)
    await resource(candidate, "/public/collision.js")
    const d = await deps()
    const first = request(action, otherPage, otherArtifact, candidate)
    const claim = request("publish", secondPage, otherArtifact, candidate)
    await expect(executeGuarded(d, actor, [first, claim], [effect()])).rejects.toMatchObject({ code: "conflict" })
    expect(await env.DB.prepare("SELECT visibility FROM pages WHERE page_id = ?").bind(pageId).first()).toEqual({ visibility: "private" })
    expect(await env.DB.prepare("SELECT count(*) AS n FROM mutation_events").first()).toEqual({ n: 0 })
  })
  it("checks a foreign subtree claim after an unpublish row", async () => {
    await seedOther()
    await resource(candidate, "/a/sample/unmounted.js")
    await expect(executeGuarded(await deps(), actor, [request("unpublish", otherPage, otherArtifact, candidate), request("publish", secondPage, otherArtifact, candidate)], [effect()])).rejects.toMatchObject({ code: "conflict" })
    expect(await env.DB.prepare("SELECT visibility FROM pages WHERE page_id = ?").bind(pageId).first()).toEqual({ visibility: "private" })
  })
  it("refuses a late reverse claim against an injected legacy orphan mount atomically", async () => {
    await seedOther()
    await resource(candidate, "/a/new/index.html", "document")
    expect(await validateRevisionPaths(await deps(), { artifactId: otherArtifact, paths: ["/a/new/index.html"], resultingSubtreeSlugs: ["new"] })).toEqual([])
    // Fault injection: a normal publisher cannot mount a resource under an unrouted reserved subtree.
    await mount("/a/new/orphan.js", artifactId, revisionId)
    await expect(executeGuarded(await deps(), actor, [request("unpublish", otherPage, otherArtifact, candidate), request("publish", secondPage, otherArtifact, candidate)], [effect()])).rejects.toMatchObject({ code: "conflict" })
    expect(await env.DB.prepare("SELECT visibility FROM pages WHERE page_id = ?").bind(pageId).first()).toEqual({ visibility: "private" })
    expect(await env.DB.prepare("SELECT count(*) AS n FROM mutation_events").first()).toEqual({ n: 0 })
  })
  it.each(["restore-first", "all-drop-first"] as const)("checks a %s restore claim", async order => {
    await seedOther()
    await resource(candidate, "/other/restored.html", "document")
    await env.DB.prepare("INSERT INTO revision_pages (revision_id,page_id,document_path,metadata_json) VALUES (?,?,?,'{}')").bind(candidate, otherPage, "/other/restored.html").run()
    await env.DB.batch([...retirePageStatements(await deps(), actor, { pageId: otherPage, at: 5 })])
    await resource(candidate, "/a/sample/unmounted.js")
    const restore = request("restore_page", otherPage, otherArtifact, candidate)
    const drop = request("unpublish", secondPage, otherArtifact, candidate)
    await expect(executeGuarded(await deps(), actor, order === "restore-first" ? [restore, drop] : [drop, restore], [effect()])).rejects.toMatchObject({ code: "conflict" })
    expect(await env.DB.prepare("SELECT visibility FROM pages WHERE page_id = ?").bind(pageId).first()).toEqual({ visibility: "private" })
  })
  it("admits resources beneath its own subtree and its own reverse-claim mount", async () => {
    await seedOther()
    await resource(revisionId, "/a/sample/own.js")
    await executeGuarded(await deps(), actor, [request("publish", pageId, artifactId, revisionId)], [])
    await resource(candidate, "/a/own/index.html", "document")
    await mount("/a/own/asset.js", otherArtifact, otherRevision)
    await executeGuarded(await deps(), actor, [request("publish", otherPage, otherArtifact, candidate)], [])
  })
  it("rechecks a different artefact and revision after a successful first claim", async () => {
    await seedOther()
    await resource(candidate, "/a/sample/unmounted.js")
    await expect(executeGuarded(await deps(), actor, [request("publish", pageId, artifactId, revisionId), request("publish", otherPage, otherArtifact, candidate)], [effect()])).rejects.toMatchObject({ code: "conflict" })
    expect(await env.DB.prepare("SELECT visibility FROM pages WHERE page_id = ?").bind(pageId).first()).toEqual({ visibility: "private" })
  })
  it("retains page verdict precedence and per-page audit", async () => {
    await seedOther()
    await resource(candidate, "/a/sample/unmounted.js")
    await expect(executeGuarded(await deps(), actor, [request("publish", `pg_${"z".repeat(26)}`, otherArtifact, candidate)], [])).rejects.toMatchObject({ code: "not_found" })
    await executeGuarded(await deps(), actor, [request("publish", otherPage, otherArtifact, otherRevision), request("publish", secondPage, otherArtifact, otherRevision)], [])
    const events = await env.DB.prepare("SELECT action,page_id,artifact_id,revision_id,verdict FROM mutation_events ORDER BY page_id").all()
    expect(events.results).toEqual([
      { action: "publish", page_id: otherPage, artifact_id: otherArtifact, revision_id: otherRevision, verdict: "ok" },
      { action: "publish", page_id: secondPage, artifact_id: otherArtifact, revision_id: otherRevision, verdict: "ok" },
    ])
  })
  it.each([
    ["/a/sample/x.css", true], ["/a/sample", false], ["/a/sample-x/y", false],
    ["/a/sample.x/y", false], ["/a/sample0/y", false], ["/a/samplez/y", false],
    ["/a/Sample/y", false], ["/a/sample/é", true], ["/a/sampleį/x", false],
  ])("preserves foreign subtree prefix boundary %s", async (path, conflict) => {
    await seedOther()
    await resource(candidate, path)
    const call = executeGuarded(await deps(), actor, [request("publish", otherPage, otherArtifact, candidate)], [])
    if (conflict) await expect(call).rejects.toMatchObject({ code: "conflict" })
    else await expect(call).resolves.toBeDefined()
  })
  it.each([
    ["/a/k/index.html", "/a/k/z.png", true],
    ["/a/k/index.html", "/a/k", false],
    ["/a/k/index.html", "/a/k-2/x", false],
    ["/a/k/sub/index.html", "/a/k/sub/x", false],
    ["/a/%41/index.html", "/a/A/x", false],
    ["/a/_/index.html", "/a/b/x", false],
    ["/a/*/index.html", "/a/x/y", false],
    ["/a/*/index.html", "/a/*/q", true],
  ])("preserves reverse-claim boundary %s against %s", async (document, mounted, conflict) => {
    await seedOther()
    await resource(candidate, document, "document")
    // Legacy/corrupt orphan mount; the normal writer rejects unrouted reserved paths.
    await mount(mounted, artifactId, revisionId)
    const call = executeGuarded(await deps(), actor, [request("publish", otherPage, otherArtifact, candidate)], [])
    if (conflict) await expect(call).rejects.toMatchObject({ code: "conflict" })
    else await expect(call).resolves.toBeDefined()
  })
})
