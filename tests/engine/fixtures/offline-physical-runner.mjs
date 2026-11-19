// Fixed synthetic test harness: real descriptor operations and local native preparation only.
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { prepare } from '../../../scripts/forge-import-offline.mjs'
import { sourceAccess } from '../../../scripts/forge-import-physical.mjs'

const [mode, selection, workspace, capture] = process.argv.slice(2)
if (!['observe', 'remove-second', 'alias-collision'].includes(mode) || !selection || !workspace || !capture) throw new Error('invalid synthetic harness arguments')
const bodyReads = []
let removed = false
function instrument(source) {
  return {
    async open(relative) {
      const file = await source.open(relative)
      return new Proxy(file, {
        get(target, property) {
          const value = Reflect.get(target, property, target)
          if (property === 'read' && typeof value === 'function') return (...args) => { bodyReads.push(relative); return Reflect.apply(value, target, args) }
          return typeof value === 'function' ? value.bind(target) : value
        },
      })
    },
    close: () => source.close(),
  }
}
const access = {
  metadata: sourceAccess.metadata,
  inspect: (source, relative, authorized) => sourceAccess.inspect(instrument(source), relative, authorized),
  async readPinned(source, relative, observed, identity, cap) {
    if (mode === 'remove-second' && relative === 'second.html' && !removed) {
      removed = true
      await rm(join(capture, 'second.html'))
    }
    return sourceAccess.readPinned(instrument(source), relative, observed, identity, cap)
  },
}
try {
  const roots = mode === 'alias-collision' ? { capture, alternate: capture } : { capture }
  const result = await prepare({ selection, workspace, roots }, access)
  console.log(JSON.stringify({ fatal: result.fatal, pinned: result.pinned, units: result.units, compatibility: result.compatibility, census: result.census, bodyReads, removed }))
} catch (error) {
  console.log(JSON.stringify({ error: ['protected_locator', 'invalid_locator'].includes(error?.message) ? error.message : 'offline_operation_failed', bodyReads, removed }))
  process.exitCode = 1
}
