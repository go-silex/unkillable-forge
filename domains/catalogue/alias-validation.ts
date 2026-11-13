// Alias locations are pathnames, not URLs with an authority, query, or fragment.
// Check decoded forms too: encoded or repeatedly encoded separators and controls
// must not become meaningful when another layer interprets the location.
function safePath(value: unknown): value is string {
  if (typeof value !== 'string' || !/^[!-~]+$/.test(value) || !value.startsWith('/') || value.startsWith('//')) return false
  let path = value
  for (;;) {
    if (/[\\\u0000-\u001f\u007f?#]/.test(path) || path.includes('//') || /%(?:2f|2e|5c)/i.test(path)) return false
    if (path.split('/').some(segment => segment === '.' || segment === '..')) return false
    if (!path.includes('%')) break
    let decoded: string
    try { decoded = decodeURIComponent(path) } catch { return false }
    if (decoded === path) break
    path = decoded
  }
  try {
    const base = 'https://alias.invalid'
    return new URL(value, base).origin === base
  } catch { return false }
}

/** Validate the decoded pathname used as an alias lookup key. */
export function isValidAliasPath(value: unknown): boolean {
  return safePath(value) && !value.includes('..')
}

/** Validate a same-origin pathname suitable for a Location header. */
export function isValidAliasDestination(value: unknown): boolean {
  return safePath(value)
}
