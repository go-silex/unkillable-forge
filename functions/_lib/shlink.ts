import type { ForgeEnv } from "./access"

interface ShlinkShortUrl {
  shortUrl?: string
}

async function shlinkRequest(
  apiUrl: string,
  apiKey: string,
  method: "POST" | "PATCH",
  body: Record<string, unknown>,
): Promise<Response> {
  return fetch(apiUrl, {
    method,
    headers: {
      "Content-Type": "application/json",
      "X-Api-Key": apiKey,
    },
    body: JSON.stringify(body),
  })
}

async function shortUrlFrom(res: Response): Promise<string | undefined> {
  if (!res.ok) return undefined
  const data = (await res.json()) as ShlinkShortUrl
  return data.shortUrl
}

/**
 * Best-effort deterministic Shlink upsert.
 *
 * Edit f-<slug> first so a rotated Forge share key updates the existing alias.
 * Create only when the alias does not exist. A final PATCH closes the race where
 * another request creates the alias between our first PATCH and POST.
 */
export async function upsertShortlink(
  env: ForgeEnv,
  longUrl: string,
  slug: string,
): Promise<string | undefined> {
  const apiKey = env.SHLINK_API_KEY
  const apiUrl = env.SHLINK_API_URL
  if (!apiKey || !apiUrl) return undefined
  const customSlug = `f-${slug}`.slice(0, 50)
  const collectionUrl = apiUrl.replace(/\/+$/, "")
  const itemUrl = `${collectionUrl}/${encodeURIComponent(customSlug)}`
  try {
    const edit = await shlinkRequest(itemUrl, apiKey, "PATCH", { longUrl })
    if (edit.ok) return shortUrlFrom(edit)
    if (edit.status !== 404) return undefined

    const create = await shlinkRequest(collectionUrl, apiKey, "POST", {
      longUrl,
      customSlug,
      findIfExists: true,
    })
    if (create.ok) return shortUrlFrom(create)
    if (create.status !== 400 && create.status !== 409) return undefined

    // Concurrent creator or an alias left by an older Forge release.
    const retryEdit = await shlinkRequest(itemUrl, apiKey, "PATCH", { longUrl })
    return shortUrlFrom(retryEdit)
  } catch {
    return undefined
  }
}
