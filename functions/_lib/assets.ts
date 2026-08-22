/** Hub artefact presence checks via ASSETS binding (fail-closed before vis mutations). */

import type { ForgeEnv } from "./access"

export async function assetExists(
  env: ForgeEnv,
  request: Request,
  slug: string,
): Promise<boolean> {
  const url = new URL(`/a/${slug}/index.html`, request.url)
  const res = await env.ASSETS.fetch(new Request(url.toString()))
  return res.ok
}
