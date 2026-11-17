import { env } from 'cloudflare:workers'
import { beforeEach, expect, it } from 'vitest'
import { captureRenderGraph } from '../../domains/catalogue/render-graph'
import { claimEnrichment, enqueueEnrichment, finalizeOg, finalizeShortlink, putEnrichmentOg } from '../../domains/delivery/enrichments'
import { shortlinkDestinationDigest } from '../../domains/catalogue/shortlinks'
import { DerivedStore } from '../../domains/store/derived-store'
import { RevisionStore } from '../../domains/store/revision-store'
import { actor, artifactId, bootstrap, configs, instanceId, jwks, pageFixture, pageId, principalId, revisionId } from './fixtures/catalogue'

beforeEach(async () => { await bootstrap(); await pageFixture(); await env.DB.prepare("UPDATE revision_resources SET object_version='version-1' WHERE revision_id=?").bind(revisionId).run() })

async function setup(original = false) {
  if (original) await env.DB.prepare("INSERT INTO revision_resources (revision_id,path,kind,object_key,object_version,sha256,size,content_type) VALUES (?,'/a/sample/og.jpg','asset','original','original-version',?,1,'image/jpeg')").bind(revisionId, 'a'.repeat(64)).run()
  let now = 10
  const deps = { db: env.DB, config: (await configs()).manage, jwks, now: () => now }
  const graph = await captureRenderGraph(deps, actor, { artifactId, revisionId, pageId, expectedContentVersion: 0, expectedPolicyEpoch: 0, recipeSha256: 'a'.repeat(64) })
  const job = await enqueueEnrichment(deps, actor, { artifactId, revisionId, pageId, expectedContentVersion: 0, expectedPolicyEpoch: 0, kind: 'og', inputSha256: graph.inputSha256, desiredGrantId: null, graph })
  const attempt = await claimEnrichment(env.DB, instanceId, job, 20, 100)
  const image = new Uint8Array([255, 216, 3, 4, 255, 217])
  const hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', image)), b => b.toString(16).padStart(2, '0')).join('')
  const ref = { kind: 'og' as const, artifactId, revisionId, pageId, recipeSha256: graph.recipeSha256, inputSha256: graph.inputSha256, contentSha256: hash, extension: 'jpg' as const }
  const store = new DerivedStore(new RevisionStore(env.REVISION_BYTES, instanceId))
  const descriptor = await putEnrichmentOg(env.DB, instanceId, attempt, store, ref, { size: image.length, sha256: hash }, new ReadableStream({ start(c) { c.enqueue(image); c.close() } }), () => 21, 10)
  now = 22
  return { deps, job, attempt, store, descriptor, setNow: (value: number) => { now = value } }
}

it('rejects actor revocation during HEAD without selecting the preview', async () => {
  const { deps, job, attempt, store, descriptor } = await setup()
  const head = store.head.bind(store)
  store.head = async ref => { const result = await head(ref); await env.DB.prepare('UPDATE principals SET authority_epoch=authority_epoch+1 WHERE principal_id=?').bind(principalId).run(); return result }
  await expect(finalizeOg(deps, actor, attempt, store, descriptor)).rejects.toMatchObject({ code: 'conflict' })
  expect(await env.DB.prepare('SELECT count(*) AS n FROM preview_selections').first()).toEqual({ n: 0 })
  expect(await env.DB.prepare('SELECT state FROM enrichment_jobs WHERE job_id=?').bind(job).first()).toEqual({ state: 'running' })
})

it('samples lease time after HEAD', async () => {
  const { deps, job, attempt, store, descriptor, setNow } = await setup()
  const head = store.head.bind(store)
  store.head = async ref => { const result = await head(ref); setNow(120); return result }
  await expect(finalizeOg(deps, actor, attempt, store, descriptor)).rejects.toMatchObject({ code: 'conflict' })
  expect(await env.DB.prepare('SELECT count(*) AS n FROM preview_selections').first()).toEqual({ n: 0 })
  expect(await env.DB.prepare('SELECT state FROM enrichment_jobs WHERE job_id=?').bind(job).first()).toEqual({ state: 'running' })
})

it('records a conventional original as preserved when derived bytes are finalized', async () => {
  const { deps, job, attempt, store, descriptor } = await setup(true)
  await finalizeOg(deps, actor, attempt, store, descriptor)
  expect(await env.DB.prepare('SELECT state,result_source FROM enrichment_jobs WHERE job_id=?').bind(job).first()).toEqual({ state: 'ready', result_source: 'preserved' })
  expect(await env.DB.prepare("SELECT object_key,object_version FROM revision_resources WHERE revision_id=? AND path='/a/sample/og.jpg'").bind(revisionId).first()).toEqual({ object_key: 'original', object_version: 'original-version' })
})

it('freshly authorizes shortlink finalization even for an existing mapping', async () => {
  const deps = { db: env.DB, config: (await configs()).manage, jwks, now: () => 20 }
  const identity = { mappingId: 'mapping-guard', providerOrigin: 'https://short.example', shortDomain: 'short.example', shortCode: 'code', destinationSha256: await shortlinkDestinationDigest('https://forge.example.test/a/sample/') }
  const job = await enqueueEnrichment(deps, actor, { artifactId, revisionId, pageId, expectedContentVersion: 0, expectedPolicyEpoch: 0, kind: 'shortlink', inputSha256: 'b'.repeat(64), desiredGrantId: null, ...identity })
  const attempt = await claimEnrichment(env.DB, instanceId, job, 20, 100)
  await env.DB.prepare("INSERT INTO shortlink_mappings (mapping_id,provider_origin,short_domain,short_code,short_url,page_id,grant_id,destination,source,observed_at,destination_digest) VALUES (?,?,?,?,?,?,NULL,?,'created',1,?)").bind(identity.mappingId,identity.providerOrigin,identity.shortDomain,identity.shortCode,'https://short.example/code',pageId,'https://forge.example.test/a/sample/',identity.destinationSha256).run()
  await env.DB.prepare('UPDATE principals SET authority_epoch=authority_epoch+1 WHERE principal_id=?').bind(principalId).run()
  await expect(finalizeShortlink(deps, actor, attempt)).rejects.toMatchObject({ code: 'conflict' })
  expect(await env.DB.prepare('SELECT state FROM enrichment_jobs WHERE job_id=?').bind(job).first()).toEqual({ state: 'running' })
})
