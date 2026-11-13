import { authenticate, type JwksSource } from "./identity"
import type { ReadInstanceConfig } from "./instance-config"
import { checkReadInstance, decideRead, type ReadSubject } from "./read"
import { parseRequest } from "./routing/grammar"
import { toOutcome, type RouteOutcome } from "./routing/outcome"

export interface ReadDeps {
  readonly db: D1Database
  readonly config: ReadInstanceConfig
  readonly jwks: JwksSource
  readonly nowSeconds: () => number
  /** Opaque token; Catalogue verifies its authenticity and claims. */
  readonly pinnedProof?: string | null
}

export async function resolveRead(request: Request, deps: ReadDeps): Promise<RouteOutcome> {
  const nowSeconds = deps.nowSeconds()
  const identity = await authenticate(request, { teamDomain: deps.config.accessTeamDomain, audiences: deps.config.readAudiences, surface: "read" }, deps.jwks, nowSeconds)
  const { parsed, credentials, aliasPath } = parseRequest(request, deps.config)
  if (parsed.kind === "deny") return parsed
  if (parsed.kind === "shell" || parsed.kind === "catalogue") {
    const failure = await checkReadInstance(deps.db, deps.config)
    return toOutcome(parsed, failure ?? { kind: "deny", reason: "not_found" }, identity, deps.config)
  }
  let subject: ReadSubject
  switch (parsed.kind) {
    case "subtree":
      subject = { kind: "page", route: { kind: "subtree", slug: parsed.slug }, candidates: parsed.candidates, fragmentPath: null }
      break
    case "tree":
      subject = { kind: "page", route: { kind: "tree_page", pageRef: parsed.pageRef }, candidates: parsed.candidates, fragmentPath: `/${parsed.pageRef}` }
      break
    case "resource": subject = { kind: "resource", path: parsed.path }; break
    case "share": subject = { kind: "share", route: parsed.route, candidates: parsed.candidates }; break
    case "card": subject = { kind: "card", targets: parsed.targets }; break
    case "pinned": subject = { kind: "pinned", pageId: parsed.pageId, revisionId: parsed.revisionId, path: parsed.path }; break
  }
  const decision = await decideRead(deps.db, deps.config, subject, {
    team: identity,
    shareKey: parsed.kind === "share" || parsed.kind === "card" ? parsed.key : null,
    shareCookie: credentials.shareCookie,
    pinnedProof: deps.pinnedProof ?? null,
    nowSeconds,
  }, aliasPath)
  return toOutcome(parsed, decision, identity, deps.config)
}
