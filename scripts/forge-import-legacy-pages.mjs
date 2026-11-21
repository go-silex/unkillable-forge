// Capture → selection v1 + capture-root layout; production pin/apply drivers.
// Does not modify engine domain code. Never prints share keys or Shlink secrets.
import { createHash, randomBytes } from 'node:crypto'
import { copyFile, mkdir, mkdtemp, open, readFile, readdir, realpath, rename, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, extname, isAbsolute, join, relative as pathRelative, resolve, sep } from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import blake3 from 'blake3-wasm'

const fail = (code, detail) => {
  const err = new Error(detail ? `${code}: ${detail}` : code)
  err.code = code
  throw err
}
const text = (v, max = 512) => typeof v === 'string' && v.length > 0 && v.length <= max
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex')
const sha256File = async path => sha256(await readFile(path))
const isAbs = p => typeof p === 'string' && isAbsolute(p)
const json = async path => JSON.parse(await readFile(path, 'utf8'))
const utf8Bytes = value => Buffer.byteLength(typeof value === 'string' ? value : JSON.stringify(value), 'utf8')
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype
function stable(value) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value)
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`
  if (record(value)) return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stable(value[key])}`).join(',')}}`
  throw new Error('unstable_value')
}

/** Write sensitive JSON privately: create temp with mode 0600 (wx), then rename over target. */
async function writePrivate(target, data) {
  const dir = dirname(target)
  await mkdir(dir, { recursive: true, mode: 0o700 })
  const tmp = join(dir, `.forge-import-${randomBytes(8).toString('hex')}.tmp`)
  let handle
  try {
    handle = await open(tmp, 'wx', 0o600)
    await handle.writeFile(data)
    await handle.close()
    handle = null
    await rename(tmp, target)
  } catch (error) {
    if (handle) try { await handle.close() } catch { /* ignore */ }
    await rm(tmp, { force: true }).catch(() => {})
    throw error
  }
}

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
let assignSourcePins, sealInventory
async function loadTranslator() {
  if (assignSourcePins && sealInventory) return
  const result = await build({
    entryPoints: [join(repoRoot, 'scripts/forge-import-selected.mjs')],
    bundle: true, write: false, format: 'esm', platform: 'neutral', target: 'es2022', logLevel: 'silent',
  })
  if (result.outputFiles.length !== 1) fail('bundle_error')
  const module = await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].contents).toString('base64')}`)
  assignSourcePins = module.assignSourcePins
  sealInventory = module.sealInventory
}

const CONTENT_TYPES = {
  '.html': 'text/html',
  '.htm': 'text/html',
  '.css': 'text/css',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.json': 'application/json',
  '.txt': 'text/plain',
  '.md': 'text/markdown',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.zip': 'application/zip',
}

// Reader projection mirrors production FORGE_INSTANCE (minus manage/access fields,
// which selection v1 does not carry). Legacy capture longUrl hosts are rewritten
// via destinationHosts and are not necessarily live aliasHosts.
const INSTANCES = {
  unkillable: {
    sourceInstance: 'unkillable',
    instanceId: 'unkillable',
    canonicalHost: 'forge.unkillablecompanies.com',
    aliasHosts: ['forge-next.unkillablecompanies.com'],
    manageHost: 'forge-manage.unkillablecompanies.com',
    accessTeamDomain: 'gosilex.cloudflareaccess.com',
    login: 'serve-shell',
    routeGrammars: ['subtree'],
    shareGrammars: ['slug'],
    shareCookie: false,
    shellPaths: ['/', '/index.html', '/login', '/login.html'],
    shortDomain: 'unkill.si',
    providerOrigin: 'https://unkill.si',
    importBucket: 'unkillable-forge-import',
    // Captured Shlink longUrls may still name the old alias host.
    destinationHosts: ['forge.unkillablecompanies.com', 'forge-next.unkillablecompanies.com', 'forge.gosilex.com'],
  },
  roxabi: {
    sourceInstance: 'roxabi',
    instanceId: 'roxabi',
    canonicalHost: 'forge.roxabi.dev',
    aliasHosts: [],
    manageHost: null,
    accessTeamDomain: null,
    login: 'serve-shell',
    routeGrammars: ['subtree'],
    shareGrammars: ['slug'],
    shareCookie: false,
    shellPaths: ['/', '/index.html', '/login', '/login.html'],
    shortDomain: null,
    providerOrigin: null,
    importBucket: null,
    destinationHosts: ['forge.roxabi.dev'],
  },
}

const DEFAULT_LIMITS = {
  maxCommandBytes: 8_000_000,
  maxJsonDepth: 16,
  maxUploadBytes: 32 * 1024 * 1024,
  maxInventoryBytes: 8_000_000,
}

const SHARE_KEY = /^[A-Za-z0-9_-]{8,128}$/
const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const SHA256_RE = /^[a-f0-9]{64}$/
const PAGES_DIGEST_RE = /^[a-f0-9]{32}$/
// Worker public error codes (adapters/http/manage-edge.ts PublicErrorCode).
const SAFE_ERROR_CODES = new Set([
  'invalid_request', 'payload_too_large', 'request_timeout', 'unsupported_media_type',
  'unauthenticated', 'forbidden', 'not_found', 'method_not_allowed', 'conflict', 'last_admin',
  'upload_incomplete', 'not_sealed', 'session_closed', 'session_expired',
  'invalid_state', 'integrity_error', 'internal_error', 'configuration_error', 'unavailable',
])
// Issue codes the import producers can put on blocked/ready results
// (domains/catalogue/import.ts, domains/publication/import.ts, adapters/http/import.ts).
const IMPORT_ISSUE_CODES = new Set([
  'source_mapping_conflict', 'policy_conflict', 'grant_conflict', 'alias_conflict',
  'shortlink_conflict', 'preview_not_owned', 'conflict',
  'resource_removal_undeclared', 'edge_removal_undeclared',
  'kept_derived_preview_unsupported', 'kept_preview_not_preserved', 'kept_preview_unsupported',
  'unknown_visibility_private', 'import_file_too_large', 'source_integrity',
  'g1b_evidence_required', 'selection_graph_mismatch', 'expiring_policy_unsupported',
  'missing_policy_evidence', 'import_metadata_limit', 'inventory_size_exceeds_approved_limit',
  'invalid_removal', 'invalid_state', 'not_found',
])
const RESULT_STATES = new Set(['checking', 'blocked', 'ready', 'staging', 'committed'])

/** Finite request budget: one request per file (32 MiB step cap) + phase/metadata overhead. */
function continuationBudget(selection) {
  const files = Array.isArray(selection?.command?.files) ? selection.command.files.length : 0
  return Math.max(files, 1) + 64
}

/** Pages Direct Upload asset hash: BLAKE3(base64(bytes) + extWithoutDot).hex[:32]. */
export function pagesAssetHash(bytes, publishedPath) {
  const ext = extname(publishedPath).replace(/^\./, '')
  return blake3.hash(Buffer.from(bytes).toString('base64') + ext).toString('hex').slice(0, 32)
}

function contentTypeFor(path) {
  const i = path.lastIndexOf('.')
  const ext = i >= 0 ? path.slice(i).toLowerCase() : ''
  return CONTENT_TYPES[ext] ?? null
}

function graphClassFor(path, slug) {
  const doc = `/a/${slug}/index.html`
  if (path === doc) return 'page_document'
  if (path.endsWith('.html')) return 'subdocument'
  return 'asset'
}

function pagesFilesMap(raw) {
  if (raw?.result?.files && typeof raw.result.files === 'object') return raw.result.files
  if (raw?.files && typeof raw.files === 'object') return raw.files
  fail('invalid_capture', 'pages-files.json missing result.files')
}

function readMetadataV(item) {
  const meta = item?.metadata
  if (!meta || typeof meta !== 'object' || Array.isArray(meta)) return { ok: true, value: null }
  if (!Object.prototype.hasOwnProperty.call(meta, 'v')) return { ok: true, value: null }
  if (typeof meta.v !== 'string') return { ok: false, reason: 'invalid_metadata_v' }
  return { ok: true, value: meta.v }
}

function readExpiration(value) {
  if (value == null) return { ok: true, value: null }
  if (typeof value === 'number' && Number.isFinite(value)) return { ok: true, value }
  return { ok: false, value: null }
}

function loadKvMaps(entries) {
  if (!Array.isArray(entries)) fail('invalid_capture', 'kv.json must be an array')
  const vis = new Map()
  const share = new Map()
  for (const item of entries) {
    if (!item || typeof item.name !== 'string') continue
    const exp = readExpiration(item.expiration)
    if (item.name.startsWith('vis:')) {
      const meta = readMetadataV(item)
      vis.set(item.name.slice(4), {
        value: item.value,
        metadataV: meta.ok ? meta.value : null,
        metadataOk: meta.ok,
        metadataReason: meta.ok ? null : meta.reason,
        expiresAt: exp.value,
        expirationOk: exp.ok,
        keyName: item.name,
      })
    } else if (item.name.startsWith('share:')) {
      share.set(item.name.slice(6), {
        key: item.value,
        expiresAt: exp.value,
        expirationOk: exp.ok,
        keyName: item.name,
      })
    }
  }
  return { vis, share }
}

// Legacy `/a/<slug>/` reads consult only the flat `vis:<slug>` / `share:<slug>`
// keys. Tree-layout keys such as `vis:<slug>/index.html` govern a different
// route and must not widen a subtree page (verified against the live reader).
function resolveVisibility(vis, slug) {
  if (vis.has(slug)) {
    const hit = vis.get(slug)
    return {
      state: 'present',
      value: hit.value,
      metadataV: hit.metadataV,
      metadataOk: hit.metadataOk !== false,
      metadataReason: hit.metadataReason ?? null,
      expiresAt: hit.expiresAt,
      expirationOk: hit.expirationOk !== false,
      key: slug,
      keyName: hit.keyName,
    }
  }
  return { state: 'absent', value: null, metadataV: null, metadataOk: true, metadataReason: null, expiresAt: null, expirationOk: true, key: null, keyName: null }
}

function resolveShare(share, slug) {
  if (share.has(slug)) {
    const hit = share.get(slug)
    return { state: 'present', key: hit.key, expiresAt: hit.expiresAt, expirationOk: hit.expirationOk !== false, mapKey: slug, keyName: hit.keyName }
  }
  return { state: 'absent', key: null, expiresAt: null, expirationOk: true, mapKey: null, keyName: null }
}

function hubEntry(hit) {
  if (typeof hit === 'string') return { path: hit, expectedSha256: null }
  if (hit && typeof hit === 'object' && typeof hit.path === 'string') {
    return { path: hit.path, expectedSha256: typeof hit.sha256 === 'string' && SHA256_RE.test(hit.sha256) ? hit.sha256 : null }
  }
  return null
}

function resolveByteSource(publishedPath, digest, hubFound, hubDigests, rebuilt, captureDir) {
  if (digest && hubFound[digest]) {
    const entry = hubEntry(hubFound[digest])
    if (entry) {
      const expected = entry.expectedSha256
        ?? (typeof hubDigests?.[publishedPath] === 'string' && SHA256_RE.test(hubDigests[publishedPath]) ? hubDigests[publishedPath] : null)
        ?? (SHA256_RE.test(digest) ? digest : null)
      return { kind: 'hub', path: entry.path, expectedSha256: expected }
    }
  }
  if (rebuilt[publishedPath]) {
    const rel = rebuilt[publishedPath]
    const expected = typeof hubDigests?.[publishedPath] === 'string' && SHA256_RE.test(hubDigests[publishedPath])
      ? hubDigests[publishedPath]
      : (SHA256_RE.test(digest) ? digest : null)
    return { kind: 'reinject', path: isAbsolute(rel) ? rel : join(dirname(captureDir), rel), expectedSha256: expected }
  }
  return null
}

function normalizeDestination(longUrl, canonicalHost, destinationHosts) {
  let url
  try { url = new URL(longUrl) } catch { return null }
  const host = url.hostname.toLowerCase()
  const allowed = new Set([canonicalHost, ...(destinationHosts ?? [])])
  if (allowed.has(host)) {
    url.protocol = 'https:'
    url.hostname = canonicalHost
    url.port = ''
    return url.href
  }
  return null
}

function parseShlinkTarget(destination, publishedSlugs) {
  let url
  try { url = new URL(destination) } catch { return null }
  const parts = url.pathname.split('/').filter(Boolean)
  if (parts[0] === 's' && parts.length >= 2) {
    const slug = parts[1]
    if (!publishedSlugs.has(slug)) return { ok: false, reason: 'shortlink_slug_not_published', slug }
    return { ok: true, slug, kind: 'share' }
  }
  if (parts[0] === 'a' && parts.length >= 1) {
    const slug = parts[1]
    if (!publishedSlugs.has(slug)) return { ok: false, reason: 'shortlink_slug_not_published', slug }
    return { ok: true, slug, kind: 'document' }
  }
  return { ok: false, reason: 'shortlink_path_unmappable', path: url.pathname }
}

/** Reader share-key precedence: query `k` wins over the path segment (grammar.ts). */
function shareKeyFromDestination(destination) {
  let destUrl
  try { destUrl = new URL(destination) } catch { return null }
  const parts = destUrl.pathname.split('/').filter(Boolean)
  const qk = destUrl.searchParams.get('k')
  if (qk !== null) return qk
  // /s/<slug>/<key>/… → parts[0]=s, parts[1]=slug, parts[2]=key
  return parts.length >= 3 ? parts[2] : null
}

function isInsideRoot(root, target) {
  const resolvedRoot = resolve(root)
  const resolvedTarget = resolve(target)
  const rel = pathRelative(resolvedRoot, resolvedTarget)
  return rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)
}

function validateMemberRelative(publishedPath) {
  if (typeof publishedPath !== 'string' || !publishedPath.startsWith('/') || publishedPath.includes('\\') || publishedPath.includes('\u0000')) {
    return { ok: false, reason: 'invalid_member_path' }
  }
  const relative = publishedPath.slice(1)
  if (!relative) return { ok: false, reason: 'invalid_member_path' }
  const segments = relative.split('/')
  if (segments.some(s => !s || s === '.' || s === '..')) return { ok: false, reason: 'invalid_member_path' }
  return { ok: true, relative }
}

async function realExisting(path) {
  const abs = resolve(path)
  try {
    return await realpath(abs)
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
  }
  let cur = abs
  for (;;) {
    const parent = dirname(cur)
    if (parent === cur) return cur
    try {
      return join(await realpath(parent), pathRelative(parent, abs))
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
      cur = parent
    }
  }
}

async function assertFreshCaptureRootOut(captureDir, captureRootOut) {
  const input = await realpath(resolve(captureDir))
  const output = await realExisting(captureRootOut)
  if (output === input) fail('invalid_arguments', 'capture-root-out must not equal capture')
  if (isInsideRoot(input, output) || isInsideRoot(output, input)) {
    fail('invalid_arguments', 'capture-root-out must not nest with capture')
  }
  try {
    const st = await stat(resolve(captureRootOut))
    if (!st.isDirectory()) fail('invalid_arguments', 'capture-root-out must be a directory or absent')
    const entries = await readdir(resolve(captureRootOut))
    if (entries.length) fail('invalid_arguments', 'capture-root-out must be empty')
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
  }
}

/** Build selection v1 + hard-copied capture-root from a legacy Pages capture directory. */
export async function prepareSelection(options) {
  const captureDir = options.captureDir
  if (!isAbs(captureDir)) fail('invalid_arguments', 'captureDir must be absolute')
  const selectionOut = options.selectionOut
  const captureRootOut = options.captureRootOut
  if (!isAbs(selectionOut) || !isAbs(captureRootOut)) fail('invalid_arguments', 'outputs must be absolute')
  const instanceKey = options.instance ?? detectInstance(captureDir)
  const profile = { ...INSTANCES[instanceKey], ...(options.profile ?? {}) }
  if (!profile?.canonicalHost) fail('invalid_arguments', `unknown instance ${instanceKey}`)
  // Real captures require historical evidence the Worker checks; synthetic is test/dev only.
  const kind = options.kind ?? 'historical'
  if (kind !== 'historical' && kind !== 'synthetic') fail('invalid_arguments', 'kind must be historical|synthetic')
  if (kind === 'historical' && !text(options.g1bRef)) fail('invalid_arguments', 'historical requires g1bRef')
  if (kind === 'synthetic' && options.g1bRef != null) fail('invalid_arguments', 'synthetic forbids g1bRef')

  const pagesRaw = await json(join(captureDir, 'pages-files.json'))
  const hubRaw = await json(join(captureDir, 'hub-match.json'))
  const reinjectRaw = await json(join(captureDir, 'reinject.json'))
  const kvRaw = await json(join(captureDir, 'kv.json'))
  let shlinkRaw = []
  try { shlinkRaw = await json(join(captureDir, 'shlink.json')) } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }
  const files = pagesFilesMap(pagesRaw)
  const hubFound = hubRaw?.found && typeof hubRaw.found === 'object' ? hubRaw.found : fail('invalid_capture', 'hub-match.json.found')
  const hubDigests = hubRaw?.digests && typeof hubRaw.digests === 'object' ? hubRaw.digests : null
  const rebuilt = reinjectRaw?.rebuilt && typeof reinjectRaw.rebuilt === 'object' ? reinjectRaw.rebuilt : fail('invalid_capture', 'reinject.json.rebuilt')
  const allowExpiring = options.allowExpiring === true
  const { vis, share } = loadKvMaps(kvRaw)
  const shlinks = Array.isArray(shlinkRaw) ? shlinkRaw : fail('invalid_capture', 'shlink.json must be an array')

  const refused = []
  const softRefused = []
  const evidence = []
  const bySlug = new Map()
  for (const [publishedPath, digest] of Object.entries(files)) {
    if (!publishedPath.startsWith('/a/')) continue
    const parts = publishedPath.split('/')
    if (parts.length < 4 || !parts[2]) {
      refused.push({ kind: 'entry', path: publishedPath, reason: 'invalid_a_path' })
      continue
    }
    const slug = parts[2]
    if (!SLUG_RE.test(slug)) {
      refused.push({ kind: 'entry', path: publishedPath, reason: 'invalid_slug', slug })
      continue
    }
    if (!bySlug.has(slug)) bySlug.set(slug, [])
    bySlug.get(slug).push({ path: publishedPath, digest })
  }

  await assertFreshCaptureRootOut(captureDir, captureRootOut)
  await mkdir(captureRootOut, { recursive: true, mode: 0o700 })

  const entries = []
  const pages = []
  const previews = []
  const publishedSlugs = new Set(bySlug.keys())

  for (const [slug, members] of [...bySlug.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    const indexPath = `/a/${slug}/index.html`
    if (!members.some(m => m.path === indexPath)) {
      refused.push({ kind: 'artifact', slug, reason: 'missing_index_html' })
      continue
    }
    const visHit = resolveVisibility(vis, slug)
    let visibilityValue = 'private'
    if (visHit.state === 'present') {
      if (!visHit.expirationOk) fail('invalid_expiration', visHit.keyName)
      if (visHit.expiresAt != null && !allowExpiring) fail('expiring_policy_unsupported', visHit.keyName)
      if (!visHit.metadataOk) {
        refused.push({ kind: 'visibility', slug, reason: visHit.metadataReason ?? 'invalid_metadata_v' })
        continue
      }
      if (!['private', 'public', 'shared'].includes(visHit.value)) {
        refused.push({ kind: 'visibility', slug, reason: 'unknown_visibility_value', valueType: typeof visHit.value })
        continue
      }
      if (visHit.metadataV != null && visHit.metadataV !== visHit.value) {
        refused.push({ kind: 'visibility', slug, reason: 'visibility_metadata_mismatch' })
        continue
      }
      visibilityValue = visHit.value
    }
    const shareHit = resolveShare(share, slug)
    let shareRecord = { state: 'absent' }
    if (visibilityValue === 'shared') {
      if (shareHit.state !== 'present' || typeof shareHit.key !== 'string') {
        refused.push({ kind: 'share', slug, reason: 'share_key_absent' })
        continue
      }
      if (!shareHit.expirationOk) fail('invalid_expiration', shareHit.keyName)
      if (shareHit.expiresAt != null && !allowExpiring) fail('expiring_policy_unsupported', shareHit.keyName)
      if (!SHARE_KEY.test(shareHit.key)) {
        refused.push({ kind: 'share', slug, reason: 'invalid_share_key', length: shareHit.key.length })
        continue
      }
      shareRecord = { state: 'present', key: shareHit.key, expiresAt: shareHit.expiresAt }
    }
    // Orphan share keys for non-shared published slugs are ignored (not imported).

    const artifactId = `slug:${slug}`
    let artifactFailed = false
    const artifactEntries = []
    for (const member of members.sort((a, b) => a.path.localeCompare(b.path))) {
      const source = resolveByteSource(member.path, member.digest, hubFound, hubDigests, rebuilt, captureDir)
      if (!source) {
        refused.push({ kind: 'entry', path: member.path, reason: 'bytes_unresolved' })
        artifactFailed = true
        break
      }
      let st
      try { st = await stat(source.path) } catch {
        refused.push({ kind: 'entry', path: member.path, reason: 'bytes_unreadable' })
        artifactFailed = true
        break
      }
      if (!st.isFile()) {
        refused.push({ kind: 'entry', path: member.path, reason: 'bytes_not_file' })
        artifactFailed = true
        break
      }
      const ctype = contentTypeFor(member.path)
      const gclass = graphClassFor(member.path, slug)
      if (!ctype || (gclass !== 'asset' && ctype !== 'text/html') || (gclass === 'asset' && ctype === 'text/html')) {
        refused.push({ kind: 'entry', path: member.path, reason: 'unsupported_content_type', contentType: ctype, graphClass: gclass })
        artifactFailed = true
        break
      }
      const pathCheck = validateMemberRelative(member.path)
      if (!pathCheck.ok) {
        refused.push({ kind: 'entry', path: member.path, reason: pathCheck.reason })
        artifactFailed = true
        break
      }
      const relative = pathCheck.relative
      const dest = join(captureRootOut, relative)
      if (!isInsideRoot(captureRootOut, dest)) {
        refused.push({ kind: 'entry', path: member.path, reason: 'path_escapes_capture_root' })
        artifactFailed = true
        break
      }
      await mkdir(dirname(dest), { recursive: true, mode: 0o700 })
      await copyFile(source.path, dest)
      const copiedBytes = await readFile(dest)
      const digest = sha256(copiedBytes)
      let verified = false
      if (source.expectedSha256) {
        if (digest !== source.expectedSha256) {
          refused.push({ kind: 'entry', path: member.path, reason: 'digest_mismatch' })
          artifactFailed = true
          break
        }
        verified = true
      }
      if (PAGES_DIGEST_RE.test(member.digest)) {
        if (pagesAssetHash(copiedBytes, member.path) !== member.digest) {
          refused.push({ kind: 'entry', path: member.path, reason: 'digest_mismatch' })
          artifactFailed = true
          break
        }
        verified = true
      }
      if (!verified) {
        refused.push({ kind: 'entry', path: member.path, reason: 'digest_unverified' })
        artifactFailed = true
        break
      }
      const size = (await stat(dest)).size
      evidence.push({ path: member.path, size, sha256: digest, sourceKind: source.kind })
      artifactEntries.push({
        path: member.path,
        graphClass: gclass,
        contentType: ctype,
        locator: { root: 'capture', relative },
        provenance: 'legacy-pages-capture',
        expected: { size, sha256: digest },
        placement: { sourceArtifactId: artifactId, evidenceRef: `pages:${member.digest}` },
      })
    }
    if (artifactFailed) continue

    for (const entry of artifactEntries) entries.push(entry)
    pages.push({
      sourcePageId: slug,
      documentPath: indexPath,
      metadata: {},
      ownershipEvidenceRef: `kv:vis:${visHit.key ?? 'default-private'}`,
      membership: { sourceArtifactId: artifactId, evidenceRef: `pages-artifact:${slug}` },
      visibility: {
        state: 'present',
        value: visibilityValue,
        metadataV: visHit.state === 'present' ? visHit.metadataV : null,
        expiresAt: visHit.state === 'present' ? visHit.expiresAt : null,
      },
      share: shareRecord,
    })

    const ogJpg = `/a/${slug}/og.jpg`
    const ogPng = `/a/${slug}/og.png`
    const indexOg = `/a/${slug}/index.og.png`
    const previewPath = [ogJpg, ogPng, indexOg].find(p => artifactEntries.some(e => e.path === p && (e.contentType === 'image/jpeg' || e.contentType === 'image/png')))
    if (previewPath) previews.push({ sourcePageId: slug, path: previewPath, kind: 'original' })
  }

  const shortlinks = []
  const shortDomain = options.shortDomain ?? profile.shortDomain
  const providerOrigin = options.providerOrigin ?? profile.providerOrigin
  for (const row of shlinks) {
    if (!row || typeof row !== 'object') {
      refused.push({ kind: 'shortlink', reason: 'invalid_record' })
      continue
    }
    const shortCode = row.shortCode
    const shortUrl = row.shortUrl
    const longUrl = row.longUrl
    if (!text(shortCode) || !text(shortUrl) || !text(longUrl)) {
      softRefused.push({ kind: 'shortlink', reason: 'missing_fields', shortCode: typeof shortCode === 'string' ? shortCode : null })
      continue
    }
    const domain = row.domain == null || row.domain === '' ? shortDomain : row.domain
    if (!text(domain) || !text(providerOrigin)) {
      softRefused.push({ kind: 'shortlink', reason: 'short_domain_unconfigured', shortCode })
      continue
    }
    const destination = normalizeDestination(longUrl, profile.canonicalHost, profile.destinationHosts ?? profile.aliasHosts)
    if (!destination) {
      softRefused.push({ kind: 'shortlink', reason: 'destination_host_unmappable', shortCode, host: safeHost(longUrl) })
      continue
    }
    const target = parseShlinkTarget(destination, publishedSlugs)
    if (!target?.ok) {
      softRefused.push({ kind: 'shortlink', reason: target?.reason ?? 'shortlink_unmappable', shortCode, slug: target?.slug ?? null })
      continue
    }
    const page = pages.find(p => p.sourcePageId === target.slug)
    if (!page) {
      softRefused.push({ kind: 'shortlink', reason: 'shortlink_page_missing', shortCode, slug: target.slug })
      continue
    }
    // Share destinations must match captured shared visibility + exact KV share key.
    // Stale shortlink keys or /s/ links to now-private pages are refused (not attached).
    if (target.kind === 'share') {
      const destKey = shareKeyFromDestination(destination)
      if (page.visibility.value !== 'shared' || page.share.state !== 'present') {
        softRefused.push({ kind: 'shortlink', reason: 'shortlink_share_not_current', shortCode, slug: target.slug })
        continue
      }
      if (destKey !== page.share.key) {
        softRefused.push({ kind: 'shortlink', reason: 'shortlink_share_key_mismatch', shortCode, slug: target.slug })
        continue
      }
    }
    const observedAt = Number.isSafeInteger(row.dateCreated) ? row.dateCreated
      : (typeof row.dateCreated === 'string' && !Number.isNaN(Date.parse(row.dateCreated)) ? Date.parse(row.dateCreated) : options.capturedAt ?? Date.now())
    shortlinks.push({
      mappingId: `shlink:${domain}:${shortCode}`,
      providerOrigin,
      providerId: null,
      shortDomain: domain,
      shortCode,
      shortUrl: shortUrl.includes('://') ? shortUrl : `https://${domain}/${shortCode}`,
      targetSourcePageId: target.slug,
      destination,
      observedAt: Math.max(0, observedAt),
    })
  }

  const allRefused = [...refused, ...softRefused]
  // Artifact-level refusals are fatal unless allowPartial; shortlink soft refusals are reported and omitted.
  if (refused.length && !options.allowPartial) {
    const err = new Error('prepare_selection_refused')
    err.code = 'prepare_selection_refused'
    err.refused = allRefused
    err.summary = summarizeRefused(allRefused)
    throw err
  }

  const capturedAt = options.capturedAt ?? Date.now()
  const selectionRef = options.selectionRef ?? `legacy-pages:${instanceKey}:${capturedAt}`
  const approvalRef = options.approvalRef ?? `legacy-pages-approval:${instanceKey}`
  const mappingRef = options.mappingRef ?? `legacy-pages-mapping:${instanceKey}`
  const corpusDigest = sha256(Buffer.from(stable(evidence.map(e => [e.path, e.size, e.sha256]).sort((a, b) => a[0].localeCompare(b[0])))))
  const reader = {
    canonicalHost: profile.canonicalHost,
    aliasHosts: profile.aliasHosts ?? [],
    routeGrammars: profile.routeGrammars ?? ['subtree'],
    shareGrammars: profile.shareGrammars ?? ['slug'],
    shareCookie: profile.shareCookie ?? false,
    shellPaths: profile.shellPaths ?? ['/', '/index.html', '/login', '/login.html'],
    ...(options.reader ?? {}),
  }
  const draft = {
    version: 1,
    kind,
    sourceInstance: profile.sourceInstance,
    selectionRef,
    approvalRef,
    g1bRef: kind === 'historical' ? options.g1bRef : null,
    capturedAt,
    corpusDigest: '0'.repeat(64),
    selectionDigest: '0'.repeat(64),
    mappingRef,
    complete: true,
    targetBasis: options.targetBasis ?? 'empty',
    limits: { ...DEFAULT_LIMITS, ...(options.limits ?? {}) },
    reader,
    captureRoots: ['capture'],
    entries,
    pages,
    owners: [],
    aliases: [],
    shortlinks,
    previews,
    consumerUrls: [],
    exclusions: [],
    providerMounts: [],
  }
  draft.corpusDigest = corpusDigest
  draft.selectionDigest = sha256(Buffer.from(stable({ ...draft, corpusDigest, selectionDigest: null })))

  await writePrivate(selectionOut, JSON.stringify(draft) + '\n')

  return {
    command: 'prepare-selection',
    instance: instanceKey,
    selection: selectionOut,
    captureRoot: captureRootOut,
    counts: {
      slugs: pages.length,
      entries: entries.length,
      pages: pages.length,
      shared: pages.filter(p => p.visibility.value === 'shared').length,
      public: pages.filter(p => p.visibility.value === 'public').length,
      private: pages.filter(p => p.visibility.value === 'private').length,
      shortlinks: shortlinks.length,
      previews: previews.length,
      refused: allRefused.length,
      refusedFatal: refused.length,
      refusedShortlinks: softRefused.length,
    },
    evidence: { files: evidence.length, captureRoot: captureRootOut },
    refused: summarizeRefused(allRefused),
    refusedRecords: allRefused,
  }
}

function detectInstance(captureDir) {
  const base = captureDir.replace(/\/+$/, '').split('/').pop()
  if (base === 'unkillable' || base === 'roxabi') return base
  fail('invalid_arguments', 'pass --instance unkillable|roxabi')
}

function safeHost(url) {
  try { return new URL(url).host } catch { return null }
}

function summarizeRefused(refused) {
  const byReason = {}
  for (const row of refused) {
    byReason[row.reason] = (byReason[row.reason] ?? 0) + 1
  }
  return { total: refused.length, byReason }
}

function parseArgs(argv) {
  const [command, ...rest] = argv
  const flags = {}
  for (let i = 0; i < rest.length; i++) {
    const flag = rest[i]
    if (!flag.startsWith('--')) fail('invalid_arguments', `unexpected ${flag}`)
    const value = rest[i + 1]
    if (!value || value.startsWith('--')) fail('invalid_arguments', `missing value for ${flag}`)
    flags[flag] = value
    i++
  }
  return { command, flags }
}

// The manage Worker compares the R2 binding's native `object.version`; only
// `cf r2 objects put` reports it (wrangler and the S3 API expose etags only).
async function runR2Put({ accountId, bucket, key, bytes, cfBin = 'cf' }) {
  const dir = await mkdtemp(join(tmpdir(), 'forge-import-pin-'))
  const file = join(dir, 'blob')
  try {
    await writePrivate(file, bytes)
    const { stdout } = await exec(cfBin, ['r2', 'objects', 'put', key, '--bucket-name', bucket, '--file', file], { env: { ...process.env, CLOUDFLARE_ACCOUNT_ID: accountId } })
    let reply
    try { reply = JSON.parse(stdout) } catch { fail('invalid_put_response', key) }
    if (reply?.key !== key || Number(reply.size) !== bytes.length || !/^[0-9a-f]{32}$/.test(reply.version ?? '')) fail('invalid_put_response', key)
    return { key, version: reply.version }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

function exec(bin, args, { secrets = [], env = process.env } = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'], env })
    let stdout = '', stderr = ''
    child.stdout.on('data', c => { stdout += c })
    child.stderr.on('data', c => { stderr += c })
    child.on('error', reject)
    child.on('close', code => {
      if (code === 0) return resolvePromise({ stdout, stderr })
      let message = `command_failed:${bin}`
      for (const secret of secrets) {
        if (secret) {
          stdout = stdout.split(secret).join('[redacted]')
          stderr = stderr.split(secret).join('[redacted]')
        }
      }
      const err = new Error(message)
      err.code = 'command_failed'
      err.detail = { code, stderr: stderr.slice(0, 500) }
      reject(err)
    })
  })
}

/** Re-pin prepared workspace units into an injectable R2 putter; emit FORGE_IMPORT_INVENTORIES. */
export async function pinWorkspace(options) {
  const workspace = options.workspace
  if (!isAbs(workspace)) fail('invalid_arguments', 'workspace must be absolute')
  const state = await json(join(workspace, 'state.json'))
  if (!Array.isArray(state.units) || !state.reader) fail('invalid_workspace', 'state.json missing units')
  const putObject = options.putObject
  if (typeof putObject !== 'function') fail('invalid_arguments', 'putObject required')
  const rootPaths = options.roots
  if (!rootPaths || typeof rootPaths !== 'object' || !Object.keys(rootPaths).length) fail('invalid_arguments', 'capture roots required')
  for (const [alias, path] of Object.entries(rootPaths)) {
    if (!/^[a-z][a-z0-9-]{0,31}$/.test(alias) || !isAbs(path)) fail('invalid_arguments', `bad capture root ${alias}`)
  }
  await loadTranslator()

  const approvals = []
  let pinned = 0
  let blocked = 0

  for (const unit of state.units) {
    if (unit.status !== 'representable' || !unit.inventory || !unit.inventoryKey) {
      blocked++
      continue
    }
    const pins = {}
    for (const file of unit.inventory.files) {
      const relative = file.path.startsWith('/') ? file.path.slice(1) : file.path
      const base = rootPaths.capture ?? rootPaths[Object.keys(rootPaths)[0]]
      if (!base) fail('invalid_arguments', 'missing capture root')
      const bytes = await readFile(join(base, relative))
      if (sha256(bytes) !== file.sha256 || bytes.length !== file.size) fail('source_integrity', file.path)
      const object = await putObject(file.sourceRef, bytes)
      if (!object?.version || object.version === file.sha256) fail('native_version_required', file.path)
      pins[file.sourceRef] = { version: object.version }
    }
    const assigned = assignSourcePins(unit, pins)
    if (!assigned.ok) fail(assigned.code, unit.unitId)
    const object = await putObject(unit.inventoryKey, assigned.bytes)
    const digest = sha256(assigned.bytes)
    if (!object?.version || object.version === digest) fail('invalid_inventory_pin', unit.unitId)
    const sealed = sealInventory(assigned.unit, { key: object.key ?? unit.inventoryKey, version: object.version }, digest)
    if (!sealed.ok) fail(sealed.code, unit.unitId)
    approvals.push(sealed.approval)
    pinned++
  }

  const inventories = JSON.stringify(approvals)
  if (options.inventoriesOut) {
    await writePrivate(options.inventoriesOut, inventories + '\n')
  }
  return {
    command: 'pin',
    pinned,
    blocked,
    approvals: approvals.length,
    inventoriesDigest: sha256(Buffer.from(inventories)),
    FORGE_IMPORT_INVENTORIES: inventories,
  }
}

function accessHeaders() {
  // CF_ACCESS_TOKEN is the operator's CF_Authorization JWT for the manage app.
  // The Access edge admits it as the CF_Authorization cookie and forwards the
  // verified Cf-Access-Jwt-Assertion; the Worker then requires an active
  // installation admin. Service tokens never act as a Catalogue identity.
  const jwt = process.env.CF_ACCESS_TOKEN
  if (!jwt) fail('unauthenticated', 'set CF_ACCESS_TOKEN to the operator CF_Authorization JWT for the manage host')
  return { 'content-type': 'application/json', cookie: `CF_Authorization=${jwt}` }
}

function isAlreadyCommittedConflict(body) {
  const result = body?.result
  if (result?.state !== 'blocked' || !Array.isArray(result.issues)) return false
  // dry_run preflight maps PolicyError('conflict') from an already-live `new` page
  // (domains/publication/staging.ts) onto issue code `conflict`.
  return result.issues.some(issue => issue && issue.code === 'conflict')
}


/** Drive dry_run then apply with cursor continuation against a manage host (injectable fetch). */
export async function applyImport(options) {
  const manageHost = options.manageHost
  if (!text(manageHost)) fail('invalid_arguments', 'manageHost required')
  const fetchImpl = options.fetch ?? globalThis.fetch
  const selections = options.selections
  if (!Array.isArray(selections) || !selections.length) fail('invalid_arguments', 'selections required')
  const headers = options.headers ?? accessHeaders()
  const endpoint = `https://${manageHost}/api/maintenance/import`
  const results = []

  for (const selection of selections) {
    const budget = continuationBudget(selection)
    let cursor = null
    let dry
    const seenDry = new Set()
    let dryRequests = 0
    for (;;) {
      dryRequests += 1
      if (dryRequests > budget) fail('invalid_continuation', 'dry_run request cap')
      dry = await postJson(fetchImpl, endpoint, headers, { op: 'dry_run', selection, cursor })
      const result = dry.body?.result
      if (dry.status === 200 && dry.body?.ok && result?.state === 'checking') {
        if (typeof result.nextCursor !== 'string' || seenDry.has(result.nextCursor)) fail('invalid_continuation', 'dry_run')
        seenDry.add(result.nextCursor)
        cursor = result.nextCursor
        continue
      }
      break
    }
    const dryState = dry.body?.result?.state
    if (dry.status >= 400 || !dry.body?.ok) {
      results.push(publicOutcome(selection.selectionId, 'dry_run', false, dry.status, dry.body))
      break
    }
    if (dryState === 'blocked') {
      const replay = !options.dryRunOnly && isAlreadyCommittedConflict(dry.body)
      if (!replay) {
        results.push(publicOutcome(selection.selectionId, 'dry_run', false, dry.status, dry.body))
        if (!options.continueOnBlock) break
        continue
      }
    } else if (dryState !== 'ready') {
      results.push(publicOutcome(selection.selectionId, 'dry_run', false, dry.status, dry.body))
      break
    } else if (options.dryRunOnly) {
      results.push(publicOutcome(selection.selectionId, 'dry_run', true, dry.status, dry.body))
      continue
    }
    cursor = undefined
    let applyRes
    const seenApply = new Set()
    let maxStored = -1
    let stalled = 0
    let applyRequests = 0
    for (;;) {
      applyRequests += 1
      if (applyRequests > budget) fail('invalid_continuation', 'apply request cap')
      const payload = cursor === undefined ? { op: 'apply', selection } : { op: 'apply', selection, cursor }
      applyRes = await postJson(fetchImpl, endpoint, headers, payload)
      const result = applyRes.body?.result
      if (applyRes.status === 200 && applyRes.body?.ok && result?.state === 'staging' && result.nextCursor == null) {
        // Native staging progress uses session.files[].stored (domains/publication/import.ts).
        const stored = (result.session?.files ?? []).filter(f => f?.stored).length
        if (stored > maxStored) {
          maxStored = stored
          stalled = 0
        } else {
          stalled += 1
        }
        if (stalled >= 3) fail('invalid_continuation', 'apply staging made no progress')
        cursor = undefined
        continue
      }
      if (applyRes.status === 200 && applyRes.body?.ok && (result?.state === 'checking' || result?.state === 'staging')) {
        if (typeof result.nextCursor !== 'string' || seenApply.has(result.nextCursor)) fail('invalid_continuation', 'apply')
        seenApply.add(result.nextCursor)
        cursor = result.nextCursor
        continue
      }
      break
    }
    const applyState = applyRes.body?.result?.state
    const applyOk = applyRes.status < 400 && !!applyRes.body?.ok && applyState === 'committed'
    results.push(publicOutcome(selection.selectionId, 'apply', applyOk, applyRes.status, applyRes.body))
    if (!applyOk) {
      if (applyRes.status >= 400) break
      if (applyState === 'blocked' && options.continueOnBlock) continue
      break
    }
  }
  return { command: 'apply', manageHost, results }
}

function malformedBody(status) {
  return { ok: false, error: `malformed_response:${status}` }
}

function decodeHexDigest(value) {
  return typeof value === 'string' && SHA256_RE.test(value) ? value : null
}

function decodeIssues(value) {
  if (value == null) return []
  if (!Array.isArray(value)) return null
  const issues = []
  for (const issue of value) {
    if (!record(issue) || typeof issue.code !== 'string') return null
    issues.push({ code: IMPORT_ISSUE_CODES.has(issue.code) ? issue.code : 'other' })
  }
  return issues
}

/** Strict Worker envelope: only recognized states and allowlisted codes; keep session.files for progress. */
function decodeWorkerEnvelope(parsed, status) {
  if (!record(parsed)) return malformedBody(status)
  if (parsed.ok === false) {
    const err = parsed.error
    if (record(err) && typeof err.code === 'string' && SAFE_ERROR_CODES.has(err.code)) {
      return { ok: false, error: { code: err.code } }
    }
    return malformedBody(status)
  }
  if (parsed.ok !== true) return malformedBody(status)
  if (parsed.result == null) return { ok: true, result: null }
  if (!record(parsed.result) || !RESULT_STATES.has(parsed.result.state)) return malformedBody(status)
  const src = parsed.result
  const result = { state: src.state }
  for (const key of ['planDigest', 'sourceDigest', 'targetDigest']) {
    if (src[key] == null) continue
    const digest = decodeHexDigest(src[key])
    if (!digest) return malformedBody(status)
    result[key] = digest
  }
  if (src.nextCursor != null) {
    if (typeof src.nextCursor !== 'string' || src.nextCursor.length === 0 || src.nextCursor.length > 16384) return malformedBody(status)
    result.nextCursor = src.nextCursor
  }
  const issues = decodeIssues(src.issues)
  if (issues === null) return malformedBody(status)
  if (issues.length) result.issues = issues
  const warnings = decodeIssues(src.warnings)
  if (warnings === null) return malformedBody(status)
  if (warnings.length) result.warnings = warnings
  if (src.session != null) {
    if (!record(src.session) || !Array.isArray(src.session.files)) return malformedBody(status)
    result.session = {
      files: src.session.files.map(file => ({ stored: !!(file && file.stored) })),
    }
  }
  return { ok: true, result }
}

async function postJson(fetchImpl, url, headers, body) {
  const res = await fetchImpl(url, {
    method: 'POST',
    headers: {
      ...headers,
      host: new URL(url).host,
      origin: `https://${new URL(url).host}`,
    },
    body: JSON.stringify(body),
  })
  const textBody = await res.text()
  let parsed
  try {
    parsed = JSON.parse(textBody)
  } catch {
    return { status: res.status, body: malformedBody(res.status) }
  }
  return { status: res.status, body: decodeWorkerEnvelope(parsed, res.status) }
}

/** Stdout/result summary: fixed enumerations + counts only (no cursors, digests, or file paths). */
function publicOutcome(selectionId, phase, ok, httpStatus, body) {
  const state = body?.result?.state
  const out = {
    selectionId,
    phase,
    ok,
    httpStatus,
    state: RESULT_STATES.has(state) ? state : null,
  }
  if (body?.ok === false) {
    if (typeof body.error === 'string' && /^malformed_response:\d+$/.test(body.error)) out.error = body.error
    else if (record(body.error) && SAFE_ERROR_CODES.has(body.error.code)) out.error = body.error.code
  }
  if (Array.isArray(body?.result?.issues)) out.issueCount = body.result.issues.length
  if (Array.isArray(body?.result?.session?.files)) {
    out.filesStored = body.result.session.files.filter(f => f.stored).length
  }
  return out
}

export async function selectionsFromWorkspace(workspace) {
  const state = await json(join(workspace, 'state.json'))
  const units = (state.units ?? []).filter(u => u.status === 'representable' && u.selection && u.pinState === 'pinned')
  return units.map(u => u.selection)
}

const WORKER_VAR_MAX_BYTES = 5000

/** Workers plain-text vars are capped at 5 KB: split pinned approvals into deployable batches. */
export function batchApprovals(approvals, maxBytes = WORKER_VAR_MAX_BYTES) {
  const batches = []
  let current = []
  for (const approval of approvals) {
    if (utf8Bytes([approval]) > maxBytes) fail('invalid_arguments', 'single approval exceeds the Worker var limit')
    if (current.length && utf8Bytes([...current, approval]) > maxBytes) { batches.push(current); current = [] }
    current.push(approval)
  }
  if (current.length) batches.push(current)
  return batches
}

export async function splitInventories(inventoriesPath, outDir) {
  const dest = resolve(outDir)
  try {
    const st = await stat(dest)
    if (!st.isDirectory()) fail('invalid_arguments', 'out-dir must be a directory')
    const entries = await readdir(dest)
    if (entries.length) fail('invalid_arguments', 'batch out-dir must be empty')
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
  }
  await mkdir(dest, { recursive: true, mode: 0o700 })
  const batches = batchApprovals(await json(resolve(inventoriesPath)))
  const files = []
  for (const [index, batch] of batches.entries()) {
    const file = join(dest, `batch-${String(index + 1).padStart(3, '0')}.json`)
    await writePrivate(file, JSON.stringify(batch))
    files.push({ file, approvals: batch.length })
  }
  return { command: 'split-inventories', batches: files }
}

export async function main(argv = process.argv.slice(2), deps = {}) {
  const { command, flags } = parseArgs(argv)
  if (command === 'prepare-selection') {
    const captureDir = flags['--capture']
    const selectionOut = flags['--selection']
    const captureRootOut = flags['--capture-root-out']
    if (!captureDir || !selectionOut || !captureRootOut) fail('invalid_arguments', 'prepare-selection requires --capture --selection --capture-root-out')
    const result = await prepareSelection({
      captureDir: resolve(captureDir),
      selectionOut: resolve(selectionOut),
      captureRootOut: resolve(captureRootOut),
      instance: flags['--instance'],
      kind: flags['--kind'],
      g1bRef: flags['--g1b-ref'],
      shortDomain: flags['--short-domain'],
      providerOrigin: flags['--provider-origin'],
      allowPartial: flags['--allow-partial'] === 'true',
      allowExpiring: flags['--allow-expiring'] === 'true',
    })
    // Omit refusedRecords detail that might echo secrets; keep counts only on stdout.
    const { refusedRecords, ...publicResult } = result
    const profile = INSTANCES[result.instance] ?? {}
    console.log(JSON.stringify({
      ...publicResult,
      production: {
        instanceId: profile.instanceId ?? null,
        manageHost: profile.manageHost ?? null,
        importBucket: profile.importBucket ?? null,
        shortDomain: profile.shortDomain ?? null,
      },
      refusedRecords: refusedRecords.map(r => ({ kind: r.kind, reason: r.reason, slug: r.slug ?? null, path: r.path ?? null, shortCode: r.shortCode ?? null })),
    }))
    return 0
  }
  if (command === 'pin') {
    const workspace = flags['--workspace']
    const bucket = flags['--bucket']
    const accountId = flags['--account-id']
    const captureRoot = flags['--capture-root']
    const inventoriesOut = flags['--inventories-out']
    if (!workspace || !bucket || !accountId || !captureRoot || !inventoriesOut) {
      fail('invalid_arguments', 'pin requires --workspace --bucket --account-id --capture-root alias=/abs --inventories-out')
    }
    const roots = {}
    const sepIdx = captureRoot.indexOf('=')
    if (sepIdx <= 0) fail('invalid_arguments', 'capture-root must be alias=/absolute/path')
    roots[captureRoot.slice(0, sepIdx)] = resolve(captureRoot.slice(sepIdx + 1))
    const putObject = deps.putObject ?? (async (key, bytes) => runR2Put({ accountId, bucket, key, bytes }))
    const result = await pinWorkspace({
      workspace: resolve(workspace),
      roots,
      putObject,
      inventoriesOut: resolve(inventoriesOut),
    })
    // Approvals (private R2 objectKey) stay in the inventories file only.
    console.log(JSON.stringify({
      command: result.command,
      pinned: result.pinned,
      blocked: result.blocked,
      approvals: result.approvals,
      inventoriesOut: resolve(inventoriesOut),
      inventoriesDigest: result.inventoriesDigest,
      configure: 'Set manage Worker var FORGE_IMPORT_INVENTORIES from the private inventories file (and bind FORGE_IMPORT_SOURCE to this R2 bucket).',
    }))
    return 0
  }
  if (command === 'split-inventories') {
    const inventories = flags['--inventories']
    const outDir = flags['--out-dir']
    if (!inventories || !outDir) fail('invalid_arguments', 'split-inventories requires --inventories --out-dir')
    const result = await splitInventories(inventories, outDir)
    console.log(JSON.stringify(result))
    return 0
  }
  if (command === 'apply') {
    const workspace = flags['--workspace']
    const manageHost = flags['--manage-host']
    if (!workspace || !manageHost) fail('invalid_arguments', 'apply requires --workspace --manage-host')
    let selections = await selectionsFromWorkspace(resolve(workspace))
    if (flags['--inventories']) {
      const deployed = new Set((await json(resolve(flags['--inventories']))).map(a => a.selectionId))
      selections = selections.filter(s => deployed.has(s.selectionId))
    }
    const result = await applyImport({
      manageHost,
      selections,
      dryRunOnly: flags['--dry-run-only'] === 'true',
      continueOnBlock: flags['--continue-on-block'] === 'true',
      fetch: deps.fetch,
      headers: deps.headers,
    })
    console.log(JSON.stringify(result))
    if (result.results.some(row => !row.ok)) return 1
    return 0
  }
  fail('invalid_arguments', 'command must be prepare-selection|pin|split-inventories|apply')
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) {
  main().then(code => {
    if (typeof code === 'number' && code !== 0) process.exit(code)
  }).catch(error => {
    const code = error?.code ?? 'internal_error'
    const payload = { error: code }
    if (error?.summary) payload.refused = error.summary
    if (Array.isArray(error?.refused)) {
      payload.refusedRecords = error.refused.map(r => ({
        kind: r.kind, reason: r.reason, slug: r.slug ?? null, path: r.path ?? null, shortCode: r.shortCode ?? null,
      }))
    }
    console.error(JSON.stringify(payload))
    process.exit(code === 'prepare_selection_refused' ? 2 : 1)
  })
}
