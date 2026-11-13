import { env } from "cloudflare:workers"
import { beforeEach, describe, expect, it } from "vitest"
import { artifactId, bootstrap, digest, pageFixture, pageId, revisionId } from "./fixtures/catalogue"

beforeEach(async () => { await bootstrap(); await pageFixture() })

describe("catalogue SQL invariants", () => {
  it("rejects NULL opaque text primary keys rather than relying on CHECK(NULL)", async () => {
    await expect(env.DB.prepare("INSERT INTO principals (principal_id, issuer, subject, created_at) VALUES (NULL, 'https://team.cloudflareaccess.com', 'null-id', 1)").run()).rejects.toThrow(/NOT NULL/)
    await expect(env.DB.prepare("INSERT INTO artifacts (artifact_id, origin, created_at) VALUES (NULL, 'published', 1)").run()).rejects.toThrow(/NOT NULL/)
    await expect(env.DB.prepare("INSERT INTO pages (page_id, artifact_id, created_at) VALUES (NULL, ?, 1)").bind(artifactId).run()).rejects.toThrow(/NOT NULL/)
    await expect(env.DB.prepare("INSERT INTO revisions (revision_id, artifact_id, origin, manifest_sha256, manifest_object_key, sealed_at) VALUES (NULL, ?, 'published', ?, 'x', 1)").bind(artifactId, digest).run()).rejects.toThrow(/NOT NULL/)
    await expect(env.DB.prepare("INSERT INTO role_grants (role_grant_id, principal_id, role, scope_kind, origin, granted_at) VALUES (NULL, ?, 'admin', 'installation', 'bootstrap', 1)").bind(`pr_${"a".repeat(26)}`).run()).rejects.toThrow(/NOT NULL/)
    await expect(env.DB.prepare("INSERT INTO share_grants (grant_id, page_id, key_kid, key_hmac, mode, origin, created_at) VALUES (NULL, ?, 'one', ?, 'follow_active', 'imported', 1)").bind(pageId, digest).run()).rejects.toThrow(/NOT NULL/)
    await expect(env.DB.prepare("INSERT INTO mutation_events (event_id, instance_id, action, actor_principal_id, actor_surface, request_digest, occurred_at, verdict) VALUES (NULL, 'test-forge', 'stage', ?, 'manage', ?, 1, 'ok')").bind(`pr_${"a".repeat(26)}`, digest).run()).rejects.toThrow(/NOT NULL/)
  })
  it("refuses document laundering even when the requested alternative kind exists in the revision", async () => {
    const alternate = `rv_${"b".repeat(26)}`
    await env.DB.batch([
      env.DB.prepare("INSERT INTO revisions (revision_id, artifact_id, origin, manifest_sha256, manifest_object_key, sealed_at) VALUES (?, ?, 'published', ?, 'other', 1)").bind(alternate, artifactId, digest),
      env.DB.prepare("INSERT INTO revision_resources (revision_id, path, kind, object_key, sha256, size, content_type) VALUES (?, '/a/sample/index.html', 'fragment', 'fragment', ?, 1, 'text/html')").bind(alternate, digest),
    ])
    await expect(env.DB.prepare("UPDATE mounts SET revision_id = ?, kind = 'fragment' WHERE path = '/a/sample/index.html'").bind(alternate).run()).rejects.toThrow(/FOREIGN KEY/)
    expect(await env.DB.prepare("SELECT revision_id, kind FROM mounts WHERE path = '/a/sample/index.html'").first()).toEqual({ revision_id: revisionId, kind: "document" })
    expect(await env.DB.prepare("SELECT page_id FROM routes WHERE page_id = ?").bind(pageId).first()).toEqual({ page_id: pageId })
  })
  it("refuses a tree route in the subtree namespace even for an existing document mount", async () => {
    await expect(env.DB.prepare("INSERT INTO routes (kind, route_key, page_id, artifact_id, document_path, document_kind, created_at) VALUES ('tree_page', 'a/sample/index.html', ?, ?, '/a/sample/index.html', 'document', 1)").bind(pageId, artifactId).run()).rejects.toThrow(/CHECK/)
  })
})
