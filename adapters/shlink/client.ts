export interface ShlinkMapping {
  readonly providerOrigin: string
  readonly providerId: string | null
  readonly shortCode: string
  readonly shortUrl: string
  readonly destination: string
}

export type ShlinkCreateResult =
  | { readonly state: 'ready'; readonly mapping: ShlinkMapping; readonly source: 'created' | 'preserved' }
  | { readonly state: 'failed'; readonly code: 'shortlink_conflict' | 'shortlink_unavailable'; readonly retryable: boolean }

export interface ShlinkConfig {
  /** Shlink REST short-urls collection URL, including API version. */
  readonly collectionUrl: string
  readonly apiKey: string
  readonly fetch?: typeof fetch
}

/** Create only. A lost or conflicting response is reconciled by reading the exact code. */
export async function createShortlink(config: ShlinkConfig, input: { readonly shortCode: string; readonly shortDomain: string; readonly destination: string }): Promise<ShlinkCreateResult> {
  const unavailable = (): ShlinkCreateResult => ({ state: 'failed', code: 'shortlink_unavailable', retryable: true })
  const conflict = (): ShlinkCreateResult => ({ state: 'failed', code: 'shortlink_conflict', retryable: false })
  let collection: URL
  try {
    collection = new URL(config.collectionUrl)
    const domain = new URL(`https://${input.shortDomain}`)
    if (collection.protocol !== 'https:' || collection.username || collection.password || collection.search || collection.hash || !config.apiKey || !input.shortCode || !input.destination || domain.host !== input.shortDomain || domain.username || domain.password || domain.pathname !== '/' || domain.search || domain.hash) return unavailable()
  } catch { return unavailable() }
  const base = collection.toString().replace(/\/+$/, '')
  const request = config.fetch ?? fetch
  const headers = { 'X-Api-Key': config.apiKey, 'Content-Type': 'application/json' }
  const parse = async (response: Response): Promise<ShlinkMapping | null> => {
    try {
      const data = await response.json() as Record<string, unknown>
      if (typeof data.shortCode !== 'string' || typeof data.shortUrl !== 'string' || typeof data.longUrl !== 'string' || !data.shortUrl) return null
      const url = new URL(data.shortUrl)
      if (url.protocol !== 'https:' && url.protocol !== 'http:') return null
      return { providerOrigin: collection.origin, providerId: typeof data.id === 'string' ? data.id : null, shortCode: data.shortCode, shortUrl: data.shortUrl, destination: data.longUrl }
    } catch { return null }
  }
  const classify = (mapping: ShlinkMapping, source: 'created' | 'preserved'): ShlinkCreateResult =>
    mapping.shortCode === input.shortCode && new URL(mapping.shortUrl).host === input.shortDomain && mapping.destination === input.destination
      ? { state: 'ready', mapping, source }
      : conflict()
  try {
    const response = await request(base, { method: 'POST', headers, body: JSON.stringify({ longUrl: input.destination, customSlug: input.shortCode, domain: input.shortDomain, findIfExists: false }) })
    if (response.ok) {
      const mapping = await parse(response)
      if (mapping) return classify(mapping, 'created')
    }
  } catch { /* The provider may have committed before the response was lost. */ }
  try {
    const response = await request(`${base}/${encodeURIComponent(input.shortCode)}?domain=${encodeURIComponent(input.shortDomain)}`, { method: 'GET', headers })
    if (!response.ok) return unavailable()
    const mapping = await parse(response)
    return mapping ? classify(mapping, 'preserved') : unavailable()
  } catch { return unavailable() }
}
