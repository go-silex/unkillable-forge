/**
 * GET  /api/visibility?slug=  → { slug, visibility, shareUrl? }  (team)
 * POST /api/visibility { slug, visibility } → set vis, mint/revoke share key
 *
 * public | shared | private — mutually exclusive. Keys never in HTML.
 * POST requires JSON body + Origin/Referer matching canonical host (CSRF).
 */
import {
  type ForgeEnv,
  type Visibility,
  SLUG_RE,
  activateShare,
  getVisibility,
  isTeamRequest,
  json,
  mintKey,
  publicOrigin,
  revokeShare,
  setVisibility,
} from "../_lib/access"
import { assetExists } from "../_lib/assets"
import { enforceMutationGuard } from "../_lib/csrf"
import { upsertShortlink } from "../_lib/shlink"

const VIS: Visibility[] = ["private", "shared", "public"]

export const onRequestGet: PagesFunction<ForgeEnv> = async (context) => {
  if (!(await isTeamRequest(context.request, context.env))) {
    return json({ error: "unauthorized" }, 401)
  }
  const slug = new URL(context.request.url).searchParams.get("slug") || ""
  if (!SLUG_RE.test(slug)) return json({ error: "invalid_slug" }, 400)
  const vis = await getVisibility(context.env.SHARES, slug)
  const key =
    vis === "shared" ? await context.env.SHARES.get(`share:${slug}`) : null
  let shareUrl: string | null = null
  if (key) {
    try {
      shareUrl = `${publicOrigin(context.env, context.request)}/s/${slug}/${key}/`
    } catch {
      shareUrl = null
    }
  }
  return json({ slug, visibility: vis, shareUrl })
}

export const onRequestPost: PagesFunction<ForgeEnv> = async (context) => {
  if (!(await isTeamRequest(context.request, context.env))) {
    return json({ error: "unauthorized" }, 401)
  }

  const csrf = enforceMutationGuard(context.request, context.env)
  if (csrf) return csrf

  let body: { slug?: string; visibility?: string } = {}
  try {
    body = (await context.request.json()) as {
      slug?: string
      visibility?: string
    }
  } catch {
    return json({ error: "invalid_json" }, 400)
  }
  const slug = (body.slug || "").trim()
  const vis = body.visibility as Visibility
  if (!SLUG_RE.test(slug)) return json({ error: "invalid_slug" }, 400)
  if (!VIS.includes(vis)) return json({ error: "invalid_visibility" }, 400)

  const exists = await assetExists(context.env, context.request, slug)
  if (!exists) return json({ error: "not_found", slug }, 404)

  let shareUrl: string | null = null
  let shortUrl: string | null = null

  if (vis === "shared") {
    let key = await context.env.SHARES.get(`share:${slug}`)
    if (!key) key = mintKey()
    await activateShare(context.env.SHARES, slug, key)
    try {
      const origin = publicOrigin(context.env, context.request)
      shareUrl = `${origin}/s/${slug}/${key}/`
      shortUrl = (await upsertShortlink(context.env, shareUrl, slug)) || null
    } catch {
      return json({ error: "public_host_not_configured" }, 500)
    }
  } else if (vis === "public") {
    let publicUrl: string
    try {
      publicUrl = `${publicOrigin(context.env, context.request)}/a/${slug}/`
    } catch {
      return json({ error: "public_host_not_configured" }, 500)
    }
    await setVisibility(context.env.SHARES, slug, "public")
    await context.env.SHARES.delete(`share:${slug}`)
    shortUrl = (await upsertShortlink(context.env, publicUrl, slug)) || null
  } else {
    await revokeShare(context.env.SHARES, slug)
  }

  return json({ slug, visibility: vis, shareUrl, shortUrl })
}
