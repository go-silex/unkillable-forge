/* Canonical tree URL and login behavior derived from Roxabi functions/_lib/assets.ts
 * and functions/_middleware.ts, revision 9c7dda4fd6427dde7da5f474a4519fffefe3ba6a (MIT). */
import type { VerifiedIdentity } from "../identity"
import type { ReadInstanceConfig } from "../instance-config"
import type { ReadDecision, ReadPlan } from "../read"
import { accessLoginLocation, canonicalUrl, loginLocation, type ParsedRequest } from "./grammar"

export type RouteOutcome =
  | { readonly kind: "deny"; readonly status: 403 | 404 | 405 | 503; readonly reason: string }
  | { readonly kind: "login"; readonly location: string }
  | { readonly kind: "redirect"; readonly status: 301 | 302 | 307 | 308; readonly location: string }
  | { readonly kind: "shell"; readonly path: string }
  | { readonly kind: "catalogue"; readonly viewer: "anonymous" | "team" }
  | { readonly kind: "serve"; readonly plan: ReadPlan }
  | { readonly kind: "share_exchange"; readonly plan: ReadPlan; readonly cookie: { readonly pageRef: string; readonly key: string }; readonly location: string }
  | { readonly kind: "share_unfurl"; readonly plan: ReadPlan; readonly pageRef: string; readonly key: string }
  | { readonly kind: "share_card"; readonly plan: ReadPlan }

export function toOutcome(parsed: ParsedRequest, decision: ReadDecision, identity: VerifiedIdentity | null, config: ReadInstanceConfig): RouteOutcome {
  if (parsed.kind === "deny") return parsed
  if (decision.kind === "deny" && (decision.reason === "instance_mismatch" || decision.reason === "unavailable")) return { kind: "deny", status: 503, reason: decision.reason }
  if (parsed.kind === "shell") {
    if (parsed.login && identity) return { kind: "redirect", status: 302, location: parsed.login.next }
    if (parsed.login && config.login === "redirect-access-login") return { kind: "redirect", status: 302, location: accessLoginLocation(config, parsed.login.next, parsed.login.host) }
    return { kind: "shell", path: parsed.path }
  }
  if (parsed.kind === "catalogue") return { kind: "catalogue", viewer: identity ? "team" : "anonymous" }
  if (decision.kind === "alias") return { kind: "redirect", status: decision.status, location: decision.location }
  if (decision.kind === "deny") {
    if (decision.reason === "login_required" && (parsed.kind === "subtree" || parsed.kind === "tree")) return { kind: "login", location: loginLocation(parsed.next) }
    return { kind: "deny", status: 404, reason: "not_found" }
  }
  const plan = decision.plan
  if (parsed.kind === "share") {
    if (parsed.grammar === "slug") return { kind: "serve", plan }
    if (parsed.route.kind !== "tree_page") return { kind: "deny", status: 404, reason: "not_found" }
    if (parsed.browser) return { kind: "share_exchange", plan, cookie: { pageRef: parsed.route.pageRef, key: parsed.key }, location: canonicalUrl(parsed.route) }
    return { kind: "share_unfurl", plan, pageRef: parsed.route.pageRef, key: parsed.key }
  }
  if (parsed.kind === "card") return { kind: "share_card", plan }
  if ((parsed.kind === "subtree" || parsed.kind === "tree") && (plan.resource.kind === "document" || plan.resource.kind === "subdocument")) {
    const q = parsed.next.indexOf("?")
    const requested = q < 0 ? parsed.next : parsed.next.slice(0, q)
    const search = q < 0 ? "" : parsed.next.slice(q)
    let target: string | null = null
    if (parsed.kind === "tree") {
      if (parsed.path.endsWith(".html") || (parsed.path.endsWith("/index") && plan.resource.path === `${parsed.path}.html`)) target = canonicalUrl({ kind: "tree_page", pageRef: parsed.pageRef })
    } else if (parsed.path === `/a/${parsed.slug}`) target = `${requested}/`
    else if (parsed.path.endsWith("/index.html")) target = requested.slice(0, -"index.html".length)
    else if (parsed.path.endsWith("/index") && plan.resource.path === `${parsed.path}.html`) target = requested.slice(0, -"index".length)
    else if (parsed.path.endsWith(".html")) target = requested.slice(0, -".html".length)
    else if (!parsed.path.endsWith("/") && plan.requestedPath === `${parsed.path}/index.html`) target = `${requested}/`
    if (target !== null) return { kind: "redirect", status: 308, location: target + search }
  }
  return { kind: "serve", plan }
}
