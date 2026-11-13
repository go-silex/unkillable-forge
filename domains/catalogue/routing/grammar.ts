/* Routing derived from Roxabi functions/_middleware.ts and functions/_lib/share-unfurl.ts,
 * revision 9c7dda4fd6427dde7da5f474a4519fffefe3ba6a (MIT); and Silex
 * functions/_lib/share-path.ts, revision 9722984354d4597d765b2d645240e6b2f98f3068. */
import type { InstanceBase, ReadInstanceConfig } from "../instance-config"

export type SubtreeOrTree =
  | { readonly kind: "subtree"; readonly slug: string }
  | { readonly kind: "tree_page"; readonly pageRef: string }
type Target = { readonly route: SubtreeOrTree; readonly path: string }
export type ParsedRequest =
  | { readonly kind: "deny"; readonly status: 403 | 404 | 405; readonly reason: "host" | "method" | "internal" | "malformed" }
  | { readonly kind: "shell"; readonly path: string; readonly login: { readonly next: string; readonly host: string } | null }
  | { readonly kind: "catalogue" }
  | { readonly kind: "subtree"; readonly slug: string; readonly candidates: readonly string[]; readonly next: string; readonly path: string }
  | { readonly kind: "tree"; readonly pageRef: string; readonly candidates: readonly string[]; readonly next: string; readonly path: string }
  | { readonly kind: "resource"; readonly path: string }
  | { readonly kind: "share"; readonly grammar: "slug" | "page"; readonly route: SubtreeOrTree; readonly key: string; readonly candidates: readonly string[]; readonly browser: boolean }
  | { readonly kind: "card"; readonly key: string; readonly targets: readonly Target[] }
  | { readonly kind: "pinned"; readonly pageId: string; readonly revisionId: string; readonly path: string }
export interface RequestCredentials { readonly shareCookie: { readonly pageRef: string; readonly key: string } | null }

const slugRe = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const segmentRe = /^[A-Za-z0-9._-]+$/
const keyRe = /^[A-Za-z0-9_-]{8,128}$/
const idRe = /^(?:pg|rv)_[a-z2-7]{26}$/
const pageRefRe = /^(?:[A-Za-z0-9._-]+\/)*[A-Za-z0-9._-]+\.html$/
const validPageRef = (value: string): boolean => pageRefRe.test(value) && !value.includes("..")

export function subtreeSlugOf(path: string): string | null {
  if (!path.startsWith("/a/")) return null
  const slug = path.slice(3).split("/", 1)[0]
  return slugRe.test(slug) ? slug : null
}

export function safeNext(raw: string | null, origin: string): string {
  if (!raw || !raw.startsWith("/") || raw.includes("..") || /[\\\u0000-\u001f\u007f]/.test(raw)) return "/"
  const path = raw.split(/[?#]/, 1)[0]
  if (/%(?:2f|5c|0[0-9a-f]|1[0-9a-f]|7f)/i.test(path)) return "/"
  try {
    const base = new URL(origin)
    const target = new URL(raw, base)
    if (target.origin !== base.origin || target.pathname.startsWith("//") || target.pathname === "/login" || target.pathname === "/login.html") return "/"
    return target.pathname + target.search + target.hash
  } catch { return "/" }
}
export function loginLocation(next: string): string { return next === "/" ? "/login" : `/login?next=${encodeURIComponent(next)}` }
export function accessLoginLocation(config: ReadInstanceConfig, next: string, host = config.canonicalHost): string {
  const absolute = new URL(safeNext(next, `https://${host}`), `https://${host}`).href
  return `https://${config.accessTeamDomain}/cdn-cgi/access/login/${host}?redirect_url=${encodeURIComponent(absolute)}`
}
export function canonicalUrl(route: SubtreeOrTree): string {
  if (route.kind === "subtree") return `/a/${route.slug}/`
  if (route.pageRef === "index.html") return "/"
  if (route.pageRef.endsWith("/index.html")) return `/${route.pageRef.slice(0, -"index.html".length)}`
  return `/${route.pageRef.slice(0, -".html".length)}`
}
export function shareUrl(config: InstanceBase, route: SubtreeOrTree, key: string): string {
  const ref = route.kind === "subtree" ? route.slug : route.pageRef
  return `https://${config.canonicalHost}/s/${ref}/${encodeURIComponent(key)}/`
}
export function isReservedShellPath(path: string): boolean {
  return path === "/s" || path.startsWith("/s/") || path === "/a" || path.startsWith("/a/") || path.startsWith("/_revisions") || path.startsWith("/api") || path === "/registry" || path.startsWith("/registry/") || path === "/manifest.json" || path === "/asset-owners.json" || path === "/cdn-cgi" || path.startsWith("/cdn-cgi/")
}
export function isReservedPath(path: string, config: InstanceBase & { readonly shellPaths?: readonly string[] }): boolean {
  return isReservedShellPath(path) || !!config.shellPaths?.includes(path)
}
function shareCookie(request: Request, enabled: boolean): RequestCredentials["shareCookie"] {
  if (!enabled) return null
  const match = (request.headers.get("cookie") ?? "").match(/(?:^|;\s*)forge_share=([^;]+)/)
  if (!match) return null
  try {
    const value = decodeURIComponent(match[1])
    const cut = value.lastIndexOf("|")
    const pageRef = value.slice(0, cut), key = value.slice(cut + 1)
    return cut > 0 && validPageRef(pageRef) && keyRe.test(key) ? { pageRef, key } : null
  } catch { return null }
}
function cardTargets(identity: string, config: ReadInstanceConfig): Target[] {
  const slash = identity.lastIndexOf("/")
  const dir = slash < 0 ? "" : identity.slice(0, slash)
  const file = identity.slice(slash + 1)
  const targets: Target[] = []
  if (/^og\.(?:jpe?g|png)$/.test(file)) {
    const pageRef = dir ? `${dir}/index.html` : "index.html"
    if (config.routeGrammars.includes("tree") && validPageRef(pageRef)) targets.push({ route: { kind: "tree_page", pageRef }, path: `/${identity}` })
    if (config.routeGrammars.includes("subtree") && slugRe.test(dir)) targets.push({ route: { kind: "subtree", slug: dir }, path: `/a/${dir}/${file}` })
  } else {
    const match = /^(.+)\.og\.(?:jpe?g|png)$/.exec(file)
    if (match && config.routeGrammars.includes("tree")) {
      const pageRef = `${dir ? `${dir}/` : ""}${match[1]}.html`
      if (validPageRef(pageRef)) targets.push({ route: { kind: "tree_page", pageRef }, path: `/${identity}` })
    }
  }
  return targets
}
export function parseRequest(request: Request, config: ReadInstanceConfig): { readonly parsed: ParsedRequest; readonly credentials: RequestCredentials; readonly aliasPath: string | null } {
  const credentials = { shareCookie: shareCookie(request, config.shareCookie) }
  const result = (parsed: ParsedRequest, aliasPath: string | null = null) => ({ parsed, credentials, aliasPath })
  const deny = (status: 403 | 404 | 405, reason: "host" | "method" | "internal" | "malformed") => result({ kind: "deny", status, reason })
  let url: URL
  try { url = new URL(request.url) } catch { return deny(404, "malformed") }
  const host = url.hostname.toLowerCase()
  if (url.port || (host !== config.canonicalHost && !config.aliasHosts.includes(host))) return deny(403, "host")
  if (request.method !== "GET" && request.method !== "HEAD") return deny(405, "method")
  const raw = url.pathname
  if (/%(?:2f|2e|5c)/i.test(raw) || /[\\\u0000-\u001f\u007f]/.test(raw) || raw.includes("//")) return deny(404, "malformed")
  let path: string
  try { path = raw.split("/").map(decodeURIComponent).join("/") } catch { return deny(404, "malformed") }
  if (/[\\\u0000-\u001f\u007f]/.test(path) || path.split("/").some(s => s === "." || s === ".." || s.includes("/"))) return deny(404, "malformed")
  if (path === "/manifest.json" || path === "/asset-owners.json" || path === "/registry" || path.startsWith("/registry/") || (path !== "/api/catalogue" && (path === "/api" || path.startsWith("/api/")))) return deny(404, "internal")
  if (config.shellPaths.includes(path)) return result({ kind: "shell", path, login: path === "/login" || path === "/login.html" ? { next: safeNext(url.searchParams.get("next"), url.origin), host } : null })
  if (path === "/api/catalogue") return result({ kind: "catalogue" })
  if (path === "/_revisions" || path.startsWith("/_revisions/")) {
    const parts = path.split("/")
    const pageId = parts[2] ?? "", revisionId = parts[3] ?? ""
    if (!idRe.test(pageId) || !pageId.startsWith("pg_") || !idRe.test(revisionId) || !revisionId.startsWith("rv_") || parts.length < 5 || !parts[4]) return deny(404, "malformed")
    return result({ kind: "pinned", pageId, revisionId, path: `/${parts.slice(4).join("/")}` })
  }
  if (path === "/s" || path.startsWith("/s/")) {
    const parts = path.slice(3).split("/").filter(Boolean)
    const tailKey = parts.at(-1) ?? ""
    const identity = parts.slice(0, -1).join("/")
    const tailValid = parts.length >= 2 && keyRe.test(tailKey) && !identity.includes("..") && parts.slice(0, -1).every(s => segmentRe.test(s))
    if (tailValid && config.shareGrammars.includes("page") && validPageRef(identity)) return result({ kind: "share", grammar: "page", route: { kind: "tree_page", pageRef: identity }, key: tailKey, candidates: [`/${identity}`], browser: request.headers.get("sec-fetch-dest") === "document" })
    if (tailValid && config.shareGrammars.includes("card")) {
      const targets = cardTargets(identity, config)
      if (targets.length) return result({ kind: "card", key: tailKey, targets })
    }
    if (!config.shareGrammars.includes("slug")) return deny(404, "malformed")
    const qk = url.searchParams.get("k")
    const slug = parts[0] ?? "", key = qk === null ? parts[1] ?? "" : qk
    const rest = parts.slice(qk === null ? 2 : 1)
    if (!slugRe.test(slug) || !keyRe.test(key) || rest.some(s => !segmentRe.test(s) || s === "." || s === "..")) return deny(404, "malformed")
    const suffix = rest.length === 0 ? "index.html" : rest.at(-1)!.includes(".") ? rest.join("/") : `${rest.join("/")}/index.html`
    return result({ kind: "share", grammar: "slug", route: { kind: "subtree", slug }, key, candidates: [`/a/${slug}/${suffix}`], browser: false })
  }
  if ((path === "/a" || path.startsWith("/a/")) && config.routeGrammars.includes("subtree")) {
    const parts = path.split("/")
    const slug = parts[2] ?? ""
    if (!slugRe.test(slug)) return deny(404, "malformed")
    const base = `/a/${slug}`
    let candidates: string[]
    if (path === base || path === `${base}/`) candidates = [`${base}/index.html`]
    else if (path.endsWith("/")) candidates = [`${path}index.html`]
    else if (path.endsWith("/index")) candidates = [`${path}.html`]
    else if (!parts.at(-1)!.includes(".")) candidates = [path, `${path}.html`, `${path}/index.html`]
    else candidates = [path]
    return result({ kind: "subtree", slug, candidates, next: raw + url.search, path }, path)
  }
  if (config.routeGrammars.includes("tree") && path !== "/" && path !== "/a" && !path.startsWith("/a/") && !path.includes("..") && path.slice(1).split("/").filter(Boolean).every(s => segmentRe.test(s))) {
    const last = path.split("/").at(-1)!
    const pageRef = path.endsWith("/") ? `${path.slice(1)}index.html` : path.endsWith(".html") ? path.slice(1) : !last.includes(".") ? `${path.slice(1)}.html` : null
    if (pageRef && validPageRef(pageRef)) return result({ kind: "tree", pageRef, candidates: [`/${pageRef}`], next: raw + url.search, path }, path)
  }
  return result({ kind: "resource", path }, path)
}
