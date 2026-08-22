/** Strict /s/<slug>/<key>/… routing — confine to slug subtree, reject traversal encodings. */

import { SLUG_RE } from "./access"

/** Matches mintKey output (18 chars from url-safe alphabet). */
export const SHARE_KEY_RE = /^[A-Za-z0-9_-]{8,128}$/

const ENCODED_SEPARATOR_RE = /%(2[fFeE]|5[cC])/

export function rawUrlPathHasEncodedSeparators(rawUrl: string): boolean {
  const pathPart = rawUrl.split(/[?#]/)[0] ?? rawUrl
  return ENCODED_SEPARATOR_RE.test(pathPart)
}

export function isSafeAssetSegment(segment: string): boolean {
  if (!segment || segment === "." || segment === "..") return false
  if (segment.includes("/") || segment.includes("\\") || segment.includes("%")) {
    return false
  }
  return /^[a-zA-Z0-9._-]+$/.test(segment)
}

export type ShareRoute = {
  slug: string
  key: string
  rest: string[]
}

export function parseShareRoute(
  url: URL,
  rawUrl: string,
): { ok: true; route: ShareRoute } | { ok: false } {
  if (rawUrlPathHasEncodedSeparators(rawUrl)) return { ok: false }

  const path = url.pathname
  if (path === "/s" || path === "/s/") return { ok: false }
  if (!path.startsWith("/s/")) return { ok: false }

  const parts = path.replace(/^\/s\/?/, "").split("/").filter(Boolean)
  const qk = url.searchParams.get("k") || ""

  let slug = ""
  let key = ""
  let rest: string[] = []

  if (parts.length >= 2 && !qk) {
    slug = parts[0]
    key = parts[1]
    rest = parts.slice(2)
  } else if (parts.length >= 1 && qk) {
    slug = parts[0]
    key = qk
    rest = parts.slice(1)
  } else {
    return { ok: false }
  }

  if (!SLUG_RE.test(slug)) return { ok: false }
  if (!SHARE_KEY_RE.test(key)) return { ok: false }
  if (rest.some((segment) => !isSafeAssetSegment(segment))) return { ok: false }

  return { ok: true, route: { slug, key, rest } }
}

/** Map authorised share rest segments to an artefact path under /a/<slug>/ only. */
export function shareAssetPath(slug: string, rest: string[]): string {
  if (rest.length === 0) return `/a/${slug}/index.html`
  const last = rest[rest.length - 1]
  if (last.includes(".")) return `/a/${slug}/${rest.join("/")}`
  return `/a/${slug}/${rest.join("/")}/index.html`
}
