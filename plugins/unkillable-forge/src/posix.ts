import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

type Handle = object
export interface NativeBridge {
  root(): Handle
  child(dir: Handle, name: string, create: boolean, privateDirectory: boolean): Handle
  file(dir: Handle, name: string, mode: 0 | 1 | 2 | 3): Handle
  close(handle: Handle): void
  fd(handle: Handle): number
  identity(handle: Handle): { dev: bigint; ino: bigint; type: number }
  mutation(dir: Handle, name: string, operation: 0 | 1 | 2, destination: string): void
  names(dir: Handle): string[]
  space(dir: Handle): bigint
  sync(dir: Handle): void
  lock(handle: Handle, acquire: boolean): boolean
}

function record(value: unknown, keys: string[]): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).sort().join(',') === [...keys].sort().join(',')
}
const hex = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
const nonempty = (value: unknown): value is string => typeof value === 'string' && value.length > 0
function load(): NativeBridge {
  if (!['linux', 'darwin'].includes(process.platform) || !['x64', 'arm64'].includes(process.arch) || Number(process.versions.napi) < 8) throw new Error('native_unsupported')
  const moduleDir = dirname(fileURLToPath(import.meta.url))
  const nativeDir = join(moduleDir, moduleDir.endsWith('/src') ? '../dist/native' : 'native')
  try {
    const manifest: unknown = JSON.parse(readFileSync(join(nativeDir, 'manifest.json'), 'utf8'))
    if (!record(manifest, ['format', 'version', 'napiVersion', 'artifacts']) || manifest.format !== 'unkillable-forge-native' || manifest.version !== 1 || manifest.napiVersion !== 8 || !Array.isArray(manifest.artifacts)) throw new Error()
    const selected = manifest.artifacts.filter((a: unknown) => record(a, ['platform', 'arch', 'file', 'sha256', 'sourceInputSha256', 'nodeHeaders', 'toolchain', 'provenance']) && a.platform === process.platform && a.arch === process.arch)
    if (selected.length !== 1) throw new Error()
    const a = selected[0] as Record<string, unknown>
    const headers = a.nodeHeaders, toolchain = a.toolchain, provenance = a.provenance
    if (a.file !== `${process.platform}-${process.arch}/posix.node` || !hex(a.sha256) || !hex(a.sourceInputSha256) || !record(headers, ['version', 'sha256']) || !nonempty(headers.version) || !hex(headers.sha256) || !record(toolchain, ['compiler', 'target', 'osFloor', 'libcFloor', 'sdk']) || !nonempty(toolchain.compiler) || !nonempty(toolchain.target) || !nonempty(toolchain.osFloor) || !(toolchain.libcFloor === null || nonempty(toolchain.libcFloor)) || !(toolchain.sdk === null || nonempty(toolchain.sdk))) throw new Error()
    if (!(record(provenance, ['kind']) && provenance.kind === 'local') && !(record(provenance, ['kind', 'repository', 'runId', 'inputSha']) && provenance.kind === 'ci' && provenance.repository === 'go-silex/unkillable-forge' && nonempty(provenance.runId) && nonempty(provenance.inputSha))) throw new Error()
    const path = join(nativeDir, a.file as string)
    if (createHash('sha256').update(readFileSync(path)).digest('hex') !== a.sha256) throw new Error()
    return createRequire(import.meta.url)(path) as NativeBridge
  } catch { throw new Error('native_payload_invalid') }
}
let bridge: NativeBridge | undefined
export function native(): NativeBridge { return bridge ??= load() }
