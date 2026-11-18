import { randomBytes } from 'node:crypto'
import { open, realpath, type FileHandle } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join } from 'node:path'
import { native } from './posix.js'

type Handle = object
export interface SourceRoot { open(relativePath: string): Promise<FileHandle>; close(): Promise<void> }
export interface PrivateDirectory {
  child(name: string, create: boolean): Promise<PrivateDirectory>
  open(name: string, mode: 'read' | 'exclusive'): Promise<FileHandle>
  replace(name: string, bytes: Uint8Array): Promise<void>
  unlink(name: string): Promise<void>
  names(): Promise<readonly string[]>
  removeEmptyChild(name: string): Promise<void>
  availableBytes(): Promise<bigint>
  close(): Promise<void>
}
function component(name: string): void {
  if (typeof name !== 'string' || !name || name === '.' || name === '..' || name.includes('/') || name.includes('\0') || !name.isWellFormed()) throw new Error('invalid_path')
}
async function resolvedRoot(path: string, createLeaf: boolean): Promise<string> {
  if (!isAbsolute(path) || !path.isWellFormed() || path.includes('\0')) throw new Error('invalid_root')
  try { return await realpath(path) } catch (error) {
    if (!createLeaf || (error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    const leaf = basename(path); component(leaf)
    return join(await realpath(dirname(path)), leaf)
  }
}
async function bind(path: string, privateRoot: boolean, createLeaf: boolean): Promise<Handle> {
  const resolved = await resolvedRoot(path, createLeaf)
  const parts = resolved.split('/').filter(Boolean)
  let current = native().root()
  try {
    for (let i = 0; i < parts.length; i++) {
      component(parts[i])
      const last = i === parts.length - 1
      const next = native().child(current, parts[i], privateRoot && createLeaf && last, privateRoot && last)
      native().close(current); current = next
    }
    if (privateRoot && parts.length === 0) throw new Error('invalid_root')
    return current
  } catch (error) { native().close(current); throw error }
}
class HeldDirectory {
  private active = 0
  private closing = false
  private done?: Promise<void>
  private finish?: () => void
  constructor(protected readonly handle: Handle) {}
  protected async use<T>(action: (handle: Handle) => Promise<T> | T): Promise<T> {
    if (this.closing) throw new Error('filesystem_closed')
    this.active++
    try { return await action(this.handle) } finally { if (--this.active === 0 && this.closing) this.finish?.() }
  }
  async close(): Promise<void> {
    if (!this.done) {
      this.closing = true
      this.done = (async () => {
        if (this.active) {
          const gate = Promise.withResolvers<void>()
          this.finish = gate.resolve
          await gate.promise
        }
        native().close(this.handle)
      })()
    }
    return this.done
  }
}
async function adopt(carrier: Handle, writable: boolean): Promise<FileHandle> {
  let file: FileHandle | undefined
  try {
    const bridge = native()
    const identity = bridge.identity(carrier)
    const alias = process.platform === 'linux' ? '/proc/self/fd/' : '/dev/fd/'
    file = await open(alias + bridge.fd(carrier), writable ? 'r+' : 'r')
    const stat = await file.stat({ bigint: true })
    if (stat.dev !== identity.dev || stat.ino !== identity.ino || Number(stat.mode & 0o170000n) !== identity.type || !stat.isFile()) throw new Error('filesystem_identity_mismatch')
    return file
  } catch (error) { if (file) await file.close(); throw error } finally { native().close(carrier) }
}
class Source extends HeldDirectory implements SourceRoot {
  async open(path: string): Promise<FileHandle> {
    if (typeof path !== 'string' || path.startsWith('/')) throw new Error('invalid_source')
    const parts = path.split('/'); parts.forEach(component)
    return this.use(async root => {
      let parent: Handle | undefined
      try {
        for (const part of parts.slice(0, -1)) {
          const next = native().child(parent ?? root, part, false, false)
          if (parent) native().close(parent)
          parent = next
        }
        return await adopt(native().file(parent ?? root, parts[parts.length - 1], 0), false)
      } finally { if (parent) native().close(parent) }
    })
  }
}
class Private extends HeldDirectory implements PrivateDirectory {
  async child(name: string, create: boolean): Promise<PrivateDirectory> { component(name); return this.use(h => new Private(native().child(h, name, create, true))) }
  async open(name: string, mode: 'read' | 'exclusive'): Promise<FileHandle> { component(name); if (mode !== 'read' && mode !== 'exclusive') throw new Error('invalid_mode'); return this.use(h => adopt(native().file(h, name, mode === 'read' ? 1 : 2), mode === 'exclusive')) }
  async replace(name: string, bytes: Uint8Array): Promise<void> {
    component(name)
    return this.use(async h => {
      const temp = `.tmp-${randomBytes(24).toString('hex')}`
      let created = false
      try {
        const carrier = native().file(h, temp, 2); created = true
        const file = await adopt(carrier, true)
        try { await file.writeFile(bytes); await file.sync() } finally { await file.close() }
        native().mutation(h, temp, 0, name); created = false
        native().sync(h)
      } finally { if (created) native().mutation(h, temp, 1, '') }
    })
  }
  async unlink(name: string): Promise<void> { component(name); await this.use(h => native().mutation(h, name, 1, '')) }
  async names(): Promise<readonly string[]> { return this.use(h => native().names(h)) }
  async removeEmptyChild(name: string): Promise<void> { component(name); await this.use(h => native().mutation(h, name, 2, '')) }
  async availableBytes(): Promise<bigint> { return this.use(h => native().space(h)) }
  async locked<T>(name: string, wait: { deadlineMs: number; signal?: AbortSignal }, action: () => Promise<T>): Promise<T> {
    component(name)
    return this.use(async h => {
      const lock = native().file(h, name, 3)
      let acquired = false
      try {
        for (;;) {
          if (wait.signal?.aborted) throw new Error('lock_aborted')
          if (Date.now() >= wait.deadlineMs) throw new Error('lock_timeout')
          if (native().lock(lock, true)) { acquired = true; break }
          const { promise, resolve, reject } = Promise.withResolvers<void>()
          const signal = wait.signal
          const timer = setTimeout(() => { signal?.removeEventListener('abort', abort); resolve() }, Math.min(50, Math.max(0, wait.deadlineMs - Date.now())))
          const abort = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); reject(new Error('lock_aborted')) }
          signal?.addEventListener('abort', abort, { once: true })
          if (signal?.aborted) abort()
          await promise
        }
        return await action()
      } finally { try { if (acquired) native().lock(lock, false) } finally { native().close(lock) } }
    })
  }
}
export async function bindSourceRoot(approvedAbsoluteRoot: string): Promise<SourceRoot> { return new Source(await bind(approvedAbsoluteRoot, false, false)) }
export async function bindPrivateRoot(approvedAbsoluteRoot: string, createLeaf: boolean): Promise<PrivateDirectory> { return new Private(await bind(approvedAbsoluteRoot, true, createLeaf)) }
export async function withPrivateLock<T>(root: PrivateDirectory, name: string, wait: { deadlineMs: number; signal?: AbortSignal }, action: () => Promise<T>): Promise<T> {
  if (!(root instanceof Private) || !Number.isFinite(wait.deadlineMs)) throw new Error('invalid_lock')
  return root.locked(name, wait, action)
}
