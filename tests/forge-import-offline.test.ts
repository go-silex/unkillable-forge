import { describe, expect, it } from 'vitest'
import { spawn } from 'node:child_process'
import { webcrypto } from 'node:crypto'
import { link, mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { z } from 'zod'
import { makeSelectedFixture, type SyntheticInput } from './engine/fixtures/import-selected.mjs'
import { preflightSelection, type Observation } from '../scripts/forge-import-selected.mjs'
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
  census: z.object({ counts: z.record(z.string(), z.record(z.string(), z.number())) }).optional(),
  compatibility: z.object({ unsupported: z.record(z.string(), z.number()), represented: z.record(z.string(), z.number()).optional() }).optional(),
  warnings: z.record(z.string(), z.number()).optional(),
  results: z.array(z.object({ state: z.string(), status: z.number().optional(), codes: z.array(z.string()).optional(), warnings: z.record(z.string(), z.number()).optional() })).optional(),
  stores: z.object({ status: z.string(), equal: z.boolean().nullable() }).optional(),
  bodyReads: z.array(z.string()).optional(), removed: z.boolean().optional(),
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

function excluded(input: SyntheticInput) {
  input.entries.push({ path: '/asset-owners.json', graphClass: 'excluded', contentType: null, locator: { root: 'capture', relative: 'asset-owners.json' }, provenance: 'synthetic-metadata', expected: null, placement: null })
  input.exclusions.push({ path: '/asset-owners.json', evidenceRef: 'synthetic-evidence', reason: 'engine' })
}

function allExcluded(input: SyntheticInput) {
  input.entries = []; input.pages = []; input.owners = []; input.aliases = []; input.shortlinks = []; input.previews = []
  excluded(input)
}

describe('offline selected import CLI', () => {
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
      expect(output.bodyReads!).toContain('first.html'); expect(output.bodyReads!).toContain('second.html'); expect(output.bodyReads!).toContain('third.html')
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
      const tree = translation.units.find(unit => unit.unitId === 'tree:synthetic')!
      const slug = translation.units.find(unit => unit.unitId === 'slug:sample')!
      expect(tree.status).toBe('representable'); expect(slug.status).toBe('representable')
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
