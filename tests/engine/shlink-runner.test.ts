import { env } from 'cloudflare:workers'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { setVisibility } from '../../domains/catalogue/commands'
import { shortlinkDestinationDigest } from '../../domains/catalogue/shortlinks'
import { enqueueEnrichment } from '../../domains/delivery/enrichments'
import { runShortlinkEnrichment } from '../../adapters/shlink/enrichment-runner'
import { actor, artifactId, bootstrap, configs, jwks, pageFixture, pageId, revisionId } from './fixtures/catalogue'

beforeEach(async () => { await bootstrap(); await pageFixture() })
async function setup() {
  const deps = { db:env.DB, config:(await configs()).manage, jwks, now:() => 10 }
  await setVisibility(deps, actor, { artifactId, pageId, expectedPolicyEpoch:0, visibility:'public' })
  const destination = 'https://forge.example.test/a/sample/'
  const job = await enqueueEnrichment(deps, actor, { artifactId,revisionId,pageId,expectedContentVersion:0,expectedPolicyEpoch:1,kind:'shortlink',inputSha256:'a'.repeat(64),desiredGrantId:null,mappingId:'requested-mapping',providerOrigin:'https://short.example',shortDomain:'short.example',shortCode:'owned',destinationSha256:await shortlinkDestinationDigest(destination) })
  return { deps, destination, job }
}

describe('guarded shortlink job', () => {
  it('reconciles a lost create by exact domain, code and destination', async () => {
    const { deps, destination, job } = await setup()
    const fetcher = vi.fn().mockRejectedValueOnce(new Error('lost')).mockResolvedValueOnce(Response.json({ shortCode:'owned',shortUrl:'https://short.example/owned',longUrl:destination }))
    await runShortlinkEnrichment(deps, actor, { collectionUrl:'https://short.example/rest/v3/short-urls',apiKey:'test',fetch:fetcher as typeof fetch }, job, 1000)
    expect(fetcher.mock.calls.map(call => call[1].method)).toEqual(['POST','GET'])
    expect(await env.DB.prepare('SELECT short_domain,short_code,destination FROM shortlink_mappings WHERE mapping_id=?').bind('requested-mapping').first()).toEqual({ short_domain:'short.example',short_code:'owned',destination })
    expect(await env.DB.prepare('SELECT state,result_source FROM enrichment_jobs WHERE job_id=?').bind(job).first()).toEqual({ state:'ready',result_source:'created' })
  })
  it('records provider collision without writing or retargeting a mapping', async () => {
    const { deps, job } = await setup()
    const fetcher = vi.fn().mockResolvedValueOnce(new Response(null,{status:409})).mockResolvedValueOnce(Response.json({ shortCode:'owned',shortUrl:'https://short.example/owned',longUrl:'https://other.example/' }))
    await runShortlinkEnrichment(deps, actor, { collectionUrl:'https://short.example/rest/v3/short-urls',apiKey:'test',fetch:fetcher as typeof fetch }, job, 1000)
    expect(await env.DB.prepare('SELECT count(*) AS n FROM shortlink_mappings').first()).toEqual({ n:0 })
    expect(await env.DB.prepare('SELECT state,error_code FROM enrichment_jobs WHERE job_id=?').bind(job).first()).toEqual({ state:'failed',error_code:'shortlink_conflict' })
  })
  it('records provider outage without changing the published revision', async () => {
    const { deps, job } = await setup()
    const fetcher = vi.fn().mockRejectedValue(new Error('offline'))
    await runShortlinkEnrichment(deps, actor, { collectionUrl:'https://short.example/rest/v3/short-urls',apiKey:'test',fetch:fetcher as typeof fetch }, job, 1000)
    expect(await env.DB.prepare('SELECT state,error_code,retryable FROM enrichment_jobs WHERE job_id=?').bind(job).first()).toEqual({ state:'failed',error_code:'shortlink_unavailable',retryable:1 })
    expect(await env.DB.prepare('SELECT active_revision_id,content_version FROM artifacts WHERE artifact_id=?').bind(artifactId).first()).toEqual({ active_revision_id:revisionId,content_version:0 })
  })
  it('rejects a policy change before contacting the provider', async () => {
    const { deps, job } = await setup()
    await setVisibility(deps, actor, { artifactId,pageId,expectedPolicyEpoch:1,visibility:'private' })
    const fetcher = vi.fn()
    await expect(runShortlinkEnrichment(deps, actor, { collectionUrl:'https://short.example/rest/v3/short-urls',apiKey:'test',fetch:fetcher as typeof fetch }, job, 1000)).rejects.toMatchObject({ code:'conflict' })
    expect(fetcher).not.toHaveBeenCalled()
  })
})
