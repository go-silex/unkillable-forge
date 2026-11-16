export interface VerifiedIdentity {
  readonly issuer: string
  readonly subject: string | null
  readonly email: string | null
  readonly audience: string
  readonly surface: "read" | "manage"
  readonly expiresAt: number
}

export interface AccessVerifier {
  readonly teamDomain: string
  readonly audiences: readonly string[]
  readonly surface: "read" | "manage"
}

export type JwksSource = (teamDomain: string, kid?: string) => Promise<readonly JsonWebKey[]>

const verifiedIdentities = new WeakSet<object>()

export function isVerifiedIdentity(value: unknown): value is VerifiedIdentity {
  return value !== null && typeof value === "object" && verifiedIdentities.has(value)
}

const TEAM_DOMAIN = /^[a-z0-9-]+\.cloudflareaccess\.com$/
const JWKS_TTL_MS = 60 * 60 * 1000
// Per source/isolate and team, not a fleet-wide limit. A random kid can consume
// the refresh opportunity and delay a genuine rotation until this interval ends.
const JWKS_RETRY_MS = 30 * 1000
const CLOCK_SKEW_SECONDS = 30

type AccessKey = JsonWebKey & { readonly kid?: string }

/** The only network key source is the configured Access team's certificate endpoint. */
export function accessJwksSource(fetcher: typeof fetch = fetch, nowMs: () => number = Date.now): JwksSource {
  const cache = new Map<string, {
    at: number
    keys: readonly JsonWebKey[]
    retryAt: number
    pending?: Promise<readonly JsonWebKey[] | null>
  }>()
  return async (teamDomain, kid) => {
    if (!TEAM_DOMAIN.test(teamDomain)) return []
    let entry = cache.get(teamDomain)
    if (!entry) {
      entry = { at: 0, keys: [], retryAt: 0 }
      cache.set(teamDomain, entry)
    }
    const now = nowMs()
    const valid = entry.at > 0 && now >= entry.at && now - entry.at < JWKS_TTL_MS
    const missingKid = valid && kid !== undefined && !entry.keys.some(key => (key as AccessKey).kid === kid)
    if (valid && !missingKid) return entry.keys
    if (!entry.pending && now >= entry.retryAt) {
      const current = entry
      if (missingKid) current.retryAt = now + JWKS_RETRY_MS
      current.pending = (async () => {
        try {
          // workerd does not support redirect: "error"; never follow a key-source redirect.
          const response = await fetcher(`https://${teamDomain}/cdn-cgi/access/certs`, { redirect: "manual" })
          if (!response.ok) return null
          const body: unknown = await response.json()
          if (!body || typeof body !== "object" || !("keys" in body) || !Array.isArray(body.keys)) return null
          const keys: unknown[] = body.keys
          if (!keys.every(key => key !== null && typeof key === "object" && !Array.isArray(key))) return null
          current.at = nowMs()
          current.keys = keys as JsonWebKey[]
          return current.keys
        } catch {
          return null
        }
      })().then(keys => {
        if (!keys) current.retryAt = Math.max(current.retryAt, now + JWKS_RETRY_MS)
        current.pending = undefined
        return keys
      })
    }
    const fetched = await entry.pending
    if (fetched) return fetched
    const after = nowMs()
    return entry.at > 0 && after >= entry.at && after - entry.at < JWKS_TTL_MS ? entry.keys : []
  }
}

function decodeBase64Url(value: string): Uint8Array {
  if (!value || !/^[A-Za-z0-9_-]+$/.test(value) || value.length % 4 === 1) throw new Error("invalid encoding")
  const binary = atob(value.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - value.length % 4) % 4))
  return Uint8Array.from(binary, (character) => character.charCodeAt(0))
}

function decodeObject(value: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(decodeBase64Url(value)))
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("invalid JSON object")
  return parsed as Record<string, unknown>
}

function requestToken(request: Request): string | null {
  const header = request.headers.get("Cf-Access-Jwt-Assertion")
  if (header) return header
  const match = (request.headers.get("Cookie") || "").match(/(?:^|;\s*)CF_Authorization=([^;]+)/)
  if (!match) return null
  try {
    return decodeURIComponent(match[1])
  } catch {
    return match[1]
  }
}

export async function authenticate(
  request: Request,
  verifier: AccessVerifier,
  jwks: JwksSource,
  nowSeconds: number,
): Promise<VerifiedIdentity | null> {
  if (!TEAM_DOMAIN.test(verifier.teamDomain) || !Number.isFinite(nowSeconds) ||
      (verifier.surface !== "read" && verifier.surface !== "manage") ||
      !Array.isArray(verifier.audiences) || verifier.audiences.length === 0 ||
      verifier.audiences.some((audience) => typeof audience !== "string" || !audience.trim())) return null
  const token = requestToken(request)
  if (!token) return null

  try {
    const parts = token.split(".")
    if (parts.length !== 3) return null
    const header = decodeObject(parts[0])
    const payload = decodeObject(parts[1])
    const signature = decodeBase64Url(parts[2])
    if (header.alg !== "RS256" || (header.kid !== undefined && (typeof header.kid !== "string" || !header.kid))) return null
    const issuer = `https://${verifier.teamDomain}`
    if (payload.iss !== issuer && payload.iss !== `${issuer}/`) return null
    if (typeof payload.exp !== "number" || !Number.isFinite(payload.exp) || payload.exp < nowSeconds - CLOCK_SKEW_SECONDS) return null
    if (payload.nbf !== undefined && (typeof payload.nbf !== "number" || !Number.isFinite(payload.nbf) || payload.nbf > nowSeconds + CLOCK_SKEW_SECONDS)) return null
    const tokenAudiences = typeof payload.aud === "string" ? [payload.aud] : payload.aud
    if (!Array.isArray(tokenAudiences) || !tokenAudiences.every((audience) => typeof audience === "string")) return null
    const audience = verifier.audiences.find((configured) => tokenAudiences.includes(configured))
    if (!audience) return null
    const subject = typeof payload.sub === "string" && payload.sub.length > 0 ? payload.sub : null
    if (payload.sub !== undefined && typeof payload.sub !== "string") return null
    if (verifier.surface === "manage" && !subject) return null
    const keys = await jwks(verifier.teamDomain, header.kid as string | undefined)
    if (!Array.isArray(keys)) return null
    const data = new TextEncoder().encode(`${parts[0]}.${parts[1]}`)
    for (const jwk of keys as readonly AccessKey[]) {
      if (!jwk || jwk.kty !== "RSA" || !jwk.n || !jwk.e || (header.kid !== undefined && jwk.kid !== header.kid)) continue
      try {
        const key = await crypto.subtle.importKey(
          "jwk", { kty: "RSA", n: jwk.n, e: jwk.e, alg: "RS256", ext: true },
          { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"],
        )
        if (await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, signature as BufferSource, data as BufferSource)) {
          const identity: VerifiedIdentity = Object.freeze({
            issuer, subject, email: typeof payload.email === "string" ? payload.email : null,
            audience, surface: verifier.surface, expiresAt: payload.exp,
          })
          verifiedIdentities.add(identity)
          return identity
        }
      } catch {
        // One malformed key must not prevent trying the other matching keys.
      }
    }
  } catch {
    // Malformed tokens, a failing key source and crypto errors all fail closed.
  }
  return null
}
