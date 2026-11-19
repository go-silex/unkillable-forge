#!/usr/bin/env node
// Isolated local preparation and authenticated, read-only planning. No provider transport.
import { createHash, createHmac, randomBytes, webcrypto } from 'node:crypto'
import { mkdir, readFile, realpath } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import { Miniflare, convertV4MiniflareOptions } from 'miniflare'
import { readD1Migrations } from '@cloudflare/vitest-plugin'
import { bindPrivateRoot, bindSourceRoot } from '../plugins/unkillable-forge/dist/filesystem.js'
import { authorizeSources, inspectSources, pinUnits, sourceAccess, createAssertionSigner } from './forge-import-physical.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
let preflightSelection, projectTranslation, assignSourcePins, sealInventory, stable, isProtectedCaptureRelative
async function loadTranslator() {
  const result = await build({ entryPoints: [join(root, 'scripts/forge-import-selected.mjs')], bundle: true, write: false, format: 'esm', platform: 'neutral', target: 'es2022', logLevel: 'silent' })
  if (result.outputFiles.length !== 1) fail('bundle_error')
  const module = await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].contents).toString('base64')}`)
  ;({ preflightSelection, projectTranslation, assignSourcePins, sealInventory, stable, isProtectedCaptureRelative } = module)
}
const issuer = 'https://team.cloudflareaccess.com'
const certs = `${issuer}/cdn-cgi/access/certs`
const fixtureInstance = { instanceId: 'test-forge', accessTeamDomain: 'team.cloudflareaccess.com', readAudiences: ['reader'], manageAudiences: ['manager'], login: 'serve-shell' }
const publication = { sessionTtlMs: 60000, maxUploadTimeoutMs: 5000, retainMs: 900000, marginMs: 5000, manageClockSkewMs: 0, readClockSkewMs: 0 }
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const keyed = (key, value) => createHmac('sha256', Buffer.from(key, 'base64url')).update(stable(value)).digest('hex')
const fail = code => { throw new Error(code) }

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
async function privateRead(directory, name) {
  const file = await directory.open(name, 'read')
  try { return await file.readFile('utf8') } finally { await file.close() }
}
async function readSelection(path) {
  const parent = await bindPrivateRoot(dirname(path), false)
  try { return await privateRead(parent, basename(path)) } finally { await parent.close() }
}
function compatibilityCounts(compatibility) {
  const result = {}
  for (const [group, entries] of Object.entries(compatibility)) {
    result[group] = {}
    for (const entry of entries) result[group][entry.code] = (result[group][entry.code] ?? 0) + 1
  }
  return result
}
function warningCounts(warnings) {
  const counts = {}
  for (const warning of Array.isArray(warnings) ? warnings : []) {
    const code = warning?.code === 'unknown_visibility_private' ? warning.code : 'unknown_warning'
    counts[code] = (counts[code] ?? 0) + 1
  }
  return counts
}
function accountingCounts(accounting) {
  const counts = {}
  for (const row of accounting) counts[row.disposition] = (counts[row.disposition] ?? 0) + 1
  return counts
}
function censusReceipt(state) {
  const counts = {}
  for (const row of state.census) {
    counts[row.kind] ??= {}
    counts[row.kind][row.disposition] = (counts[row.kind][row.disposition] ?? 0) + 1
  }
  return { counts, digest: keyed(state.receiptKey, state.census) }
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
async function workerBundle() {
  const result = await build({ entryPoints: [join(root, 'adapters/http/manageWorker.ts')], bundle: true, write: false, format: 'esm', platform: 'browser', target: 'es2022', logLevel: 'silent' })
  if (result.outputFiles.length !== 1) fail('bundle_error')
  return result.outputFiles[0].text
}
async function runtime(workspace, state, approvals) {
  const script = await workerBundle()
  const jwksScript = `export default { fetch(r) { if (r.method === 'GET' && r.url === ${JSON.stringify(certs)}) return Response.json({keys:[${JSON.stringify(state.publicKey)}]}); return new Response('denied',{status:403}) } }`
  const endpoint = `https://${state.manageHost}/api/maintenance/import`
  const shim = `export default { async fetch(r,e) {
    const u = new URL(r.url)
    if (r.method !== 'POST' || u.href !== ${JSON.stringify(endpoint)}) return new Response('denied',{status:403})
    let body
    try { body = await r.json() } catch { return new Response('denied',{status:403}) }
    if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length !== 3 || body.op !== 'dry_run' || !Object.hasOwn(body,'selection') || !Object.hasOwn(body,'cursor')) return new Response('denied',{status:403})
    const headers = new Headers({host:${JSON.stringify(state.manageHost)},'content-type':'application/json','cf-access-jwt-assertion':r.headers.get('cf-access-jwt-assertion') ?? ''})
    return e.MANAGE.fetch(new Request(${JSON.stringify(endpoint)},{method:'POST',headers,body:JSON.stringify({op:'dry_run',selection:body.selection,cursor:body.cursor}),redirect:'manual'}))
  } }`
  const deny = `export default { fetch() { return new Response('denied',{status:403}) } }`
  const bindings = { FORGE_INSTANCE: JSON.stringify({ ...fixtureInstance, ...state.reader, manageHost: state.manageHost }), FORGE_SHARE_VERIFIER_KEYS: JSON.stringify(state.keyring), FORGE_PUBLICATION_OPTIONS: JSON.stringify(publication), FORGE_MANAGE_TRANSPORT: JSON.stringify(state.transport) }
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
export async function prepare(args, access = sourceAccess) {
  // mkdir is exclusive: existing workspaces, even empty ones, are never reused.
  await mkdir(args.workspace, { mode: 0o700 })
  const workspace = await bindPrivateRoot(args.workspace, false)
  const sources = new Map(), rootPaths = new Map()
  try {
    await loadTranslator()
    const input = JSON.parse(await readSelection(args.selection))
    const preflight = await preflightSelection(input)
    if (preflight.kind === 'fatal') {
      const result = preflight.result
      const state = { version: 1, preparation: 'fatal', fatal: result.fatal, receiptKey: randomBytes(32).toString('base64url'), accounting: result.accounting, census: result.census, compatibility: result.compatibility, warnings: result.warnings }
      await workspace.replace('state.json', Buffer.from(JSON.stringify(state)))
      process.exitCode = 1
      return { command: 'prepare', fatal: state.fatal, accounting: accountingCounts(state.accounting), census: censusReceipt(state), compatibility: compatibilityCounts(state.compatibility), warnings: warningCounts(state.warnings), units: 0, pinned: 0 }
    }
    if (preflight.kind !== 'prepared') fail('invalid_selection')
    for (const [alias, path] of Object.entries(args.roots)) {
      rootPaths.set(alias, await realpath(path))
      sources.set(alias, await bindSourceRoot(path))
    }
    if (preflight.captureRoots.length !== sources.size || preflight.captureRoots.some(alias => !sources.has(alias))) fail('invalid_roots')
    const authorization = await authorizeSources({ reads: preflight.reads, protectedLocators: preflight.protectedLocators, inventoryKeys: preflight.inventoryKeys, sources, rootPaths, isProtectedCaptureRelative }, access)
    const { observations, identities } = await inspectSources(preflight.reads, authorization, sources, access)
    const translated = await preflight.finish(observations)
    if (!translated.ledger || !Array.isArray(translated.units) || !Array.isArray(translated.census)) fail('invalid_selection')
    const limits = preflight.limits
    // manage-config.ts validates these positive safe integers and caps depth at 64;
    // its validator is private, so reject unsupported input rather than clamp it.
    if (!limits || ![limits.maxCommandBytes, limits.maxUploadBytes, limits.maxInventoryBytes, limits.maxJsonDepth].every(value => Number.isSafeInteger(value) && value > 0) || limits.maxJsonDepth > 64) fail('unsupported_limits')
    const transport = { maxCommandBytes: limits.maxCommandBytes, commandReadTimeoutMs: 100, maxUploadBytes: limits.maxUploadBytes, maxJsonDepth: limits.maxJsonDepth }
    const keys = await webcrypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify'])
    let manageHost
    do { manageHost = `manage-${randomBytes(12).toString('hex')}.example.test` } while (manageHost === preflight.reader.canonicalHost || preflight.reader.aliasHosts?.includes(manageHost))
    const state = { version: 1, fatal: translated.fatal, reader: preflight.reader, manageHost, privateKey: await webcrypto.subtle.exportKey('jwk', keys.privateKey), publicKey: { ...await webcrypto.subtle.exportKey('jwk', keys.publicKey), kid: 'fixture', alg: 'RS256', use: 'sig' }, keyring: [{ kid: 'fixture', key: randomBytes(32).toString('base64url') }], receiptKey: randomBytes(32).toString('base64url'), transport, ledger: translated.ledger, units: [], approvals: [] }
    const { mf, runtime: runtimeInfo } = await runtime(args.workspace, state, [])
    try {
      const db = await mf.getD1Database('DB', 'manage')
      for (const migration of await readD1Migrations(join(root, 'migrations'))) for (const sql of migration.queries) await db.prepare(sql).run()
      await db.batch([db.prepare("INSERT INTO instance_meta (singleton, instance_id, contract_version, created_at) VALUES (1, 'test-forge', 1, 1)"), db.prepare("INSERT INTO principals (principal_id, issuer, subject, created_at) VALUES ('pr_aaaaaaaaaaaaaaaaaaaaaaaaaa', ?, 'fixture-admin', 1)").bind(issuer), db.prepare("INSERT INTO role_grants (role_grant_id, principal_id, role, scope_kind, origin, granted_at) VALUES ('rg_aaaaaaaaaaaaaaaaaaaaaaaaaa', 'pr_aaaaaaaaaaaaaaaaaaaaaaaaaa', 'admin', 'installation', 'bootstrap', 1)")])
      const bucket = await mf.getR2Bucket('FORGE_IMPORT_SOURCE', 'manage')
      if (translated.fatal && translated.units.some(unit => unit.status === 'representable')) fail('invalid_selection')
      const pinned = translated.fatal
        ? { units: translated.units, approvals: [], pinFailures: [] }
        : await pinUnits({ units: translated.units, reads: preflight.reads, observations, identities, sources, bucket, transport, assignSourcePins, sealInventory, validateUnit: unit => checkEnvelope(unit.selection, null, transport) }, access)
      const projected = projectTranslation(translated, pinned.pinFailures)
      const byUnit = new Map(pinned.units.map(unit => [unit.unitId, unit]))
      state.units = projected.units.map(unit => unit.status === 'representable' ? byUnit.get(unit.unitId) : unit)
      state.approvals = state.units.filter(unit => unit.pinState === 'pinned').map(unit => unit.approval)
      state.ledger = projected.ledger
      state.compatibility = projected.compatibility
      state.accounting = projected.accounting
      state.census = projected.census
      state.warnings = projected.warnings
      state.facts = projected.facts
    } finally { await mf.dispose() }
    await workspace.replace('state.json', Buffer.from(JSON.stringify(state)))
    if (state.fatal) process.exitCode = 1
    return { command: 'prepare', fatal: state.fatal, accounting: accountingCounts(state.accounting), census: censusReceipt(state), runtime: runtimeInfo, units: state.units.length, pinned: state.approvals.length, compatibility: compatibilityCounts(state.compatibility), warnings: warningCounts(state.warnings), receipt: keyed(state.receiptKey, { units: state.units, compatibility: state.compatibility }) }
  } finally { await Promise.all([...sources.values()].map(source => source.close())); await workspace.close() }
}
async function plan(args) {
  const workspace = await bindPrivateRoot(args.workspace, false)
  let mf, beforeDigest, runtimeInfo
  const results = []
  try {
    const state = JSON.parse(await privateRead(workspace, 'state.json'))
    if (state.version === 1 && state.preparation === 'fatal' && typeof state.fatal === 'string' && Array.isArray(state.census)) {
      process.exitCode = 1
      return { command: 'plan', fatal: state.fatal, accounting: accountingCounts(state.accounting), census: censusReceipt(state), compatibility: compatibilityCounts(state.compatibility), results: [], stores: { status: 'not_prepared', equal: null } }
    }
    if (state.version !== 1 || !Array.isArray(state.units) || !Array.isArray(state.approvals) || !Array.isArray(state.census) || !(state.fatal === null || typeof state.fatal === 'string') || (state.fatal && (state.approvals.length || state.units.some(unit => unit.pinState === 'pinned')))) fail('invalid_workspace')
    const batches = [[]]
    let pinned = 0
    for (const unit of state.units) {
      if (unit.pinState === 'pinned' && pinned === 1000) { batches.push([]); pinned = 0 }
      batches.at(-1).push(unit)
      if (unit.pinState === 'pinned') pinned++
    }
    const signAssertion = await createAssertionSigner({ privateKey: state.privateKey, kid: state.publicKey.kid })
    let failure = null
    try {
      for (const batch of batches) {
        const approvals = batch.filter(unit => unit.pinState === 'pinned').map(unit => unit.approval)
        const started = await runtime(args.workspace, state, approvals)
        mf = started.mf; runtimeInfo = started.runtime
        if (beforeDigest === undefined) beforeDigest = keyed(state.receiptKey, await snapshot(mf))
        const shim = await mf.getWorker('shim')
        for (const unit of batch) {
          if (unit.pinState !== 'pinned') { results.push({ state: 'translation_blocked', warnings: {} }); continue }
          const token = await signAssertion()
          let cursor = null, steps = 0, result
          const seen = new Set()
          do {
            const envelope = checkEnvelope(unit.selection, cursor, state.transport)
            const response = await shim.fetch(`https://${state.manageHost}/api/maintenance/import`, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/json', 'cf-access-jwt-assertion': token }, body: JSON.stringify(envelope) })
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
          results.push({ state: result.state, steps, codes: result.state === 'request_blocked' ? [result.code] : (result.issues ?? []).map(issue => issue.code).filter(code => typeof code === 'string' && /^[a-z_]+$/.test(code)), warnings: warningCounts(result.warnings), digest: keyed(state.receiptKey, result) })
        }
        if (batch !== batches.at(-1)) { await mf.dispose(); mf = undefined }
      }
    } catch (error) { failure = error }
    let stores = { equal: null, status: 'unknown' }
    if (mf && beforeDigest !== undefined) {
      try {
        const afterDigest = keyed(state.receiptKey, await snapshot(mf))
        stores = { before: beforeDigest, after: afterDigest, equal: beforeDigest === afterDigest, status: 'observed' }
      } catch (error) { failure ??= error }
    }
    if (stores.equal === false) failure ??= new Error('store_mutation')
    if (failure || state.fatal) process.exitCode = 1
    const knownErrors = ['budget_exceeded', 'invalid_continuation', 'invalid_result', 'store_mutation', 'invalid_pagination']
    return { command: 'plan', fatal: state.fatal, error: failure ? (knownErrors.includes(failure.message) ? failure.message : 'planning_failed') : null, runtime: runtimeInfo ?? null, results, accounting: accountingCounts(state.accounting), census: censusReceipt(state), compatibility: compatibilityCounts(state.compatibility), stores }
  } finally {
    try { if (mf) await mf.dispose() } finally { await workspace.close() }
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.umask(0o077)
  try {
    const args = argumentsOf(process.argv.slice(2))
    if (args.command === 'plan') await loadTranslator()
    console.log(JSON.stringify(await (args.command === 'prepare' ? prepare(args) : plan(args))))
  } catch (error) {
    const safe = new Set(['invalid_arguments', 'private_file_required', 'private_workspace_required', 'invalid_roots', 'invalid_selection', 'invalid_locator', 'protected_locator', 'unsupported_limits', 'source_changed', 'budget_exceeded', 'bundle_error', 'invalid_pagination', 'missing_source', 'invalid_workspace', 'invalid_continuation', 'invalid_result', 'store_mutation', 'inventory_budget_exceeded', 'native_version_required', 'invalid_inventory_pin', 'unit_not_representable', 'invalid_pins'])
    console.error(JSON.stringify({ error: safe.has(error?.message) ? error.message : 'offline_operation_failed', ...(process.argv[2] === 'plan' ? { stores: { status: 'unknown', equal: null } } : {}) }))
    process.exitCode = 1
  }
}
