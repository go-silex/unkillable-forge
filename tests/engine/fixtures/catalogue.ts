import { env } from "cloudflare:workers"
import { claimPageStatements, setVisibility } from "../../../domains/catalogue/commands"
import type { ManageInstanceConfig, ReadInstanceConfig } from "../../../domains/catalogue/instance-config"
import { authenticateManage, type ManageActor } from "../../../domains/catalogue/principals"
import { authenticate, type JwksSource, type VerifiedIdentity } from "../../../domains/catalogue/identity"
import { executeGuarded } from "../../../domains/catalogue/guard"

export const instanceId = "test-forge"
export const principalId = `pr_${"a".repeat(26)}`
export const adminRoleId = `rg_${"a".repeat(26)}`
export const artifactId = `ar_${"a".repeat(26)}`
export const revisionId = `rv_${"a".repeat(26)}`
export const pageId = `pg_${"a".repeat(26)}`
export const digest = "a".repeat(64)
export let actor: ManageActor
export let teamIdentity: VerifiedIdentity
let signingKey: CryptoKey
let publicKey: JsonWebKey & { kid: string }
export const jwks: JwksSource = async () => [publicKey]

export async function manageRequest(subject = "admin", audience = "manager", expiresAt = 2_000_000_000): Promise<Request> {
  const encode = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_")
  const header = encode(new TextEncoder().encode(JSON.stringify({ alg: "RS256", kid: "test" })))
  const claims = encode(new TextEncoder().encode(JSON.stringify({ iss: "https://team.cloudflareaccess.com", aud: audience, sub: subject, exp: expiresAt })))
  const unsigned = `${header}.${claims}`
  const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", signingKey, new TextEncoder().encode(unsigned))
  return new Request("https://manage.example.test/", { headers: { "Cf-Access-Jwt-Assertion": `${unsigned}.${encode(new Uint8Array(signature))}` } })
}

export async function authenticatedActor(subject = "admin", expiresAt = 2_000_000_000): Promise<ManageActor> {
  const result = await authenticateManage(await manageRequest(subject, "manager", expiresAt), { db: env.DB, config: (await configs()).manage, jwks, now: () => 10 })
  if (!result) throw new Error("test identity was not authenticated")
  return result
}
export async function authenticatedReader(expiresAt = 2_000_000_000): Promise<VerifiedIdentity> {
  const result = await authenticate(await manageRequest("reader", "reader", expiresAt), { teamDomain: "team.cloudflareaccess.com", audiences: ["reader"], surface: "read" }, jwks, 1)
  if (!result) throw new Error("test reader was not authenticated")
  return result
}


export async function configs(): Promise<{ read: ReadInstanceConfig; manage: ManageInstanceConfig }> {
  const hmac = await crypto.subtle.importKey("raw", new Uint8Array(32).fill(4), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"])
  const aes = await crypto.subtle.importKey("raw", new Uint8Array(32).fill(5), "AES-GCM", false, ["encrypt", "decrypt"])
  const base = { instanceId, canonicalHost: "forge.example.test", aliasHosts: ["alias.example.test"], accessTeamDomain: "team.cloudflareaccess.com", routeGrammars: ["tree", "subtree"] as const, shareGrammars: ["page", "card", "slug"] as const, shareVerifierKeys: [{ kid: "one", key: hmac }] }
  return {
    read: { ...base, surface: "read", readAudiences: ["reader"], login: "serve-shell", shareCookie: true, shellPaths: ["/", "/login", "/login.html"] },
    manage: { ...base, surface: "manage", manageHost: "manage.example.test", manageAudiences: ["manager"], shareSealKey: { kid: "seal", key: aes }, shellPaths: ["/", "/login", "/login.html"] },
  }
}

export async function bootstrap(): Promise<void> {
  await env.DB.batch([
    env.DB.prepare("INSERT INTO instance_meta (singleton, instance_id, contract_version, created_at) VALUES (1, ?, 1, 1)").bind(instanceId),
    env.DB.prepare("INSERT INTO principals (principal_id, issuer, subject, created_at) VALUES (?, 'https://team.cloudflareaccess.com', 'admin', 1)").bind(principalId),
    env.DB.prepare("INSERT INTO role_grants (role_grant_id, principal_id, role, scope_kind, origin, granted_at) VALUES (?, ?, 'admin', 'installation', 'bootstrap', 1)").bind(adminRoleId, principalId),
  ])
  const keys = await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"])
  signingKey = keys.privateKey
  publicKey = { ...await crypto.subtle.exportKey("jwk", keys.publicKey), kid: "test" }
  actor = await authenticatedActor()
  teamIdentity = await authenticatedReader()
}

export async function pageFixture(options: { artifact?: string; revision?: string; page?: string; route?: { kind: "subtree"; slug: string } | { kind: "tree_page"; pageRef: string }; visibility?: "private" | "shared" | "public"; ownership?: readonly { path: string; providerArtifactId: string }[] } = {}): Promise<void> {
  const artifact = options.artifact ?? artifactId
  const revision = options.revision ?? revisionId
  const page = options.page ?? pageId
  const route = options.route ?? { kind: "subtree" as const, slug: "sample" }
  const path = route.kind === "subtree" ? `/a/${route.slug}/index.html` : `/${route.pageRef}`
  const deps = { db: env.DB, config: (await configs()).manage, jwks, now: () => 1 }
  await env.DB.batch([
    env.DB.prepare("INSERT INTO artifacts (artifact_id, origin, created_at) VALUES (?, 'published', 1)").bind(artifact),
    env.DB.prepare("INSERT INTO revisions (revision_id, artifact_id, origin, manifest_sha256, manifest_object_key, sealed_at) VALUES (?, ?, 'published', ?, 'manifest', 1)").bind(revision, artifact, digest),
    env.DB.prepare("INSERT INTO revision_resources (revision_id, path, kind, object_key, sha256, size, content_type) VALUES (?, ?, 'document', 'document', ?, 1, 'text/html')").bind(revision, path, digest),
    env.DB.prepare("INSERT INTO mounts (path, artifact_id, revision_id, kind) VALUES (?, ?, ?, 'document')").bind(path, artifact, revision),
  ])
  const effects = [
    ...claimPageStatements(deps, actor, { pageId: page, artifactId: artifact, route, at: 1 }),
    env.DB.prepare("INSERT INTO revision_pages (revision_id, page_id, document_path, metadata_json) VALUES (?, ?, ?, '{}')").bind(revision, page, path),
  ]
  const activate = env.DB.prepare("UPDATE artifacts SET active_revision_id = ? WHERE artifact_id = ?").bind(revision, artifact)
  if (options.ownership) {
    await executeGuarded(deps, actor, [{ action: "create_page", pageId: page, artifactId: artifact, revisionId: revision, requestDigest: digest, occurredAt: 1 }], effects,
      { revisionId: revision, edges: options.ownership.map(edge => ({ ownerPageId: page, ...edge })) }, [activate])
  } else {
    await env.DB.batch([...effects, activate])
  }
  if (options.visibility === "public") {
    await setVisibility({ db: env.DB, config: (await configs()).manage, jwks, now: () => 2 }, actor, { pageId: page, artifactId: artifact, expectedPolicyEpoch: 0, visibility: "public" })
  }
}

export async function mountedSubdocument(path: string): Promise<void> {
  await env.DB.batch([
    env.DB.prepare("INSERT INTO revision_resources (revision_id,path,kind,object_key,sha256,size,content_type) VALUES (?, ?, 'subdocument', ?, ?, 1, 'text/html')").bind(revisionId, path, path, digest),
    env.DB.prepare("INSERT INTO mounts (path,artifact_id,revision_id,kind) VALUES (?, ?, ?, 'subdocument')").bind(path, artifactId, revisionId),
  ])
}

