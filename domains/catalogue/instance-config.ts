import { isReservedShellPath } from "./routing/grammar"

export type RouteGrammar = "subtree" | "tree"
export type ShareGrammar = "slug" | "page" | "card"
export type LoginMode = "serve-shell" | "redirect-access-login"

export interface ShareVerifierKey { readonly kid: string; readonly key: CryptoKey }
export interface ShareSealKey { readonly kid: string; readonly key: CryptoKey }
export interface InstanceBase {
  readonly instanceId: string
  readonly canonicalHost: string
  readonly aliasHosts: readonly string[]
  readonly accessTeamDomain: string
  readonly routeGrammars: readonly RouteGrammar[]
  readonly shareGrammars: readonly ShareGrammar[]
  readonly shareVerifierKeys: readonly ShareVerifierKey[]
}
export interface ReadInstanceConfig extends InstanceBase {
  readonly surface: "read"
  readonly readAudiences: readonly string[]
  readonly login: LoginMode
  readonly shareCookie: boolean
  readonly shellPaths: readonly string[]
}
export interface ManageInstanceConfig extends InstanceBase {
  readonly surface: "manage"
  readonly manageHost: string
  readonly manageAudiences: readonly string[]
  readonly shareSealKey: ShareSealKey | null
}
export type ConfigResult<T> =
  | { readonly ok: true; readonly config: T }
  | { readonly ok: false; readonly errors: readonly string[] }

type ObjectValue = Record<string, unknown>

function object(value: unknown): value is ObjectValue {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

function json(value: unknown, name: string, errors: string[]): unknown {
  if (typeof value !== "string") {
    errors.push(`${name} must be a JSON string`)
    return null
  }
  try { return JSON.parse(value) as unknown } catch {
    errors.push(`${name} must be valid JSON`)
    return null
  }
}

function hostname(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 253 || value.length === 0) return false
  if (!/^[a-z0-9.-]+$/.test(value) || value.endsWith(".pages.dev") || value.endsWith(".workers.dev")) return false
  return value.split(".").every(label => label.length > 0 && label.length <= 63 && /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label))
}

function strings(value: unknown, name: string, errors: string[], nonempty = false): string[] {
  if (!Array.isArray(value) || value.some(item => typeof item !== "string" || item.length === 0) || (nonempty && value.length === 0)) {
    errors.push(`${name} must be ${nonempty ? "a non-empty" : "an"} array of non-empty strings`)
    return []
  }
  const result = value as string[]
  if (new Set(result).size !== result.length) errors.push(`${name} must not contain duplicates`)
  return result
}

function keyBytes(value: unknown): Uint8Array<ArrayBuffer> | null {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]+$/.test(value) || value.length % 4 === 1) return null
  try {
    const binary = atob(value.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - value.length % 4) % 4))
    if (btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "") !== value) return null
    const bytes = new Uint8Array(binary.length)
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
    return bytes
  } catch { return null }
}

async function importKey(value: unknown, kind: "verifier" | "seal", errors: string[]): Promise<ShareVerifierKey | ShareSealKey | null> {
  if (!object(value) || typeof value.kid !== "string" || !/^[a-z0-9]{1,16}$/.test(value.kid)) {
    errors.push(`${kind} key has an invalid kid`)
    return null
  }
  const bytes = keyBytes(value.key)
  if (!bytes || (kind === "seal" ? bytes.length !== 32 : bytes.length < 32)) {
    errors.push(`${kind} key has invalid base64url key material or length`)
    return null
  }
  try {
    const key = kind === "seal"
      ? await crypto.subtle.importKey("raw", bytes, "AES-GCM", false, ["encrypt", "decrypt"])
      : await crypto.subtle.importKey("raw", bytes, { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"])
    return { kid: value.kid, key }
  } catch {
    errors.push(`${kind} key could not be imported`)
    return null
  }
}

async function parse(env: Readonly<Record<string, unknown>>, surface: "read" | "manage"): Promise<ConfigResult<ReadInstanceConfig | ManageInstanceConfig>> {
  const errors: string[] = []
  const db = env.DB
  if (!object(db) || typeof db.prepare !== "function" || typeof db.batch !== "function") errors.push("DB must be a D1 binding")
  const parsed = json(env.FORGE_INSTANCE, "FORGE_INSTANCE", errors)
  if (!object(parsed)) errors.push("FORGE_INSTANCE must be an object")
  const data = object(parsed) ? parsed : {}
  const instanceId = data.instanceId
  if (typeof instanceId !== "string" || !/^[a-z][a-z0-9-]{1,39}$/.test(instanceId)) errors.push("instanceId is invalid")
  const canonicalHost = data.canonicalHost
  const manageHost = data.manageHost
  if (!hostname(canonicalHost)) errors.push("canonicalHost is invalid")
  if (!hostname(manageHost)) errors.push("manageHost is invalid")
  const aliasHosts = strings(data.aliasHosts, "aliasHosts", errors)
  if (aliasHosts.some(host => !hostname(host))) errors.push("aliasHosts contains an invalid host")
  if (typeof canonicalHost === "string" && aliasHosts.includes(canonicalHost)) errors.push("canonicalHost must not be an alias")
  if (typeof manageHost === "string" && (manageHost === canonicalHost || aliasHosts.includes(manageHost))) errors.push("manageHost must be distinct from read hosts")
  const accessTeamDomain = data.accessTeamDomain
  if (typeof accessTeamDomain !== "string" || !/^[a-z0-9-]+\.cloudflareaccess\.com$/.test(accessTeamDomain) || !hostname(accessTeamDomain)) errors.push("accessTeamDomain is invalid")
  const readAudiences = strings(data.readAudiences, "readAudiences", errors, true)
  const manageAudiences = strings(data.manageAudiences, "manageAudiences", errors, true)
  if (readAudiences.some(audience => manageAudiences.includes(audience))) errors.push("readAudiences and manageAudiences must be disjoint")
  const routes = strings(data.routeGrammars, "routeGrammars", errors, true)
  const shares = strings(data.shareGrammars, "shareGrammars", errors, true)
  if (routes.some(route => route !== "tree" && route !== "subtree")) errors.push("routeGrammars contains an unknown grammar")
  if (shares.some(share => share !== "slug" && share !== "page" && share !== "card")) errors.push("shareGrammars contains an unknown grammar")
  if (shares.includes("page") && !routes.includes("tree")) errors.push("page shares require tree routes")
  if (shares.includes("slug") && !routes.includes("subtree")) errors.push("slug shares require subtree routes")
  if (shares.includes("card") && !routes.includes("tree") && !routes.includes("subtree")) errors.push("card shares require a route grammar")
  if (typeof data.shareCookie !== "boolean") errors.push("shareCookie must be a boolean")
  if (data.shareCookie === true && (!shares.includes("page") || !routes.includes("tree"))) errors.push("shareCookie requires page shares and tree routes")
  if (data.login !== "serve-shell" && data.login !== "redirect-access-login") errors.push("login is invalid")
  const shellPaths = strings(data.shellPaths, "shellPaths", errors, true)
  if (!shellPaths.includes("/login")) errors.push("shellPaths must include /login")
  const verifierInput = json(env.FORGE_SHARE_VERIFIER_KEYS, "FORGE_SHARE_VERIFIER_KEYS", errors)
  const verifierKeys: ShareVerifierKey[] = []
  if (!Array.isArray(verifierInput) || verifierInput.length < 1 || verifierInput.length > 2) errors.push("FORGE_SHARE_VERIFIER_KEYS must contain one or two keys")
  else {
    for (const item of verifierInput) {
      const key = await importKey(item, "verifier", errors)
      if (key) verifierKeys.push(key)
    }
    if (new Set(verifierKeys.map(key => key.kid)).size !== verifierKeys.length) errors.push("verifier key kids must be distinct")
  }
  let sealKey: ShareSealKey | null = null
  if (surface === "read" && "FORGE_SHARE_SEAL_KEY" in env) errors.push("FORGE_SHARE_SEAL_KEY must not be bound on read")
  if (surface === "manage" && "FORGE_SHARE_SEAL_KEY" in env) {
    sealKey = await importKey(json(env.FORGE_SHARE_SEAL_KEY, "FORGE_SHARE_SEAL_KEY", errors), "seal", errors)
  }
  const base: InstanceBase = {
    instanceId: typeof instanceId === "string" ? instanceId : "",
    canonicalHost: typeof canonicalHost === "string" ? canonicalHost : "",
    aliasHosts,
    accessTeamDomain: typeof accessTeamDomain === "string" ? accessTeamDomain : "",
    routeGrammars: routes as RouteGrammar[],
    shareGrammars: shares as ShareGrammar[],
    shareVerifierKeys: verifierKeys,
  }
  for (const path of shellPaths) {
    if (!path.startsWith("/") || path.startsWith("//") || /[?#\\\x00-\x1f\x7f%]/.test(path) || path.split("/").some((segment, index, segments) => index > 0 && (segment === "." || segment === ".." || (segment === "" && index < segments.length - 1)))) {
      errors.push("shellPaths contains a malformed path")
    } else if (isReservedShellPath(path)) errors.push("shellPaths contains a reserved path")
  }
  if (errors.length) return { ok: false, errors }
  if (surface === "read") return { ok: true, config: { ...base, surface, readAudiences, login: data.login as LoginMode, shareCookie: data.shareCookie as boolean, shellPaths } }
  return { ok: true, config: { ...base, surface, manageHost: manageHost as string, manageAudiences, shareSealKey: sealKey } }
}

export async function parseReadConfig(env: Readonly<Record<string, unknown>>): Promise<ConfigResult<ReadInstanceConfig>> {
  return await parse(env, "read") as ConfigResult<ReadInstanceConfig>
}

export async function parseManageConfig(env: Readonly<Record<string, unknown>>): Promise<ConfigResult<ManageInstanceConfig>> {
  return await parse(env, "manage") as ConfigResult<ManageInstanceConfig>
}
