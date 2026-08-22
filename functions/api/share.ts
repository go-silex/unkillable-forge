/**
 * POST /api/share  { slug, rotate? }  → mint share URL (sets visibility=shared)
 * GET  /api/share?slug=…             → { active } only (team JWT)
 * DELETE /api/share { slug }         → revoke + visibility=private
 *
 * POST/DELETE: team JWT or X-Forge-Share-Secret (ops). Team path requires CSRF guard.
 */
import {
  type ForgeEnv,
  SLUG_RE,
  activateShare,
  isOpsShareBypass,
  isShareApiRequest,
  isTeamRequest,
  json,
  mintKey,
  publicOrigin,
  revokeShare,
} from "../_lib/access"
import { assetExists } from "../_lib/assets"
import { enforceMutationGuard } from "../_lib/csrf"
import { upsertShortlink } from "../_lib/shlink"

type Env = ForgeEnv

export const onRequestGet: PagesFunction<Env> = async (context) => {
  const url = new URL(context.request.url)
  const slug = url.searchParams.get("slug") || ""
  if (!SLUG_RE.test(slug)) return json({ error: "invalid_slug" }, 400)
  if (!(await isTeamRequest(context.request, context.env))) {
    return json({ error: "unauthorized" }, 401)
  }

  const key = await context.env.SHARES.get(`share:${slug}`)
  if (!key) return json({ slug, active: false })
  return json({ slug, active: true })
}

export const onRequestPost: PagesFunction<Env> = async (context) => {
  const request = context.request
  if (!(await isShareApiRequest(request, context.env))) {
    return json({ error: "unauthorized" }, 401)
  }

  if (!isOpsShareBypass(request, context.env)) {
    const csrf = enforceMutationGuard(request, context.env)
    if (csrf) return csrf
  }

  let body: { slug?: string; rotate?: boolean } = {}
  try {
    body = (await request.json()) as { slug?: string; rotate?: boolean }
  } catch {
    return json({ error: "invalid_json" }, 400)
  }

  const slug = (body.slug || "").trim()
  if (!SLUG_RE.test(slug)) return json({ error: "invalid_slug" }, 400)

  const exists = await assetExists(context.env, request, slug)
  if (!exists) return json({ error: "not_found", slug }, 404)

  let key = await context.env.SHARES.get(`share:${slug}`)
  if (!key || body.rotate) {
    key = mintKey()
  }
  await activateShare(context.env.SHARES, slug, key)

  let origin: string
  try {
    origin = publicOrigin(context.env, request)
  } catch {
    return json({ error: "public_host_not_configured" }, 500)
  }
  const shareUrl = `${origin}/s/${slug}/${key}/`
  const shortUrl = await upsertShortlink(context.env, shareUrl, slug)

  return json({
    slug,
    shareUrl,
    shortUrl: shortUrl || null,
    rotated: Boolean(body.rotate),
  })
}

export const onRequestDelete: PagesFunction<Env> = async (context) => {
  const request = context.request
  if (!(await isShareApiRequest(request, context.env))) {
    return json({ error: "unauthorized" }, 401)
  }

  if (!isOpsShareBypass(request, context.env)) {
    const csrf = enforceMutationGuard(request, context.env)
    if (csrf) return csrf
  }

  let body: { slug?: string } = {}
  try {
    body = (await request.json()) as { slug?: string }
  } catch {
    return json({ error: "invalid_json" }, 400)
  }
  const slug = (body.slug || "").trim()
  if (!SLUG_RE.test(slug)) return json({ error: "invalid_slug" }, 400)

  await revokeShare(context.env.SHARES, slug)
  return json({ slug, active: false })
}
