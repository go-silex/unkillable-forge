import { env } from 'cloudflare:workers'
import { beforeEach, expect, it, vi } from 'vitest'
import { runOgJob } from '../../adapters/render/og-orchestrator'
import { OG_RECIPE } from '../../adapters/render/browser-run'
import { captureRenderGraph } from '../../domains/catalogue/render-graph'
import { enqueueEnrichment } from '../../domains/delivery/enrichments'
import { RevisionStore } from '../../domains/store/revision-store'
import { actor, artifactId, bootstrap, configs, instanceId, jwks, pageFixture, pageId, revisionId } from './fixtures/catalogue'

beforeEach(async () => { await bootstrap(); await pageFixture(); await env.DB.prepare("UPDATE revision_resources SET object_version='version-1' WHERE revision_id=?").bind(revisionId).run() })

it.each(['get', 'body'] as const)('bounds a stalled input %s by the job lease without sleeping', async stage => {
  const deps = { db: env.DB, config: (await configs()).manage, jwks, now: () => 10 }
  const hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(OG_RECIPE))), b => b.toString(16).padStart(2, '0')).join('')
  const graph = await captureRenderGraph(deps, actor, { artifactId, revisionId, pageId, expectedContentVersion: 0, expectedPolicyEpoch: 0, recipeSha256: hash })
  const job = await enqueueEnrichment(deps, actor, { artifactId, revisionId, pageId, expectedContentVersion: 0, expectedPolicyEpoch: 0, kind: 'og', inputSha256: graph.inputSha256, desiredGrantId: null, graph })
  let reached!: () => void
  const entered = new Promise<void>(resolve => { reached = resolve })
  let cancelled = false
  const stream = new ReadableStream<Uint8Array>({ pull() { reached(); return new Promise<void>(() => {}) }, cancel() { cancelled = true } }, { highWaterMark: 0 })
  const base = new RevisionStore(env.REVISION_BYTES, instanceId)
  const store = new Proxy(base, { get(target, property) {
    if (property === 'get') return async () => {
      if (stage === 'get') { reached(); return new Promise<never>(() => {}) }
      return { key: 'document', version: 'version-1', size: 1, checksums: { sha256: new Uint8Array(32).fill(0xaa).buffer }, body: stream }
    }
    const value = Reflect.get(target, property, target)
    return typeof value === 'function' ? value.bind(target) : value
  } })
  const nativeTimer = globalThis.setTimeout
  let expire: (() => void) | undefined
  const timer = vi.spyOn(globalThis, 'setTimeout').mockImplementation(((callback: (...args: unknown[]) => void, delay?: number, ...args: unknown[]) => {
    if (delay === 120_000) { expire = () => callback(...args); return 0 }
    return nativeTimer(callback, delay, ...args)
  }) as typeof setTimeout)
  try {
    const result = runOgJob(deps, actor, store, { accountId: '0'.repeat(32), apiToken: 'token' }, job)
    await entered
    expect(expire).toBeDefined()
    expire!()
    expect(await result).toMatchObject({ state: 'failed', code: 'render_timeout' })
    if (stage === 'body') expect(cancelled).toBe(true)
    expect(await env.DB.prepare('SELECT count(*) AS n FROM preview_selections').first()).toEqual({ n: 0 })
  } finally { timer.mockRestore() }
})
