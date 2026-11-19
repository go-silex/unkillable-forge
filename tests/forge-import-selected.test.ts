import { describe, expect, it } from 'vitest'
import { translateSelection, assignSourcePins, sealInventory, stable, type Translation, type Unit, type RepresentableUnit } from '../scripts/forge-import-selected.mjs'
import { makeSelectedFixture } from './engine/fixtures/import-selected.mjs'

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
    expect(unitFor(result, 'tree:').status).toBe('representable')
    expect(unitFor(result, 'slug:sample').status).toBe('representable')
  })

  it('does not import a key without shared visibility and distinguishes capture states', async () => {
    const { input, observations } = await makeSelectedFixture()
    input.pages[0].share = { state: 'present', key: 'staleSyntheticKey', expiresAt: null }
    input.pages[0].visibility = { state: 'absent' }
    const result = await translateSelection(input, null, observations)
    expect(codes(result)).toContain('share_key_not_imported')
    expect(JSON.stringify(result)).not.toContain('staleSyntheticKey')
    const operation = represented(result, 'tree:').inventory.operations.find(op => op.kind === 'page_policy' && op.policy.sourcePageId === 'tree/one.html')
    if (!operation || operation.kind !== 'page_policy') throw new Error('expected page policy')
    const policy = operation.policy
    expect(policy.grantId).toBeNull()
    expect(policy.share.key).toBeNull()
    expect(policy.visibility.value).toBeNull()
    observations['/tree/asset0.css'] = { state: 'unreadable' }
    observations['/tree/asset1.css'] = { state: 'absent' }
    delete observations['/tree/asset2.css']
    const missing = await translateSelection(input, result.ledger, observations)
    expect(codes(missing)).toEqual(expect.arrayContaining(['capture_unreadable', 'capture_absent', 'capture_unknown']))
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
    input.entries.push({ path: '/asset-owners.json', graphClass: 'excluded', contentType: null, locator: { root: 'capture', relative: 'asset-owners.json' }, provenance: 'synthetic-metadata', expected: null })
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
