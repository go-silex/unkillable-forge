import { describe, expect, it } from 'vitest'
import { preflightSelection, projectTranslation, assignSourcePins, sealInventory, stable, type Translation, type Unit, type RepresentableUnit } from '../scripts/forge-import-selected.mjs'
import type { ImportOperation } from '../domains/catalogue/import'
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
    const key = stable([input.sourceInstance, 'tree:synthetic', 'tree/one.html'])
    expect(first.ledger.pages[key]).toMatch(/^pg_[a-z2-7]{26}$/)
    expect(fresh.ledger.pages[key]).not.toBe(first.ledger.pages[key])
    const other = structuredClone(input)
    other.sourceInstance = 'other-synthetic-instance'
    const isolated = await translateSelection(other, first.ledger, observations)
    expect(represented(isolated, 'tree:').command.pages[0].pageId).not.toBe(represented(first, 'tree:').command.pages[0].pageId)
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
    expect(preflight.reads.map(read => read.path).every(path => path.startsWith('/a/sample/'))).toBe(true)
    expect(preflight.protectedLocators.map(row => row.locator.relative)).not.toContain('tree/two.html')
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
    expect(missingKey.reads.map(read => read.path).every(path => path.startsWith('/a/sample/'))).toBe(true)
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
    expect(preflight.reads.map(read => read.path).every(value => value.startsWith('/a/sample/'))).toBe(true)
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

  it('vetoes an excluded placed body and preserves independent readable units', async () => {
    const { input, observations } = await makeSelectedFixture()
    input.exclusions.push({ path: '/tree/asset0.css', evidenceRef: 'synthetic-exclusion', reason: 'non_content' })
    const prepared = await preflightSelection(input)
    if (prepared.kind !== 'prepared') throw new Error('expected prepared selection')
    expect(prepared.reads.some(read => read.path === '/tree/asset0.css')).toBe(false)
    expect(prepared.protectedLocators.some(row => row.locator.relative === 'tree/asset0.css')).toBe(true)
    const result = await prepared.finish(observations)
    expect(unitFor(result, 'tree:').status).toBe('blocked')
    expect(unitFor(result, 'slug:').status).toBe('representable')
    expect(codes(result)).toContain('excluded_content_contradiction')
  })

  it('projects byte and pin failures consistently without promoting rejected facts', async () => {
    const { input, observations } = await makeSelectedFixture()
    input.consumerUrls.push({ url: 'https://links.example.test/abc', purpose: 'shortlink', targetSourcePageId: 'sample', mappingRef: 'synthetic-mapping' })
    const prepared = await preflightSelection(input)
    if (prepared.kind !== 'prepared') throw new Error('expected prepared selection')
    const result = await prepared.finish(observations)
    const projected = projectTranslation(result, [{ kind: 'unit', unitId: 'slug:sample', code: 'inventory_budget_exceeded' }])
    expect(unitFor(projected, 'slug:').status).toBe('blocked')
    expect(unitFor(projected, 'tree:').status).toBe('representable')
    expect(projected.census.find(row => row.kind === 'consumerUrl')?.disposition).toBe('rejected')
    expect(projected.compatibility.represented.some(issue => issue.unitId === 'slug:sample')).toBe(false)
    expect(codes(projected)).toContain('inventory_budget_exceeded')
    expect(projectTranslation(projected).units.find(unit => unit.unitId === 'slug:sample')?.status).toBe('blocked')
  })

  it('blocks a malformed mapping assertion only in its attributable artifact', async () => {
    const { input, observations } = await makeSelectedFixture()
    input.consumerUrls.push({ url: 'https://forge.example.test/tree/one', purpose: 'document', targetSourcePageId: 'tree/one.html', mappingRef: 'missing' })
    const result = await translateSelection(input, null, observations)
    expect(unitFor(result, 'tree:').status).toBe('blocked')
    expect(unitFor(result, 'slug:').status).toBe('representable')
    expect(result.census.find(row => row.kind === 'consumerUrl')?.disposition).toBe('rejected')
  })

  it('rejects duplicate owner edges and ownerless fragments before body authorization', async () => {
    const { input } = await makeSelectedFixture()
    input.owners.push({ ...input.owners[0], evidenceRef: 'another-evidence' })
    const prepared = await preflightSelection(input)
    if (prepared.kind !== 'prepared') throw new Error('expected prepared selection')
    expect(prepared.reads.every(read => read.path.startsWith('/a/sample/'))).toBe(true)
    input.owners = input.owners.filter(owner => owner.path !== '/tree/fragment.html')
    const ownerless = await preflightSelection(input)
    if (ownerless.kind !== 'prepared') throw new Error('expected prepared selection')
    expect(ownerless.reads.some(read => read.path === '/tree/fragment.html')).toBe(false)
  })

  it('reserves native controls but does not protect omitted foreign subtree content', async () => {
    const { input } = await makeSelectedFixture()
    const example = input.entries.find(entry => entry.path === '/tree/asset0.css')
    if (!example) throw new Error('expected asset')
    input.entries.push({ ...example, path: '/cdn-cgi/synthetic.css', locator: { root: 'capture', relative: 'cdn-cgi/synthetic.css' } })
    input.entries.push({ ...example, path: '/a/foreign/synthetic.css', locator: { root: 'capture', relative: 'a/foreign/synthetic.css' } })
    const result = await preflightSelection(input)
    if (result.kind !== 'prepared') throw new Error('expected prepared selection')
    expect(result.protectedLocators.some(row => row.locator.relative === 'cdn-cgi/synthetic.css')).toBe(true)
    expect(result.protectedLocators.some(row => row.locator.relative === 'a/foreign/synthetic.css')).toBe(false)
    expect(result.reads.some(row => row.path === '/a/foreign/synthetic.css')).toBe(false)
    expect(result.reads.some(row => row.path === '/a/sample/index.html')).toBe(true)
  })

  it('rejects invalid reader profiles before authorizing any body', async () => {
    const { input } = await makeSelectedFixture()
    input.reader.shellPaths = []
    expect(await preflightSelection(input)).toMatchObject({ kind: 'fatal', result: { fatal: 'invalid_grammar' } })
    input.reader.shellPaths = ['/login', '/api/private']
    expect(await preflightSelection(input)).toMatchObject({ kind: 'fatal', result: { fatal: 'invalid_grammar' } })
  })

  it('treats a misplaced public document differently from absent inventory', async () => {
    const { input, observations } = await makeSelectedFixture()
    const document = input.entries.find(entry => entry.path === '/tree/one.html')
    if (!document) throw new Error('expected document')
    document.placement = { sourceArtifactId: 'slug:sample', evidenceRef: 'synthetic-contradiction' }
    const result = await translateSelection(input, null, observations)
    expect(codes(result)).toContain('document_placement_conflict')
    expect(codes(result)).not.toContain('or1_missing_document')
    expect(result.census.find(row => row.kind === 'entry' && row.ordinal === input.entries.indexOf(document))?.affectedUnitIds).toEqual(expect.arrayContaining(['tree:synthetic', 'slug:sample']))
  })

  it('rejects an orphan document before body reads while keeping other units', async () => {
    const { input } = await makeSelectedFixture()
    const original = input.entries.find(entry => entry.path === '/tree/one.html')
    if (!original) throw new Error('expected document')
    input.entries.push({ ...original, path: '/tree/orphan.html', locator: { root: 'capture', relative: 'tree/orphan.html' } })
    const result = await preflightSelection(input)
    if (result.kind !== 'prepared') throw new Error('expected prepared selection')
    expect(result.reads.some(read => read.path === '/tree/orphan.html')).toBe(false)
    expect(result.reads.some(read => read.path === '/a/sample/index.html')).toBe(true)
  })

  it('requires the card owner and the actual winning original image', async () => {
    const { input, observations } = await makeSelectedFixture()
    const original = input.entries.find(entry => entry.path === '/tree/preview.png')
    if (!original) throw new Error('expected preview')
    const card = '/tree/two.og.png'
    input.entries.push({ ...original, path: card, locator: { root: 'capture', relative: card.slice(1) } })
    observations[card] = observations[original.path]
    input.owners.push({ path: card, ownerSourcePageId: 'tree/one.html', evidenceRef: 'synthetic-edge', basis: 'declared' })
    input.consumerUrls.push({ url: 'https://forge.example.test/s/tree/two.og.png/syntheticTreeKey/', purpose: 'card', targetSourcePageId: 'tree/two.html', mappingRef: null })
    const wrong = await translateSelection(input, null, observations)
    expect(unitFor(wrong, 'tree:').status).toBe('blocked')
    input.owners.at(-1)!.ownerSourcePageId = 'tree/two.html'
    const owned = await translateSelection(input, null, observations)
    expect(unitFor(owned, 'tree:').status).toBe('representable')
    const alternate = '/tree/alternate.png'
    input.entries.push({ ...original, path: alternate, locator: { root: 'capture', relative: alternate.slice(1) } })
    observations[alternate] = observations[original.path]
    input.owners.push({ path: alternate, ownerSourcePageId: 'tree/two.html', evidenceRef: 'synthetic-edge', basis: 'declared' })
    input.previews.push({ sourcePageId: 'tree/two.html', path: alternate, kind: 'original' })
    const overridden = await translateSelection(input, null, observations)
    expect(unitFor(overridden, 'tree:').status).toBe('blocked')
  })

  it('indexes dense evidenced edges and covers each selected record', async () => {
    const { input, observations } = await makeSelectedFixture()
    const original = input.entries.find(entry => entry.path === '/tree/fragment.html')
    if (!original) throw new Error('expected fragment')
    for (let index = 0; index < 120; index++) {
      const path = `/tree/dense${index}.html`
      input.entries.push({ ...original, path, locator: { root: 'capture', relative: path.slice(1) } })
      observations[path] = observations[original.path]
      for (const ownerSourcePageId of ['tree/one.html', 'tree/two.html']) input.owners.push({ path, ownerSourcePageId, evidenceRef: 'synthetic-dense-edge', basis: 'declared' })
    }
    const result = await translateSelection(input, null, observations)
    const tree = represented(result, 'tree:')
    expect(tree.command.edges.filter(edge => edge.path.includes('/dense'))).toHaveLength(240)
    expect(result.census.filter(row => row.kind === 'owner')).toHaveLength(input.owners.length)
    expect(result.census.every(row => row.disposition !== 'rejected')).toBe(true)
  })

  it('uses decoded alias fallback, longest prefix and shell precedence', async () => {
    const { input, observations } = await makeSelectedFixture()
    input.aliases.push({ aliasKind: 'redirect_prefix', path: '/old/', to: '/a/sample/', status: 301, targetSourcePageId: 'sample', capturedBehavior: 'team_fallback' })
    input.consumerUrls.push({ url: 'https://forge.example.test/old/nest%65d?not-forwarded=1', purpose: 'alias', targetSourcePageId: 'sample', mappingRef: null })
    const valid = await translateSelection(input, null, observations)
    expect(unitFor(valid, 'slug:').status).toBe('representable')
    input.aliases.push({ aliasKind: 'redirect_exact', path: '/old/nested', to: '/tree/one', status: 301, targetSourcePageId: 'tree/one.html', capturedBehavior: 'team_fallback' })
    const shadowed = await translateSelection(input, null, observations)
    expect(shadowed.census.find(row => row.kind === 'consumerUrl')?.disposition).toBe('rejected')
    input.consumerUrls[0].url = 'https://forge.example.test/login'
    const shell = await translateSelection(input, null, observations)
    expect(shell.census.find(row => row.kind === 'consumerUrl')?.disposition).toBe('rejected')
  })

  it('keeps exact and prefix alias operation identities distinct for the same key', async () => {
    const { input, observations } = await makeSelectedFixture()
    input.aliases.push({ aliasKind: 'redirect_exact', path: '/old/', to: '/a/sample/', status: 301, targetSourcePageId: 'sample', capturedBehavior: 'team_fallback' })
    input.aliases.push({ aliasKind: 'redirect_prefix', path: '/old/', to: '/a/sample/', status: 301, targetSourcePageId: 'sample', capturedBehavior: 'team_fallback' })
    const result = await translateSelection(input, null, observations)
    const operations = represented(result, 'slug:').inventory.operations.filter((op): op is Extract<ImportOperation, { kind: 'alias' }> => op.kind === 'alias' && op.path === '/old/')
    expect(operations).toHaveLength(2)
    expect(new Set(operations.map(op => op.operationId)).size).toBe(2)
  })

  it('contains attributable malformed aliases and previews to their own unit', async () => {
    const { input, observations } = await makeSelectedFixture()
    input.aliases[0].status = -1
    input.previews.push({ sourcePageId: 'sample', path: '/a/sample/missing.png', kind: 'original' })
    const result = await translateSelection(input, null, observations)
    expect(unitFor(result, 'slug:').status).toBe('blocked')
    expect(unitFor(result, 'tree:').status).toBe('representable')
    expect(result.census.filter(row => row.kind === 'alias' || row.kind === 'preview').filter(row => row.unitId === 'slug:sample').every(row => row.disposition === 'rejected')).toBe(true)
  })
  it('uses opaque bounded storage keys and retains blocked control locators', async () => {
    const { input, observations } = await makeSelectedFixture()
    const control = input.entries.find(entry => entry.path === '/tree/asset0.css')!
    control.locator.relative = 'nested/.ssh/id'
    const ordinary = input.entries.find(entry => entry.path === '/tree/asset1.css')!
    ordinary.locator.relative = 'ordinary.css'
    const prepared = await preflightSelection(input)
    if (prepared.kind !== 'prepared') throw new Error('expected prepared selection')
    expect(prepared.protectedLocators.map(item => item.locator.relative)).toContain('nested/.ssh/id')
    expect(prepared.reads.map(item => item.locator.relative)).not.toContain('ordinary.css')
    expect(prepared.reads.every(item => /^capture\/v1\/[a-f0-9]{64}\/\d+$/.test(item.sourceKey))).toBe(true)
    expect(prepared.inventoryKeys.every(key => /^inventory\/v1\/[a-f0-9]{64}\.json$/.test(key))).toBe(true)
    const result = await prepared.finish(observations)
    expect(unitFor(result, 'tree:').status).toBe('blocked')
    expect(unitFor(result, 'slug:').status).toBe('representable')
  })

  it('retains individual reread absence facts and projects them idempotently', async () => {
    const { input, observations } = await makeSelectedFixture()
    const prepared = await preflightSelection(input)
    if (prepared.kind !== 'prepared') throw new Error('expected prepared selection')
    const result = await prepared.finish(observations)
    const document = prepared.reads.find(item => item.path === '/tree/one.html')!
    const css = prepared.reads.find(item => item.path === '/tree/asset0.css')!
    const failures = [document, css].map(item => ({ kind: 'source' as const, entryOrdinal: item.ordinal, stage: 'pin_reread' as const, reason: 'absent' as const }))
    const projected = projectTranslation(result, failures)
    const missing = projected.compatibility.unsupported.filter(issue => issue.code === 'capture_absent')
    expect(missing).toHaveLength(2)
    expect(missing.map(issue => issue.entryOrdinal)).toEqual(expect.arrayContaining([document.ordinal, css.ordinal]))
    expect(projected.compatibility.unsupported.filter(issue => issue.code === 'or1_missing_document')).toHaveLength(1)
    expect(projectTranslation(projected, failures)).toEqual(projected)
    expect(() => projectTranslation(result, [{ ...failures[0], entryOrdinal: 999999 }])).toThrow('invalid_pin_failure')
  })

  it('rejects unused malformed replay values without issuing reads', async () => {
    const { input, observations } = await makeSelectedFixture()
    const first = await translateSelection(input, null, observations)
    for (const table of ['pages', 'grants', 'idempotencyKeys', 'inventoryIds', 'selectionIds', 'planIds', 'operationIds'] as const) {
      const ledger = structuredClone(first.ledger)
      ledger[table]['unused'] = ''
      const preflight = await preflightSelection(input, ledger)
      expect(preflight.kind).toBe('fatal')
      if (preflight.kind === 'fatal') expect(preflight.result.fatal).toBe('invalid_ledger')
    }
  })

  it('distinguishes a subtree stylesheet from the winning document', async () => {
    const { input, observations } = await makeSelectedFixture()
    const source = input.entries.find(entry => entry.path === '/a/sample/index.html')!
    const path = '/a/sample/style.css'
    input.entries.push({ ...source, path, graphClass: 'asset', contentType: 'text/css', locator: { root: 'capture', relative: 'a/sample/style.css' } })
    observations[path] = observations[source.path]
    input.consumerUrls.push({ url: 'https://forge.example.test/a/sample/style.css', purpose: 'document', targetSourcePageId: 'sample', mappingRef: null })
    const result = await translateSelection(input, null, observations)
    expect(unitFor(result, 'slug:').status).toBe('blocked')
    expect(unitFor(result, 'tree:').status).toBe('representable')
  })
  it('binds reproducible source keys to proposal identity and original ordinal', async () => {
    const { input, observations } = await makeSelectedFixture()
    const first = await preflightSelection(input)
    if (first.kind !== 'prepared') throw new Error('expected prepared selection')
    const translated = await first.finish(observations)
    const replay = await preflightSelection(input, translated.ledger)
    if (replay.kind !== 'prepared') throw new Error('expected replay')
    expect(replay.reads.map(read => read.sourceKey)).toEqual(first.reads.map(read => read.sourceKey))
    for (const read of first.reads) {
      const unit = represented(translated, read.unitId)
      expect(unit.inventory.files.find(file => file.path === read.path)?.sourceRef).toBe(read.sourceKey)
      expect(read.sourceKey.endsWith(`/${read.ordinal}`)).toBe(true)
    }
    const next = structuredClone(input)
    next.selectionRef = 'another-synthetic-selection'
    const other = await preflightSelection(next, translated.ledger)
    if (other.kind !== 'prepared') throw new Error('expected other proposal')
    expect(other.reads[0].sourceKey).not.toBe(first.reads[0].sourceKey)
  })
  it('retains missing and unverified external dependencies for each dependent unit', async () => {
    const { input, observations } = await makeSelectedFixture()
    const path = '/external/shared.css'
    for (const ownerSourcePageId of ['tree/one.html', 'sample']) input.owners.push({ path, ownerSourcePageId, evidenceRef: 'synthetic-external-edge', basis: 'declared' })
    const missing = await translateSelection(input, null, observations)
    for (const prefix of ['tree:', 'slug:']) {
      expect(unitFor(missing, prefix).dependencies).toContainEqual({ path, providerArtifactId: null, kind: null, state: 'missing' })
    }
    input.providerMounts.push({ path, kind: 'asset', artifactId: 'ar_aaaaaaaaaaaaaaaaaaaaaaaaaa' })
    const declared = await translateSelection(input, null, observations)
    for (const prefix of ['tree:', 'slug:']) {
      expect(unitFor(declared, prefix).dependencies).toContainEqual({ path, providerArtifactId: 'ar_aaaaaaaaaaaaaaaaaaaaaaaaaa', kind: 'asset', state: 'unverified' })
    }
    expect(declared.census.find(row => row.kind === 'providerMount')?.affectedUnitIds).toEqual(expect.arrayContaining(['tree:synthetic', 'slug:sample']))
  })

  it('contains invalid Unicode locator and logical asset to their known unit', async () => {
    for (const field of ['locator', 'path'] as const) {
      const { input, observations } = await makeSelectedFixture()
      const asset = input.entries.find(entry => entry.path === '/tree/asset0.css')!
      if (field === 'locator') asset.locator.relative = 'tree/\ud800.css'
      else {
        const previous = asset.path
        asset.path = '/tree/\ud800.css'
        input.owners.find(owner => owner.path === previous)!.path = asset.path
      }
      const prepared = await preflightSelection(input)
      if (prepared.kind !== 'prepared') throw new Error('expected prepared selection')
      expect(prepared.reads.some(read => read.unitId === 'tree:synthetic')).toBe(false)
      const result = await prepared.finish(observations)
      expect(unitFor(result, 'tree:').status).toBe('blocked')
      expect(unitFor(result, 'slug:').status).toBe('representable')
    }
  })
  it('rejects noncanonical ledger tuple spellings before source authorization', async () => {
    const { input, observations } = await makeSelectedFixture()
    const first = await translateSelection(input, null, observations)
    for (const table of ['pages', 'planIds'] as const) {
      const ledger = structuredClone(first.ledger)
      const key = Object.keys(ledger[table])[0]
      const value = ledger[table][key]
      delete ledger[table][key]
      ledger[table][key.replace(',', ', ')] = value
      const result = await preflightSelection(input, ledger)
      expect(result.kind).toBe('fatal')
      if (result.kind === 'fatal') expect(result.result.fatal).toBe('invalid_ledger')
    }
    const escaped = structuredClone(first.ledger)
    const key = Object.keys(escaped.pages)[0], value = escaped.pages[key]
    delete escaped.pages[key]
    escaped.pages[key.replace('synthetic', '\\u0073ynthetic')] = value
    expect((await preflightSelection(input, escaped)).kind).toBe('fatal')
    const invalidOperation = structuredClone(first.ledger)
    invalidOperation.operationIds['["unused"]'] = 'valid-operation-id'
    expect((await preflightSelection(input, invalidOperation)).kind).toBe('fatal')
  })

  it('projects fatal receipts without fabricating facts', async () => {
    for (const preflight of [await preflightSelection(null), await preflightSelection((await makeSelectedFixture()).input, { version: 1 })]) {
      if (preflight.kind !== 'fatal') throw new Error('expected fatal')
      expect(projectTranslation(preflight.result)).toBe(preflight.result)
      expect(preflight.result.facts).toBeUndefined()
    }
  })

  it('preserves thousands of distinct absent members and reprojection', async () => {
    const { input, observations } = await makeSelectedFixture()
    const template = input.entries.find(entry => entry.path === '/tree/asset0.css')!
    input.limits.maxCommandBytes = 20000000
    input.limits.maxInventoryBytes = 20000000
    for (let i = 0; i < 8000; i++) {
      const path = `/tree/missing-${i}.css`
      input.entries.push({ ...template, path, locator: { root: 'capture', relative: path.slice(1) } })
      input.owners.push({ path, ownerSourcePageId: 'tree/one.html', evidenceRef: 'synthetic-edge', basis: 'declared' })
      observations[path] = { state: 'absent' }
    }
    const prepared = await preflightSelection(input)
    if (prepared.kind !== 'prepared') throw new Error('expected prepared')
    const result = await prepared.finish(observations)
    const issues = unitFor(result, 'tree:').blockers.filter(issue => issue.code === 'capture_absent')
    expect(issues).toHaveLength(8000)
    expect(result.compatibility.unsupported.some(issue => issue.code === 'or1_missing_document')).toBe(false)
    expect(unitFor(result, 'slug:').status).toBe('representable')
    const ordinal = issues[0].entryOrdinal!
    const duplicate = { kind: 'source' as const, entryOrdinal: ordinal, stage: 'inspect' as const, reason: 'absent' as const }
    expect(projectTranslation(result, [duplicate])).toEqual(result)
    expect(unitFor(projectTranslation(result, [{ ...duplicate, stage: 'pin_reread' }]), 'tree:').blockers.filter(issue => issue.code === 'capture_absent')).toHaveLength(8001)
  })
  it('requires the captured key for a claimed alias destination', async () => {
    const { input, observations } = await makeSelectedFixture()
    input.aliases[0].to = '/s/sample/wrongSyntheticKey/'
    input.consumerUrls.push({ url: 'https://forge.example.test/legacy-sample', purpose: 'alias', targetSourcePageId: 'sample', mappingRef: null })
    const wrong = await translateSelection(input, null, observations)
    expect(unitFor(wrong, 'slug:').status).toBe('blocked')
    input.consumerUrls = []
    const stored = await translateSelection(input, null, observations)
    expect(represented(stored, 'slug:').inventory.operations).toContainEqual(expect.objectContaining({ kind: 'alias', to: '/s/sample/wrongSyntheticKey/' }))
    input.aliases[0].to = '/s/sample/syntheticSlugKey/'
    input.consumerUrls.push({ url: 'https://forge.example.test/legacy-sample', purpose: 'alias', targetSourcePageId: 'sample', mappingRef: null })
    expect(unitFor(await translateSelection(input, null, observations), 'slug:').status).toBe('representable')
  })

  it('ignores excluded census names while retaining actual alias precedence', async () => {
    const { input, observations } = await makeSelectedFixture()
    input.entries.push({ path: '/legacy-sample.html', graphClass: 'excluded', contentType: null, locator: { root: 'capture', relative: 'legacy-sample.html' }, provenance: 'synthetic-exclusion', expected: null, placement: null })
    input.exclusions.push({ path: '/legacy-sample.html', evidenceRef: 'synthetic-exclusion', reason: 'non_content' })
    input.consumerUrls.push({ url: 'https://forge.example.test/legacy-sample', purpose: 'alias', targetSourcePageId: 'sample', mappingRef: null })
    const excluded = await translateSelection(input, null, observations)
    expect(unitFor(excluded, 'slug:').status).toBe('representable')
    const template = input.entries.find(entry => entry.path === '/tree/fragment.html')!
    input.entries[input.entries.length - 1] = { ...template, path: '/legacy-sample.html', locator: { root: 'capture', relative: 'legacy-sample.html' } }
    input.exclusions = []
    input.owners.push({ path: '/legacy-sample.html', ownerSourcePageId: 'tree/one.html', evidenceRef: 'synthetic-edge', basis: 'declared' })
    observations['/legacy-sample.html'] = observations[template.path]
    const mounted = await translateSelection(input, null, observations)
    expect(unitFor(mounted, 'slug:').status).toBe('blocked')
  })

  it('contains an attributable malformed provider and retains known fatal attribution', async () => {
    const { input, observations } = await makeSelectedFixture()
    const templatePage = input.pages.find(page => page.sourcePageId === 'tree/one.html')!
    const templateEntry = input.entries.find(entry => entry.path === '/tree/one.html')!
    input.pages.push({ ...templatePage, sourcePageId: 'other.html', documentPath: '/other.html', membership: { sourceArtifactId: 'tree:other', evidenceRef: 'synthetic-membership' } })
    input.entries.push({ ...templateEntry, path: '/other.html', locator: { root: 'capture', relative: 'other.html' }, placement: { sourceArtifactId: 'tree:other', evidenceRef: 'synthetic-placement' } })
    observations['/other.html'] = observations[templateEntry.path]
    const path = '/external/shared.css'
    for (const ownerSourcePageId of ['tree/one.html', 'sample']) input.owners.push({ path, ownerSourcePageId, evidenceRef: 'synthetic-external', basis: 'declared' })
    input.providerMounts.push({ path, kind: 'asset', artifactId: 'mistyped-provider' })
    const result = await translateSelection(input, null, observations)
    for (const prefix of ['tree:synthetic', 'slug:']) {
      expect(unitFor(result, prefix).dependencies).toContainEqual({ path, providerArtifactId: null, kind: 'asset', state: 'missing' })
    }
    expect(unitFor(result, 'tree:other').status).toBe('representable')
    expect(result.census.find(row => row.kind === 'providerMount')).toEqual(expect.objectContaining({ ordinal: 0, affectedUnitIds: expect.arrayContaining(['tree:synthetic', 'slug:sample']), reason: 'invalid_provider_mount' }))
    input.providerMounts.push({ path: '/unknown.css', kind: 'asset', artifactId: 'mistyped-provider' })
    const fatal = await preflightSelection(input)
    if (fatal.kind !== 'fatal') throw new Error('expected fatal')
    expect(fatal.result.census.find(row => row.kind === 'providerMount' && row.ordinal === 0)?.affectedUnitIds).toEqual(expect.arrayContaining(['tree:synthetic', 'slug:sample']))
  })
  it('retains the exact private locator on its ordinal fact', async () => {
    const { input, observations } = await makeSelectedFixture()
    const item = input.entries.find(entry => entry.path === '/tree/one.html')!
    item.locator.relative = 'captured/different-name.html'
    const prepared = await preflightSelection(input)
    if (prepared.kind !== 'prepared') throw new Error('expected prepared')
    const result = await prepared.finish(observations)
    expect(result.facts).toContainEqual(expect.objectContaining({ kind: 'entry', ordinal: input.entries.indexOf(item), path: item.path, unitId: 'tree:synthetic', locator: { root: 'capture', relative: 'captured/different-name.html' } }))
  })
  it('does not represent a shortlink whose destination key is stale', async () => {
    const { input, observations } = await makeSelectedFixture()
    input.shortlinks[0].destination = 'https://forge.example.test/s/sample/?k=wrongSyntheticKey'
    input.consumerUrls.push({ url: input.shortlinks[0].shortUrl, purpose: 'shortlink', targetSourcePageId: 'sample', mappingRef: 'synthetic-mapping' })
    const result = await translateSelection(input, null, observations)
    expect(unitFor(result, 'slug:').status).toBe('blocked')
    expect(result.census.find(row => row.kind === 'consumerUrl')?.disposition).toBe('rejected')
    expect(unitFor(result, 'tree:').status).toBe('representable')
  })
  it('treats an ownerless placed asset as a mounted alias collision', async () => {
    const { input, observations } = await makeSelectedFixture()
    const template = input.entries.find(entry => entry.path === '/tree/asset0.css')!
    input.entries.push({ ...template, path: '/legacy-sample.css', locator: { root: 'capture', relative: 'legacy-sample.css' } })
    observations['/legacy-sample.css'] = observations[template.path]
    input.aliases[0].path = '/legacy-sample.css'
    input.consumerUrls.push({ url: 'https://forge.example.test/legacy-sample.css', purpose: 'alias', targetSourcePageId: 'sample', mappingRef: null })
    const collision = await translateSelection(input, null, observations)
    expect(unitFor(collision, 'slug:').status).toBe('blocked')
    const tree = represented(collision, 'tree:')
    expect(tree.command.files.some(file => file.path === '/legacy-sample.css')).toBe(true)
    expect(tree.command.edges.some(edge => edge.path === '/legacy-sample.css')).toBe(false)
  })

  it('retains every provider slot and all conflicting placement units on fatal input', async () => {
    const { input, observations } = await makeSelectedFixture()
    const path = '/tree/asset0.css'
    const artifactId = `ar_${'a'.repeat(26)}`
    input.owners.push({ path, ownerSourcePageId: 'sample', evidenceRef: 'synthetic-owner', basis: 'declared' })
    input.providerMounts.push({ path, kind: 'asset', artifactId })
    const page = input.pages.find(item => item.sourcePageId === 'tree/one.html')!
    const document = input.entries.find(item => item.path === '/tree/one.html')!
    input.pages.push({ ...page, sourcePageId: 'other.html', documentPath: '/other.html', membership: { sourceArtifactId: 'tree:other', evidenceRef: 'synthetic-membership' } })
    input.entries.push({ ...document, path: '/other.html', locator: { root: 'capture', relative: 'other.html' }, placement: { sourceArtifactId: 'tree:other', evidenceRef: 'synthetic-placement' } })
    observations['/other.html'] = observations[document.path]
    const conflict = await translateSelection(input, null, observations)
    expect(unitFor(conflict, 'slug:').dependencies).toContainEqual({ path, providerArtifactId: null, kind: 'asset', state: 'missing' })
    expect(unitFor(conflict, 'tree:synthetic').dependencies.some(dependency => dependency.path === path)).toBe(false)
    expect(unitFor(conflict, 'tree:other').status).toBe('representable')
    expect(conflict.census.find(row => row.kind === 'providerMount')).toEqual(expect.objectContaining({ declaredProviderArtifactId: artifactId, reason: 'provider_local_placement_conflict' }))
    input.providerMounts.push({ kind: 'asset', artifactId } as typeof input.providerMounts[number])
    const prepared = await preflightSelection(input)
    if (prepared.kind !== 'fatal') throw new Error('expected fatal')
    const providers = prepared.result.census.filter(row => row.kind === 'providerMount')
    expect(providers).toHaveLength(2)
    expect(providers[0]).toEqual(expect.objectContaining({ declaredProviderArtifactId: artifactId, reason: 'provider_local_placement_conflict', affectedUnitIds: expect.arrayContaining(['tree:synthetic', 'slug:sample']) }))
    expect(providers[1]).toEqual(expect.objectContaining({ path: null, providerKind: 'asset', declaredProviderArtifactId: artifactId, affectedUnitIds: [] }))
    expect(JSON.parse(JSON.stringify(providers))).toEqual(providers)
  })

  it('rejects fabricated source failures for protected and omitted entries', async () => {
    const { input, observations } = await makeSelectedFixture()
    input.exclusions.push({ path: '/tree/one.html', evidenceRef: 'synthetic-exclusion', reason: 'non_content' })
    const prepared = await preflightSelection(input)
    if (prepared.kind !== 'prepared') throw new Error('expected prepared')
    const result = await prepared.finish(observations)
    const protectedOrdinal = input.entries.findIndex(entry => entry.path === '/tree/one.html')
    const omittedOrdinal = input.entries.findIndex(entry => entry.path === '/tree/asset0.css')
    for (const entryOrdinal of [protectedOrdinal, omittedOrdinal]) {
      for (const stage of ['inspect', 'pin_reread'] as const) {
        expect(() => projectTranslation(result, [{ kind: 'source', entryOrdinal, stage, reason: 'absent' }])).toThrow('invalid_pin_failure')
      }
    }
    const candidate = prepared.reads.find(read => read.unitId === 'slug:sample')!
    expect(unitFor(projectTranslation(result, [{ kind: 'source', entryOrdinal: candidate.ordinal, stage: 'inspect', reason: 'absent' }]), 'slug:').status).toBe('blocked')
  })

  it('attributes a consumer to direct and all duplicate mapping targets even on an early fatal', async () => {
    const { input } = await makeSelectedFixture()
    const original = input.shortlinks[0]
    input.shortlinks.push({ ...original, targetSourcePageId: 'tree/one.html' })
    input.consumerUrls.push({ url: original.shortUrl, purpose: 'shortlink', targetSourcePageId: 'sample', mappingRef: original.mappingId })
    input.providerMounts.push({ path: '/unowned.css', kind: 'asset', artifactId: `ar_${'a'.repeat(26)}` })
    const prepared = await preflightSelection(input)
    if (prepared.kind !== 'fatal') throw new Error('expected fatal')
    expect(prepared.result.census.find(row => row.kind === 'consumerUrl')).toEqual(expect.objectContaining({
      affectedUnitIds: expect.arrayContaining(['tree:synthetic', 'slug:sample']), disposition: 'rejected',
    }))
  })

  it('contains a non-scalar provider path to its evidenced owner unit', async () => {
    const { input, observations } = await makeSelectedFixture()
    const path = '/asset-\uD800.css'
    input.owners.push({ path, ownerSourcePageId: 'sample', evidenceRef: 'synthetic-owner', basis: 'declared' })
    input.providerMounts.push({ path, kind: 'asset', artifactId: `ar_${'a'.repeat(26)}` })
    const result = await translateSelection(input, null, observations)
    expect(unitFor(result, 'slug:').status).toBe('blocked')
    expect(unitFor(result, 'tree:').status).toBe('representable')
    expect(result.census.find(row => row.kind === 'providerMount')).toEqual(expect.objectContaining({ reason: 'invalid_provider_mount', affectedUnitIds: ['slug:sample'] }))
  })

  it('rejects a non-scalar unused preview ledger path but preserves replacement characters', async () => {
    const { input, observations } = await makeSelectedFixture()
    const first = await translateSelection(input, null, observations)
    const ledger = structuredClone(first.ledger)
    const key = (path: string) => stable([input.sourceInstance, 'tree:synthetic', input.selectionRef, input.selectionDigest, 'preview', 'tree/one.html', path])
    ledger.operationIds[key('/bad\uD800.png')] = 'opsynthetic'
    expect((await preflightSelection(input, ledger)).kind).toBe('fatal')
    delete ledger.operationIds[key('/bad\uD800.png')]
    ledger.operationIds[key('/valid\uFFFD.png')] = 'opsynthetic'
    expect((await preflightSelection(input, ledger)).kind).toBe('prepared')
  })
})
