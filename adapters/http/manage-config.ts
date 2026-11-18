import { parseManageConfig } from '../../domains/catalogue/instance-config'
import { accessJwksSource } from '../../domains/catalogue/identity'
import { PublicationService, type PublicationDeps, type PublicationOptions } from '../../domains/publication'
import { RevisionStore } from '../../domains/store/revision-store'
import type { ShlinkConfig } from '../shlink/client'
import type { OgRuntime } from '../render/og-orchestrator'
import type { ImportApproval } from '../../domains/catalogue/import'

export interface ImportSource {
  readonly bucket: R2Bucket
  readonly approvals: readonly ImportApproval[]
}

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
  shlink?: ShlinkConfig
  shortDomain?: string
  og?: OgRuntime
  importSource?: ImportSource
}

function numbers(value: unknown, keys: readonly string[]): Record<string, number> {
  if (typeof value !== 'string') throw new Error('configuration')
  const parsed: unknown = JSON.parse(value)
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('configuration')
  const obj = parsed as Record<string, unknown>
  if (Object.keys(obj).length !== keys.length || !keys.every(k => Object.hasOwn(obj, k) && Number.isSafeInteger(obj[k]))) throw new Error('configuration')
  return obj as Record<string, number>
}

function importSource(env: Record<string, unknown>): ImportSource | undefined {
  if (env.FORGE_IMPORT_SOURCE === undefined && env.FORGE_IMPORT_INVENTORIES === undefined) return undefined
  const bucket = env.FORGE_IMPORT_SOURCE as R2Bucket | undefined
  if (!bucket || typeof bucket.get !== 'function' || typeof env.FORGE_IMPORT_INVENTORIES !== 'string') throw new Error('configuration')
  const value: unknown = JSON.parse(env.FORGE_IMPORT_INVENTORIES)
  if (!Array.isArray(value) || value.length === 0 || value.length > 1000) throw new Error('configuration')
  const keys = ['inventoryId', 'selectionId', 'sourceInstance', 'objectKey', 'objectVersion', 'sha256', 'approvalRef', 'kind', 'g1bRef', 'maxInventoryBytes']
  const seen = new Set<string>()
  for (const item of value) {
    if (!item || typeof item !== 'object' || Array.isArray(item) || Object.keys(item).length !== keys.length ||
        !keys.every(k => Object.hasOwn(item, k)) ||
        !keys.filter(k => k !== 'g1bRef' && k !== 'maxInventoryBytes').every(k => typeof item[k] === 'string' && item[k].length > 0 && item[k].length <= 1024) ||
        !Number.isSafeInteger(item.maxInventoryBytes) || item.maxInventoryBytes <= 0 ||
        !(item.g1bRef === null || typeof item.g1bRef === 'string' && item.g1bRef.length > 0 && item.g1bRef.length <= 1024) ||
        !/^[a-f0-9]{64}$/.test(item.sha256) || !['synthetic', 'historical'].includes(item.kind)) throw new Error('configuration')
    const identity = JSON.stringify([item.inventoryId, item.selectionId])
    if (seen.has(identity)) throw new Error('configuration')
    seen.add(identity)
    Object.freeze(item)
  }
  return { bucket, approvals: Object.freeze(value) as readonly ImportApproval[] }
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
  const url = env.SHLINK_API_URL, key = env.SHLINK_API_KEY
  const shlink = typeof url === 'string' && url && typeof key === 'string' && key ? { collectionUrl: url, apiKey: key } : undefined
  const shortDomain = typeof env.SHLINK_DOMAIN === 'string' && env.SHLINK_DOMAIN ? env.SHLINK_DOMAIN : undefined
  const accountId = env.FORGE_BROWSER_ACCOUNT_ID, apiToken = env.FORGE_BROWSER_API_TOKEN
  const og = typeof accountId === 'string' && /^[a-f0-9]{32}$/i.test(accountId) && typeof apiToken === 'string' && apiToken.length > 0 && !/[\r\n]/.test(apiToken) ? { accountId, apiToken } : undefined
  return { deps, service: new PublicationService(deps), transport, shlink, shortDomain, og, importSource: importSource(env) }
}
