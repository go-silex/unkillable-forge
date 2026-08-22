/**
 * GET /s/<slug>/<key>/…  — share public (key in path)
 * GET /s/<slug>/?k=<key> — same secret in query (alias)
 *
 * Requires vis:shared + valid KV share:<slug> key, then serves /a/<slug>/… via ASSETS.
 * Path confined to slug subtree; dot-segments and encoded separators rejected.
 */
import {
  type ForgeEnv,
  getVisibility,
  timingSafeEqualStr,
} from "../_lib/access"
import { parseShareRoute, shareAssetPath } from "../_lib/share-path"

async function plain404(): Promise<Response> {
  return new Response("Not found", {
    status: 404,
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "no-store",
    },
  })
}

export const onRequest: PagesFunction<ForgeEnv> = async (context) => {
  const request = context.request
  const url = new URL(request.url)
  const parsed = parseShareRoute(url, request.url)
  if (!parsed.ok) return plain404()

  const { slug, key, rest } = parsed.route

  const vis = await getVisibility(context.env.SHARES, slug)
  if (vis !== "shared") return plain404()

  const stored = await context.env.SHARES.get(`share:${slug}`)
  if (!stored || !timingSafeEqualStr(stored, key)) return plain404()

  const assetPath = shareAssetPath(slug, rest)
  const assetUrl = new URL(assetPath, url.origin)
  const res = await context.env.ASSETS.fetch(assetUrl.toString())

  if (res.status === 404) return plain404()

  const headers = new Headers(res.headers)
  headers.set("cache-control", "no-store")
  headers.set("x-robots-tag", "noindex, nofollow, noarchive")
  headers.set("x-forge-share", "1")
  headers.set("x-content-type-options", "nosniff")
  return new Response(res.body, { status: res.status, headers })
}
