// Metadata authorization, bounded source reads and native pinning for the offline importer.
import { createHash, webcrypto } from 'node:crypto'
import { resolve } from 'node:path'

const fail = code => { throw new Error(code) }
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const identity = info => `${info.dev}:${info.ino}`
const sameFile = (a, b) => a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs
const invalidRelative = path => typeof path !== 'string' || path.includes('\\') || path.includes('\0') || path.split('/').some(part => !part || part === '.' || part === '..')
const credentialRelative = path => invalidRelative(path) || path.split('/').some(part => part === '.env' || part.startsWith('.env.') || part === '.git' || part === '.ssh')
const unreadable = error => ['EACCES', 'EPERM', 'EIO', 'ELOOP', 'ENOTDIR', 'EINVAL'].includes(error?.code)

export const sourceAccess = {
  async metadata(source, relative) {
    const file = await source.open(relative)
    try { return await file.stat({ bigint: true }) } finally { await file.close() }
  },
  async inspect(source, relative, authorized) {
    let file
    try { file = await source.open(relative) } catch (error) {
      if (error.code === 'ENOENT') return { observation: { state: 'absent' } }
      if (unreadable(error)) return { observation: { state: 'unreadable' } }
      if (error.message === 'filesystem_identity_mismatch') return { observation: { state: 'unknown' } }
      throw error
    }
    try {
      const before = await file.stat({ bigint: true })
      if (!authorized || !sameFile(authorized, before)) return { observation: { state: 'unknown' } }
      const hash = createHash('sha256'), buffer = Buffer.allocUnsafe(64 * 1024)
      let offset = 0
      for (;;) {
        const { bytesRead } = await file.read(buffer, 0, buffer.length, offset)
        if (!bytesRead) break
        hash.update(buffer.subarray(0, bytesRead)); offset += bytesRead
        if (!Number.isSafeInteger(offset)) fail('source_changed')
      }
      const after = await file.stat({ bigint: true })
      if (!sameFile(before, after) || BigInt(offset) !== after.size) return { observation: { state: 'unknown' } }
      return { observation: { state: 'present', size: offset, sha256: hash.digest('hex') }, identity: after }
    } catch (error) {
      if (unreadable(error)) return { observation: { state: 'unreadable' } }
      if (error.message === 'filesystem_identity_mismatch' || error.message === 'source_changed') return { observation: { state: 'unknown' } }
      throw error
    } finally { await file.close() }
  },
  async readPinned(source, relative, observed, initial, cap) {
    if (!initial || observed.size > cap) fail('source_changed')
    const file = await source.open(relative)
    try {
      const before = await file.stat({ bigint: true })
      if (!sameFile(initial, before) || before.size !== BigInt(observed.size)) fail('source_changed')
      const bytes = Buffer.allocUnsafe(observed.size)
      let offset = 0
      while (offset < bytes.length) {
        const part = await file.read(bytes, offset, bytes.length - offset, offset)
        if (!part.bytesRead) fail('source_changed')
        offset += part.bytesRead
      }
      const after = await file.stat({ bigint: true })
      if (!sameFile(before, after) || sha(bytes) !== observed.sha256) fail('source_changed')
      return bytes
    } finally { await file.close() }
  },
}

export async function authorizeSources({ reads, protectedLocators, sources, rootPaths }, access = sourceAccess) {
  const deniedPaths = new Set(), deniedIdentities = new Set(), metadata = new Map()
  let collision = false
  const locatorPath = locator => {
    if (!locator || !sources.has(locator.root) || invalidRelative(locator.relative)) fail('invalid_locator')
    return resolve(rootPaths.get(locator.root), locator.relative)
  }
  for (const item of protectedLocators) {
    const path = locatorPath(item.locator)
    deniedPaths.add(path)
    try { deniedIdentities.add(identity(await access.metadata(sources.get(item.locator.root), item.locator.relative))) }
    catch (error) { if (!['ENOENT', 'ENOTDIR', 'EINVAL'].includes(error.code)) throw error }
  }
  for (const item of reads) {
    const path = locatorPath(item.locator)
    if (credentialRelative(item.locator.relative)) fail('invalid_locator')
    if (deniedPaths.has(path)) collision = true
    try {
      const info = await access.metadata(sources.get(item.locator.root), item.locator.relative)
      if (deniedIdentities.has(identity(info))) collision = true
      metadata.set(item.ordinal, { identity: info })
    } catch (error) {
      if (error.code === 'ENOENT') metadata.set(item.ordinal, { observation: { state: 'absent' } })
      else if (unreadable(error)) metadata.set(item.ordinal, { observation: { state: 'unreadable' } })
      else if (error.message === 'filesystem_identity_mismatch') metadata.set(item.ordinal, { observation: { state: 'unknown' } })
      else throw error
    }
  }
  if (collision) fail('protected_locator')
  return metadata
}

export async function inspectSources(reads, authorization, sources, access = sourceAccess) {
  const observations = {}, identities = new Map()
  for (const item of reads) {
    const admitted = authorization.get(item.ordinal)
    const result = admitted.observation ? admitted : await access.inspect(sources.get(item.locator.root), item.locator.relative, admitted.identity)
    observations[item.path] = result.observation
    if (result.identity) identities.set(item.path, result.identity)
  }
  return { observations, identities }
}

export async function pinUnits({ units, reads, observations, identities, sources, bucket, transport, assignSourcePins, sealInventory, validateUnit }, access = sourceAccess) {
  const byPath = new Map(reads.map(item => [item.path, item])), pins = {}, pinHashes = {}, output = [], approvals = [], pinFailures = []
  for (const unit of units) {
    if (unit.status !== 'representable') { output.push(unit); continue }
    try { validateUnit(unit) } catch (error) {
      if (error.message !== 'budget_exceeded') throw error
      pinFailures.push({ unitId: unit.unitId, code: 'budget_exceeded' }); output.push(unit); continue
    }
    let failure = null
    for (const file of unit.inventory.files) {
      if (Object.hasOwn(pins, file.sourceRef) && pinHashes[file.sourceRef] !== file.sha256) fail('invalid_selection')
      if (Object.hasOwn(pins, file.sourceRef)) continue
      const item = byPath.get(file.path), observed = observations[file.path]
      if (!item || observed?.state !== 'present') fail('missing_source')
      let bytes
      try { bytes = await access.readPinned(sources.get(item.locator.root), item.locator.relative, observed, identities.get(file.path), Math.min(transport.maxUploadBytes, 32 * 1024 * 1024)) }
      catch (error) {
        if (error.code === 'ENOENT') failure = 'capture_absent'
        else if (unreadable(error)) failure = 'capture_unreadable'
        else if (error.message === 'source_changed' || error.message === 'filesystem_identity_mismatch') failure = 'source_changed'
        else throw error
        break
      }
      const object = await bucket.put(file.sourceRef, bytes)
      pins[file.sourceRef] = { version: object.version }; pinHashes[file.sourceRef] = file.sha256
    }
    if (failure) { pinFailures.push({ unitId: unit.unitId, code: failure }); output.push(unit); continue }
    const assigned = assignSourcePins(unit, pins)
    if (!assigned.ok) {
      if (assigned.code !== 'inventory_budget_exceeded') fail(assigned.code)
      pinFailures.push({ unitId: unit.unitId, code: assigned.code }); output.push(unit); continue
    }
    const object = await bucket.put(`inventory/${unit.inventory.inventoryId}.json`, assigned.bytes)
    const sealed = sealInventory(assigned.unit, { key: object.key, version: object.version }, sha(assigned.bytes))
    if (!sealed.ok) fail(sealed.code)
    output.push(sealed.unit); approvals.push(sealed.approval)
  }
  return { units: output, approvals, pinFailures }
}

export async function createAssertionSigner({ privateKey, kid, now = Date.now }) {
  const key = await webcrypto.subtle.importKey('jwk', privateKey, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign'])
  const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url')
  return async () => {
    const header = encode({ alg: 'RS256', kid })
    const payload = encode({ iss: 'https://team.cloudflareaccess.com', aud: 'manager', sub: 'fixture-admin', exp: Math.floor(now() / 1000) + 3600 })
    const input = `${header}.${payload}`
    return `${input}.${Buffer.from(await webcrypto.subtle.sign('RSASSA-PKCS1-v1_5', key, Buffer.from(input))).toString('base64url')}`
  }
}
