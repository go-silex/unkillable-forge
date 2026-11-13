import { env } from "cloudflare:workers"
import { claimPageStatements, setVisibility } from "../../../domains/catalogue/commands"
import type { ManageInstanceConfig, ReadInstanceConfig } from "../../../domains/catalogue/instance-config"

export const instanceId = "test-forge"
export const principalId = `pr_${"a".repeat(26)}`
export const adminRoleId = `rg_${"a".repeat(26)}`
export const artifactId = `ar_${"a".repeat(26)}`
export const revisionId = `rv_${"a".repeat(26)}`
export const pageId = `pg_${"a".repeat(26)}`
export const digest = "a".repeat(64)
export const actor = { principalId, authorityEpoch: 0, surface: "manage" as const }

export async function configs(): Promise<{ read: ReadInstanceConfig; manage: ManageInstanceConfig }> {
  const hmac = await crypto.subtle.importKey("raw", new Uint8Array(32).fill(4), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"])
  const aes = await crypto.subtle.importKey("raw", new Uint8Array(32).fill(5), "AES-GCM", false, ["encrypt", "decrypt"])
  const base = { instanceId, canonicalHost: "forge.example.test", aliasHosts: ["alias.example.test"], accessTeamDomain: "team.cloudflareaccess.com", routeGrammars: ["tree", "subtree"] as const, shareGrammars: ["page", "card", "slug"] as const, shareVerifierKeys: [{ kid: "one", key: hmac }] }
  return {
    read: { ...base, surface: "read", readAudiences: ["reader"], login: "serve-shell", shareCookie: true, shellPaths: ["/", "/login", "/login.html"] },
    manage: { ...base, surface: "manage", manageHost: "manage.example.test", manageAudiences: ["manager"], shareSealKey: { kid: "seal", key: aes } },
  }
}

export async function bootstrap(): Promise<void> {
  await env.DB.batch([
    env.DB.prepare("INSERT INTO instance_meta (singleton, instance_id, contract_version, created_at) VALUES (1, ?, 1, 1)").bind(instanceId),
    env.DB.prepare("INSERT INTO principals (principal_id, issuer, subject, created_at) VALUES (?, 'https://team.cloudflareaccess.com', 'admin', 1)").bind(principalId),
    env.DB.prepare("INSERT INTO role_grants (role_grant_id, principal_id, role, scope_kind, origin, granted_at) VALUES (?, ?, 'admin', 'installation', 'bootstrap', 1)").bind(adminRoleId, principalId),
  ])
}

export async function pageFixture(options: { artifact?: string; revision?: string; page?: string; route?: { kind: "subtree"; slug: string } | { kind: "tree_page"; pageRef: string }; visibility?: "private" | "shared" | "public" } = {}): Promise<void> {
  const artifact = options.artifact ?? artifactId
  const revision = options.revision ?? revisionId
  const page = options.page ?? pageId
  const route = options.route ?? { kind: "subtree" as const, slug: "sample" }
  const path = route.kind === "subtree" ? `/a/${route.slug}/index.html` : `/${route.pageRef}`
  await env.DB.batch([
    env.DB.prepare("INSERT INTO artifacts (artifact_id, origin, created_at) VALUES (?, 'published', 1)").bind(artifact),
    env.DB.prepare("INSERT INTO revisions (revision_id, artifact_id, origin, manifest_sha256, manifest_object_key, sealed_at) VALUES (?, ?, 'published', ?, 'manifest', 1)").bind(revision, artifact, digest),
    env.DB.prepare("INSERT INTO revision_resources (revision_id, path, kind, object_key, sha256, size, content_type) VALUES (?, ?, 'document', 'document', ?, 1, 'text/html')").bind(revision, path, digest),
    env.DB.prepare("INSERT INTO mounts (path, artifact_id, revision_id, kind) VALUES (?, ?, ?, 'document')").bind(path, artifact, revision),
    ...claimPageStatements(env.DB, { pageId: page, artifactId: artifact, route, actorPrincipalId: principalId, at: 1 }),
    env.DB.prepare("INSERT INTO revision_pages (revision_id, page_id, document_path, metadata_json) VALUES (?, ?, ?, '{}')").bind(revision, page, path),
    env.DB.prepare("UPDATE artifacts SET active_revision_id = ? WHERE artifact_id = ?").bind(revision, artifact),
  ])
  if (options.visibility === "public") {
    await setVisibility({ db: env.DB, config: (await configs()).manage, now: () => 2 }, actor, { pageId: page, artifactId: artifact, expectedPolicyEpoch: 0, visibility: "public" })
  }
}

export async function mountedSubdocument(path: string): Promise<void> {
  await env.DB.batch([
    env.DB.prepare("INSERT INTO revision_resources (revision_id,path,kind,object_key,sha256,size,content_type) VALUES (?, ?, 'subdocument', ?, ?, 1, 'text/html')").bind(revisionId, path, path, digest),
    env.DB.prepare("INSERT INTO mounts (path,artifact_id,revision_id,kind) VALUES (?, ?, ?, 'subdocument')").bind(path, artifactId, revisionId),
  ])
}
