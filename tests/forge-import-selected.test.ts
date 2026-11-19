import { describe, expect, it } from 'vitest'
import { preflightSelection, assignSourcePins, sealInventory, stable, type Translation, type Unit, type RepresentableUnit } from '../scripts/forge-import-selected.mjs'
import { makeSelectedFixture } from './engine/fixtures/import-selected.mjs'

async function translateSelection(input: unknown, ledger: unknown = null, observations: unknown = {}): Promise<Translation> {
  const preflight = await preflightSelection(input, ledger)
  return preflight.kind === 'fatal' ? preflight.result : preflight.finish(observations)
}

function unitFor(result: Translation, prefix: string): Unit {
  const unit = result.units.find(item => item.unitId.startsWith(prefix))
  if (!unit) throw new Error('expected unit')
  return unit
}
function represented(result: Translation, prefix: string): RepresentableUnit {
  const unit = unitFor(result, prefix)
  if (unit.status !== 'representable') throw new Error('expected representable unit')
  return unit
}
const codes = (result: Translation) => result.compatibility.unsupported.map(issue => issue.code)
const pinsFor = (unit: RepresentableUnit, version = 'native-version') => Object.fromEntries(unit.inventory.files.map(file => [file.sourceRef, { version }]))

describe('selected import translation', () => {
  it('keeps shared resources once, evidence edges, policies and exact selected destination', async () => {
    const { input, observations } = await makeSelectedFixture()
    const result = await translateSelection(input, null, observations)
    const t = represented(result, 'tree:'), s = represented(result, 'slug:sample')
    expect(t.status).toBe('representable')
    expect(s.status).toBe('representable')
    expect(t.command.files).toHaveLength(9)
    expect(t.command.files.filter(f => f.path === '/tree/fragment.html')).toHaveLength(1)
    expect(t.command.edges.filter(e => e.path === '/tree/fragment.html')).toHaveLength(2)
    expect(t.inventory.operations.filter(op => op.kind === 'page_policy')).toHaveLength(2)
    expect(t.inventory.operations.filter(op => op.kind === 'preview_selection')).toHaveLength(1)
    expect(t.inventory.pageMappings.map(m => m.documentPath)).not.toContain('/tree/fragment.html')
    const alias = s.inventory.operations.find(op => op.kind === 'alias')
    const link = s.inventory.operations.find(op => op.kind === 'shortlink')
    const policy = s.inventory.operations.find(op => op.kind === 'page_policy')
    expect(alias?.aliasKind).toBe('redirect_exact')
    expect(link?.mapping.destination).toBe(input.shortlinks[0].destination)
    expect(policy?.policy.share.key).toBe('syntheticSlugKey')
    expect(JSON.stringify(result.compatibility)).not.toContain('syntheticSlugKey')
    expect(JSON.stringify(result.compatibility)).not.toContain(input.shortlinks[0].destination)
    expect(result.census).toHaveLength(input.entries.length + input.pages.length + input.owners.length + input.aliases.length + input.shortlinks.length + input.previews.length + input.exclusions.length + input.providerMounts.length + input.consumerUrls.length)
    expect(result.census.every(row => row.disposition === 'represented' || row.disposition === 'excluded')).toBe(true)
    expect(new Set(result.accounting.map(row => row.path)).size).toBe(input.entries.length)
  })

  it('persists random opaque IDs while fresh ledgers mint distinct identities', async () => {
    const { input, observations } = await makeSelectedFixture()
    const first = await translateSelection(input, null, observations)
    const again = await translateSelection(input, first.ledger, observations)
    const fresh = await translateSelection(input, null, observations)
    expect(again.ledger).toEqual(first.ledger)
    expect(represented(again, 'tree:').selection).toEqual(represented(first, 'tree:').selection)
    expect(first.ledger.pages['tree/one.html']).toMatch(/^pg_[a-z2-7]{26}$/)
    expect(fresh.ledger.pages['tree/one.html']).not.toBe(first.ledger.pages['tree/one.html'])
  })

  it('reports missing public document while independent units remain representable', async () => {
    const { input, observations } = await makeSelectedFixture({ includeMissing: true })
    const result = await translateSelection(input, null, observations)
    expect(codes(result)).toContain('or1_missing_document')
    expect(result.accounting.find(row => row.path === '/missing.html')?.disposition).toBe('blocked')
    expect(unitFor(result, 'tree:synthetic').status).toBe('representable')
    expect(unitFor(result, 'slug:sample').status).toBe('representable')
  })

  it('does not import a key without shared visibility and distinguishes capture states', async () => {
    const { input, observations } = await makeSelectedFixture()
    input.pages[0].share = { state: 'present', key: 'staleSyntheticKey', expiresAt: null }
    input.pages[0].visibility = { state: 'absent' }
    const result = await translateSelection(input, null, observations)
    expect(codes(result)).toContain('share_key_not_imported')
    const operation = represented(result, 'tree:').inventory.operations.find(op => op.kind === 'page_policy' && op.policy.sourcePageId === 'tree/one.html')
    if (!operation || operation.kind !== 'page_policy') throw new Error('expected page policy')
    const policy = operation.policy
    expect(policy.grantId).toBeNull()
    expect(policy.share.key).toBe('staleSyntheticKey')
    expect(policy.visibility.value).toBeNull()
    observations['/tree/asset0.css'] = { state: 'unreadable' }
    observations['/tree/asset1.css'] = { state: 'absent' }
    delete observations['/tree/asset2.css']
    const missing = await translateSelection(input, result.ledger, observations)
    expect(codes(missing)).toEqual(expect.arrayContaining(['capture_unreadable', 'capture_absent', 'capture_unknown']))
  })

  it('blocks unobserved policy evidence and retains captured unknown values', async () => {
    const { input, observations } = await makeSelectedFixture()
    input.pages[2].visibility = { state: 'unknown' }
    const unknown = await translateSelection(input, null, observations)
    expect(codes(unknown)).toContain('visibility_unknown')
    expect(unknown.units.flatMap(unit => unit.command?.pages ?? []).some(page => page.documentPath === '/a/sample/index.html')).toBe(false)
    input.pages[2].visibility = { state: 'present', value: 'historic-custom', metadataV: 'historic-custom', expiresAt: null }
    input.pages[2].share = { state: 'unreadable' }
    const unreadable = await translateSelection(input, null, observations)
    expect(codes(unreadable)).toContain('share_key_unreadable')
    input.pages[2].share = { state: 'absent' }
    const stale = await translateSelection(input, null, observations)
    expect(unitFor(stale, 'slug:sample').status).toBe('blocked')
    expect(codes(stale)).toContain('shortlink_destination_unverified')
    input.shortlinks[0].destination = 'https://forge.example.test/a/sample/'
    const captured = await translateSelection(input, null, observations)
    const operation = represented(captured, 'slug:sample').inventory.operations.find(op => op.kind === 'page_policy')
    if (!operation || operation.kind !== 'page_policy') throw new Error('expected page policy')
    expect(operation.policy.visibility).toEqual({ captured: true, value: 'historic-custom', metadataV: 'historic-custom', expiresAt: null })
    expect(operation.policy.share).toEqual({ captured: true, key: null, expiresAt: null })
    const mapping = represented(captured, 'slug:sample').inventory.operations.find(op => op.kind === 'shortlink')
    if (!mapping || mapping.kind !== 'shortlink') throw new Error('expected shortlink')
    expect(mapping.mapping.grantId).toBeNull()
    expect(mapping.mapping.destination).toBe('https://forge.example.test/a/sample/')
  })

  it('preflights the whole affected artifact without reading its selected bodies', async () => {
    const { input, observations } = await makeSelectedFixture()
    input.pages[0].visibility = { state: 'present', value: null, metadataV: null, expiresAt: null }
    const preflight = await preflightSelection(input)
    if (preflight.kind !== 'prepared') throw new Error('expected independent unit')
    expect(preflight.readOrdinals.map(index => input.entries[index].path).every(path => path.startsWith('/a/sample/'))).toBe(true)
    expect(preflight.protectedOrdinals.map(index => input.entries[index].path)).toContain('/tree/two.html')
    const result = await preflight.finish(observations)
    expect(unitFor(result, 'tree:').status).toBe('blocked')
    expect(unitFor(result, 'slug:sample').status).toBe('representable')
    expect(codes(result)).toContain('visibility_present_without_value')
    input.pages[0].visibility = { state: 'present', value: '', metadataV: '', expiresAt: null }
    const captured = await translateSelection(input, null, observations)
    const policy = represented(captured, 'tree:').inventory.operations.find(op => op.kind === 'page_policy' && op.policy.sourcePageId === 'tree/one.html')
    if (!policy || policy.kind !== 'page_policy') throw new Error('expected page policy')
    expect(policy.policy.visibility.value).toBe('')
    expect(policy.policy.visibility.metadataV).toBe('')
    input.pages[0].visibility = { state: 'present', value: 'null', metadataV: 'null', expiresAt: null }
    const literal = await translateSelection(input, null, observations)
    const literalPolicy = represented(literal, 'tree:').inventory.operations.find(op => op.kind === 'page_policy' && op.policy.sourcePageId === 'tree/one.html')
    if (!literalPolicy || literalPolicy.kind !== 'page_policy') throw new Error('expected page policy')
    expect(literalPolicy.policy.visibility.value).toBe('null')
    input.pages[0].share = { state: 'present', key: null, expiresAt: null }
    const missingKey = await preflightSelection(input)
    if (missingKey.kind !== 'prepared') throw new Error('expected independent unit')
    expect(missingKey.readOrdinals.map(index => input.entries[index].path).every(path => path.startsWith('/a/sample/'))).toBe(true)
  })

  it('accepts canonical metadata arrays and Unicode within the native string limit', async () => {
    const { input, observations } = await makeSelectedFixture()
    input.pages[0].metadata = ['漢'.repeat(3000)]
    const result = await translateSelection(input, null, observations)
    expect(represented(result, 'tree:').command.pages.find(page => page.documentPath === '/tree/one.html')?.metadata).toEqual(['漢'.repeat(3000)])
    input.pages[0].metadata = ['漢'.repeat(8192)]
    const oversized = await translateSelection(input, null, observations)
    expect(codes(oversized)).toContain('metadata_too_large')
  })

  it('recognizes an original preview inside its own slug without a tree edge', async () => {
    const { input, observations } = await makeSelectedFixture()
    const original = input.entries.find(entry => entry.path === '/tree/preview.png')
    if (!original) throw new Error('expected preview')
    const path = '/a/sample/preview.png'
    input.entries.push({ ...original, path, locator: { root: 'capture', relative: path.slice(1) }, placement: { sourceArtifactId: 'slug:sample', evidenceRef: 'synthetic-placement' } })
    observations[path] = observations[original.path]
    input.previews.push({ sourcePageId: 'sample', path, kind: 'original' })
    const result = await translateSelection(input, null, observations)
    expect(represented(result, 'slug:sample').inventory.operations).toContainEqual(expect.objectContaining({ kind: 'preview_selection', path }))
    expect(codes(result)).not.toContain('preview_not_owned')
  })

  it('uses original membership and blocks only the artifact missing a selected child', async () => {
    const { input, observations } = await makeSelectedFixture()
    observations['/a/sample/nested/index.html'] = { state: 'absent' }
    const result = await translateSelection(input, null, observations)
    expect(unitFor(result, 'slug:sample').status).toBe('blocked')
    expect(unitFor(result, 'tree:').status).toBe('representable')
    expect(result.accounting.find(row => row.path === '/a/sample/nested/index.html')?.unitId).toBe('slug:sample')
    expect(result.census?.find(row => row.kind === 'page' && row.unitId === 'slug:sample')?.disposition).toBe('rejected')
    expect(represented(result, 'tree:').inventory.sourceArtifactId).toBe('tree:synthetic')
  })

  it('keeps source membership without inferring a join from ownership', async () => {
    const { input, observations } = await makeSelectedFixture()
    input.owners = input.owners.filter(owner => owner.path !== '/tree/fragment.html' || owner.ownerSourcePageId !== 'tree/two.html')
    const joined = await translateSelection(input, null, observations)
    expect(represented(joined, 'tree:').command.pages).toHaveLength(2)
    const other = input.pages.find(page => page.sourcePageId === 'tree/two.html')
    const document = input.entries.find(entry => entry.path === '/tree/two.html')
    if (!other || !document) throw new Error('expected tree page')
    other.membership = { sourceArtifactId: 'tree:other', evidenceRef: 'synthetic-membership' }
    document.placement = { sourceArtifactId: 'tree:other', evidenceRef: 'synthetic-placement' }
    input.owners.push({ path: '/tree/fragment.html', ownerSourcePageId: 'tree/two.html', evidenceRef: 'synthetic-edge', basis: 'declared' })
    const split = await translateSelection(input, null, observations)
    expect(unitFor(split, 'tree:other').status).toBe('blocked')
    expect(represented(split, 'tree:synthetic').command.pages).toHaveLength(1)
    expect(codes(split)).toContain('provider_mount_required')
  })

  it('blocks repeated preview selection using the native operation-set rule', async () => {
    const { input, observations } = await makeSelectedFixture()
    const original = input.entries.find(entry => entry.path === '/tree/preview.png')
    if (!original) throw new Error('expected preview')
    const path = '/tree/second-preview.png'
    input.entries.push({ ...original, path, locator: { root: 'capture', relative: path.slice(1) } })
    observations[path] = observations[original.path]
    input.owners.push({ path, ownerSourcePageId: 'tree/one.html', evidenceRef: 'synthetic-edge', basis: 'declared' })
    input.previews.push({ sourcePageId: 'tree/one.html', path, kind: 'original' })
    const preflight = await preflightSelection(input)
    if (preflight.kind !== 'prepared') throw new Error('expected independent unit')
    expect(preflight.readOrdinals.map(index => input.entries[index].path).every(value => value.startsWith('/a/sample/'))).toBe(true)
    const result = await preflight.finish(observations)
    expect(unitFor(result, 'tree:').status).toBe('blocked')
    expect(codes(result)).toContain('conflicting_import_operations')
    expect(unitFor(result, 'slug:sample').status).toBe('representable')
  })

  it('rejects malformed and dangling selected relationships instead of dropping them', async () => {
    const { input, observations } = await makeSelectedFixture()
    input.shortlinks[0].observedAt = -1
    const malformed = await translateSelection(input, null, observations)
    expect(unitFor(malformed, 'slug:sample').status).toBe('blocked')
    expect(malformed.census?.find(row => row.kind === 'shortlink')?.disposition).toBe('rejected')
    input.shortlinks[0].targetSourcePageId = 'not-selected'
    const dangling = await translateSelection(input, null, observations)
    expect(dangling.fatal).toBe('unassignable_record')
  })

  it('does not associate stale shortlinks or claim disabled grammar is represented', async () => {
    const { input, observations } = await makeSelectedFixture()
    input.shortlinks[0].destination = 'https://forge.example.test/s/sample/?k=otherSyntheticKey'
    const stale = await translateSelection(input, null, observations)
    expect(codes(stale)).toContain('shortlink_destination_unverified')
    expect(unitFor(stale, 'slug:sample').status).toBe('blocked')
    input.shortlinks[0].destination = 'https://forge.example.test/s/sample/?k=syntheticSlugKey#section'
    input.reader.shareGrammars = ['page', 'card']
    input.consumerUrls.push({ url: 'https://forge.example.test/s/sample/?k=syntheticSlugKey', purpose: 'share', targetSourcePageId: 'sample', mappingRef: null })
    const disabled = await translateSelection(input, null, observations)
    expect(codes(disabled)).toContain('consumer_url_unsupported')
    expect(disabled.census?.find(row => row.kind === 'consumerUrl')?.disposition).toBe('rejected')
  })

  it('blocks changed observed bytes instead of adopting them', async () => {
    const { input, observations } = await makeSelectedFixture()
    const observed = observations['/tree/one.html']
    if (!observed || observed.state !== 'present') throw new Error('expected captured bytes')
    observations['/tree/one.html'] = { ...observed, sha256: 'f'.repeat(64) }
    const result = await translateSelection(input, null, observations)
    expect(codes(result)).toContain('capture_fingerprint_mismatch')
    expect(result.accounting.find(row => row.path === '/tree/one.html')?.disposition).toBe('blocked')
    expect(result.units.flatMap(u => u.command?.pages ?? []).map(p => p.documentPath)).not.toContain('/tree/one.html')
  })

  it('accounts for absent reserved metadata only with explicit exclusion evidence', async () => {
    const { input, observations } = await makeSelectedFixture()
    input.entries.push({ path: '/asset-owners.json', graphClass: 'excluded', contentType: null, locator: { root: 'capture', relative: 'asset-owners.json' }, provenance: 'synthetic-metadata', expected: null, placement: null })
    input.exclusions.push({ path: '/asset-owners.json', evidenceRef: 'synthetic-control-evidence', reason: 'engine' })
    const result = await translateSelection(input, null, observations)
    expect(result.accounting.filter(row => row.path === '/asset-owners.json')).toEqual([
      { path: '/asset-owners.json', disposition: 'excluded', unitId: null, reason: 'engine' },
    ])
    expect(result.units.flatMap(unit => unit.command?.files ?? []).some(file => file.path === '/asset-owners.json')).toBe(false)
    input.exclusions = []
    const unapproved = await translateSelection(input, result.ledger, observations)
    expect(unapproved.accounting.filter(row => row.path === '/asset-owners.json')).toEqual([
      { path: '/asset-owners.json', disposition: 'blocked', unitId: null, reason: 'exclusion_evidence_required' },
    ])
    expect(unitFor(unapproved, 'tree:').status).toBe('representable')
  })

  it('distinguishes fatal input from an all-excluded selection and partial compatibility', async () => {
    const { input, observations } = await makeSelectedFixture({ includeMissing: true })
    const partial = await translateSelection(input, null, observations)
    expect(partial.fatal).toBeNull()
    expect(partial.ok).toBe(false)
    input.entries = [{ path: '/asset-owners.json', graphClass: 'excluded', contentType: null, locator: { root: 'capture', relative: 'asset-owners.json' }, provenance: 'synthetic-metadata', expected: null, placement: null }]
    input.exclusions = [{ path: '/asset-owners.json', evidenceRef: 'synthetic-evidence', reason: 'engine' }]
    input.pages = []
    input.owners = []
    input.aliases = []
    input.shortlinks = []
    input.previews = []
    const excluded = await translateSelection(input, null, {})
    expect(excluded.fatal).toBeNull()
    expect(excluded.ok).toBe(true)
    expect(excluded.units).toHaveLength(0)
    input.entries.push(input.entries[0])
    const contradictory = await translateSelection(input, null, {})
    expect(contradictory.fatal).toBe('contradictory_input')
    expect(contradictory.units).toHaveLength(0)
  })

  it('budgets the actual cursor envelope and pinned inventory, requiring native versions', async () => {
    const { input, observations } = await makeSelectedFixture()
    const result = await translateSelection(input, null, observations)
    const unit = represented(result, 'tree:')
    const envelopeBytes = new TextEncoder().encode(stable({ op: 'dry_run', selection: unit.selection, cursor: 'x'.repeat(16384) })).length
    expect(unit.budget.envelopeBytes).toBe(envelopeBytes)
    const small = structuredClone(input)
    small.limits.maxCommandBytes = envelopeBytes - 1
    const limited = await translateSelection(small, result.ledger, observations)
    expect(unitFor(limited, 'tree:').status).toBe('blocked')
    expect(unitFor(limited, 'tree:').budget.failed).toContain('command_bytes')
    expect(assignSourcePins(unit, {})).toMatchObject({ ok: false, code: 'native_version_required' })
    expect(assignSourcePins(unit, pinsFor(unit, 'placeholder'))).toMatchObject({ ok: false, code: 'native_version_required' })
    const pinned = assignSourcePins(unit, pinsFor(unit))
    if (!pinned.ok) throw new Error('expected pinned inventory')
    expect(assignSourcePins({ ...unit, maxInventoryBytes: pinned.bytes.length - 1 }, pinsFor(unit))).toMatchObject({ ok: false, code: 'inventory_budget_exceeded' })
    const sealed = sealInventory(pinned.unit, { key: 'synthetic-inventory', version: 'inventory-native-version' }, 'a'.repeat(64))
    if (!sealed.ok) throw new Error('expected sealed inventory')
    expect(sealed.unit.pinState).toBe('pinned')
  })
})
