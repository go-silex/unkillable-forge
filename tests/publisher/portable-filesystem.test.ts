import { describe, expect, it } from 'vitest'
import { spawn } from 'node:child_process'
import { chmod, cp, link, mkdir, mkdtemp, readFile, readdir, rename, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { bindSourceRoot } from '../../plugins/unkillable-forge/src/files'
import { bindPrivateRoot, withPrivateLock, type PrivateDirectory } from '../../plugins/unkillable-forge/src/filesystem'

const dist = fileURLToPath(new URL('../../plugins/unkillable-forge/dist/', import.meta.url))
const filesystemUrl = pathToFileURL(join(dist, 'filesystem.js')).href

async function run(executable: string, args: string[], env: NodeJS.ProcessEnv = {}) {
  const child = spawn(executable, args, { stdio: ['ignore', 'pipe', 'pipe'], env })
  let stdout = '', stderr = ''
  child.stdout.setEncoding('utf8'); child.stdout.on('data', chunk => { stdout += chunk })
  child.stderr.setEncoding('utf8'); child.stderr.on('data', chunk => { stderr += chunk })
  const done = Promise.withResolvers<number | null>()
  child.once('error', done.reject); child.once('close', done.resolve)
  return { code: await done.promise, stdout, stderr }
}

async function readPrivate(dir: PrivateDirectory, name: string) {
  const file = await dir.open(name, 'read')
  try { return await file.readFile('utf8') } finally { await file.close() }
}

describe('portable descriptor-relative filesystem', () => {
  it('keeps grant and operation read, create, replace and unlink inside bound directories after ancestor swaps', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'forge-private-race-'))
    const parent = join(dir, 'parent'), rootPath = join(parent, 'state'), outside = join(dir, 'outside')
    await mkdir(rootPath, { recursive: true, mode: 0o700 }); await mkdir(join(outside, 'state'), { recursive: true, mode: 0o700 })
    const root = await bindPrivateRoot(rootPath, false)
    const grant = await root.child('grant', true), operation = await root.child('operation', true)
    try {
      for (const name of ['grant', 'operation']) {
        await mkdir(join(outside, 'state', name), { mode: 0o700 })
        await writeFile(join(outside, 'state', name, 'record'), 'outside sentinel', { mode: 0o600 })
      }
      await grant.replace('record', Buffer.from('grant before'))
      await operation.replace('record', Buffer.from('operation before'))
      await rename(parent, join(dir, 'original')); await symlink(outside, parent)
      for (const [capability, value] of [[grant, 'grant'], [operation, 'operation']] as const) {
        expect(await readPrivate(capability, 'record')).toBe(`${value} before`)
        const created = await capability.open('new', 'exclusive')
        try { await created.writeFile(`${value} created`) } finally { await created.close() }
        expect((await stat(join(dir, 'original', 'state', value, 'new'))).mode & 0o777).toBe(0o600)
        await capability.replace('record', Buffer.from(`${value} after`))
        expect(await readPrivate(capability, 'record')).toBe(`${value} after`)
        await capability.unlink('new')
        expect(await capability.names()).toEqual(['record'])
        expect(await readFile(join(outside, 'state', value, 'record'), 'utf8')).toBe('outside sentinel')
        expect(await readdir(join(outside, 'state', value))).toEqual(['record'])
      }
    } finally { await grant.close(); await operation.close(); await root.close(); await rm(dir, { recursive: true, force: true }) }
  })

  it('rejects symlinks, special files, private hardlinks, unsafe permissions and invalid component names', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'forge-private-types-'))
    const source = join(dir, 'source'), state = join(dir, 'state')
    await mkdir(source, { mode: 0o700 }); await mkdir(state, { mode: 0o700 })
    const root = await bindSourceRoot(source), privateRoot = await bindPrivateRoot(state, false)
    try {
      await writeFile(join(source, 'regular'), 'source'); await symlink('regular', join(source, 'link'))
      const fifo = await run('/usr/bin/mkfifo', [join(source, 'fifo')])
      expect(fifo.code).toBe(0)
      await expect(root.open('link')).rejects.toThrow()
      await expect(root.open('fifo')).rejects.toThrow()
      const sourceFile = await root.open('regular'); try { expect(await sourceFile.readFile('utf8')).toBe('source') } finally { await sourceFile.close() }
      await link(join(source, 'regular'), join(source, 'hardlink'))
      const linkedSource = await root.open('hardlink'); try { expect(await linkedSource.readFile('utf8')).toBe('source') } finally { await linkedSource.close() }
      expect((await run('/usr/bin/mkfifo', [join(state, 'fifo')])).code).toBe(0)
      await expect(privateRoot.open('fifo', 'read')).rejects.toThrow()
      await writeFile(join(state, 'record'), 'private', { mode: 0o600 })
      await link(join(state, 'record'), join(state, 'hardlink'))
      await expect(privateRoot.open('record', 'read')).rejects.toThrow()
      await rm(join(state, 'hardlink')); await chmod(join(state, 'record'), 0o644)
      await symlink('record', join(state, 'link'))
      await expect(privateRoot.open('link', 'read')).rejects.toThrow()
      await expect(privateRoot.open('record', 'read')).rejects.toThrow()
      await chmod(join(state, 'record'), 0o600)
      expect(await readPrivate(privateRoot, 'record')).toBe('private')
      for (const name of ['', '.', '..', 'a/b', 'x\0y', '\ud800']) {
        await expect(privateRoot.open(name, 'read')).rejects.toThrow()
        await expect(privateRoot.replace(name, Buffer.from('x'))).rejects.toThrow()
      }
      await mkdir(join(dir, 'unsafe'), { mode: 0o755 }); await chmod(join(dir, 'unsafe'), 0o755)
      await expect(bindPrivateRoot(join(dir, 'unsafe'), false)).rejects.toThrow()
    } finally { await root.close(); await privateRoot.close(); await rm(dir, { recursive: true, force: true }) }
  })

  it.skipIf(process.platform !== 'darwin')('refuses Darwin private state with an exploitable inherited foreign-user ACL', async () => {
    const dir = await mkdtemp('/private/tmp/forge-acl-')
    const clean = await mkdtemp('/private/tmp/forge-acl-file-')
    const root = await bindPrivateRoot(dir, false)
    const fileRoot = await bindPrivateRoot(clean, false)
    try {
      const ace = 'nobody allow read,execute,file_inherit,directory_inherit'
      const configured = await run('/bin/chmod', ['+a', ace, dir])
      expect(configured, configured.stderr).toMatchObject({ code: 0 })
      const probe = join(dir, 'probe')
      await writeFile(probe, 'synthetic-grant-value', { mode: 0o600 })
      await chmod(probe, 0o600)
      expect((await stat(dir)).mode & 0o777).toBe(0o700)
      expect((await stat(probe)).mode & 0o777).toBe(0o600)
      const foreign = await run('/usr/bin/sudo', ['-n', '-u', 'nobody', '/bin/cat', probe])
      expect(foreign, foreign.stderr).toMatchObject({ code: 0, stdout: 'synthetic-grant-value' })

      await expect(bindPrivateRoot(dir, false)).rejects.toThrow()
      await expect(root.open('probe', 'read')).rejects.toThrow()
      await expect(root.child('inherited', true)).rejects.toThrow()
      await expect(root.open('new-grant', 'exclusive')).rejects.toThrow()
      await expect(root.replace('grant', Buffer.from('synthetic-not-written'))).rejects.toThrow()

      const file = join(clean, 'record')
      await writeFile(file, 'synthetic-only', { mode: 0o600 })
      const fileAce = await run('/bin/chmod', ['+a', 'nobody allow read', file])
      expect(fileAce, fileAce.stderr).toMatchObject({ code: 0 })
      expect((await stat(file)).mode & 0o777).toBe(0o600)
      await expect(fileRoot.open('record', 'read')).rejects.toThrow()

      const deniedFile = join(clean, 'deny-only')
      await writeFile(deniedFile, 'synthetic-only', { mode: 0o600 })
      const fileDeny = await run('/bin/chmod', ['+a', 'nobody deny read', deniedFile])
      expect(fileDeny, fileDeny.stderr).toMatchObject({ code: 0 })
      await expect(fileRoot.open('deny-only', 'read')).rejects.toThrow()
      const directoryDeny = await run('/bin/chmod', ['+a', 'nobody deny read', clean])
      expect(directoryDeny, directoryDeny.stderr).toMatchObject({ code: 0 })
      await expect(bindPrivateRoot(clean, false)).rejects.toThrow()
    } finally {
      try { await root.close(); await fileRoot.close() } finally {
        await rm(dir, { recursive: true, force: true }); await rm(clean, { recursive: true, force: true })
      }
    }
  })

  it('rejects use after close while an already returned file handle remains independently usable', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'forge-capability-life-'))
    await writeFile(join(dir, 'record'), 'held', { mode: 0o600 })
    const root = await bindPrivateRoot(dir, false)
    const file = await root.open('record', 'read')
    try {
      await root.close()
      await expect(root.open('record', 'read')).rejects.toThrow()
      expect(await file.readFile('utf8')).toBe('held')
    } finally { await file.close(); await rm(dir, { recursive: true, force: true }) }
  })

  it('keeps another process lock held through cancellation and releases it when that owner dies', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'forge-lock-death-'))
    const root = await bindPrivateRoot(dir, false)
    // The child imports the bundled production seam; no test-specific native interface.
    const script = `
      const { bindPrivateRoot, withPrivateLock } = await import(process.argv[1]);
      const root = await bindPrivateRoot(process.argv[2], false);
      await withPrivateLock(root, 'stable.lock', { deadlineMs: Date.now() + 5000 }, async () => {
        const release = new Promise(resolve => process.once('message', resolve));
        process.send('held'); await release;
      });
    `
    const child = spawn(process.execPath, ['--input-type=module', '-e', script, filesystemUrl, dir], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'], env: { PATH: '' } })
    let stderr = ''
    const ready = Promise.withResolvers<void>(), exited = Promise.withResolvers<{ code: number | null; signal: NodeJS.Signals | null }>()
    child.once('message', message => { if (message === 'held') ready.resolve(); else ready.reject(new Error('unexpected child message')) })
    child.once('error', ready.reject)
    child.once('exit', (code, signal) => { exited.resolve({ code, signal }); ready.reject(new Error(`owner exited: ${stderr}`)) })
    try {
      if (!child.stderr) throw new Error('owner stderr pipe unavailable')
      child.stderr.setEncoding('utf8'); child.stderr.on('data', chunk => { stderr += chunk })
      await ready.promise
      const controller = new AbortController()
      const cancelled = withPrivateLock(root, 'stable.lock', { deadlineMs: Date.now() + 5000, signal: controller.signal }, async () => { throw new Error('unexpected acquisition') })
      controller.abort()
      await expect(cancelled).rejects.toThrow('lock_aborted')
      await expect(withPrivateLock(root, 'stable.lock', { deadlineMs: Date.now() + 300 }, async () => 'wrong')).rejects.toThrow('lock_timeout')
      child.kill('SIGKILL'); expect((await exited.promise).signal).toBe('SIGKILL')
      expect(await withPrivateLock(root, 'stable.lock', { deadlineMs: Date.now() + 5000 }, async () => 'acquired')).toBe('acquired')
    } finally { if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await exited.promise } await root.close(); await rm(dir, { recursive: true, force: true }) }
  })

  it('fails closed for a missing or corrupted selected packaged native payload with no compiler on PATH', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'forge-payload-'))
    try {
      const copied = join(dir, 'dist'); await cp(dist, copied, { recursive: true })
      const moduleUrl = pathToFileURL(join(copied, 'filesystem.js')).href
      const selected = join(copied, 'native', `${process.platform}-${process.arch}`, 'posix.node')
      const bytes = await readFile(selected)
      const script = `const { bindPrivateRoot } = await import(process.argv[1]); const root = await bindPrivateRoot(process.argv[2], false); await root.close();`
      const invoke = () => run(process.execPath, ['--input-type=module', '-e', script, moduleUrl, dir], { PATH: '' })
      expect((await invoke()).code).toBe(0)
      await rm(selected)
      expect((await invoke()).code).not.toBe(0)
      await writeFile(selected, Buffer.concat([bytes, Buffer.from('corrupt')]))
      expect((await invoke()).code).not.toBe(0)
    } finally { await rm(dir, { recursive: true, force: true }) }
  })
})
