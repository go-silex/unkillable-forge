import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LocalPublisher, type AuthenticatedTransport } from '../../plugins/unkillable-forge/src/publisher'
import { enrichmentSchema, statusSchema } from '../../plugins/unkillable-forge/src/publisher-wire'

const temporary: string[] = []
afterEach(async () => { await Promise.all(temporary.splice(0).map(path => rm(path, { recursive: true, force: true }))) })
async function setup(transport: AuthenticatedTransport) {
  const dir = await mkdtemp(join(tmpdir(), 'forge-publisher-')); temporary.push(dir)
  const root = join(dir, 'root'), stateDir = join(dir, 'state'); await mkdir(root); await mkdir(stateDir, { mode: 0o700 })
  return { root, stateDir, publisher: new LocalPublisher({ transport, roots: [{ id: 'root', absolutePath: root }], stateDir, profileFingerprint: 'test', readOrigin: 'https://read.example' }) }
}
const source = { rootId: 'root', relativePath: 'index.html' }
const artifactId = 'ar_' + 'a'.repeat(26), revisionId = 'rv_' + 'a'.repeat(26), pageId = 'pg_' + 'a'.repeat(26), sessionId = 'ps_' + 'a'.repeat(26)
const emptyChanges = { upserts: [], pageChanges: [], removeResourcePaths: [], ownershipChanges: [] }
type TestCommand = { files: { path: string; source: string }[]; pages: { pageId: string }[]; edges: unknown[] }

describe('local publisher', () => {
  it('refuses stale baselines before beginning', async () => {
    const calls: string[] = []
    const transport: AuthenticatedTransport = { async call(tool) { calls.push(tool); return { artifactId, activeRevisionId: revisionId, contentVersion: 2, pages: [] } }, async upload() { throw new Error('unexpected') }, async supports() { return false } }
    const { publisher } = await setup(transport)
    await expect(publisher.publish({ source, metadata: {}, target: { kind: 'existing', baseline: { kind: 'explicit', expected: { artifactId, expectedRevisionId: revisionId, expectedContentVersion: 1 } }, changes: emptyChanges } })).rejects.toThrow('conflict')
    expect(calls).toEqual(['forge_artifact_state'])
  })
  it('rejects a symlink source without beginning a session', async () => {
    const calls: string[] = []
    const transport: AuthenticatedTransport = { async call(tool) { calls.push(tool); throw new Error('unexpected') }, async upload() { throw new Error('unexpected') }, async supports() { return false } }
    const { root, publisher } = await setup(transport)
    await symlink('/etc/passwd', join(root, 'index.html'))
    await expect(publisher.publish({ source, metadata: {}, target: { kind: 'new', route: { kind: 'subtree', slug: 'deck' } } })).rejects.toThrow()
    expect(calls).toEqual([])
  })
  it('rejects a symlink in an ancestor component', async () => {
    const calls: string[] = []
    const transport: AuthenticatedTransport = { async call(tool) { calls.push(tool); throw new Error('unexpected') }, async upload() { throw new Error('unexpected') }, async supports() { return false } }
    const { root, publisher } = await setup(transport)
    await symlink('/etc', join(root, 'ancestor'))
    await expect(publisher.publish({ source: { rootId: 'root', relativePath: 'ancestor/passwd' }, metadata: {}, target: { kind: 'new', route: { kind: 'subtree', slug: 'deck' } } })).rejects.toThrow()
    expect(calls).toEqual([])
  })
  it('does not begin when the selected source is missing', async () => {
    const calls: string[] = []
    const transport: AuthenticatedTransport = { async call(tool) { calls.push(tool); throw new Error('unexpected') }, async upload() { throw new Error('unexpected') }, async supports() { return false } }
    const { publisher } = await setup(transport)
    await expect(publisher.publish({ source, metadata: {}, target: { kind: 'new', route: { kind: 'subtree', slug: 'deck' } } })).rejects.toThrow()
    expect(calls).toEqual([])
  })
  it('rejects a symlink substituted for an operation directory', async () => {
    const transport: AuthenticatedTransport = { async call() { throw new Error('unexpected') }, async upload() { throw new Error('unexpected') }, async supports() { return false } }
    const { publisher, stateDir, root } = await setup(transport)
    const operationId = '12345678-1234-4234-8234-123456789abc'
    await symlink(root, join(stateDir, operationId))
    await expect(publisher.status(operationId)).rejects.toThrow()
  })
  it('serializes competing operation observers without stale lock cleanup', async () => {
    let command!: TestCommand, entered = 0
    const gate = Promise.withResolvers<void>(), first = Promise.withResolvers<void>()
    const transport: AuthenticatedTransport = {
      async call(tool, args) {
        if (tool === 'forge_begin') { command = args.command as TestCommand; return { sessionId, artifactId, revisionId, baseRevisionId: null, expiresAt: 9999999999999, state: 'open', files: command.files.map(f => ({ path: f.path, source: f.source, stored: false })) } }
        if (tool === 'forge_status') { entered++; if (entered === 1) { first.resolve(); await gate.promise } return { sessionId, artifactId, revisionId, baseRevisionId: null, expiresAt: 9999999999999, state: 'open', files: command.files.map(f => ({ path: f.path, source: f.source, stored: false })) } }
        throw new Error('unexpected')
      },
      async upload() { throw new Error('connection lost') }, async supports() { return false },
    }
    const { root, stateDir, publisher } = await setup(transport)
    await writeFile(join(root, 'index.html'), 'content')
    let operationId = ''
    try { await publisher.publish({ source, metadata: {}, target: { kind: 'new', route: { kind: 'subtree', slug: 'deck' } } }) } catch (error) { if (error && typeof error === 'object' && 'operationId' in error && typeof error.operationId === 'string') operationId = error.operationId }
    expect(operationId).not.toBe('')
    const other = new LocalPublisher({ transport, roots: [{ id: 'root', absolutePath: root }], stateDir, profileFingerprint: 'test', readOrigin: 'https://read.example' })
    const one = publisher.status(operationId); await first.promise
    const two = other.status(operationId)
    // Independent publisher instances contend on the same native kernel lock.
    await new Promise(resolve => setTimeout(resolve, 100))
    expect(entered).toBe(1)
    gate.resolve()
    await Promise.all([one, two])
    expect(entered).toBe(2)
    expect(await readFile(join(stateDir, 'locks', `operation-${operationId}.lock`))).toHaveLength(0)
  })
  it('persists the exact command and spooled bytes across a lost begin response', async () => {
    let command!: TestCommand; let calls = 0, commitCalls = 0, uploaded = '', stage = 'open'
    const transport: AuthenticatedTransport = {
      async call(tool, args) {
        if (tool === 'forge_begin') { calls++; if (!command) command = args.command as TestCommand; else expect(args.command).toEqual(command); if (calls === 1) throw new Error('lost'); return { sessionId, artifactId, revisionId, baseRevisionId: null, expiresAt: 9999999999999, state: stage, files: command.files.map(f => ({ path: f.path, source: f.source, stored: false })) } }
        if (tool === 'forge_status') return { sessionId, artifactId, revisionId, baseRevisionId: null, expiresAt: 9999999999999, state: stage, files: command.files.map(f => ({ path: f.path, source: f.source, stored: true })) }
        if (tool === 'forge_seal') { stage = 'sealed'; return { sessionId, artifactId, revisionId, baseRevisionId: null, expiresAt: 9999999999999, state: stage, files: command.files.map(f => ({ path: f.path, source: f.source, stored: true })) } }
        if (tool === 'forge_commit') { stage = 'committed'; if (++commitCalls === 1) throw new Error('lost commit'); return { artifactId, revisionId, contentVersion: 1, pages: [{ pageId: command.pages[0].pageId, url: '/a/deck/' }] } }
        throw new Error('unexpected')
      },
      async upload(_session, path, body) { const reader = body.getReader(); for (;;) { const item = await reader.read(); if (item.done) break; uploaded += Buffer.from(item.value).toString() } return { sessionId, path, stored: true, state: 'open' } },
      async supports() { return false },
    }
    const { root, publisher, stateDir } = await setup(transport); await writeFile(join(root, 'index.html'), 'original')
    let operationId = ''
    try { await publisher.publish({ source, metadata: {}, target: { kind: 'new', route: { kind: 'subtree', slug: 'deck' } } }) } catch (e) { if (e && typeof e === 'object' && 'operationId' in e && typeof e.operationId === 'string') operationId = e.operationId }
    expect(operationId).toBeTruthy(); await writeFile(join(root, 'index.html'), 'changed')
    await expect(publisher.resume(operationId)).rejects.toThrow('lost commit')
    const result = await publisher.resume(operationId)
    expect(uploaded).toBe('original'); expect(command.files[0].path).toBe('/a/deck/index.html'); expect(result.publication.contentVersion).toBe(1); expect(commitCalls).toBe(2)
    const record = JSON.parse(await readFile(join(stateDir, operationId, 'record.json'), 'utf8')); expect(record.command).toEqual(command); expect(record.receipt).toEqual(result.publication)
  })
  it('preserves paginated unselected resources and pages in the begin command', async () => {
    let command!: TestCommand
    const transport: AuthenticatedTransport = {
      async call(tool, args) {
        if (tool === 'forge_artifact_state') return { artifactId, activeRevisionId: revisionId, contentVersion: 3, pages: [{ pageId, artifactId, visibility: 'private', policyEpoch: 7, tombstoned: false, route: { kind: 'subtree', slug: 'deck' } }] }
        if (tool === 'forge_manifest') {
          const section = args.section as string, cursor = args.cursor
          const item = section === 'files' ? cursor ? { path: '/a/deck/image.png', kind: 'asset', sha256: 'b'.repeat(64), size: 2, contentType: 'image/png' } : { path: '/a/deck/index.html', kind: 'document', sha256: 'a'.repeat(64), size: 1, contentType: 'text/html' } : section === 'pages' ? { pageId, documentPath: '/a/deck/index.html', metadata: {} } : { ownerPageId: pageId, path: '/a/deck/image.png', providerArtifactId: artifactId }
          return { artifactId, activeRevisionId: revisionId, contentVersion: 3, revision: { revisionId, manifestSha256: 'c'.repeat(64), sealedAt: 1, previouslyActivated: true, retention: 'retained', discardedAt: null, purgedAt: null }, section, items: [item], nextCursor: section === 'files' && !cursor ? 'next' : null }
        }
        if (tool === 'forge_begin') { command = args.command as TestCommand; throw new Error('stop after begin') }
        throw new Error('unexpected')
      }, async upload() { throw new Error('unexpected') }, async supports() { return false },
    }
    const { publisher } = await setup(transport)
    await expect(publisher.publish({ source, metadata: {}, target: { kind: 'existing', baseline: { kind: 'explicit', expected: { artifactId, expectedRevisionId: revisionId, expectedContentVersion: 3 } }, changes: emptyChanges } })).rejects.toThrow('publication_outcome_unknown')
    expect(command.files).toHaveLength(2); expect(command.files.every(f => f.source === 'base')).toBe(true); expect(command.pages[0]).toMatchObject({ pageId, disposition: 'keep', expectedPolicyEpoch: 7 }); expect(command.edges).toEqual([{ ownerPageId: pageId, path: '/a/deck/image.png', providerArtifactId: artifactId }])
    const baseline = { kind: 'explicit' as const, expected: { artifactId, expectedRevisionId: revisionId, expectedContentVersion: 3 } }
    const removal = { ...emptyChanges, removeResourcePaths: ['/a/deck/image.png'] }
    await expect(publisher.publish({ source, metadata: {}, target: { kind: 'existing', baseline, changes: removal } })).rejects.toThrow('invalid_graph')
    const changes = { ...removal, ownershipChanges: [{ action: 'remove' as const, ownerPageId: pageId, path: '/a/deck/image.png', providerArtifactId: artifactId }] }
    await expect(publisher.publish({ source, metadata: {}, target: { kind: 'existing', baseline, changes } })).rejects.toThrow('publication_outcome_unknown')
    expect(command.files).toHaveLength(1); expect(command.edges).toEqual([])
  })
  it('rejects malformed F07 status and unsafe enrichment fields', () => {
    expect(statusSchema.safeParse({ sessionId, state: 'committed', files: [] }).success).toBe(false)
    const status = { state: 'ready', source: 'generated' }
    const result = { version: 1, artifactId, revisionId, observedAt: 1, items: [{ pageId, revisionId, og: status, shortlink: { state: 'disabled', reason: 'not_configured' } }], nextCursor: null }
    expect(enrichmentSchema.safeParse(result).success).toBe(true)
    expect(enrichmentSchema.safeParse({ ...result, destination: 'https://secret.invalid/' }).success).toBe(false)
    expect(enrichmentSchema.safeParse({ ...result, items: [{ ...result.items[0], og: { state: 'ready', source: 'fake' } }] }).success).toBe(false)
  })
})
