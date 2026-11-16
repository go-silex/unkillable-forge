import { env } from "cloudflare:workers"
import { applyD1Migrations, reset } from "cloudflare:test"
import { describe, expect, it } from "vitest"
import { executeGuarded, type GuardRequest } from "../../domains/catalogue/guard"
import { actor, adminRoleId, artifactId, bootstrap, configs, digest, jwks, pageFixture, pageId, revisionId } from "./fixtures/catalogue"

const originalGuard: GuardRequest = { action: "set_visibility", pageId, artifactId, expectedPolicyEpoch: 0, requestDigest: digest, occurredAt: 10 }
const effect = () => env.DB.prepare("UPDATE pages SET visibility = 'public' WHERE page_id = ?").bind(pageId)

async function preMigration() {
  // The shared setup migrates DB fully; reset all isolated storage before applying
  // the real historical migrations to the same native D1 binding used by fixtures.
  await reset()
  const prior = env.TEST_MIGRATIONS.filter(m => m.name === "0001_catalogue.sql" || m.name === "0002_publication.sql")
  const next = env.TEST_MIGRATIONS.filter(m => m.name === "0003_previews_sharing.sql")
  expect(prior.map(m => m.name)).toEqual(["0001_catalogue.sql", "0002_publication.sql"])
  expect(next).toHaveLength(1)
  await applyD1Migrations(env.DB, prior)
  await bootstrap()
  await pageFixture()
  return next
}

async function guardedBehavior() {
  const deps = { db: env.DB, config: (await configs()).manage, jwks, now: () => 10 }
  const before = await env.DB.prepare("SELECT event_id, action, verdict FROM mutation_events ORDER BY event_id").all()
  await expect(executeGuarded(deps, actor, [{ ...originalGuard, expectedPolicyEpoch: 1 }], [effect()])).rejects.toMatchObject({ code: "conflict" })
  await env.DB.prepare("UPDATE role_grants SET revoked_at = 2, revoked_by = ? WHERE role_grant_id = ?").bind(actor.principalId, adminRoleId).run()
  await expect(executeGuarded(deps, actor, [originalGuard], [effect()])).rejects.toMatchObject({ code: "forbidden" })
  expect(await env.DB.prepare("SELECT visibility, policy_epoch FROM pages WHERE page_id = ?").bind(pageId).first()).toEqual({ visibility: "private", policy_epoch: 0 })
  expect((await env.DB.prepare("SELECT event_id, action, verdict FROM mutation_events ORDER BY event_id").all()).results).toEqual(before.results)
  await env.DB.prepare("UPDATE role_grants SET revoked_at = NULL, revoked_by = NULL WHERE role_grant_id = ?").bind(adminRoleId).run()
  await executeGuarded(deps, actor, [originalGuard], [effect()])
  expect(await env.DB.prepare("SELECT visibility FROM pages WHERE page_id = ?").bind(pageId).first()).toEqual({ visibility: "public" })
  expect((await env.DB.prepare("SELECT action, verdict FROM mutation_events WHERE action = 'set_visibility' ORDER BY occurred_at").all()).results).toContainEqual({ action: "set_visibility", verdict: "ok" })
}

async function schema() {
  return (await env.DB.prepare("SELECT type, name, tbl_name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name").all()).results
}

describe("preview namespace migration on native D1", () => {
  it("atomically refuses a pre-existing original and leaves the prior instance usable", async () => {
    const next = await preMigration()
    await env.DB.prepare("INSERT INTO revision_resources (revision_id,path,kind,object_key,sha256,size,content_type) VALUES (?,'/_derived/existing.png','asset','original',?,1,'image/png')").bind(revisionId, digest).run()
    const beforeSchema = await schema()
    const beforeResources = (await env.DB.prepare("SELECT * FROM revision_resources ORDER BY path").all()).results
    const beforeMigrations = (await env.DB.prepare("SELECT name FROM d1_migrations ORDER BY id").all()).results
    await expect(applyD1Migrations(env.DB, next)).rejects.toThrow(/preview_namespace_collision/)
    expect(await schema()).toEqual(beforeSchema)
    expect((await env.DB.prepare("SELECT * FROM revision_resources ORDER BY path").all()).results).toEqual(beforeResources)
    expect((await env.DB.prepare("SELECT name FROM d1_migrations ORDER BY id").all()).results).toEqual(beforeMigrations)
    await guardedBehavior()
    // The old schema still accepts another formerly legal original path.
    await env.DB.prepare("INSERT INTO revision_resources (revision_id,path,kind,object_key,sha256,size,content_type) VALUES (?,'/_derived/another.png','asset','another',?,1,'image/png')").bind(revisionId, digest).run()
  })

  it("preserves existing events and transactional policy guards after migration while reserving the namespace", async () => {
    const next = await preMigration()
    await env.DB.prepare("INSERT INTO revision_resources (revision_id,path,kind,object_key,sha256,size,content_type) VALUES (?,'/_derived.html','document','tree-document',?,1,'text/html')").bind(revisionId, digest).run()
    const deps = { db: env.DB, config: (await configs()).manage, jwks, now: () => 10 }
    await executeGuarded(deps, actor, [originalGuard], [])
    const events = (await env.DB.prepare("SELECT * FROM mutation_events ORDER BY event_id").all()).results
    await applyD1Migrations(env.DB, next)
    expect((await env.DB.prepare("SELECT * FROM mutation_events ORDER BY event_id").all()).results).toEqual(events)
    await guardedBehavior()
    for (const path of ["/_derived/new.png"]) {
      await expect(env.DB.prepare("INSERT INTO revision_resources (revision_id,path,kind,object_key,sha256,size,content_type) VALUES (?,?,'asset','new',?,1,'image/png')").bind(revisionId, path, digest).run()).rejects.toThrow()
    }
    await env.DB.prepare("INSERT INTO revision_resources (revision_id,path,kind,object_key,sha256,size,content_type) VALUES (?,'/_derived-other.png','asset','allowed',?,1,'image/png')").bind(revisionId, digest).run()
    await env.DB.prepare("INSERT INTO revision_resources (revision_id,path,kind,object_key,sha256,size,content_type) VALUES (?,'/_derived','asset','allowed-root',?,1,'image/png')").bind(revisionId, digest).run()
  })
})
