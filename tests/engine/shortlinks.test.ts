import { env } from 'cloudflare:workers'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createShortlink } from '../../adapters/shlink/client'
import { setShortlinkMapping, shortlinkDestinationDigest, type ShortlinkMapping } from '../../domains/catalogue/shortlinks'
import { actor, artifactId, bootstrap, configs, jwks, pageFixture, pageId, revisionId } from './fixtures/catalogue'

const destination = 'https://forge.example.test/s/page/secret/'
const observed = { shortCode: 'owned-code', shortUrl: 'https://short.example/owned-code', longUrl: destination }
const config = { collectionUrl: 'https://short.example/rest/v3/short-urls', apiKey: 'test' }
const input = { shortCode: 'owned-code', shortDomain: 'short.example', destination }

describe('create-only Shlink', () => {
  it('creates the exact identity without a retarget request', async () => {
    const fetcher = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => Response.json(observed))
    const result = await createShortlink({ ...config, fetch: fetcher as typeof fetch }, input)
    expect(result).toMatchObject({ state: 'ready', source: 'created', mapping: { shortCode: 'owned-code', destination } })
    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(fetcher.mock.calls[0][1]).toMatchObject({ method: 'POST' })
    expect(JSON.parse(fetcher.mock.calls[0][1]!.body as string)).toMatchObject({ customSlug: input.shortCode, domain: input.shortDomain, longUrl: destination })
  })
  it('reconciles a lost create only when provider identity and destination match', async () => {
    const fetcher = vi.fn().mockRejectedValueOnce(new Error('lost')).mockResolvedValueOnce(Response.json(observed))
    expect(await createShortlink({ ...config, fetch: fetcher as typeof fetch }, input)).toMatchObject({ state: 'ready', source: 'preserved' })
    expect(fetcher.mock.calls.map(call => call[1].method)).toEqual(['POST', 'GET'])
    expect(fetcher.mock.calls[1][0]).toBe(`${config.collectionUrl}/owned-code?domain=short.example`)
  })
  it('reports collisions and outages without patching', async () => {
    const collision = vi.fn().mockResolvedValueOnce(new Response(null, { status: 409 })).mockResolvedValueOnce(Response.json({ ...observed, longUrl: 'https://elsewhere.example/' }))
    expect(await createShortlink({ ...config, fetch: collision as typeof fetch }, input)).toMatchObject({ state: 'failed', code: 'shortlink_conflict', retryable: false })
    const outage = vi.fn().mockRejectedValue(new Error('offline'))
    expect(await createShortlink({ ...config, fetch: outage as typeof fetch }, input)).toMatchObject({ state: 'failed', code: 'shortlink_unavailable', retryable: true })
  })
  it('rejects a provider response for a different short domain', async () => {
    const fetcher = vi.fn().mockResolvedValue(Response.json({ ...observed, shortUrl: 'https://other.example/owned-code' }))
    expect(await createShortlink({ ...config, fetch: fetcher as typeof fetch }, input)).toMatchObject({ state: 'failed', code: 'shortlink_conflict', retryable: false })
  })
})

describe('Catalogue shortlink mappings', () => {
  beforeEach(async () => { await bootstrap(); await pageFixture() })
  it('preserves imported exact mappings and requires a guarded digest CAS for reconciliation', async () => {
    const deps = { db: env.DB, config: (await configs()).manage, jwks, now: () => 10 }
    const target = { pageId, artifactId, revisionId, expectedPolicyEpoch: 0, expectedContentVersion: 0 }
    const mapping: ShortlinkMapping = { mappingId: 'legacy-1', providerOrigin: 'https://short.example', providerId: null, shortDomain: 'short.example', shortCode: 'actual-legacy-code', shortUrl: 'https://short.example/actual-legacy-code', pageId, grantId: null, destination, source: 'imported', observedAt: 10, destinationDigest: await shortlinkDestinationDigest(destination) }
    await setShortlinkMapping(deps, actor, target, { op: 'create', mapping })
    const nextDestination = 'https://forge.example.test/s/page/new-secret/'
    const next = { ...mapping, destination: nextDestination, destinationDigest: await shortlinkDestinationDigest(nextDestination) }
    await expect(setShortlinkMapping(deps, actor, target, { op: 'reconcile', mapping: next, expectedDestinationDigest: '0'.repeat(64) })).rejects.toMatchObject({ code: 'conflict' })
    expect(await env.DB.prepare('SELECT short_code,destination FROM shortlink_mappings WHERE mapping_id = ?').bind(mapping.mappingId).first()).toEqual({ short_code: mapping.shortCode, destination })
    await setShortlinkMapping(deps, actor, target, { op: 'reconcile', mapping: next, expectedDestinationDigest: mapping.destinationDigest })
    expect(await env.DB.prepare('SELECT destination FROM shortlink_mappings WHERE mapping_id = ?').bind(mapping.mappingId).first()).toEqual({ destination: nextDestination })
    await expect(setShortlinkMapping(deps, actor, { ...target, expectedPolicyEpoch: 1 }, { op: 'reconcile', mapping, expectedDestinationDigest: next.destinationDigest })).rejects.toMatchObject({ code: 'conflict' })
  })
})
