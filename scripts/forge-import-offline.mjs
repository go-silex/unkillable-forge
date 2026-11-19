#!/usr/bin/env node
// Isolated local preparation and authenticated, read-only planning. No provider transport.
import { createHash, createHmac, randomBytes, webcrypto } from 'node:crypto'
import { constants } from 'node:fs'
import { mkdir, open, readFile, stat } from 'node:fs/promises'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import { Miniflare, convertV4MiniflareOptions } from 'miniflare'
import { readD1Migrations } from '@cloudflare/vitest-plugin'
import { bindSourceRoot } from '../plugins/unkillable-forge/dist/filesystem.js'
import { translateSelection, assignSourcePins, sealInventory, stable } from './forge-import-selected.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const issuer = 'https://team.cloudflareaccess.com'
const certs = `${issuer}/cdn-cgi/access/certs`
const instance = { instanceId: 'test-forge', canonicalHost: 'forge.example.test', aliasHosts: ['alias.example.test'], manageHost: 'manage.example.test', accessTeamDomain: 'team.cloudflareaccess.com', readAudiences: ['reader'], manageAudiences: ['manager'], login: 'serve-shell', routeGrammars: ['tree', 'subtree'], shareGrammars: ['page', 'card', 'slug'], shareCookie: true, shellPaths: ['/', '/login'] }
const publication = { sessionTtlMs: 60000, maxUploadTimeoutMs: 5000, retainMs: 900000, marginMs: 5000, manageClockSkewMs: 0, readClockSkewMs: 0 }
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const keyed = (key, value) => createHmac('sha256', Buffer.from(key, 'base64url')).update(stable(value)).digest('hex')
const fail = code => { throw new Error(code) }
const encoded = value => Buffer.from(JSON.stringify(value)).toString('base64url')

function argumentsOf(args) {
  const command = args.shift()
  if (!['prepare', 'plan'].includes(command)) fail('invalid_arguments')
  const flags = {}, roots = {}
  while (args.length) {
    const flag = args.shift(), value = args.shift()
    if (!value || value.startsWith('--') || !['--selection', '--workspace', '--capture-root'].includes(flag)) fail('invalid_arguments')
    if (flag === '--capture-root') {
      const at = value.indexOf('=')
      const alias = value.slice(0, at), path = value.slice(at + 1)
      if (at < 1 || !/^[A-Za-z0-9_-]+$/.test(alias) || !isAbsolute(path) || Object.hasOwn(roots, alias)) fail('invalid_arguments')
      roots[alias] = path
    } else {
      if (Object.hasOwn(flags, flag)) fail('invalid_arguments')
      flags[flag] = value
    }
  }
  if (!flags['--workspace'] || !isAbsolute(flags['--workspace'])) fail('invalid_arguments')
  if (command === 'prepare' ? !flags['--selection'] || !isAbsolute(flags['--selection']) || !Object.keys(roots).length : flags['--selection'] || Object.keys(roots).length) fail('invalid_arguments')
  return { command, workspace: flags['--workspace'], selection: flags['--selection'], roots }
}
async function privateRead(path) {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const info = await file.stat()
    if (!info.isFile() || (info.mode & 0o077) !== 0) fail('private_file_required')
    return await file.readFile('utf8')
  } finally { await file.close() }
}
function protectedRelative(path) {
  return typeof path !== 'string' || path.split('/').some(part => !part || part === '.' || part === '..' || part === '.env' || part.startsWith('.env.') || part === '.git' || part === '.ssh') || path.includes('\\') || path.includes('\0')
}
function protectedPath(path) {
  return typeof path !== 'string' || !path.startsWith('/') || /^\/(?:s|_revisions|api|registry|_derived)(?:\/|$)/.test(path) || path === '/manifest.json' || path === '/asset-owners.json'
}
function compatibilityCounts(compatibility) {
  const result = {}
  for (const [group, entries] of Object.entries(compatibility)) {
    result[group] = {}
    for (const entry of entries) result[group][entry.code] = (result[group][entry.code] ?? 0) + 1
  }
  return result
}
async function privateWrite(path, value) {
  const file = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
  try { await file.writeFile(JSON.stringify(value)); await file.sync() } finally { await file.close() }
}
function depth(value) {
  if (value === null || typeof value !== 'object') return 0
  return 1 + Math.max(0, ...Object.values(value).map(depth))
}
function checkEnvelope(selection, cursor, transport) {
  const envelope = { op: 'dry_run', selection, cursor }
  const begin = { op: 'begin', command: selection.command }
  const command = selection.command
  if ((cursor !== null && (typeof cursor !== 'string' || cursor.length > 16384)) ||
      Buffer.byteLength(JSON.stringify(envelope)) > transport.maxCommandBytes || depth(envelope) > transport.maxJsonDepth ||
      Buffer.byteLength(JSON.stringify(begin)) > transport.maxCommandBytes || depth(begin) > transport.maxJsonDepth ||
      command.files.length > 10000 || command.pages.length > 1000 || command.edges.length > 20000 ||
      !command.pages.some(page => page.disposition !== 'drop') || command.files.some(file => file.size > Math.min(transport.maxUploadBytes, 32 * 1024 * 1024))) fail('budget_exceeded')
  return envelope
}
function sameFile(a, b) {
  return a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs
}
async function inspectSource(source, relative) {
  let file
  try { file = await source.open(relative) } catch (error) {
    if (error.code === 'ENOENT') return { observation: { state: 'absent' } }
    if (['EACCES', 'EPERM', 'EIO', 'ELOOP', 'ENOTDIR'].includes(error.code)) return { observation: { state: 'unreadable' } }
    if (error.message === 'filesystem_identity_mismatch') return { observation: { state: 'unknown' } }
    throw error
  }
  try {
    const before = await file.stat({ bigint: true })
    const hash = createHash('sha256'), buffer = Buffer.allocUnsafe(64 * 1024)
    let offset = 0
    for (;;) {
      const { bytesRead } = await file.read(buffer, 0, buffer.length, offset)
      if (!bytesRead) break
      hash.update(buffer.subarray(0, bytesRead))
      offset += bytesRead
      if (!Number.isSafeInteger(offset)) fail('source_changed')
    }
    const after = await file.stat({ bigint: true })
    if (!sameFile(before, after) || BigInt(offset) !== after.size) return { observation: { state: 'unknown' } }
    return { observation: { state: 'present', size: offset, sha256: hash.digest('hex') }, identity: after }
  } catch (error) {
    if (['EACCES', 'EPERM', 'EIO'].includes(error.code)) return { observation: { state: 'unreadable' } }
    if (error.message === 'filesystem_identity_mismatch' || error.message === 'source_changed') return { observation: { state: 'unknown' } }
    throw error
  } finally { await file.close() }
}
async function readPinnedSource(source, relative, observed, identity, cap) {
  if (!identity || observed.size > cap) fail('source_changed')
  const file = await source.open(relative)
  try {
    const before = await file.stat({ bigint: true })
    if (!sameFile(identity, before) || before.size !== BigInt(observed.size)) fail('source_changed')
    const bytes = Buffer.allocUnsafe(observed.size)
    let offset = 0
    while (offset < bytes.length) {
      const part = await file.read(bytes, offset, bytes.length - offset, offset)
      if (!part.bytesRead) fail('source_changed')
      offset += part.bytesRead
    }
    const after = await file.stat({ bigint: true })
    if (!sameFile(before, after) || sha(bytes) !== observed.sha256) fail('source_changed')
    return bytes
  } finally { await file.close() }
}
async function workerBundle() {
  const result = await build({ entryPoints: [join(root, 'adapters/http/manageWorker.ts')], bundle: true, write: false, format: 'esm', platform: 'browser', target: 'es2022', logLevel: 'silent' })
  if (result.outputFiles.length !== 1) fail('bundle_error')
  return result.outputFiles[0].text
}
async function runtime(workspace, state, approvals) {
  const script = await workerBundle()
  const jwksScript = `export default { fetch(r) { if (r.method === 'GET' && r.url === ${JSON.stringify(certs)}) return Response.json({keys:[${JSON.stringify(state.publicKey)}]}); return new Response('denied',{status:403}) } }`
  const shim = `export default { fetch(r,e) { const h=new Headers(r.headers); h.set('host',new URL(r.url).hostname); return e.MANAGE.fetch(new Request(r.url,{method:r.method,headers:h,body:r.body,redirect:'manual'})) } }`
  const deny = `export default { fetch() { return new Response('denied',{status:403}) } }`
  const bindings = { FORGE_INSTANCE: JSON.stringify(instance), FORGE_SHARE_VERIFIER_KEYS: JSON.stringify(state.keyring), FORGE_PUBLICATION_OPTIONS: JSON.stringify(publication), FORGE_MANAGE_TRANSPORT: JSON.stringify(state.transport) }
  if (approvals.length) bindings.FORGE_IMPORT_INVENTORIES = JSON.stringify(approvals)
  const common = { compatibilityDate: '2025-02-14', compatibilityFlags: ['enable_request_signal', 'unhandled_rejection_after_microtask_checkpoint'] }
  const options = convertV4MiniflareOptions({ cf: false, enableDevRegistry: false, resourcePersistencePath: join(workspace, 'persist'), workers: [
    { ...common, name: 'shim', modules: true, script: shim, serviceBindings: { MANAGE: 'manage' }, outboundService: 'deny' },
    { ...common, name: 'manage', modules: true, script, d1Databases: { DB: 'forge-manage-local' }, r2Buckets: { REVISION_BYTES: 'revision-bytes', FORGE_IMPORT_SOURCE: 'import-source' }, bindings, outboundService: 'jwks' },
    { ...common, name: 'jwks', modules: true, script: jwksScript, outboundService: 'deny' },
    { ...common, name: 'deny', modules: true, script: deny, outboundService: 'deny' },
  ] })
  options.telemetry = { enabled: false }; options.cf = false; options.enableDevRegistry = false
  for (const worker of options.workers) worker.dev.unsafeRegisterWorker = false
  const mf = new Miniflare(options)
  await mf.ready
  const miniflare = JSON.parse(await readFile(join(root, 'node_modules/miniflare/package.json'), 'utf8')).version
  const workerd = JSON.parse(await readFile(join(root, 'node_modules/workerd/package.json'), 'utf8')).version
  return { mf, runtime: { node: process.version, miniflarePackage: miniflare, workerdPackage: workerd, bundleInputSha256: sha(Buffer.from(script)) } }
}
async function snapshot(mf) {
  const db = await mf.getD1Database('DB', 'manage')
  const tables = (await db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' ORDER BY name").all()).results
  const rows = {}
  for (const { name } of tables) {
    const quoted = `"${name.replaceAll('"', '""')}"`
    const data = (await db.prepare(`SELECT * FROM ${quoted}`).all()).results
    rows[name] = data.map(row => stable(row)).sort()
  }
  const buckets = {}
  for (const name of ['REVISION_BYTES', 'FORGE_IMPORT_SOURCE']) {
    const bucket = await mf.getR2Bucket(name, 'manage'); const objects = []; let cursor
    do {
      const page = await bucket.list({ cursor })
      objects.push(...page.objects.map(({ key, version, size }) => ({ key, version, size })))
      cursor = page.truncated ? page.cursor : undefined
      if (page.truncated && !cursor) fail('invalid_pagination')
    } while (cursor)
    buckets[name] = objects.sort((a, b) => a.key < b.key ? -1 : a.key > b.key ? 1 : 0)
  }
  return { rows, buckets }
}
async function assertion(state) {
  const header = encoded({ alg: 'RS256', kid: state.publicKey.kid })
  const payload = encoded({ iss: issuer, aud: 'manager', sub: 'fixture-admin', exp: Math.floor(Date.now() / 1000) + 3600 })
  const input = `${header}.${payload}`
  const key = await webcrypto.subtle.importKey('jwk', state.privateKey, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign'])
  return `${input}.${Buffer.from(await webcrypto.subtle.sign('RSASSA-PKCS1-v1_5', key, Buffer.from(input))).toString('base64url')}`
}
async function prepare(args) {
  // mkdir is exclusive: existing workspaces, even empty ones, are never reused.
  await mkdir(args.workspace, { mode: 0o700 })
  const input = JSON.parse(await privateRead(args.selection))
  const sources = new Map(), observations = {}, identities = new Map(), entries = new Map()
  try {
    for (const [alias, path] of Object.entries(args.roots)) sources.set(alias, await bindSourceRoot(path))
    if (!Array.isArray(input.captureRoots) || input.captureRoots.length !== sources.size || input.captureRoots.some(alias => !sources.has(alias))) fail('invalid_roots')
    if (!Array.isArray(input.entries)) fail('invalid_selection')
    for (const entry of input.entries) {
      if (['shell', 'excluded', 'unresolved'].includes(entry?.graphClass)) continue
      if (!entry?.locator || protectedPath(entry.path) || protectedRelative(entry.locator.relative) || !sources.has(entry.locator.root)) fail('invalid_locator')
      const inspected = await inspectSource(sources.get(entry.locator.root), entry.locator.relative)
      observations[entry.path] = inspected.observation
      if (inspected.identity) identities.set(entry.path, inspected.identity)
      entries.set(entry.path, entry)
    }
    const translated = await translateSelection(input, null, observations)
    if (!translated.ledger || !Array.isArray(translated.units)) fail('invalid_selection')
    const limits = input.limits
    // manage-config.ts validates these positive safe integers and caps depth at 64;
    // its validator is private, so reject unsupported input rather than clamp it.
    if (!limits || ![limits.maxCommandBytes, limits.maxUploadBytes, limits.maxInventoryBytes, limits.maxJsonDepth].every(value => Number.isSafeInteger(value) && value > 0) || limits.maxJsonDepth > 64) fail('unsupported_limits')
    const transport = { maxCommandBytes: limits.maxCommandBytes, commandReadTimeoutMs: 100, maxUploadBytes: limits.maxUploadBytes, maxJsonDepth: limits.maxJsonDepth }
    const keys = await webcrypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify'])
    const state = { version: 1, privateKey: await webcrypto.subtle.exportKey('jwk', keys.privateKey), publicKey: { ...await webcrypto.subtle.exportKey('jwk', keys.publicKey), kid: 'fixture', alg: 'RS256', use: 'sig' }, keyring: [{ kid: 'fixture', key: randomBytes(32).toString('base64url') }], receiptKey: randomBytes(32).toString('base64url'), transport, ledger: translated.ledger, compatibility: translated.compatibility, accounting: translated.accounting, units: [], approvals: [] }
    const { mf, runtime: runtimeInfo } = await runtime(args.workspace, state, [])
    try {
      const db = await mf.getD1Database('DB', 'manage')
      for (const migration of await readD1Migrations(join(root, 'migrations'))) for (const sql of migration.queries) await db.prepare(sql).run()
      await db.batch([db.prepare("INSERT INTO instance_meta (singleton, instance_id, contract_version, created_at) VALUES (1, 'test-forge', 1, 1)"), db.prepare("INSERT INTO principals (principal_id, issuer, subject, created_at) VALUES ('pr_aaaaaaaaaaaaaaaaaaaaaaaaaa', ?, 'fixture-admin', 1)").bind(issuer), db.prepare("INSERT INTO role_grants (role_grant_id, principal_id, role, scope_kind, origin, granted_at) VALUES ('rg_aaaaaaaaaaaaaaaaaaaaaaaaaa', 'pr_aaaaaaaaaaaaaaaaaaaaaaaaaa', 'admin', 'installation', 'bootstrap', 1)")])
      const bucket = await mf.getR2Bucket('FORGE_IMPORT_SOURCE', 'manage'), pins = {}, pinHashes = {}
      for (const unit of translated.units) {
        if (unit.status !== 'representable') { state.units.push(unit); continue }
        try { checkEnvelope(unit.selection, null, transport) } catch (error) {
          if (error.message !== 'budget_exceeded') throw error
          state.units.push({ ...unit, status: 'blocked', pinState: 'blocked' })
          state.compatibility.unsupported.push({ code: 'budget_exceeded' })
          continue
        }
        for (const file of unit.inventory.files) {
          if (Object.hasOwn(pins, file.sourceRef) && pinHashes[file.sourceRef] !== file.sha256) fail('invalid_selection')
          if (!Object.hasOwn(pins, file.sourceRef)) {
            const entry = entries.get(file.path), observed = observations[file.path]
            if (!entry || observed?.state !== 'present') fail('missing_source')
            const bytes = await readPinnedSource(sources.get(entry.locator.root), entry.locator.relative, observed, identities.get(file.path), Math.min(transport.maxUploadBytes, 32 * 1024 * 1024))
            const object = await bucket.put(file.sourceRef, bytes)
            pins[file.sourceRef] = { version: object.version }
            pinHashes[file.sourceRef] = file.sha256
          }
        }
        const assigned = assignSourcePins(unit, pins)
        if (!assigned.ok) fail(assigned.code)
        const object = await bucket.put(`inventory/${unit.inventory.inventoryId}.json`, assigned.bytes)
        const sealed = sealInventory(assigned.unit, { key: object.key, version: object.version }, sha(assigned.bytes))
        if (!sealed.ok) fail(sealed.code)
        state.units.push(sealed.unit); state.approvals.push(sealed.approval)
      }
    } finally { await mf.dispose() }
    await privateWrite(join(args.workspace, 'state.json'), state)
    return { command: 'prepare', runtime: runtimeInfo, units: state.units.length, pinned: state.approvals.length, compatibility: compatibilityCounts(state.compatibility), receipt: keyed(state.receiptKey, { units: state.units, compatibility: state.compatibility }) }
  } finally { await Promise.all([...sources.values()].map(source => source.close())) }
}
async function plan(args) {
  const info = await stat(args.workspace)
  if (!info.isDirectory() || (info.mode & 0o077) !== 0) fail('private_workspace_required')
  const state = JSON.parse(await privateRead(join(args.workspace, 'state.json')))
  if (state.version !== 1 || !Array.isArray(state.units) || !Array.isArray(state.approvals)) fail('invalid_workspace')
  const { mf, runtime: runtimeInfo } = await runtime(args.workspace, state, state.approvals)
  try {
    const before = await snapshot(mf), results = []
    const token = await assertion(state), shim = await mf.getWorker('shim')
    for (const unit of state.units) {
      if (unit.pinState !== 'pinned') { results.push({ state: 'translation_blocked' }); continue }
      let cursor = null, steps = 0, result
      const seen = new Set()
      do {
        const envelope = checkEnvelope(unit.selection, cursor, state.transport)
        const response = await shim.fetch('https://manage.example.test/api/maintenance/import', { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/json', 'cf-access-jwt-assertion': token }, body: JSON.stringify(envelope) })
        const body = await response.json()
        steps++
        if (response.status !== 200 || !body.ok || !body.result) { result = { state: 'request_blocked', status: response.status, code: typeof body.error?.code === 'string' && /^[a-z_]+$/.test(body.error.code) ? body.error.code : 'unknown', digest: keyed(state.receiptKey, body) }; break }
        result = body.result
        if (result.state !== 'checking') break
        cursor = result.nextCursor
        if (typeof cursor !== 'string' || seen.has(cursor)) fail('invalid_continuation')
        seen.add(cursor)
      } while (true)
      if (!['ready', 'blocked', 'request_blocked'].includes(result.state)) fail('invalid_result')
      results.push({ state: result.state, steps, codes: result.state === 'request_blocked' ? [result.code] : (result.issues ?? []).map(issue => issue.code).filter(code => typeof code === 'string' && /^[a-z_]+$/.test(code)), digest: keyed(state.receiptKey, result) })
    }
    const after = await snapshot(mf)
    const beforeDigest = keyed(state.receiptKey, before), afterDigest = keyed(state.receiptKey, after)
    const receipt = { command: 'plan', runtime: runtimeInfo, results, compatibility: compatibilityCounts(state.compatibility), stores: { before: beforeDigest, after: afterDigest, equal: beforeDigest === afterDigest } }
    if (!receipt.stores.equal) fail('store_mutation')
    return receipt
  } finally { await mf.dispose() }
}
process.umask(0o077)
try {
  const args = argumentsOf(process.argv.slice(2))
  console.log(JSON.stringify(await (args.command === 'prepare' ? prepare(args) : plan(args))))
} catch (error) {
  const safe = new Set(['invalid_arguments', 'private_file_required', 'private_workspace_required', 'invalid_roots', 'invalid_selection', 'invalid_locator', 'unsupported_limits', 'source_changed', 'budget_exceeded', 'bundle_error', 'invalid_pagination', 'missing_source', 'invalid_workspace', 'invalid_continuation', 'invalid_result', 'store_mutation', 'inventory_budget_exceeded', 'native_version_required', 'invalid_inventory_pin', 'unit_not_representable', 'invalid_pins'])
  console.error(JSON.stringify({ error: safe.has(error?.message) ? error.message : 'offline_operation_failed' }))
  process.exitCode = 1
}
