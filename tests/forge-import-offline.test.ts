import { describe, expect, it } from 'vitest'
import { spawn } from 'node:child_process'
import { createHmac, webcrypto } from 'node:crypto'
import { link, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { z } from 'zod'
import { makeSelectedFixture, type SyntheticInput } from './engine/fixtures/import-selected.mjs'
import { preflightSelection, stable, type Observation } from '../scripts/forge-import-selected.mjs'
import { createAssertionSigner } from '../scripts/forge-import-physical.mjs'

const cli = fileURLToPath(new URL('../scripts/forge-import-offline.mjs', import.meta.url))
const physicalRunner = fileURLToPath(new URL('./engine/fixtures/offline-physical-runner.mjs', import.meta.url))
const secretMarkers = ['syntheticTreeKey', 'syntheticSlugKey', 'PRIVATE KEY', 'privateKey', 'receiptKey', 'keyring']
type Fixture = { input: SyntheticInput; observations: Record<string, Observation>; files: Record<string, Uint8Array> }
type Run = { code: number | null; signal: NodeJS.Signals | null; timedOut: boolean; stdout: string; stderr: string }

async function run(executable: string, args: string[], home: string, timeout = 180_000): Promise<Run> {
  const child = spawn(executable, args, {
    cwd: home,
    env: { HOME: home, XDG_CONFIG_HOME: join(home, 'config'), XDG_CACHE_HOME: join(home, 'cache'), XDG_DATA_HOME: join(home, 'data'), TMPDIR: join(home, 'tmp'), PATH: '/usr/bin:/bin', LANG: 'C', NO_COLOR: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let stdout = '', stderr = '', timedOut = false
  child.stdout.setEncoding('utf8'); child.stdout.on('data', chunk => { stdout += chunk })
  child.stderr.setEncoding('utf8'); child.stderr.on('data', chunk => { stderr += chunk })
  // A real deadline detects a subprocess blocked opening a FIFO.
  const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL') }, timeout)
  try {
    const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
      child.once('error', reject)
      child.once('close', (code, signal) => resolve({ code, signal }))
    })
    return { ...result, timedOut, stdout, stderr }
  } finally { clearTimeout(timer) }
}

async function sandbox() {
  const root = await mkdtemp(join(tmpdir(), 'forge-offline-test-'))
  const home = join(root, 'home'), capture = join(root, 'capture'), selection = join(root, 'selection.json'), workspace = join(root, 'workspace')
  for (const dir of [home, capture, join(home, 'tmp')]) await mkdir(dir, { mode: 0o700 })
  async function save(fixture: Fixture) {
    for (const [path, bytes] of Object.entries(fixture.files)) {
      const destination = join(capture, path.slice(1))
      await mkdir(dirname(destination), { recursive: true, mode: 0o700 })
      await writeFile(destination, bytes, { mode: 0o600 })
    }
    await writeFile(selection, JSON.stringify(fixture.input), { mode: 0o600 })
  }
  const invoke = (...args: string[]) => run(process.execPath, [cli, ...args], home)
  const prepare = (...roots: string[]) => invoke('prepare', '--selection', selection, '--workspace', workspace, '--capture-root', `capture=${capture}`, ...roots)
  const plan = () => invoke('plan', '--workspace', workspace)
  return { root, home, capture, selection, workspace, save, prepare, plan, invoke, cleanup: () => rm(root, { recursive: true, force: true }) }
}

const receiptSchema = z.object({
  fatal: z.string().nullable().optional(), error: z.string().nullable().optional(),
  pinned: z.number().optional(), units: z.number().optional(),
  census: z.object({ counts: z.record(z.string(), z.record(z.string(), z.number())), digest: z.string().optional() }).optional(),
  compatibility: z.object({ unsupported: z.record(z.string(), z.number()), represented: z.record(z.string(), z.number()).optional() }).optional(),
  warnings: z.record(z.string(), z.number()).optional(),
  results: z.array(z.object({ state: z.string(), status: z.number().optional(), codes: z.array(z.string()).optional(), warnings: z.record(z.string(), z.number()).optional() })).optional(),
  stores: z.object({ status: z.string(), equal: z.boolean().nullable() }).optional(),
  metadataPaths: z.array(z.string()).optional(), bodyReads: z.array(z.string()).optional(), bodyBytes: z.record(z.string(), z.number()).optional(), removed: z.boolean().optional(), grown: z.boolean().optional(),
})
function receipt(result: Run, code = 0) {
  expect(result.timedOut).toBe(false)
  expect(result.code).toBe(code)
  expect(result.signal).toBeNull()
  // Assertions never print captured output, which might itself expose a secret.
  expect(secretMarkers.some(marker => (result.stdout + result.stderr).includes(marker))).toBe(false)
  let value: unknown
  try { value = JSON.parse(code === 0 || result.stdout.trim() ? result.stdout : result.stderr) } catch { throw new Error('CLI did not return a JSON receipt') }
  return receiptSchema.parse(value)
}

const checkpointSchema = z.object({
  units: z.array(z.object({
    unitId: z.string(), pinState: z.string(),
    blockers: z.array(z.object({ code: z.string(), unitId: z.string().optional(), entryOrdinal: z.number().optional(), path: z.string().optional(), sourcePageId: z.string().nullable().optional(), stage: z.string().optional(), reason: z.string().optional(), basis: z.string().optional() })),
    inventory: z.object({ files: z.array(z.object({ path: z.string(), sourceRef: z.string(), sourceVersion: z.string().nullable() })) }).nullable(),
  })),
  facts: z.array(z.object({ kind: z.string(), ordinal: z.number().optional(), unitId: z.string().nullable().optional(), path: z.string().optional(), locator: z.object({ root: z.string().nullable(), relative: z.string().nullable() }).optional() })).optional(),
  approvals: z.array(z.object({ inventoryId: z.string(), objectKey: z.string(), objectVersion: z.string() })),
})
async function checkpoint(workspace: string) {
  const value: unknown = JSON.parse(await readFile(join(workspace, 'state.json'), 'utf8'))
  return checkpointSchema.parse(value)
}

function excluded(input: SyntheticInput) {
  input.entries.push({ path: '/asset-owners.json', graphClass: 'excluded', contentType: null, locator: { root: 'capture', relative: 'asset-owners.json' }, provenance: 'synthetic-metadata', expected: null, placement: null })
  input.exclusions.push({ path: '/asset-owners.json', evidenceRef: 'synthetic-evidence', reason: 'engine' })
}

function allExcluded(input: SyntheticInput) {
  input.entries = []; input.pages = []; input.owners = []; input.aliases = []; input.shortlinks = []; input.previews = []
  excluded(input)
}

describe('offline selected import CLI', () => {
  it('signs and replays the persisted JSON-safe census for a raw nonfinite placement identity', async () => {
    const box = await sandbox()
    try {
      const fixture = await makeSelectedFixture()
      const ordinal = fixture.input.entries.findIndex(entry => entry.path === '/tree/asset0.css')
      expect(ordinal).toBeGreaterThanOrEqual(0)
      const placement = fixture.input.entries[ordinal].placement
      if (!placement) throw new Error('expected synthetic placement')
      const marker = 'synthetic-invalid-placement-token'
      placement.sourceArtifactId = marker
      fixture.input.exclusions.push({ path: '/tree/asset1.css', evidenceRef: 'synthetic-exclusion', reason: 'non_content' })
      fixture.input.consumerUrls.push({ url: 'https://forge.example.test/missing.html', purpose: 'document', targetSourcePageId: 'missing.html', mappingRef: null })
      await box.save(fixture)
      const original = await readFile(box.selection, 'utf8')
      expect(original.split(JSON.stringify(marker))).toHaveLength(2)
      const raw = original.replace(JSON.stringify(marker), '1e400')
      expect(raw.includes('\"sourceArtifactId\":1e400')).toBe(true)
      await writeFile(box.selection, Buffer.from(raw, 'utf8'), { mode: 0o600 })
      await rm(box.capture, { recursive: true })
      const prepared = receipt(await box.prepare(), 1)
      expect(prepared.error).toBeUndefined()
      expect(prepared.fatal).toBe('contradictory_input')
      expect(prepared.units).toBe(0); expect(prepared.pinned).toBe(0)
      expect(prepared.compatibility!.unsupported.contradictory_entry).toBe(1)
      expect(prepared.census!.counts.entry.rejected).toBe(fixture.input.entries.length)
      const before = await readFile(join(box.workspace, 'state.json'))
      const state = z.object({
        preparation: z.literal('fatal'), fatal: z.literal('contradictory_input'), receiptKey: z.string(),
        approvals: z.array(z.unknown()).optional(),
        census: z.array(z.object({ kind: z.string(), ordinal: z.number(), unitId: z.string().nullable(), affectedUnitIds: z.array(z.string()), disposition: z.string() }).passthrough()),
      }).parse(JSON.parse(before.toString('utf8')))
      expect(state.approvals ?? []).toHaveLength(0)
      const row = state.census.find(item => item.kind === 'entry' && item.ordinal === ordinal)
      expect(row).toMatchObject({ unitId: null, affectedUnitIds: [], disposition: 'rejected' })
      const exclusion = state.census.find(item => item.kind === 'exclusion' && item.ordinal === 0)
      expect(exclusion).toMatchObject({ unitId: 'tree:synthetic', affectedUnitIds: ['tree:synthetic'], disposition: 'rejected' })
      const expectedDigest = createHmac('sha256', Buffer.from(state.receiptKey, 'base64url')).update(stable(state.census)).digest('hex')
      expect(prepared.census!.digest === expectedDigest).toBe(true)
      const planned = receipt(await box.plan(), 1)
      expect(planned.error).toBeUndefined(); expect(planned.fatal).toBe('contradictory_input')
      expect(planned.results).toEqual([]); expect(planned.census).toEqual(prepared.census)
      expect(planned.stores).toMatchObject({ status: 'not_prepared', equal: null })
      expect((await readFile(join(box.workspace, 'state.json'))).equals(before)).toBe(true)
      await expect(stat(join(box.workspace, 'persist'))).rejects.toMatchObject({ code: 'ENOENT' })
      const observed = receipt(await run(process.execPath, [physicalRunner, 'observe', box.selection, join(box.root, 'observed-workspace'), box.capture], box.home), 1)
      expect(observed.fatal).toBe('contradictory_input')
      expect(observed.metadataPaths).toEqual([]); expect(observed.bodyReads).toEqual([])
    } finally { await box.cleanup() }
  }, 600_000)

  it('checkpoints and replays a specific fatal receipt for a provider declaration missing its path', async () => {
    const box = await sandbox()
    try {
      const fixture = await makeSelectedFixture()
      await box.save(fixture)
      const provider = { artifactId: `ar_${'a'.repeat(26)}`, kind: 'asset' }
      await writeFile(box.selection, JSON.stringify({ ...fixture.input, providerMounts: [provider] }), { mode: 0o600 })
      const prepared = receipt(await box.prepare(), 1)
      expect(prepared.error).toBeUndefined()
      expect(prepared.fatal).toBe('unassignable_record')
      expect(prepared.pinned).toBe(0); expect(prepared.units).toBe(0)
      expect(prepared.compatibility!.unsupported.unassignable_record).toBe(1)
      expect(prepared.census!.counts.providerMount.rejected).toBe(1)
      expect(prepared.census!.digest).toMatch(/^[a-f0-9]{64}$/)
      const before = await readFile(join(box.workspace, 'state.json'))
      const fatalCheckpoint = z.object({
        preparation: z.literal('fatal'), fatal: z.literal('unassignable_record'),
        census: z.array(z.object({ kind: z.string(), ordinal: z.number(), unitId: z.string().nullable(), affectedUnitIds: z.array(z.string()), disposition: z.string(), path: z.string().nullable().optional(), providerKind: z.string().nullable().optional(), reason: z.string().optional() })),
      }).parse(JSON.parse(before.toString('utf8')))
      const providerRow = fatalCheckpoint.census.find(row => row.kind === 'providerMount')
      expect(providerRow).toMatchObject({ ordinal: 0, unitId: null, affectedUnitIds: [], disposition: 'rejected', path: null, providerKind: 'asset', reason: 'invalid_provider_mount' })
      const planned = receipt(await box.plan(), 1)
      expect(planned.error).toBeUndefined()
      expect(planned.fatal).toBe('unassignable_record')
      expect(planned.results).toEqual([])
      expect(planned.census).toEqual(prepared.census)
      expect(planned.stores).toMatchObject({ status: 'not_prepared', equal: null })
      expect((await readFile(join(box.workspace, 'state.json'))).equals(before)).toBe(true)
      const observed = receipt(await run(process.execPath, [physicalRunner, 'observe', box.selection, join(box.root, 'observed-workspace'), box.capture], box.home), 1)
      expect(observed.fatal).toBe('unassignable_record')
      expect(observed.metadataPaths).toEqual([]); expect(observed.bodyReads).toEqual([])
    } finally { await box.cleanup() }
  }, 600_000)

  it('rejects malformed UTF-8 before source access despite an existing replacement-character file', async () => {
    const invalid = await sandbox(), valid = await sandbox()
    try {
      const fixture = await makeSelectedFixture()
      const relative = 'synthetic-\ufffd-document.html'
      fixture.input.entries.find(entry => entry.path === '/tree/one.html')!.locator.relative = relative
      fixture.files[`/${relative}`] = fixture.files['/tree/one.html']
      await invalid.save(fixture); await valid.save(fixture)
      expect((await readFile(join(invalid.capture, relative))).equals(Buffer.from(fixture.files['/tree/one.html']))).toBe(true)
      const original = await readFile(invalid.selection)
      const encoded = Buffer.from('\ufffd', 'utf8'), position = original.indexOf(encoded)
      expect(position).toBeGreaterThan(-1)
      const malformed = Buffer.concat([original.subarray(0, position), Buffer.from([0xff]), original.subarray(position + encoded.length)])
      await writeFile(invalid.selection, malformed, { mode: 0o600 })
      const failure = await invalid.prepare()
      expect((failure.stdout + failure.stderr).includes(relative)).toBe(false)
      expect(receipt(failure, 1).error).toBe('offline_operation_failed')
      const instrumented = receipt(await run(process.execPath, [physicalRunner, 'observe', invalid.selection, join(invalid.root, 'observed-workspace'), invalid.capture], invalid.home), 1)
      expect(instrumented.error).toBe('offline_operation_failed')
      const unavailable = await invalid.invoke('prepare', '--selection', invalid.selection, '--workspace', join(invalid.root, 'unavailable-workspace'), '--capture-root', `capture=${join(invalid.root, 'missing-capture')}`)
      expect(receipt(unavailable, 1).error).toBe('offline_operation_failed')
      expect(instrumented.metadataPaths).toEqual([]); expect(instrumented.bodyReads).toEqual([])
      const validPrepare = await valid.prepare()
      expect((validPrepare.stdout + validPrepare.stderr).includes(relative)).toBe(false)
      const prepared = receipt(validPrepare)
      expect(prepared.fatal).toBeNull(); expect(prepared.pinned).toBe(2)
      const planned = receipt(await valid.plan())
      expect(planned.results!.filter(result => result.state === 'ready')).toHaveLength(2)
      expect(planned.stores).toMatchObject({ status: 'observed', equal: true })
    } finally { await Promise.all([invalid.cleanup(), valid.cleanup()]) }
  }, 600_000)

  it('rejects malformed checkpoint UTF-8 before an isolated runtime can be prepared', async () => {
    const box = await sandbox()
    try {
      await mkdir(box.workspace, { mode: 0o700 })
      await writeFile(join(box.workspace, 'state.json'), Buffer.from([0x7b, 0x22, 0x78, 0x22, 0x3a, 0x22, 0xff, 0x22, 0x7d]), { mode: 0o600 })
      const output = receipt(await box.plan(), 1)
      expect(output.error).toBe('offline_operation_failed')
      expect(output.stores).toMatchObject({ status: 'unknown', equal: null })
      await expect(stat(join(box.workspace, 'persist'))).rejects.toMatchObject({ code: 'ENOENT' })
    } finally { await box.cleanup() }
  }, 240_000)

  it('retains the original locator privately beside the actual native pin and plans without capture or selector', async () => {
    const box = await sandbox()
    try {
      const fixture = await makeSelectedFixture()
      const path = '/tree/one.html', relative = 'private-synthetic-locator/preserved-source.html'
      const ordinal = fixture.input.entries.findIndex(entry => entry.path === path)
      expect(ordinal).toBeGreaterThanOrEqual(0)
      fixture.input.entries[ordinal].locator = { root: 'capture', relative }
      fixture.files[`/${relative}`] = fixture.files[path]
      await box.save(fixture)
      const preparation = await box.prepare()
      expect((preparation.stdout + preparation.stderr).includes(relative)).toBe(false)
      const prepared = receipt(preparation)
      expect(prepared.fatal).toBeNull(); expect(prepared.pinned).toBe(2)
      const state = await checkpoint(box.workspace)
      const fact = state.facts!.find(item => item.kind === 'entry' && item.ordinal === ordinal)
      expect(fact?.path === path && fact.unitId === 'tree:synthetic' && fact.locator?.root === 'capture' && fact.locator.relative === relative).toBe(true)
      const unit = state.units.find(item => item.unitId === fact?.unitId)
      const file = unit?.inventory?.files.find(item => item.path === fact?.path)
      expect(unit?.pinState).toBe('pinned')
      expect(typeof file?.sourceVersion === 'string' && file.sourceVersion.length > 0).toBe(true)
      expect(typeof file?.sourceRef === 'string' && /^capture\/v1\/[a-f0-9]{64}\/[0-9]+$/.test(file.sourceRef) && !file.sourceRef.includes(relative)).toBe(true)
      await rm(box.selection); await rm(box.capture, { recursive: true })
      const planning = await box.plan()
      expect((planning.stdout + planning.stderr).includes(relative)).toBe(false)
      const planned = receipt(planning)
      expect(planned.results!.filter(result => result.state === 'ready')).toHaveLength(2)
      expect(planned.stores).toMatchObject({ status: 'observed', equal: true })
    } finally { await box.cleanup() }
  }, 600_000)

  it('denies a protected inode reused through another root before any body read', async () => {
    for (const protectedName of ['.env.fixture', '.ENV.FiXtUrE', '.e\u200cnv.fixture']) {
      const box = await sandbox()
      try {
        const fixture = await makeSelectedFixture()
        const asset = fixture.input.entries.find(entry => entry.path === '/tree/asset0.css')!
        asset.locator = { root: 'capture', relative: protectedName }
        fixture.input.captureRoots.push('alternate')
        fixture.input.entries.push({ ...structuredClone(asset), path: '/a/sample/shared.css', locator: { root: 'alternate', relative: 'ordinary-hardlink.css' }, placement: { sourceArtifactId: 'slug:sample', evidenceRef: 'synthetic-placement' } })
        fixture.files[`/${protectedName}`] = fixture.files['/tree/asset0.css']
        await box.save(fixture)
        await link(join(box.capture, protectedName), join(box.capture, 'ordinary-hardlink.css'))
        const output = receipt(await run(process.execPath, [physicalRunner, 'alias-collision', box.selection, box.workspace, box.capture], box.home), 1)
        expect(output.error).toBe('protected_locator')
        expect(output.bodyReads).toEqual([])
      } finally { await box.cleanup() }
    }
  }, 720_000)

  it('protects reserved comparison spellings without a canonical exclusion row', async () => {
    for (const relative of ['.ENV.FiXtUrE', '.ＥＮＶ.fixture', '.e\u200cnv.FiXtUrE', 'nested/.g\u200cit/marker.css', 'nested/.sSh/marker.css', 'nested/.EnV/marker.css', 'nested/.e\u200cnv.prefix/marker.css']) {
      const box = await sandbox()
      try {
        const fixture = await makeSelectedFixture()
        const ordinal = fixture.input.entries.findIndex(entry => entry.path === '/tree/asset0.css')
        fixture.input.entries[ordinal].locator.relative = relative
        fixture.files[`/${relative}`] = fixture.files['/tree/asset0.css']
        const preflight = await preflightSelection(fixture.input)
        expect(preflight.kind).toBe('prepared')
        if (preflight.kind !== 'prepared') throw new Error('expected prepared selection')
        expect(preflight.reads.some(item => item.ordinal === ordinal)).toBe(false)
        expect(preflight.protectedLocators.some(item => item.ordinal === ordinal && item.locator.relative === relative)).toBe(true)
        await box.save(fixture)
        const output = receipt(await run(process.execPath, [physicalRunner, 'observe', box.selection, box.workspace, box.capture], box.home))
        expect(output.fatal).toBeNull(); expect(output.pinned).toBe(1)
        expect(output.metadataPaths!).toContain(relative)
        expect(output.bodyReads!).not.toContain(relative)
        const state = await checkpoint(box.workspace)
        const fact = state.facts!.find(item => item.kind === 'entry' && item.ordinal === ordinal)
        expect(fact?.locator).toEqual({ root: 'capture', relative })
        expect(fact?.path).toBe('/tree/asset0.css')
        const planned = receipt(await box.plan())
        expect(planned.results!.map(item => item.state).sort()).toEqual(['ready', 'translation_blocked'])
      } finally { await box.cleanup() }
    }
  }, 3_600_000)

  it('keeps a similarly named ordinary component eligible for actual source reads', async () => {
    const box = await sandbox()
    try {
      const fixture = await makeSelectedFixture()
      const relative = 'nested/.envx/ordinary.css'
      const ordinal = fixture.input.entries.findIndex(entry => entry.path === '/tree/asset0.css')
      fixture.input.entries[ordinal].locator.relative = relative
      fixture.files[`/${relative}`] = fixture.files['/tree/asset0.css']
      const preflight = await preflightSelection(fixture.input)
      expect(preflight.kind).toBe('prepared')
      if (preflight.kind !== 'prepared') throw new Error('expected prepared selection')
      expect(preflight.reads.some(item => item.ordinal === ordinal)).toBe(true)
      await box.save(fixture)
      const output = receipt(await run(process.execPath, [physicalRunner, 'observe', box.selection, box.workspace, box.capture], box.home))
      expect(output.fatal).toBeNull(); expect(output.pinned).toBe(2)
      expect(output.bodyReads!).toContain(relative)
      const planned = receipt(await box.plan())
      expect(planned.results!.filter(item => item.state === 'ready')).toHaveLength(2)
      expect(planned.stores).toMatchObject({ status: 'observed', equal: true })
    } finally { await box.cleanup() }
  }, 600_000)

  it('contains an overlong native component as unreadable without stranding an independent unit', async () => {
    for (const intermediate of [false, true]) {
      const box = await sandbox()
      try {
        const fixture = await makeSelectedFixture()
        const ordinal = fixture.input.entries.findIndex(entry => entry.path === '/tree/asset0.css')
        const huge = '界'.repeat(1500)
        expect(Buffer.byteLength(huge, 'utf8')).toBeGreaterThanOrEqual(4096)
        const relative = intermediate ? `tree/${huge}/member.css` : `tree/${huge}`
        fixture.input.entries[ordinal].locator.relative = relative
        // Only the JSON carries the impossible component; fixture setup never creates it.
        await box.save(fixture)
        const output = receipt(await run(process.execPath, [physicalRunner, 'observe', box.selection, box.workspace, box.capture], box.home))
        expect(output.error).toBeUndefined(); expect(output.fatal).toBeNull(); expect(output.pinned).toBe(1)
        expect(output.compatibility!.unsupported.capture_unreadable).toBe(1)
        expect(output.compatibility!.unsupported.capture_absent ?? 0).toBe(0)
        expect(output.compatibility!.unsupported.or1_missing_document ?? 0).toBe(0)
        expect(output.metadataPaths!.includes(relative)).toBe(true)
        expect(output.bodyReads!.includes(relative)).toBe(false)
        const state = await checkpoint(box.workspace)
        expect(state.approvals).toHaveLength(1)
        const bad = state.units.find(unit => unit.unitId === 'tree:synthetic')
        const healthy = state.units.find(unit => unit.unitId === 'slug:sample')
        expect(bad?.pinState).toBe('blocked'); expect(healthy?.pinState).toBe('pinned')
        expect(bad?.blockers).toContainEqual(expect.objectContaining({ code: 'capture_unreadable', unitId: 'tree:synthetic', entryOrdinal: ordinal, path: '/tree/asset0.css', stage: 'inspect', reason: 'unreadable' }))
        const planned = receipt(await box.plan())
        expect(planned.results!.map(item => item.state).sort()).toEqual(['ready', 'translation_blocked'])
        expect(planned.stores).toMatchObject({ status: 'observed', equal: true })
      } finally { await box.cleanup() }
    }
  }, 1_200_000)

  it('fails closed before body reads when a protected native component is overlong', async () => {
    const box = await sandbox()
    try {
      const fixture = await makeSelectedFixture()
      excluded(fixture.input)
      const entry = fixture.input.entries.find(item => item.path === '/asset-owners.json')!
      entry.locator.relative = `tree/${'界'.repeat(1500)}`
      await box.save(fixture)
      const output = receipt(await run(process.execPath, [physicalRunner, 'observe', box.selection, box.workspace, box.capture], box.home), 1)
      expect(output.error).toBe('offline_operation_failed')
      expect(output.bodyReads).toEqual([])
    } finally { await box.cleanup() }
  }, 240_000)

  it('rejects an unconstructible canonical origin before root binding, with and without pages', async () => {
    for (const empty of [false, true]) {
      const box = await sandbox()
      try {
        const fixture = await makeSelectedFixture()
        fixture.input.reader.canonicalHost = '999.999.999.999'
        if (empty) {
          fixture.input.entries = []; fixture.input.pages = []; fixture.input.owners = []; fixture.input.aliases = []; fixture.input.shortlinks = []; fixture.input.previews = []; fixture.input.consumerUrls = []
        }
        await box.save(fixture)
        await rm(box.capture, { recursive: true })
        const prepared = receipt(await box.prepare(), 1)
        expect(prepared.error).toBeUndefined(); expect(prepared.fatal).toBe('invalid_grammar')
        expect(prepared.units).toBe(0); expect(prepared.pinned).toBe(0)
        expect(prepared.census!.digest).toMatch(/^[a-f0-9]{64}$/)
        if (empty) expect(prepared.census!.counts.page).toBeUndefined()
        else expect(prepared.census!.counts.page.rejected).toBe(fixture.input.pages.length)
        const observed = receipt(await run(process.execPath, [physicalRunner, 'observe', box.selection, join(box.root, 'observed-workspace'), box.capture], box.home), 1)
        expect(observed.fatal).toBe('invalid_grammar')
        expect(observed.metadataPaths).toEqual([]); expect(observed.bodyReads).toEqual([])
        const planned = receipt(await box.plan(), 1)
        expect(planned.fatal).toBe('invalid_grammar'); expect(planned.census).toEqual(prepared.census)
        expect(planned.results).toEqual([])
        expect(planned.stores).toMatchObject({ status: 'not_prepared', equal: null })
        await expect(stat(join(box.workspace, 'persist'))).rejects.toMatchObject({ code: 'ENOENT' })
      } finally { await box.cleanup() }
    }
  }, 600_000)

  it('retains a valid unbound root spelling but nulls a malformed root in private locator evidence', async () => {
    for (const root of ['not/a-root', 'unbound'] as const) {
      const box = await sandbox()
      try {
        const fixture = await makeSelectedFixture()
        const ordinal = fixture.input.entries.findIndex(entry => entry.path === '/tree/asset0.css')
        fixture.input.entries[ordinal].locator.root = root
        const preflight = await preflightSelection(fixture.input)
        expect(preflight.kind).toBe('prepared')
        if (preflight.kind !== 'prepared') throw new Error('expected prepared selection')
        expect(preflight.reads.some(item => item.ordinal === ordinal)).toBe(false)
        expect(preflight.protectedLocators.some(item => item.ordinal === ordinal)).toBe(false)
        const translated = await preflight.finish(fixture.observations)
        const fact = translated.facts.find(item => item.kind === 'entry' && item.ordinal === ordinal)
        if (!fact || fact.kind !== 'entry') throw new Error('expected entry evidence')
        const expected = { root: root === 'unbound' ? root : null, relative: 'tree/asset0.css' }
        expect(fact.locator).toEqual(expected)
        expect(fact.unitId).toBe('tree:synthetic')
        expect(translated.compatibility.unsupported.some(issue => issue.code === 'unsafe_locator')).toBe(true)
        await box.save(fixture)
        const output = receipt(await run(process.execPath, [physicalRunner, 'observe', box.selection, box.workspace, box.capture], box.home))
        expect(output.fatal).toBeNull(); expect(output.pinned).toBe(1)
        expect(output.compatibility!.unsupported.unsafe_locator).toBeGreaterThan(0)
        expect(output.compatibility!.unsupported.capture_absent ?? 0).toBe(0)
        expect(output.compatibility!.unsupported.or1_missing_document ?? 0).toBe(0)
        expect(output.metadataPaths!).not.toContain('tree/asset0.css')
        expect(output.bodyReads!).not.toContain('tree/asset0.css')
        const saved = await checkpoint(box.workspace)
        expect(saved.facts!.find(item => item.kind === 'entry' && item.ordinal === ordinal)?.locator).toEqual(expected)
        const planned = receipt(await box.plan())
        expect(planned.results!.map(item => item.state).sort()).toEqual(['ready', 'translation_blocked'])
        expect(planned.stores).toMatchObject({ status: 'observed', equal: true })
        const replay = await checkpoint(box.workspace)
        expect(replay.facts!.find(item => item.kind === 'entry' && item.ordinal === ordinal)?.locator).toEqual(fact.locator)
      } finally { await box.cleanup() }
    }
  }, 1_200_000)

  it('rejects malformed or unbound roots on protected locators before any body read', async () => {
    for (const root of ['not/a-root', 'unbound'] as const) {
      const box = await sandbox()
      try {
        const fixture = await makeSelectedFixture()
        excluded(fixture.input)
        fixture.input.entries.find(item => item.path === '/asset-owners.json')!.locator.root = root
        await box.save(fixture)
        const output = receipt(await run(process.execPath, [physicalRunner, 'observe', box.selection, box.workspace, box.capture], box.home), 1)
        expect(output.error).toBeUndefined(); expect(typeof output.fatal).toBe('string')
        expect(output.pinned).toBe(0)
        expect(output.metadataPaths).toEqual([]); expect(output.bodyReads).toEqual([])
      } finally { await box.cleanup() }
    }
  }, 480_000)

  it('keeps each valid locator component in memory and checkpoint when the other is raw 1e400', async () => {
    for (const invalidComponent of ['relative', 'root'] as const) {
      const box = await sandbox()
      try {
        const fixture = await makeSelectedFixture()
        const ordinal = fixture.input.entries.findIndex(entry => entry.path === '/tree/asset0.css')
        const locator = fixture.input.entries[ordinal].locator
        const marker = 'synthetic-invalid-locator-component'
        locator[invalidComponent] = marker
        await box.save(fixture)
        const original = await readFile(box.selection, 'utf8')
        expect(original.split(JSON.stringify(marker))).toHaveLength(2)
        const raw = original.replace(JSON.stringify(marker), '1e400')
        expect(raw.includes(`"${invalidComponent}":1e400`)).toBe(true)
        await writeFile(box.selection, Buffer.from(raw, 'utf8'), { mode: 0o600 })
        const input: unknown = JSON.parse(raw)
        const preflight = await preflightSelection(input)
        expect(preflight.kind).toBe('prepared')
        if (preflight.kind !== 'prepared') throw new Error('expected prepared selection')
        expect(preflight.reads.some(item => item.ordinal === ordinal)).toBe(false)
        expect(preflight.protectedLocators.some(item => item.ordinal === ordinal)).toBe(false)
        const translated = await preflight.finish(fixture.observations)
        const memoryFact = translated.facts.find(item => item.kind === 'entry' && item.ordinal === ordinal)
        if (!memoryFact || memoryFact.kind !== 'entry') throw new Error('expected entry evidence')
        const expected = invalidComponent === 'relative' ? { root: 'capture', relative: null } : { root: null, relative: 'tree/asset0.css' }
        expect(memoryFact.locator).toEqual(expected)
        expect(memoryFact.unitId).toBe('tree:synthetic')
        expect(translated.compatibility.unsupported.some(issue => issue.code === 'unsafe_locator')).toBe(true)
        const output = receipt(await run(process.execPath, [physicalRunner, 'observe', box.selection, box.workspace, box.capture], box.home))
        expect(output.error).toBeUndefined(); expect(output.fatal).toBeNull(); expect(output.pinned).toBe(1)
        expect(output.compatibility!.unsupported.unsafe_locator).toBeGreaterThan(0)
        expect(output.compatibility!.unsupported.capture_absent ?? 0).toBe(0)
        expect(output.compatibility!.unsupported.or1_missing_document ?? 0).toBe(0)
        expect(output.metadataPaths!).not.toContain('tree/asset0.css')
        expect(output.bodyReads!).not.toContain('tree/asset0.css')
        const state = await checkpoint(box.workspace)
        const saved = state.facts!.find(item => item.kind === 'entry' && item.ordinal === ordinal)
        expect(saved?.locator).toEqual(memoryFact.locator)
        expect(saved?.unitId).toBe('tree:synthetic')
        const planned = receipt(await box.plan())
        expect(planned.results!.map(item => item.state).sort()).toEqual(['ready', 'translation_blocked'])
        expect(planned.stores).toMatchObject({ status: 'observed', equal: true })
        const replay = await checkpoint(box.workspace)
        expect(replay.facts!.find(item => item.kind === 'entry' && item.ordinal === ordinal)?.locator).toEqual(memoryFact.locator)
      } finally { await box.cleanup() }
    }
  }, 1_200_000)

  it('refuses an unresolved protected locator before opening any candidate body', async () => {
    const box = await sandbox()
    try {
      const fixture = await makeSelectedFixture()
      excluded(fixture.input)
      const entry = fixture.input.entries.find(item => item.path === '/asset-owners.json')!
      const marker = 'synthetic-protected-invalid-component'
      entry.locator.relative = marker
      await box.save(fixture)
      const original = await readFile(box.selection, 'utf8')
      expect(original.split(JSON.stringify(marker))).toHaveLength(2)
      await writeFile(box.selection, Buffer.from(original.replace(JSON.stringify(marker), '1e400'), 'utf8'), { mode: 0o600 })
      const output = receipt(await run(process.execPath, [physicalRunner, 'observe', box.selection, box.workspace, box.capture], box.home), 1)
      expect(output.error).toBeUndefined()
      expect(typeof output.fatal).toBe('string')
      expect(output.pinned).toBe(0)
      expect(output.metadataPaths).toEqual([]); expect(output.bodyReads).toEqual([])
    } finally { await box.cleanup() }
  }, 240_000)

  it('attributes an unpaired-surrogate ordinary locator before attempting that filesystem name', async () => {
    const box = await sandbox()
    try {
      const fixture = await makeSelectedFixture()
      const invalid = `invalid-\ud800.css`
      fixture.input.entries.find(entry => entry.path === '/tree/asset0.css')!.locator.relative = invalid
      await box.save(fixture)
      const output = receipt(await run(process.execPath, [physicalRunner, 'observe', box.selection, box.workspace, box.capture], box.home))
      expect(output.fatal).toBeNull(); expect(output.pinned).toBe(1)
      expect(output.metadataPaths!).not.toContain(invalid)
      expect(output.bodyReads!).not.toContain(invalid)
      expect(output.bodyReads!).toContain('a/sample/index.html')
      const planned = receipt(await box.plan())
      expect(planned.results!.map(result => result.state).sort()).toEqual(['ready', 'translation_blocked'])
    } finally { await box.cleanup() }
  }, 600_000)

  it('refuses an already oversized source without reading it and continues independent planning', async () => {
    const box = await sandbox()
    try {
      const fixture = await makeSelectedFixture()
      const asset = fixture.input.entries.find(entry => entry.path === '/tree/asset0.css')!
      const expectedSize = asset.expected!.size
      await box.save(fixture)
      await writeFile(join(box.capture, 'tree/asset0.css'), Buffer.alloc(expectedSize + 65536, 120))
      const output = receipt(await run(process.execPath, [physicalRunner, 'observe', box.selection, box.workspace, box.capture], box.home))
      expect(output.fatal).toBeNull(); expect(output.pinned).toBe(1)
      expect(output.metadataPaths!).toContain('tree/asset0.css')
      expect(output.bodyBytes!['tree/asset0.css'] ?? 0).toBe(0)
      expect(output.bodyReads!).not.toContain('tree/asset0.css')
      const planned = receipt(await box.plan())
      expect(planned.results!.map(result => result.state).sort()).toEqual(['ready', 'translation_blocked'])
    } finally { await box.cleanup() }
  }, 600_000)

  it('bounds bytes consumed when a source grows after metadata and keeps the other unit usable', async () => {
    const box = await sandbox()
    try {
      const fixture = await makeSelectedFixture()
      const asset = fixture.input.entries.find(entry => entry.path === '/tree/asset0.css')!
      const expectedSize = asset.expected!.size
      asset.locator.relative = 'grow.css'
      fixture.files['/grow.css'] = fixture.files['/tree/asset0.css']
      await box.save(fixture)
      const output = receipt(await run(process.execPath, [physicalRunner, 'grow', box.selection, box.workspace, box.capture], box.home))
      expect(output.grown).toBe(true)
      expect(output.bodyBytes!['grow.css']).toBeLessThanOrEqual(expectedSize + 1)
      expect(output.fatal).toBeNull(); expect(output.pinned).toBe(1)
      const planned = receipt(await box.plan())
      expect(planned.results!.map(result => result.state).sort()).toEqual(['ready', 'translation_blocked'])
    } finally { await box.cleanup() }
  }, 600_000)

  it('pins two independently evidenced long multibyte capture locators with bounded native keys', async () => {
    const box = await sandbox()
    try {
      const fixture = await makeSelectedFixture()
      const entry = fixture.input.entries.find(item => item.path === '/tree/one.html')!
      const page = fixture.input.pages.find(item => item.sourcePageId === 'tree/one.html')!
      const body = fixture.files['/tree/one.html']
      const directory = Array.from({ length: 6 }, (_, i) => `${'界'.repeat(60)}${i}`).join('/')
      fixture.input.entries = []; fixture.input.pages = []; fixture.input.owners = []; fixture.input.aliases = []; fixture.input.shortlinks = []; fixture.input.previews = []; fixture.input.consumerUrls = []
      for (const name of ['first', 'second']) {
        const relative = `${directory}/${name}.html`, path = `/${name}.html`, sourceArtifactId = `long:${name}`
        expect(Buffer.byteLength(`capture/capture/${relative}`, 'utf8')).toBeGreaterThan(1024)
        fixture.input.entries.push({ ...structuredClone(entry), path, locator: { root: 'capture', relative }, placement: { sourceArtifactId, evidenceRef: `${name}-placement` } })
        fixture.input.pages.push({ ...structuredClone(page), sourcePageId: `${name}.html`, documentPath: path, membership: { sourceArtifactId, evidenceRef: `${name}-membership` } })
        fixture.files[`/${relative}`] = body
      }
      await box.save(fixture)
      const prepared = receipt(await box.prepare())
      expect(prepared.fatal).toBeNull(); expect(prepared.units).toBe(2); expect(prepared.pinned).toBe(2)
      const state = await checkpoint(box.workspace)
      const files = state.units.flatMap(unit => unit.inventory?.files ?? [])
      expect(files).toHaveLength(2); expect(state.approvals).toHaveLength(2)
      expect(files.every(file => /^capture\/v1\/[a-f0-9]{64}\/[0-9]+$/.test(file.sourceRef) && Buffer.byteLength(file.sourceRef) <= 1024 && typeof file.sourceVersion === 'string' && file.sourceVersion.length > 0)).toBe(true)
      expect(new Set(files.map(file => file.sourceRef)).size).toBe(2)
      expect(new Set(files.map(file => file.sourceVersion)).size).toBe(2)
      expect(state.approvals.every(approval => /^inventory\/v1\/[a-f0-9]{64}\.json$/.test(approval.objectKey) && Buffer.byteLength(approval.objectKey) <= 1024 && approval.objectVersion.length > 0)).toBe(true)
      expect(new Set(state.approvals.map(approval => approval.objectKey)).size).toBe(2)
      expect(new Set(state.approvals.map(approval => approval.objectVersion)).size).toBe(2)
      const planned = receipt(await box.plan())
      expect(planned.results!.map(result => result.state)).toEqual(['ready', 'ready'])
      expect(planned.stores).toMatchObject({ status: 'observed', equal: true })
    } finally { await box.cleanup() }
  }, 600_000)

  it('mints a fresh signed local identity when a later unit starts after an hour', async () => {
    const keys = await webcrypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify'])
    const privateKey = await webcrypto.subtle.exportKey('jwk', keys.privateKey)
    let now = 2_000_000_000_000
    const sign = await createAssertionSigner({ privateKey, kid: 'fixture', now: () => now })
    const first = await sign()
    now += 3_601_000
    const second = await sign()
    const parse = async (token: string) => {
      const [header, payload, signature] = token.split('.')
      const valid = await webcrypto.subtle.verify('RSASSA-PKCS1-v1_5', keys.publicKey, Buffer.from(signature, 'base64url'), Buffer.from(`${header}.${payload}`))
      expect(valid).toBe(true)
      return z.object({ iss: z.string(), sub: z.string(), aud: z.string(), exp: z.number() }).parse(JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')))
    }
    const oldIdentity = await parse(first), freshIdentity = await parse(second)
    expect(oldIdentity.exp * 1000).toBeLessThan(now)
    expect(freshIdentity.exp * 1000).toBeGreaterThan(now)
    expect({ iss: freshIdentity.iss, sub: freshIdentity.sub, aud: freshIdentity.aud }).toEqual({ iss: oldIdentity.iss, sub: oldIdentity.sub, aud: oldIdentity.aud })
  })

  it('does not read explicitly excluded content while an independent unit seals', async () => {
    const box = await sandbox()
    try {
      const fixture = await makeSelectedFixture()
      fixture.input.exclusions.push({ path: '/tree/asset0.css', evidenceRef: 'explicit-exclusion', reason: 'non_content' })
      await box.save(fixture)
      const output = receipt(await run(process.execPath, [physicalRunner, 'observe', box.selection, box.workspace, box.capture], box.home))
      expect(output.fatal).toBeNull(); expect(output.pinned).toBe(1)
      expect(output.bodyReads!).not.toContain('tree/asset0.css')
      expect(output.bodyReads!).toContain('a/sample/index.html')
      const planned = receipt(await box.plan())
      expect(planned.results!.map(result => result.state).sort()).toEqual(['ready', 'translation_blocked'])
    } finally { await box.cleanup() }
  }, 600_000)

  it('does not read reserved or foreign-subtree assets, but reads a legitimate subtree asset', async () => {
    for (const path of ['/cdn-cgi/fixture.css', '/apifake.css', '/_revisionsfake.css', '/login', '/a/foreign/extra.css']) {
      const box = await sandbox()
      try {
        const fixture = await makeSelectedFixture()
        const asset = fixture.input.entries.find(entry => entry.path === '/tree/asset0.css')!
        fixture.input.entries.push({ ...structuredClone(asset), path, locator: { root: 'capture', relative: 'probe.css' } })
        fixture.input.entries.push({ ...structuredClone(asset), path: '/a/sample/extra.css', locator: { root: 'capture', relative: 'legitimate.css' }, placement: { sourceArtifactId: 'slug:sample', evidenceRef: 'legitimate-placement' } })
        fixture.files['/probe.css'] = fixture.files['/tree/asset0.css']
        fixture.files['/legitimate.css'] = fixture.files['/tree/asset0.css']
        excluded(fixture.input)
        fixture.files['/asset-owners.json'] = new TextEncoder().encode('excluded synthetic metadata')
        await box.save(fixture)
        const output = receipt(await run(process.execPath, [physicalRunner, 'observe', box.selection, box.workspace, box.capture], box.home))
        expect(output.fatal).toBeNull(); expect(output.pinned).toBe(1)
        expect(output.bodyReads!).not.toContain('probe.css')
        expect(output.bodyReads!).not.toContain('asset-owners.json')
        expect(output.bodyReads!).toContain('legitimate.css')
        const planned = receipt(await box.plan())
        expect(planned.results!.map(result => result.state).sort()).toEqual(['ready', 'translation_blocked'])
      } finally { await box.cleanup() }
    }
  }, 1_800_000)

  it('checkpoints earlier and later native units when a second file disappears between inspection and pinning', async () => {
    const box = await sandbox()
    try {
      const fixture = await makeSelectedFixture()
      const templateEntry = fixture.input.entries.find(entry => entry.path === '/tree/one.html')!
      const templatePage = fixture.input.pages.find(page => page.sourcePageId === 'tree/one.html')!
      const body = fixture.files['/tree/one.html']
      fixture.input.entries = []; fixture.input.pages = []; fixture.input.owners = []; fixture.input.aliases = []; fixture.input.shortlinks = []; fixture.input.previews = []; fixture.input.consumerUrls = []
      for (const [name, unit] of [['first', 'a-first'], ['second', 'b-second'], ['third', 'c-third']]) {
        const path = `/${name}.html`
        fixture.input.entries.push({ ...structuredClone(templateEntry), path, locator: { root: 'capture', relative: `${name}.html` }, placement: { sourceArtifactId: unit, evidenceRef: `${unit}-placement` } })
        fixture.input.pages.push({ ...structuredClone(templatePage), sourcePageId: `${name}.html`, documentPath: path, membership: { sourceArtifactId: unit, evidenceRef: `${unit}-membership` } })
        fixture.files[path] = body
      }
      await box.save(fixture)
      const output = receipt(await run(process.execPath, [physicalRunner, 'remove-second', box.selection, box.workspace, box.capture], box.home))
      expect(output.removed).toBe(true)
      expect(output.fatal).toBeNull(); expect(output.units).toBe(3); expect(output.pinned).toBe(2)
      expect(output.compatibility!.unsupported.capture_absent).toBe(1)
      expect(output.compatibility!.unsupported.or1_missing_document).toBe(1)
      const state = await checkpoint(box.workspace)
      const middle = state.units.find(unit => unit.unitId === 'b-second')!
      expect(state.approvals).toHaveLength(2)
      expect(middle.pinState).toBe('blocked')
      expect(middle.blockers).toContainEqual(expect.objectContaining({ code: 'capture_absent', unitId: 'b-second', entryOrdinal: 1, path: '/second.html', sourcePageId: 'second.html', stage: 'pin_reread', reason: 'absent' }))
      expect(middle.blockers).toContainEqual(expect.objectContaining({ code: 'or1_missing_document', unitId: 'b-second', entryOrdinal: 1, path: '/second.html', sourcePageId: 'second.html', stage: 'pin_reread', reason: 'absent', basis: 'observed_absent' }))
      expect(output.bodyReads!).toContain('first.html'); expect(output.bodyReads!).toContain('second.html'); expect(output.bodyReads!).toContain('third.html')
      const planned = receipt(await box.plan())
      expect(planned.results!.map(result => result.state)).toEqual(['ready', 'translation_blocked', 'ready'])
      expect(planned.stores).toMatchObject({ status: 'observed', equal: true })
    } finally { await box.cleanup() }
  }, 600_000)

  it('does not classify a stylesheet missing at pin reread as OR-1', async () => {
    const box = await sandbox()
    try {
      const fixture = await makeSelectedFixture()
      const document = fixture.input.entries.find(entry => entry.path === '/tree/one.html')!
      const asset = fixture.input.entries.find(entry => entry.path === '/tree/asset0.css')!
      const page = fixture.input.pages.find(item => item.sourcePageId === 'tree/one.html')!
      const documentBytes = fixture.files['/tree/one.html'], cssBytes = fixture.files['/tree/asset0.css']
      fixture.input.entries = []; fixture.input.pages = []; fixture.input.owners = []; fixture.input.aliases = []; fixture.input.shortlinks = []; fixture.input.previews = []; fixture.input.consumerUrls = []
      for (const [name, unit] of [['first', 'a-first'], ['second', 'b-second'], ['third', 'c-third']]) {
        const path = `/${name}.html`
        fixture.input.entries.push({ ...structuredClone(document), path, locator: { root: 'capture', relative: `${name}.html` }, placement: { sourceArtifactId: unit, evidenceRef: `${unit}-placement` } })
        fixture.input.pages.push({ ...structuredClone(page), sourcePageId: `${name}.html`, documentPath: path, membership: { sourceArtifactId: unit, evidenceRef: `${unit}-membership` } })
        fixture.files[path] = documentBytes
      }
      fixture.input.entries.push({ ...structuredClone(asset), path: '/second.css', locator: { root: 'capture', relative: 'second.css' }, placement: { sourceArtifactId: 'b-second', evidenceRef: 'css-placement' } })
      fixture.input.owners.push({ path: '/second.css', ownerSourcePageId: 'second.html', evidenceRef: 'css-owner', basis: 'declared' })
      fixture.files['/second.css'] = cssBytes
      await box.save(fixture)
      const output = receipt(await run(process.execPath, [physicalRunner, 'remove-style', box.selection, box.workspace, box.capture], box.home))
      expect(output.removed).toBe(true); expect(output.pinned).toBe(2)
      expect(output.compatibility!.unsupported.capture_absent).toBe(1)
      expect(output.compatibility!.unsupported.or1_missing_document ?? 0).toBe(0)
      const state = await checkpoint(box.workspace)
      const middle = state.units.find(unit => unit.unitId === 'b-second')!
      expect(state.approvals).toHaveLength(2); expect(middle.pinState).toBe('blocked')
      expect(middle.blockers).toContainEqual(expect.objectContaining({ code: 'capture_absent', unitId: 'b-second', entryOrdinal: 3, path: '/second.css', sourcePageId: null, stage: 'pin_reread', reason: 'absent' }))
      expect(middle.blockers.some(issue => issue.code === 'or1_missing_document')).toBe(false)
      const planned = receipt(await box.plan())
      expect(planned.results!.map(result => result.state)).toEqual(['ready', 'translation_blocked', 'ready'])
      expect(planned.stores).toMatchObject({ status: 'observed', equal: true })
    } finally { await box.cleanup() }
  }, 600_000)

  it('refuses an excluded physical locator reused as content through another root alias', async () => {
    const box = await sandbox()
    try {
      const fixture = await makeSelectedFixture()
      excluded(fixture.input)
      fixture.input.captureRoots.push('alternate')
      const asset = fixture.input.entries.find(entry => entry.path === '/tree/asset0.css')!
      asset.locator = { root: 'alternate', relative: 'asset-owners.json' }
      fixture.files['/asset-owners.json'] = fixture.files['/tree/asset0.css']
      await box.save(fixture)
      const output = receipt(await box.prepare('--capture-root', `alternate=${box.capture}`), 1)
      expect(output.error).toBe('protected_locator')
      await expect(stat(join(box.workspace, 'state.json'))).rejects.toMatchObject({ code: 'ENOENT' })
    } finally { await box.cleanup() }
  }, 240_000)

  it('performs no content reads when a late selector locator aliases or hardlinks excluded metadata', async () => {
    for (const hardlink of [false, true]) {
      const box = await sandbox()
      try {
        const fixture = await makeSelectedFixture()
        excluded(fixture.input)
        fixture.input.captureRoots.push('alternate')
        const asset = fixture.input.entries.find(entry => entry.path === '/tree/asset0.css')!
        asset.locator = { root: 'alternate', relative: hardlink ? 'metadata-hardlink' : 'asset-owners.json' }
        fixture.files['/asset-owners.json'] = fixture.files['/tree/asset0.css']
        await box.save(fixture)
        if (hardlink) await link(join(box.capture, 'asset-owners.json'), join(box.capture, 'metadata-hardlink'))
        const result = receipt(await run(process.execPath, [physicalRunner, 'alias-collision', box.selection, box.workspace, box.capture], box.home), 1)
        expect(result.error).toBe('protected_locator')
        expect(result.bodyReads).toEqual([])
      } finally { await box.cleanup() }
    }
  }, 600_000)

  it('distinguishes an evidenced exclusions-only receipt from a fatal duplicate', async () => {
    const clean = await sandbox(), duplicate = await sandbox()
    try {
      const fixture = await makeSelectedFixture(); allExcluded(fixture.input)
      await clean.save(fixture)
      const prepared = receipt(await clean.prepare())
      expect(prepared.fatal).toBeNull(); expect(prepared.pinned).toBe(0)
      expect(prepared.census!.counts.entry.excluded).toBe(1)
      const planned = receipt(await clean.plan())
      expect(planned.fatal).toBeNull(); expect(planned.results).toHaveLength(0)
      fixture.input.entries.push(structuredClone(fixture.input.entries[0]))
      await duplicate.save(fixture)
      const fatal = receipt(await duplicate.prepare(), 1)
      expect(fatal.fatal).toBe('contradictory_input'); expect(fatal.pinned).toBe(0)
      const denied = receipt(await duplicate.plan(), 1)
      expect(denied.fatal).toBe('contradictory_input'); expect(denied.results).toHaveLength(0)
    } finally { await Promise.all([clean.cleanup(), duplicate.cleanup()]) }
  }, 600_000)

  it('reports a dangling consumer as fatal before attempting to bind an unavailable capture root', async () => {
    const box = await sandbox()
    try {
      const fixture = await makeSelectedFixture()
      fixture.input.consumerUrls.push({ url: 'https://forge.example.test/missing.html', purpose: 'document', targetSourcePageId: 'missing.html', mappingRef: null })
      await box.save(fixture)
      await rm(box.capture, { recursive: true })
      const output = receipt(await box.prepare(), 1)
      expect(output.fatal).toBe('unassignable_record')
      expect(output.pinned).toBe(0)
      expect(output.census!.counts.consumerUrl.rejected).toBe(1)
    } finally { await box.cleanup() }
  }, 240_000)

  it('rejects invalid reader profiles before binding an unavailable capture root', async () => {
    for (const variant of ['empty-shell', 'reserved-shell', 'incompatible-grammar'] as const) {
      const box = await sandbox()
      try {
        const fixture = await makeSelectedFixture()
        if (variant === 'empty-shell') fixture.input.reader.shellPaths = []
        if (variant === 'reserved-shell') fixture.input.reader.shellPaths.push('/api/internal')
        if (variant === 'incompatible-grammar') fixture.input.reader.routeGrammars = ['subtree']
        await box.save(fixture)
        await rm(box.capture, { recursive: true })
        const output = receipt(await box.prepare(), 1)
        expect(typeof output.fatal).toBe('string')
        expect(output.pinned).toBe(0)
        expect(output.error).not.toBe('offline_operation_failed')
      } finally { await box.cleanup() }
    }
  }, 600_000)

  it('seals an independent unit sharing ordinary content with a policy-blocked unit', async () => {
    const box = await sandbox()
    try {
      const fixture = await makeSelectedFixture()
      const entry = fixture.input.entries.find(item => item.path === '/tree/one.html')!
      const page = fixture.input.pages.find(item => item.sourcePageId === 'tree/one.html')!
      fixture.input.entries = [structuredClone(entry), { ...structuredClone(entry), path: '/other.html', placement: { sourceArtifactId: 'other', evidenceRef: 'other-placement' } }]
      fixture.input.pages = [{ ...structuredClone(page), visibility: { state: 'unknown' } }, { ...structuredClone(page), sourcePageId: 'other.html', documentPath: '/other.html', membership: { sourceArtifactId: 'other', evidenceRef: 'other-membership' } }]
      fixture.input.owners = []; fixture.input.aliases = []; fixture.input.shortlinks = []; fixture.input.previews = []; fixture.input.consumerUrls = []
      await box.save(fixture)
      const prepared = receipt(await box.prepare())
      expect(prepared.fatal).toBeNull(); expect(prepared.units).toBe(2); expect(prepared.pinned).toBe(1)
      const planned = receipt(await box.plan())
      expect(planned.results!.map(result => result.state).sort()).toEqual(['ready', 'translation_blocked'])
      expect(planned.stores).toMatchObject({ status: 'observed', equal: true })
    } finally { await box.cleanup() }
  }, 600_000)

  it('exposes the native fallback warning without revealing the unrecognized visibility', async () => {
    const box = await sandbox()
    try {
      const fixture = await makeSelectedFixture()
      const marker = 'sensitiveSyntheticVisibilityMarker'
      const page = fixture.input.pages.find(item => item.sourcePageId === 'tree/one.html')!
      page.visibility = { state: 'present', value: marker, metadataV: null, expiresAt: null }
      await box.save(fixture)
      const preparation = await box.prepare()
      expect((preparation.stdout + preparation.stderr).includes(marker)).toBe(false)
      const prepared = receipt(preparation)
      expect(prepared.warnings!.unknown_visibility_private).toBe(1)
      const planning = await box.plan()
      expect((planning.stdout + planning.stderr).includes(marker)).toBe(false)
      const planned = receipt(planning)
      expect(planned.results!.some(result => result.state === 'ready' && result.warnings?.unknown_visibility_private === 1)).toBe(true)
      expect(planned.stores).toMatchObject({ status: 'observed', equal: true })
    } finally { await box.cleanup() }
  }, 600_000)

  it('blocks only the unit whose real pinned inventory crosses its budget', async () => {
    const box = await sandbox()
    try {
      const fixture = await makeSelectedFixture()
      fixture.input.consumerUrls.push({ url: 'https://forge.example.test/tree/one.html', purpose: 'document', targetSourcePageId: 'tree/one.html', mappingRef: null })
      const preflight = await preflightSelection(fixture.input)
      expect(preflight.kind).toBe('prepared')
      if (preflight.kind !== 'prepared') throw new Error('expected prepared selection')
      const translation = await preflight.finish(fixture.observations)
      const tree = translation.units.find(unit => unit.unitId === 'tree:synthetic')
      const slug = translation.units.find(unit => unit.unitId === 'slug:sample')
      expect(tree?.status).toBe('representable'); expect(slug?.status).toBe('representable')
      if (!tree || tree.status !== 'representable' || !slug || slug.status !== 'representable') throw new Error('expected representable units')
      expect(tree.budget.inventoryBytes).toBeGreaterThan(slug.budget.inventoryBytes)
      fixture.input.limits.maxInventoryBytes = tree.budget.inventoryBytes + 1
      await box.save(fixture)
      const prepared = receipt(await box.prepare())
      expect(prepared.fatal).toBeNull(); expect(prepared.pinned).toBe(1)
      expect(prepared.compatibility!.unsupported.inventory_budget_exceeded).toBe(1)
      expect(prepared.compatibility!.represented!.publication_unit).toBe(1)
      expect(prepared.compatibility!.represented!.consumer_url_represented ?? 0).toBe(0)
      expect(prepared.compatibility!.represented!.original_preview ?? 0).toBe(0)
      expect(prepared.census!.counts.preview.rejected).toBe(1)
      expect(prepared.census!.counts.consumerUrl.rejected).toBe(1)
      const planned = receipt(await box.plan())
      expect(planned.fatal).toBeNull(); expect(planned.error).toBeNull()
      expect(planned.results!.map(r => r.state).sort()).toEqual(['ready', 'translation_blocked'])
      expect(planned.stores).toMatchObject({ status: 'observed', equal: true })
    } finally { await box.cleanup() }
  }, 600_000)

  it('keeps a missing selected directory member attributed while another unit plans', async () => {
    const box = await sandbox()
    try {
      const fixture = await makeSelectedFixture()
      fixture.input.consumerUrls.push({ url: 'https://forge.example.test/a/sample/', purpose: 'document', targetSourcePageId: 'sample', mappingRef: null })
      await box.save(fixture)
      await rm(join(box.capture, 'a/sample/nested'), { recursive: true })
      const prepared = receipt(await box.prepare())
      expect(prepared.fatal).toBeNull(); expect(prepared.pinned).toBe(1)
      expect(prepared.compatibility!.unsupported.capture_absent).toBe(1)
      expect(prepared.compatibility!.represented!.publication_unit).toBe(1)
      expect(prepared.compatibility!.represented!.consumer_url_represented ?? 0).toBe(0)
      expect(prepared.compatibility!.represented!.shortlink_exact_destination ?? 0).toBe(0)
      expect(prepared.compatibility!.represented!.alias_team_fallback ?? 0).toBe(0)
      expect(prepared.census!.counts.alias.rejected).toBe(1)
      expect(prepared.census!.counts.shortlink.rejected).toBe(1)
      expect(prepared.census!.counts.consumerUrl.rejected).toBe(1)
      const planned = receipt(await box.plan())
      expect(planned.results!.map(r => r.state).sort()).toEqual(['ready', 'translation_blocked'])
      expect(planned.stores).toMatchObject({ status: 'observed', equal: true })
    } finally { await box.cleanup() }
  }, 600_000)

  it('attributes a directory content locator to its unit and plans the independent unit', async () => {
    const box = await sandbox()
    try {
      const fixture = await makeSelectedFixture(); await box.save(fixture)
      const path = join(box.capture, 'a/sample/nested/index.html')
      await rm(path); await mkdir(path, { mode: 0o700 })
      const prepared = receipt(await box.prepare())
      expect(prepared.fatal).toBeNull(); expect(prepared.pinned).toBe(1)
      expect(prepared.compatibility!.unsupported.capture_unreadable).toBe(1)
      const planned = receipt(await box.plan())
      expect(planned.results!.map(r => r.state).sort()).toEqual(['ready', 'translation_blocked'])
      expect(planned.stores).toMatchObject({ status: 'observed', equal: true })
    } finally { await box.cleanup() }
  }, 600_000)

  it('refuses a FIFO selector within a bounded subprocess lifetime', async () => {
    const box = await sandbox()
    try {
      expect((await run('/usr/bin/mkfifo', [box.selection], box.home, 10_000)).code).toBe(0)
      const result = await run(process.execPath, [cli, 'prepare', '--selection', box.selection, '--workspace', box.workspace, '--capture-root', `capture=${box.capture}`], box.home, 30_000)
      const output = receipt(result, 1)
      expect(['private_file_required', 'offline_operation_failed']).toContain(output.error)
    } finally { await box.cleanup() }
  }, 60_000)

  it('rejects a hardlinked selector and a hardlinked private state file', async () => {
    const selectorBox = await sandbox(), stateBox = await sandbox()
    try {
      const fixture = await makeSelectedFixture()
      await selectorBox.save(fixture); await link(selectorBox.selection, join(selectorBox.root, 'selector-link'))
      expect(receipt(await selectorBox.prepare(), 1).error).toMatch(/^(private_file_required|offline_operation_failed)$/)
      await stateBox.save(fixture); receipt(await stateBox.prepare())
      expect((await stat(stateBox.workspace)).mode & 0o777).toBe(0o700)
      expect((await stat(join(stateBox.workspace, 'state.json'))).mode & 0o777).toBe(0o600)
      await link(join(stateBox.workspace, 'state.json'), join(stateBox.workspace, 'state-link'))
      expect(receipt(await stateBox.plan(), 1).error).toMatch(/^(private_file_required|offline_operation_failed)$/)
    } finally { await Promise.all([selectorBox.cleanup(), stateBox.cleanup()]) }
  }, 600_000)

  it.skipIf(process.platform !== 'darwin')('rejects a selector with a foreign-user ACL despite private mode', async () => {
    const box = await sandbox()
    try {
      await box.save(await makeSelectedFixture())
      const configured = await run('/bin/chmod', ['+a', 'nobody allow read', box.selection], box.home, 10_000)
      expect(configured.code).toBe(0)
      expect((await stat(box.selection)).mode & 0o777).toBe(0o600)
      expect(receipt(await box.prepare(), 1).error).toMatch(/^(private_file_required|offline_operation_failed)$/)
    } finally { await box.cleanup() }
  }, 240_000)

  it('plans more than 1000 independent approvals without poisoning native configuration', async () => {
    const box = await sandbox()
    try {
      const fixture = await makeSelectedFixture()
      const entry = fixture.input.entries.find(item => item.path === '/tree/one.html')!
      const page = fixture.input.pages.find(item => item.sourcePageId === 'tree/one.html')!
      fixture.input.entries = []; fixture.input.pages = []; fixture.input.owners = []; fixture.input.aliases = []; fixture.input.shortlinks = []; fixture.input.previews = []
      for (let i = 0; i < 1001; i++) {
        const name = `batch/p${String(i).padStart(4, '0')}.html`, sourceArtifactId = `batch:${i}`
        fixture.input.entries.push({ ...structuredClone(entry), path: `/${name}`, placement: { sourceArtifactId, evidenceRef: `placement-${i}` } })
        fixture.input.pages.push({ ...structuredClone(page), sourcePageId: name, documentPath: `/${name}`, membership: { sourceArtifactId, evidenceRef: `membership-${i}` } })
      }
      await box.save(fixture)
      const prepared = receipt(await run(process.execPath, [cli, 'prepare', '--selection', box.selection, '--workspace', box.workspace, '--capture-root', `capture=${box.capture}`], box.home, 1_700_000))
      expect(prepared.fatal).toBeNull(); expect(prepared.units).toBe(1001); expect(prepared.pinned).toBe(1001)
      const planned = receipt(await run(process.execPath, [cli, 'plan', '--workspace', box.workspace], box.home, 1_700_000))
      expect(planned.fatal).toBeNull(); expect(planned.error).toBeNull(); expect(planned.results).toHaveLength(1001)
      expect(planned.results!.filter(r => r.state === 'ready')).toHaveLength(1001)
      expect(planned.results!.some(r => r.status === 503 || r.codes?.includes('configuration_error'))).toBe(false)
      expect(planned.stores).toMatchObject({ status: 'observed', equal: true })
    } finally { await box.cleanup() }
  }, 3_600_000)
})
