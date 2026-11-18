import { describe, expect, it } from 'vitest'
import { spawn } from 'node:child_process'
import { mkdtemp, mkdir, readFile, readdir, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { LocalPublisher, type AuthenticatedTransport } from '../../plugins/unkillable-forge/src/publisher'
import { bindSourceRoot, type SourceRoot } from '../../plugins/unkillable-forge/src/files'

const artifactId = 'ar_' + 'a'.repeat(26), revisionId = 'rv_' + 'a'.repeat(26), sessionId = 'ps_' + 'a'.repeat(26)
type Command = { files: { path: string; source: string }[]; pages: { pageId: string }[] }
const input = { source: { rootId: 'root', relativePath: 'ancestor/index.html' }, metadata: {}, target: { kind: 'new' as const, route: { kind: 'subtree' as const, slug: 'deck' } } }

async function fixture(transport: AuthenticatedTransport) {
  const dir = await mkdtemp(join(tmpdir(), 'forge-races-'))
  const root = join(dir, 'root'), stateDir = join(dir, 'state'), outside = join(dir, 'outside')
  await mkdir(join(root, 'ancestor'), { recursive: true, mode: 0o700 })
  await mkdir(stateDir, { mode: 0o700 }); await mkdir(outside, { mode: 0o700 })
  await writeFile(join(root, 'ancestor', 'index.html'), 'bound content')
  const publisher = new LocalPublisher({ transport, roots: [{ id: 'root', absolutePath: root }], stateDir, profileFingerprint: 'test', readOrigin: 'https://read.example' })
  return { dir, root, stateDir, outside, publisher }
}

function gatedTransport() {
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>()
  let command!: Command, uploaded = ''
  const state = (stage: 'open' | 'sealed', stored: boolean) => ({ sessionId, artifactId, revisionId, baseRevisionId: null, expiresAt: 9999999999999, state: stage, files: command.files.map(f => ({ path: f.path, source: f.source, stored })) })
  const transport: AuthenticatedTransport = {
    async call(tool, args) {
      if (tool === 'forge_begin') { command = args.command as Command; entered.resolve(); await release.promise; return state('open', false) }
      if (tool === 'forge_seal') return state('sealed', true)
      if (tool === 'forge_commit') return { artifactId, revisionId, contentVersion: 1, pages: command.pages.map(p => ({ pageId: p.pageId, url: '/a/deck/' })) }
      throw new Error(`unexpected ${tool}`)
    },
    async upload(_session, path, body) {
      const reader = body.getReader()
      for (;;) { const part = await reader.read(); if (part.done) break; uploaded += Buffer.from(part.value).toString() }
      return { sessionId, path, stored: true, state: 'open' }
    },
    async supports() { return false },
  }
  return { transport, entered, release, uploaded: () => uploaded }
}

async function contender(stateDir: string, id: string, effect: string) {
  const moduleUrl = pathToFileURL(fileURLToPath(new URL('../../plugins/unkillable-forge/dist/filesystem.js', import.meta.url))).href
  const script = `
    const { bindPrivateRoot, withPrivateLock } = await import(process.argv[1]);
    const { writeFile } = await import('node:fs/promises');
    const root = await bindPrivateRoot(process.argv[2], false);
    const locks = await root.child('locks', false);
    try {
      try {
        await withPrivateLock(locks, 'operation-' + process.argv[3] + '.lock', { deadlineMs: Date.now() + 400 }, async () => {
          await writeFile(process.argv[4], 'contended');
        });
        console.log('acquired');
      } catch (error) { console.log('denied:' + String(error)); }
    } finally { await locks.close(); await root.close(); }
  `
  const child = spawn(process.execPath, ['--input-type=module', '-e', script, moduleUrl, stateDir, id, effect], { stdio: ['ignore', 'pipe', 'pipe'], env: { PATH: '' } })
  let output = '', errors = ''
  child.stdout.setEncoding('utf8'); child.stdout.on('data', chunk => { output += chunk })
  child.stderr.setEncoding('utf8'); child.stderr.on('data', chunk => { errors += chunk })
  const done = Promise.withResolvers<number | null>()
  child.once('error', done.reject); child.once('close', done.resolve)
  const code = await done.promise
  if (code !== 0) throw new Error(`contender failed: ${errors}`)
  return output.trim()
}

describe('publisher filesystem race boundaries', () => {
  it('keeps a selected source root bound when its ancestor is redirected before open', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'forge-source-race-'))
    const parent = join(dir, 'parent'), root = join(parent, 'root'), outside = join(dir, 'outside')
    let bound: SourceRoot | undefined
    try {
      await mkdir(join(root, 'nested'), { recursive: true, mode: 0o700 })
      await mkdir(join(outside, 'root', 'nested'), { recursive: true, mode: 0o700 })
      await writeFile(join(root, 'nested', 'index.html'), 'authorized bytes')
      await writeFile(join(outside, 'root', 'nested', 'index.html'), 'outside sentinel')
      bound = await bindSourceRoot(root)
      await rename(parent, join(dir, 'original-parent'))
      await symlink(outside, parent)
      const file = await bound.open('nested/index.html')
      try { expect(await file.readFile('utf8')).toBe('authorized bytes') } finally { await file.close() }
      expect(await readFile(join(outside, 'root', 'nested', 'index.html'), 'utf8')).toBe('outside sentinel')
    } finally {
      try { await bound?.close() } finally { await rm(dir, { recursive: true, force: true }) }
    }
  })

  it('keeps source and operation state bound across an in-flight ancestor swap', async () => {
    const gate = gatedTransport(), f = await fixture(gate.transport)
    const publishing = f.publisher.publish(input)
    try {
      await Promise.race([gate.entered.promise, publishing.then(() => { throw new Error('publish completed before barrier') })])
      const id = (await readdir(f.stateDir)).find(name => /^[0-9a-f-]{36}$/.test(name))!
      expect(id).toBeTruthy()
      await mkdir(join(f.outside, 'ancestor')); await writeFile(join(f.outside, 'ancestor', 'index.html'), 'outside sentinel')
      await mkdir(join(f.outside, id), { mode: 0o700 }); await writeFile(join(f.outside, id, 'sentinel'), 'untouched')
      await rename(f.root, join(f.dir, 'original-root')); await symlink(f.outside, f.root)
      await rename(f.stateDir, join(f.dir, 'original-state')); await symlink(f.outside, f.stateDir)
      gate.release.resolve()
      const result = await publishing
      expect(result.publication.artifactId).toBe(artifactId)
      expect(gate.uploaded()).toBe('bound content')
      expect(await readFile(join(f.outside, 'ancestor', 'index.html'), 'utf8')).toBe('outside sentinel')
      expect(await readdir(join(f.outside, id))).toEqual(['sentinel'])
      expect(await readFile(join(f.outside, id, 'sentinel'), 'utf8')).toBe('untouched')
      expect(JSON.parse(await readFile(join(f.dir, 'original-state', id, 'record.json'), 'utf8')).receipt.artifactId).toBe(artifactId)
    } finally { gate.release.resolve(); await publishing.catch(() => {}); await rm(f.dir, { recursive: true, force: true }) }
  })

  it('retains the stable operation lock throughout an in-flight transport effect', async () => {
    const gate = gatedTransport(), f = await fixture(gate.transport)
    const publishing = f.publisher.publish(input)
    try {
      await Promise.race([gate.entered.promise, publishing.then(() => { throw new Error('publish completed before barrier') })])
      const id = (await readdir(f.stateDir)).find(name => /^[0-9a-f-]{36}$/.test(name))!
      expect(id).toBeTruthy()
      const effect = join(f.dir, 'contender-effect')
      expect(await contender(f.stateDir, id, effect)).toBe('denied:Error: lock_timeout')
      await expect(readFile(effect, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
      gate.release.resolve()
      await publishing
      expect(await contender(f.stateDir, id, effect)).toBe('acquired')
      expect(await readFile(effect, 'utf8')).toBe('contended')
    } finally { gate.release.resolve(); await publishing.catch(() => {}); await rm(f.dir, { recursive: true, force: true }) }
  })
})
