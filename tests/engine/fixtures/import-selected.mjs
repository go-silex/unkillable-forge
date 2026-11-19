// Synthetic data only; no historical capture or approval.
export async function makeSelectedFixture({ includeMissing = false } = {}) {
  const files = {}, observations = {}, entries = []
  const add = async (path, graphClass, contentType) => {
    const bytes = contentType === 'image/png'
      ? Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII='), char => char.charCodeAt(0))
      : new TextEncoder().encode(`synthetic bytes for ${path}`)
    const hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), b => b.toString(16).padStart(2, '0')).join('')
    files[path] = bytes
    observations[path] = { state: 'present', size: bytes.length, sha256: hash }
    entries.push({ path, graphClass, contentType, locator: { root: 'capture', relative: path.slice(1) }, provenance: 'synthetic-capture', expected: { size: bytes.length, sha256: hash }, placement: { sourceArtifactId: path.startsWith('/a/sample/') ? 'slug:sample' : 'tree:synthetic', evidenceRef: 'synthetic-placement' } })
  }
  const a = '/tree/one.html', b = '/tree/two.html', fragment = '/tree/fragment.html', preview = '/tree/preview.png'
  await add(a, 'page_document', 'text/html')
  await add(b, 'page_document', 'text/html')
  await add(fragment, 'fragment', 'text/html')
  await add(preview, 'asset', 'image/png')
  for (let i = 0; i < 5; i++) await add(`/tree/asset${i}.css`, 'asset', 'text/css')
  await add('/a/sample/index.html', 'page_document', 'text/html')
  await add('/a/sample/nested/index.html', 'subdocument', 'text/html')
  const page = (sourcePageId, documentPath, value, key = null) => ({ sourcePageId, documentPath, metadata: {}, ownershipEvidenceRef: 'synthetic-owner-evidence', membership: { sourceArtifactId: sourcePageId === 'sample' ? 'slug:sample' : sourcePageId === 'missing.html' ? 'tree:missing' : 'tree:synthetic', evidenceRef: 'synthetic-membership' }, visibility: { state: 'present', value, metadataV: null, expiresAt: null }, share: key === null ? { state: 'absent' } : { state: 'present', key, expiresAt: null } })
  const owners = []
  const own = (path, ownerSourcePageId) => owners.push({ path, ownerSourcePageId, evidenceRef: 'synthetic-edge-evidence', basis: 'declared' })
  own(fragment, 'tree/one.html'); own(fragment, 'tree/two.html'); own(preview, 'tree/one.html')
  for (let i = 0; i < 5; i++) own(`/tree/asset${i}.css`, 'tree/one.html')
  const pages = [page('tree/one.html', a, 'public'), page('tree/two.html', b, 'shared', 'syntheticTreeKey'), page('sample', '/a/sample/index.html', 'shared', 'syntheticSlugKey')]
  if (includeMissing) pages.push(page('missing.html', '/missing.html', 'public'))
  const seedHash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode('synthetic selection'))), b => b.toString(16).padStart(2, '0')).join('')
  const input = {
    version: 1, kind: 'synthetic', sourceInstance: 'synthetic-instance', selectionRef: 'synthetic-selection', approvalRef: 'synthetic-approval', g1bRef: null, capturedAt: 1,
    corpusDigest: seedHash, selectionDigest: seedHash, mappingRef: 'synthetic-mapping', complete: true, targetBasis: 'empty',
    limits: { maxCommandBytes: 1000000, maxJsonDepth: 16, maxUploadBytes: 1000000, maxInventoryBytes: 1000000 },
    reader: { canonicalHost: 'forge.example.test', aliasHosts: [], routeGrammars: ['tree', 'subtree'], shareGrammars: ['page', 'slug', 'card'], shareCookie: true, shellPaths: ['/login'] }, captureRoots: ['capture'], entries, pages, owners,
    aliases: [{ aliasKind: 'redirect_exact', path: '/legacy-sample', to: '/a/sample/', status: 301, targetSourcePageId: 'sample', capturedBehavior: 'team_fallback' }],
    shortlinks: [{ mappingId: 'synthetic-mapping', providerOrigin: 'https://links.example.test', providerId: null, shortDomain: 'links.example.test', shortCode: 'abc', shortUrl: 'https://links.example.test/abc', targetSourcePageId: 'sample', destination: 'https://forge.example.test/s/sample/?k=syntheticSlugKey#section', observedAt: 1 }],
    previews: [{ sourcePageId: 'tree/one.html', path: preview, kind: 'original' }], consumerUrls: [], exclusions: [], providerMounts: [],
  }
  return { input, observations, files }
}
