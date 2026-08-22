/** CSRF guards for cookie-authenticated JSON mutations (Origin must match canonical host). */

import { type ForgeEnv, json, publicOrigin } from "./access"

export function requiresJsonBody(request: Request): boolean {
  const ct = (request.headers.get("Content-Type") || "").trim().toLowerCase()
  return ct.startsWith("application/json")
}

/** Canonical HTTPS origin; null if PUBLIC_HOST / request host cannot be resolved. */
export function canonicalMutationOrigin(
  env: ForgeEnv,
  request: Request,
): string | null {
  try {
    return publicOrigin(env, request)
  } catch {
    return null
  }
}

/**
 * Cookie-auth mutations must present Origin (preferred) or Referer matching the
 * canonical public origin exactly. Ops header bypass callers skip this check.
 */
export function mutationOriginAllowed(
  request: Request,
  env: ForgeEnv,
): boolean {
  const canonical = canonicalMutationOrigin(env, request)
  if (!canonical) return false

  const origin = request.headers.get("Origin")
  if (origin) return origin === canonical

  const referer = request.headers.get("Referer")
  if (!referer) return false
  try {
    return new URL(referer).origin === canonical
  } catch {
    return false
  }
}

/** Returns a Response to short-circuit, or null when the mutation may proceed. */
export function enforceMutationGuard(
  request: Request,
  env: ForgeEnv,
): Response | null {
  if (!requiresJsonBody(request)) {
    return json({ error: "invalid_content_type" }, 415)
  }
  if (!mutationOriginAllowed(request, env)) {
    return json({ error: "csrf_origin" }, 403)
  }
  return null
}
