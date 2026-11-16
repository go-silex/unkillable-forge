import { parseManageConfig } from '../../domains/catalogue/instance-config'
import { accessJwksSource } from '../../domains/catalogue/identity'
import { PublicationService, type PublicationDeps, type PublicationOptions } from '../../domains/publication'
import { RevisionStore } from '../../domains/store/revision-store'

export interface TransportOptions {
  maxCommandBytes: number
  commandReadTimeoutMs: number
  maxUploadBytes: number
  maxJsonDepth: number
}
export interface Runtime {
  deps: PublicationDeps
  service: PublicationService
  transport: TransportOptions
}

function numbers(value: unknown, keys: readonly string[]): Record<string, number> {
  if (typeof value !== 'string') throw new Error('configuration')
  const parsed: unknown = JSON.parse(value)
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('configuration')
  const obj = parsed as Record<string, unknown>
  if (Object.keys(obj).length !== keys.length || !keys.every(k => Object.hasOwn(obj, k) && Number.isSafeInteger(obj[k]))) throw new Error('configuration')
  return obj as Record<string, number>
}

const cache = new WeakMap<object, Promise<Runtime | null>>()
export function runtimeFor(env: Record<string, unknown>): Promise<Runtime | null> {
  let result = cache.get(env)
  if (!result) {
    result = createRuntime(env).catch(() => null)
    cache.set(env, result)
  }
  return result
}

async function createRuntime(env: Record<string, unknown>): Promise<Runtime | null> {
  const parsed = await parseManageConfig(env)
  if (!parsed.ok) return null
  const bucket = env.REVISION_BYTES as R2Bucket | undefined
  if (!bucket || !['put', 'head', 'get', 'list', 'delete'].every(k => typeof (bucket as unknown as Record<string, unknown>)[k] === 'function')) return null
  const publication = numbers(env.FORGE_PUBLICATION_OPTIONS, ['sessionTtlMs', 'maxUploadTimeoutMs', 'retainMs', 'marginMs', 'manageClockSkewMs', 'readClockSkewMs']) as unknown as PublicationOptions
  const transport = numbers(env.FORGE_MANAGE_TRANSPORT, ['maxCommandBytes', 'commandReadTimeoutMs', 'maxUploadBytes', 'maxJsonDepth']) as unknown as TransportOptions
  if (Object.values(transport).some(n => n <= 0) || transport.commandReadTimeoutMs > 2147483647 || transport.maxJsonDepth > 64 || publication.maxUploadTimeoutMs > 2147483647 ||
      !Number.isSafeInteger(900000 + publication.manageClockSkewMs + publication.readClockSkewMs) ||
      !Number.isSafeInteger(publication.maxUploadTimeoutMs + publication.manageClockSkewMs + publication.readClockSkewMs)) return null
  const deps: PublicationDeps = { db: env.DB as D1Database, config: parsed.config, jwks: accessJwksSource(), now: Date.now, store: new RevisionStore(bucket, parsed.config.instanceId), publication }
  return { deps, service: new PublicationService(deps), transport }
}
