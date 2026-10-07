/**
 * ACL + pages.dev lock.
 *
 * forge.unkillablecompanies.com (after Access Bypass on / and /a):
 *   /                    catalogue shell (no private titles in HTML)
 *   /api/catalogue       public OK (filtered)
 *   /a/<slug>/*          vis KV: public | shared | private  (+ JWT cookie)
 *   /s/*                 KV key + vis:shared (Function)
 *   /login               Access Allow app → once the JWT verifies, 302 back to
 *                        ?next (same-origin only); refused /a/ reads carry it
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
const LOGIN_PATHS: Record<string, true> = { "/login": true, "/login.html": true }

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

/**
 * Same-origin path to return to after login, else "/".
 *
 * Resolved with the URL parser, not prefix checks: browsers drop tab/newline
 * and read "\" as "/", so "/\t/evil.tld" or "/\evil.tld" turn into the
 * protocol-relative "//evil.tld" — an open redirect a string test lets through.
 */
function safeNext(raw: string | null, origin: string): string {
  if (!raw || !raw.startsWith("/")) return "/"
  let u: URL
  try {
    u = new URL(raw, origin)
  } catch {
    return "/"
  }
  if (u.origin !== origin || u.pathname.startsWith("//")) return "/"
  if (LOGIN_PATHS[u.pathname]) return "/"
  return u.pathname + u.search + u.hash
}

function loginRedirect(next: string): Response {
  return new Response(null, {
    status: 302,
    headers: {
      location: next === "/" ? "/login" : `/login?next=${encodeURIComponent(next)}`,
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
    // /login sits behind the Access Allow app, so a verified JWT here means the
    // login just happened: send the visitor back to the page that was refused.
    // Without one (Access not in front, or the JWT is rejected) serve the
    // static page — never bounce onward, that is how /login used to loop.
    if (LOGIN_PATHS[path] && (await isTeamRequest(context.request, context.env))) {
      return new Response(null, {
        status: 302,
        headers: {
          location: safeNext(url.searchParams.get("next"), url.origin),
          "cache-control": "no-store",
        },
      })
    }
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
    return loginRedirect(safeNext(path + url.search, url.origin))
  }

  // Other static (css leftover, random files): team or 404
  if (await isTeamRequest(context.request, context.env)) {
    const res = await context.next()
    return withAcl(res)
  }
  return plain404()
}
