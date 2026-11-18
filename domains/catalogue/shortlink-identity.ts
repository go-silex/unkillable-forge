/** Exact provider/alias identity shared by live mapping admission and archive restore. */
export function validShortlinkIdentity(providerOrigin: unknown, shortDomain: unknown, shortCode: unknown, shortUrl: unknown): boolean {
  if (typeof providerOrigin !== 'string' || typeof shortDomain !== 'string' || typeof shortCode !== 'string' || !shortCode || typeof shortUrl !== 'string') return false
  try {
    const provider = new URL(providerOrigin), domain = new URL(`https://${shortDomain}`), url = new URL(shortUrl)
    return provider.protocol === 'https:' && provider.origin === providerOrigin && !provider.username && !provider.password && provider.pathname === '/' && !provider.search && !provider.hash &&
      domain.host === shortDomain && !domain.username && !domain.password && domain.pathname === '/' && !domain.search && !domain.hash &&
      (url.protocol === 'https:' || url.protocol === 'http:') && url.host === shortDomain && !url.username && !url.password && !url.search && !url.hash && url.pathname === `/${encodeURIComponent(shortCode)}` && url.href === shortUrl
  } catch { return false }
}
