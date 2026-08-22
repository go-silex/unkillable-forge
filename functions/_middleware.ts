/**
 * ACL + pages.dev lock.
 *
 * forge.gosilex.com (after Access Bypass on / and /a):
 *   /                    catalogue shell (no private titles in HTML)
 *   /api/catalogue       public OK (filtered)
 *   /a/<slug>/*          vis KV: public | shared | private  (+ JWT cookie)
 *   /s/*                 KV key + vis:shared (Function)
 *   /manifest.json       never to clients (worker reads via ASSETS)
 *
 * Fail-closed: missing/unknown vis = private (no share-key inference).
 * pages.dev: 403 on all paths (including /s) — production custom domain only.
 */
import {
  type ForgeEnv,
  extractSlugFromAPath,
  getVisibility,
  isTeamRequest,
} from "./_lib/access"

const SHARE_PREFIX = "/s/"

function isPagesDev(host: string): boolean {
  return host === "pages.dev" || host.endsWith(".pages.dev")
}

function plain404(): Response {
  return new Response("Not found", {
    status: 404,
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "no-store",
      "x-robots-tag": "noindex, nofollow",
    },
  })
}

function loginRedirect(): Response {
  return new Response(null, {
    status: 302,
    headers: {
      location: "/login",
      "cache-control": "no-store",
    },
  })
}

function withAcl(res: Response): Response {
  const headers = new Headers(res.headers)
  headers.set("x-forge-acl", "vis-v4")
  headers.set("cache-control", "no-store")
  return new Response(res.body, { status: res.status, headers })
}

function isPublicShell(pathname: string): boolean {
  return (
    pathname === "/" ||
    pathname === "/index.html" ||
    pathname === "/login" ||
    pathname === "/login.html" ||
    pathname === "/robots.txt" ||
    pathname === "/favicon.ico" ||
    pathname === "/images/favicon.png"
  )
}

export const onRequest: PagesFunction<ForgeEnv> = async (context) => {
  const url = new URL(context.request.url)
  const host = url.hostname
  const path = url.pathname

  if (isPagesDev(host)) {
    return new Response(
      `Forbidden — use the production custom domain. This pages.dev origin does not serve forge content (including share links).`,
      {
        status: 403,
        headers: {
          "content-type": "text/plain; charset=utf-8",
          "cache-control": "no-store",
          "x-forge-origin-policy": "pages-dev-blocked",
          "x-robots-tag": "noindex, nofollow",
        },
      },
    )
  }

  // Full artefact index — worker-only (ASSETS.fetch bypasses this).
  if (path === "/manifest.json" || path.startsWith("/registry/")) {
    return plain404()
  }

  if (path.startsWith("/api/") || path.startsWith(SHARE_PREFIX) || path === "/s") {
    return context.next()
  }

  if (isPublicShell(path)) {
    const res = await context.next()
    return withAcl(res)
  }

  if (path.startsWith("/a/") || path === "/a") {
    const slug = extractSlugFromAPath(path)
    if (!slug) return plain404()

    const team = await isTeamRequest(context.request, context.env)
    if (team) {
      const res = await context.next()
      return withAcl(res)
    }

    const vis = await getVisibility(context.env.SHARES, slug)
    if (vis === "public") {
      const res = await context.next()
      return withAcl(res)
    }
    if (vis === "shared") return plain404()
    return loginRedirect()
  }

  // Other static (css leftover, random files): team or 404
  if (await isTeamRequest(context.request, context.env)) {
    const res = await context.next()
    return withAcl(res)
  }
  return plain404()
}
