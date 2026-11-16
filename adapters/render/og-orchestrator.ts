import type { ManageDeps } from '../../domains/catalogue/commands'
import type { ManageActor } from '../../domains/catalogue/principals'
import { PolicyError } from '../../domains/catalogue/guard'
import { captureRenderGraph, renderGraphAssertionStatements, type RenderResource } from '../../domains/catalogue/render-graph'
import { claimEnrichment, enqueueEnrichment, failEnrichment, finalizeOg, loadEnrichmentOgGraph, prepareEnrichmentOg, putEnrichmentOg, readOgIntent, type EnrichmentAttempt, type EnrichmentErrorCode } from '../../domains/delivery/enrichments'
import { DerivedStore } from '../../domains/store/derived-store'
import { RevisionStore, StoreError } from '../../domains/store/revision-store'
import { OG_RECIPE, RenderError, renderOgScreenshot } from './browser-run'

export interface OgTarget {
  readonly artifactId: string
  readonly revisionId: string
  readonly pageId: string
  readonly expectedPolicyEpoch: number
  readonly expectedContentVersion: number
  readonly desiredGrantId?: string | null
}
export interface OgRuntime {
  readonly accountId: string
  readonly apiToken: string
  readonly fetch?: typeof fetch
}
export type OgResult =
  | { readonly state: 'ready'; readonly jobId: string }
  | { readonly state: 'failed'; readonly jobId: string; readonly code: EnrichmentErrorCode; readonly recorded: boolean }

const leaseMs = 120_000
const putDeadlineMs = 30_000
// Raw graph bytes are bounded separately; encoded payload expansion can still be rejected by Browser Run.
const maxInputBytes = 45 * 1024 * 1024
const maxOutputBytes = 10 * 1024 * 1024
const hex = (buffer: ArrayBuffer): string => Array.from(new Uint8Array(buffer), b => b.toString(16).padStart(2, '0')).join('')
const sha256 = async (bytes: Uint8Array): Promise<string> => hex(await crypto.subtle.digest('SHA-256', bytes as BufferSource))

/** Capture and admit a fresh graph under the committing actor, without rendering it. */
export async function enqueueOgForPage(deps: ManageDeps, actor: ManageActor, target: OgTarget): Promise<string> {
  const recipeSha256 = await sha256(new TextEncoder().encode(OG_RECIPE))
  const graph = await captureRenderGraph(deps, actor, { ...target, recipeSha256 })
  return enqueueEnrichment(deps, actor, { ...target, desiredGrantId: target.desiredGrantId ?? null, kind: 'og', graph, inputSha256: graph.inputSha256 })
}

async function readResource(store: RevisionStore, resource: RenderResource, signal: AbortSignal): Promise<Uint8Array> {
  const object = await store.get({ kind: 'resource', artifactId: resource.artifactId, revisionId: resource.revisionId, path: resource.path })
  if (signal.aborted) {
    if (object && 'body' in object && object.body) void object.body.cancel().catch(() => {})
    throw new RenderError('render_timeout', 'OG deadline exceeded')
  }
  if (!object || !('body' in object) || !object.body) throw new StoreError('integrity_error')
  const checksum = object.checksums.sha256
  if (object.key !== resource.objectKey || object.version !== resource.objectVersion || object.size !== resource.size || !checksum || hex(checksum) !== resource.sha256) {
    void object.body.cancel().catch(() => {})
    throw new StoreError('integrity_error')
  }
  const reader = object.body.getReader()
  const cancel = () => { void reader.cancel().catch(() => {}) }
  signal.addEventListener('abort', cancel, { once: true })
  const bytes = new Uint8Array(resource.size)
  let offset = 0
  try {
    for (;;) {
      const part = await reader.read()
      if (part.done) break
      if (!(part.value instanceof Uint8Array) || part.value.byteLength > bytes.length - offset) throw new StoreError('integrity_error')
      bytes.set(part.value, offset)
      offset += part.value.byteLength
    }
    if (offset !== bytes.length || await sha256(bytes) !== resource.sha256) throw new StoreError('integrity_error')
    return bytes
  } catch (error) {
    void reader.cancel().catch(() => {})
    throw error
  } finally { signal.removeEventListener('abort', cancel); reader.releaseLock() }
}

/** Consume exactly one already-admitted job. The caller controls scheduling and credentials. */
export async function runOgJob(deps: ManageDeps, actor: ManageActor, store: RevisionStore, runtime: OgRuntime, jobId: string): Promise<OgResult> {
  const { db, config, now } = deps
  let attempt: EnrichmentAttempt | undefined
  let stage: 'target' | 'input' | 'render' | 'output' = 'target'
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  let deadline = 0
  const bounded = async <T>(operation: () => Promise<T>): Promise<T> => {
    if (controller.signal.aborted || now() >= deadline) throw new RenderError('render_timeout', 'OG deadline exceeded')
    let rejectTimeout!: (error: Error) => void
    const timeout = new Promise<never>((_, reject) => { rejectTimeout = reject })
    const onAbort = () => rejectTimeout(new RenderError('render_timeout', 'OG deadline exceeded'))
    controller.signal.addEventListener('abort', onAbort, { once: true })
    try {
      const value = await Promise.race([operation(), timeout])
      if (controller.signal.aborted || now() >= deadline) throw new RenderError('render_timeout', 'OG deadline exceeded')
      return value
    } finally { controller.signal.removeEventListener('abort', onAbort) }
  }
  try {
    if (store.instanceId !== config.instanceId) throw new PolicyError('invalid_state')
    const intent = await readOgIntent(db, config.instanceId, jobId)
    const recipeSha256 = await sha256(new TextEncoder().encode(OG_RECIPE))
    const fresh = await captureRenderGraph(deps, actor, { ...intent, recipeSha256 })
    if (!intent.prepared) await prepareEnrichmentOg(deps, actor, jobId, fresh)
    const graph = await loadEnrichmentOgGraph(db, config.instanceId, jobId)
    if (graph.recipeSha256 !== recipeSha256 || fresh.inputSha256 !== graph.inputSha256) throw new PolicyError('conflict')
    const started = now()
    deadline = started + leaseMs
    attempt = await claimEnrichment(db, config.instanceId, jobId, started, leaseMs)
    const remaining = deadline - now()
    if (remaining <= 0 || remaining > leaseMs) throw new RenderError('render_timeout', 'OG deadline exceeded')
    timer = setTimeout(() => controller.abort(), remaining)
    let total = 0
    for (const resource of graph.resources) {
      if (!Number.isSafeInteger(resource.size) || resource.size < 0) throw new StoreError('integrity_error')
      if (resource.size > maxInputBytes - total) throw new RenderError('render_rejected', 'Render input exceeds the admitted byte limit')
      total += resource.size
    }
    stage = 'input'
    let document: Uint8Array | undefined
    const resources: { path: string; contentType: string; bytes: Uint8Array }[] = []
    for (const resource of graph.resources) {
      const bytes = await bounded(() => readResource(store, resource, controller.signal))
      if (resource.path === graph.documentPath && resource.kind === 'document') {
        if (document) throw new StoreError('integrity_error')
        document = bytes
      } else resources.push({ path: resource.path, contentType: resource.contentType, bytes })
    }
    if (!document) throw new StoreError('integrity_error')
    stage = 'target'
    const authorized = await bounded(() => captureRenderGraph(deps, actor, { artifactId: graph.artifactId, revisionId: graph.revisionId, pageId: graph.pageId, expectedPolicyEpoch: graph.policyEpoch, expectedContentVersion: graph.contentVersion, recipeSha256 }))
    if (authorized.inputSha256 !== graph.inputSha256) throw new PolicyError('conflict')
    const guard = renderGraphAssertionStatements(db, graph)
    await bounded(() => db.batch([...guard.assertions, ...guard.cleanups]))
    stage = 'render'
    const request = runtime.fetch ?? fetch
    const image = await bounded(() => renderOgScreenshot({ ...runtime, fetch: (input, init) => request(input, { ...init, signal: init?.signal ? AbortSignal.any([init.signal, controller.signal]) : controller.signal }) }, { documentPath: graph.documentPath, document: document!, resources }))
    if (!(image instanceof Uint8Array) || image.byteLength < 4 || image.byteLength > maxOutputBytes || image[0] !== 0xff || image[1] !== 0xd8 || image[image.length - 2] !== 0xff || image[image.length - 1] !== 0xd9) throw new StoreError('integrity_error')
    stage = 'output'
    const contentSha256 = await sha256(image)
    const derived = new DerivedStore(store)
    const ref = { kind: 'og' as const, artifactId: graph.artifactId, revisionId: graph.revisionId, pageId: graph.pageId, recipeSha256: graph.recipeSha256, inputSha256: graph.inputSha256, contentSha256, extension: 'jpg' as const }
    const body = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(image); controller.close() } })
    const putRemaining = Math.min(putDeadlineMs, deadline - now())
    if (putRemaining < 1) throw new RenderError('render_timeout', 'OG deadline exceeded')
    const descriptor = await bounded(() => putEnrichmentOg(db, config.instanceId, attempt!, derived, ref, { size: image.byteLength, sha256: contentSha256 }, body, now, putRemaining))
    await bounded(() => finalizeOg(deps, actor, attempt!, derived, descriptor, controller.signal))
    return { state: 'ready', jobId }
  } catch (error) {
    const code: EnrichmentErrorCode = error instanceof RenderError ? error.code
      : error instanceof StoreError && error.code === 'integrity_error' ? 'integrity_error'
      : stage === 'target' || error instanceof PolicyError ? 'target_changed'
      : stage === 'input' || stage === 'output' ? 'render_unavailable'
      : error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError') ? 'render_timeout'
      : 'render_unavailable'
    let recorded = false
    if (attempt) {
      try { await failEnrichment(db, config.instanceId, attempt, now(), code, code === 'render_timeout' || code === 'render_unavailable') ; recorded = true } catch { /* Expired or superseded attempts cannot record a failure. */ }
    }
    return { state: 'failed', jobId, code, recorded }
  } finally {
    clearTimeout(timer)
    controller.abort()
  }
}

/** Convenience for a single committed page; bulk callers should enqueue and schedule separately. */
export async function generateOgForPage(deps: ManageDeps, actor: ManageActor, store: RevisionStore, runtime: OgRuntime, target: OgTarget): Promise<OgResult> {
  return runOgJob(deps, actor, store, runtime, await enqueueOgForPage(deps, actor, target))
}
