// Fixed synthetic test harness: real descriptor operations and local native preparation only.
import { appendFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { prepare } from '../../../scripts/forge-import-offline.mjs'
import { sourceAccess } from '../../../scripts/forge-import-physical.mjs'

const [mode, selection, workspace, capture] = process.argv.slice(2)
if (!['observe', 'remove-second', 'remove-style', 'grow', 'alias-collision'].includes(mode) || !selection || !workspace || !capture) throw new Error('invalid synthetic harness arguments')
const bodyReads = []
const metadataPaths = []
const bodyBytes = {}
let grown = false
let removed = false
function instrument(source) {
  return {
    async open(relative) {
      const file = await source.open(relative)
      return new Proxy(file, {
        get(target, property) {
          const value = Reflect.get(target, property, target)
          if (property === 'read' && typeof value === 'function') return async (...args) => {
            bodyReads.push(relative)
            if (mode === 'grow' && relative === 'grow.css' && !grown) {
              grown = true
              await appendFile(join(capture, 'grow.css'), Buffer.alloc(65536, 120))
            }
            const result = await Reflect.apply(value, target, args)
            bodyBytes[relative] = (bodyBytes[relative] ?? 0) + result.bytesRead
            return result
          }
          return typeof value === 'function' ? value.bind(target) : value
        },
      })
    },
    close: () => source.close(),
  }
}
const access = {
  metadata: (source, relative) => { metadataPaths.push(relative); return sourceAccess.metadata(source, relative) },
  inspect: (source, relative, ...args) => sourceAccess.inspect(instrument(source), relative, ...args),
  async readPinned(source, relative, observed, identity, cap) {
    if (((mode === 'remove-second' && relative === 'second.html') || (mode === 'remove-style' && relative === 'second.css')) && !removed) {
      removed = true
      await rm(join(capture, relative))
    }
    return sourceAccess.readPinned(instrument(source), relative, observed, identity, cap)
  },
}
try {
  const roots = mode === 'alias-collision' ? { capture, alternate: capture } : { capture }
  const result = await prepare({ selection, workspace, roots }, access)
  console.log(JSON.stringify({ fatal: result.fatal, pinned: result.pinned, units: result.units, compatibility: result.compatibility, census: result.census, metadataPaths, bodyReads, bodyBytes, removed, grown }))
} catch (error) {
  console.log(JSON.stringify({ error: ['protected_locator', 'invalid_locator'].includes(error?.message) ? error.message : 'offline_operation_failed', metadataPaths, bodyReads, bodyBytes, removed, grown }))
  process.exitCode = 1
}
