// Capture → selection v1 + capture-root layout; production pin/apply drivers.
// Does not modify engine domain code. Never prints share keys or Shlink secrets.
import { createHash } from 'node:crypto'
import { copyFile, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

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
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype
function stable(value) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value)
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`
  if (record(value)) return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stable(value[key])}`).join(',')}}`
  throw new Error('unstable_value')
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
    importAccountId: 'f8026cffc9463a03e1a6a76af5301861',
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
    importAccountId: null,
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

function loadKvMaps(entries) {
  if (!Array.isArray(entries)) fail('invalid_capture', 'kv.json must be an array')
  const vis = new Map()
  const share = new Map()
  for (const item of entries) {
    if (!item || typeof item.name !== 'string') continue
    if (item.name.startsWith('vis:')) vis.set(item.name.slice(4), item.value)
    else if (item.name.startsWith('share:')) share.set(item.name.slice(6), item.value)
  }
  return { vis, share }
}

function resolveVisibility(vis, slug) {
  if (vis.has(slug)) return { state: 'present', value: vis.get(slug), key: slug }
  const nested = `${slug}/index.html`
  if (vis.has(nested)) return { state: 'present', value: vis.get(nested), key: nested }
  return { state: 'absent', value: null, key: null }
}

function resolveShare(share, slug) {
  if (share.has(slug)) return { state: 'present', key: share.get(slug), mapKey: slug }
  const nested = `${slug}/index.html`
  if (share.has(nested)) return { state: 'present', key: share.get(nested), mapKey: nested }
  return { state: 'absent', key: null, mapKey: null }
}

function resolveByteSource(publishedPath, digest, hubFound, rebuilt, captureDir) {
  if (digest && hubFound[digest]) return { kind: 'hub', path: hubFound[digest] }
  if (rebuilt[publishedPath]) {
    const rel = rebuilt[publishedPath]
    return { kind: 'reinject', path: isAbsolute(rel) ? rel : join(dirname(captureDir), rel) }
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
  const kind = options.kind ?? (options.g1bRef ? 'historical' : 'synthetic')
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
  const rebuilt = reinjectRaw?.rebuilt && typeof reinjectRaw.rebuilt === 'object' ? reinjectRaw.rebuilt : fail('invalid_capture', 'reinject.json.rebuilt')
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

  await rm(captureRootOut, { recursive: true, force: true })
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
      if (!['private', 'public', 'shared'].includes(visHit.value)) {
        refused.push({ kind: 'visibility', slug, reason: 'unknown_visibility_value', valueType: typeof visHit.value })
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
      if (!SHARE_KEY.test(shareHit.key)) {
        refused.push({ kind: 'share', slug, reason: 'invalid_share_key', length: shareHit.key.length })
        continue
      }
      shareRecord = { state: 'present', key: shareHit.key, expiresAt: null }
    }
    // Orphan share keys for non-shared published slugs are ignored (not imported).

    const artifactId = `slug:${slug}`
    let artifactFailed = false
    const artifactEntries = []
    for (const member of members.sort((a, b) => a.path.localeCompare(b.path))) {
      const source = resolveByteSource(member.path, member.digest, hubFound, rebuilt, captureDir)
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
      const relative = member.path.slice(1)
      const dest = join(captureRootOut, relative)
      await mkdir(dirname(dest), { recursive: true, mode: 0o700 })
      await copyFile(source.path, dest)
      const digest = await sha256File(dest)
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
        metadataV: null,
        expiresAt: null,
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
      let destUrl
      try { destUrl = new URL(destination) } catch { destUrl = null }
      const parts = destUrl ? destUrl.pathname.split('/').filter(Boolean) : []
      const destKey = parts.length >= 3 ? parts[2] : null
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

  await mkdir(dirname(selectionOut), { recursive: true, mode: 0o700 })
  await writeFile(selectionOut, `${JSON.stringify(draft)}\n`, { mode: 0o600 })

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

async function runWranglerPut({ accountId, bucket, key, bytes, wranglerBin = 'wrangler' }) {
  const dir = await mkdtemp(join(tmpdir(), 'forge-import-pin-'))
  const file = join(dir, 'blob')
  try {
    await writeFile(file, bytes, { mode: 0o600 })
    const objectPath = `${bucket}/${key}`
    await exec(wranglerBin, ['r2', 'object', 'put', objectPath, '--file', file, '--remote', '--account-id', accountId], { secrets: [accountId] })
    // R2 always assigns an object version; prefer API head when token present, else stable content digest marker for operator follow-up.
    const version = await headR2Version({ accountId, bucket, key }) ?? `sha256:${sha256(bytes)}`
    return { key, version }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

async function headR2Version({ accountId, bucket, key }) {
  const token = process.env.CLOUDFLARE_API_TOKEN || process.env.CF_API_TOKEN
  if (!token) return null
  // Prefer API metadata when a token is present; never log the token.
  try {
    const res = await fetch(`https://api.cloudflare.com/client/v4/accounts/${accountId}/r2/buckets/${encodeURIComponent(bucket)}/objects/${key.split('/').map(encodeURIComponent).join('/')}`, {
      method: 'HEAD',
      headers: { Authorization: `Bearer ${token}` },
    })
    if (!res.ok) return null
    return res.headers.get('etag')?.replaceAll('"', '') ?? null
  } catch {
    return null
  }
}

function exec(bin, args, { secrets = [] } = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'], env: process.env })
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
    await mkdir(dirname(options.inventoriesOut), { recursive: true, mode: 0o700 })
    await writeFile(options.inventoriesOut, `${inventories}\n`, { mode: 0o600 })
  }
  return {
    command: 'pin',
    pinned,
    blocked,
    approvals: approvals.length,
    FORGE_IMPORT_INVENTORIES: inventories,
  }
}

function accessHeaders() {
  const headers = { 'content-type': 'application/json' }
  const jwt = process.env.CF_ACCESS_TOKEN
  const clientId = process.env.CF_ACCESS_CLIENT_ID
  const clientSecret = process.env.CF_ACCESS_CLIENT_SECRET
  // Manage Worker admits Cf-Access-Jwt-Assertion (or CF_Authorization cookie) with manage audience + nonempty sub,
  // then requires an active installation admin in D1. Raw Client-Id/Secret are for the Access edge only.
  if (jwt) {
    headers['cf-access-jwt-assertion'] = jwt
  } else if (clientId && clientSecret) {
    headers['CF-Access-Client-Id'] = clientId
    headers['CF-Access-Client-Secret'] = clientSecret
  } else {
    fail('unauthenticated', 'set CF_ACCESS_TOKEN (preferred) or CF_ACCESS_CLIENT_ID+CF_ACCESS_CLIENT_SECRET')
  }
  return headers
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
    let cursor = null
    let dry
    const seenDry = new Set()
    for (;;) {
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
    if (dry.status >= 400 || !dry.body?.ok || dryState === 'blocked') {
      results.push({ selectionId: selection.selectionId, phase: 'dry_run', ok: false, httpStatus: dry.status, state: dryState ?? null, body: publicBody(dry.body) })
      if (!options.continueOnBlock) break
      continue
    }
    if (options.dryRunOnly) {
      results.push({ selectionId: selection.selectionId, phase: 'dry_run', ok: true, httpStatus: dry.status, state: dryState ?? null, body: publicBody(dry.body) })
      continue
    }
    cursor = undefined
    let applyRes
    const seenApply = new Set()
    for (;;) {
      const payload = cursor === undefined ? { op: 'apply', selection } : { op: 'apply', selection, cursor }
      applyRes = await postJson(fetchImpl, endpoint, headers, payload)
      const result = applyRes.body?.result
      if (applyRes.status === 200 && applyRes.body?.ok && (result?.state === 'checking' || result?.state === 'staging')) {
        if (typeof result.nextCursor !== 'string' || seenApply.has(result.nextCursor)) fail('invalid_continuation', 'apply')
        seenApply.add(result.nextCursor)
        cursor = result.nextCursor
        continue
      }
      break
    }
    const applyState = applyRes.body?.result?.state
    results.push({
      selectionId: selection.selectionId,
      phase: 'apply',
      ok: applyRes.status < 400 && !!applyRes.body?.ok && applyState !== 'blocked',
      httpStatus: applyRes.status,
      state: applyState ?? null,
      body: publicBody(applyRes.body),
    })
    if (!results.at(-1).ok && !options.continueOnBlock) break
  }
  return { command: 'apply', manageHost, results }
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
  let parsed = null
  const textBody = await res.text()
  try { parsed = JSON.parse(textBody) } catch { parsed = { raw: textBody.slice(0, 200) } }
  return { status: res.status, body: parsed }
}

function publicBody(body) {
  if (!body || typeof body !== 'object') return body
  const out = { ...body }
  for (const key of ['selection', 'command', 'inventory', 'share', 'destination', 'key']) delete out[key]
  if (Array.isArray(out.issues)) out.issues = out.issues.map(issue => ({ code: issue.code, path: issue.path ?? undefined }))
  return out
}

export async function selectionsFromWorkspace(workspace) {
  const state = await json(join(workspace, 'state.json'))
  const units = (state.units ?? []).filter(u => u.status === 'representable' && u.selection && u.pinState === 'pinned')
  return units.map(u => u.selection)
}

async function main(argv = process.argv.slice(2)) {
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
        importAccountId: profile.importAccountId ?? null,
        shortDomain: profile.shortDomain ?? null,
      },
      refusedRecords: refusedRecords.map(r => ({ kind: r.kind, reason: r.reason, slug: r.slug ?? null, path: r.path ?? null, shortCode: r.shortCode ?? null })),
    }))
    return
  }
  if (command === 'pin') {
    const workspace = flags['--workspace']
    const bucket = flags['--bucket']
    const accountId = flags['--account-id']
    const captureRoot = flags['--capture-root']
    if (!workspace || !bucket || !accountId || !captureRoot) fail('invalid_arguments', 'pin requires --workspace --bucket --account-id --capture-root alias=/abs')
    const roots = {}
    const sep = captureRoot.indexOf('=')
    if (sep <= 0) fail('invalid_arguments', 'capture-root must be alias=/absolute/path')
    roots[captureRoot.slice(0, sep)] = resolve(captureRoot.slice(sep + 1))
    const putObject = async (key, bytes) => runWranglerPut({ accountId, bucket, key, bytes })
    const result = await pinWorkspace({
      workspace: resolve(workspace),
      roots,
      putObject,
      inventoriesOut: flags['--inventories-out'] ? resolve(flags['--inventories-out']) : null,
    })
    console.log(JSON.stringify({
      command: result.command,
      pinned: result.pinned,
      blocked: result.blocked,
      approvals: result.approvals,
      FORGE_IMPORT_INVENTORIES: result.FORGE_IMPORT_INVENTORIES,
      configure: 'Set manage Worker var FORGE_IMPORT_INVENTORIES to the JSON array above (and bind FORGE_IMPORT_SOURCE to this R2 bucket).',
    }))
    return
  }
  if (command === 'apply') {
    const workspace = flags['--workspace']
    const manageHost = flags['--manage-host']
    if (!workspace || !manageHost) fail('invalid_arguments', 'apply requires --workspace --manage-host')
    const selections = await selectionsFromWorkspace(resolve(workspace))
    const result = await applyImport({
      manageHost,
      selections,
      dryRunOnly: flags['--dry-run-only'] === 'true',
      continueOnBlock: flags['--continue-on-block'] === 'true',
    })
    console.log(JSON.stringify(result))
    return
  }
  fail('invalid_arguments', 'command must be prepare-selection|pin|apply')
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) {
  main().catch(error => {
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
