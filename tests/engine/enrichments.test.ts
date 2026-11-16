import { env } from 'cloudflare:workers'
import { beforeEach, describe, expect, it } from 'vitest'
import { claimEnrichment, enqueueEnrichment, failEnrichment, finalizeOg, finalizeShortlink, ogIntentStatement, prepareEnrichmentOg, putEnrichmentOg, renewEnrichment, retryEnrichment, retryEnrichmentKinds, supersedeEnrichment } from '../../domains/delivery/enrichments'
import { shortlinkDestinationDigest } from '../../domains/catalogue/shortlinks'
import { captureRenderGraph } from '../../domains/catalogue/render-graph'
import { readEnrichments } from '../../domains/delivery/enrichment-status'
import { DerivedStore, type DerivedObjectRef } from '../../domains/store/derived-store'
import { RevisionStore } from '../../domains/store/revision-store'
import { actor, artifactId, bootstrap, configs, instanceId, jwks, pageFixture, pageId, revisionId } from './fixtures/catalogue'

beforeEach(async () => { await bootstrap(); await pageFixture(); await env.DB.prepare("UPDATE revision_resources SET object_version='version-1' WHERE revision_id=?").bind(revisionId).run() })
async function dependencies(now = 10) { return { db: env.DB, config: (await configs()).manage, jwks, now: () => now } }
async function enqueue() {
  const deps = await dependencies()
  const graph = await captureRenderGraph(deps, actor, { artifactId, revisionId, pageId, expectedContentVersion: 0, expectedPolicyEpoch: 0, recipeSha256: 'a'.repeat(64) })
  return enqueueEnrichment(deps, actor, { artifactId, revisionId, pageId, expectedContentVersion: 0, expectedPolicyEpoch: 0, kind: 'og', inputSha256: graph.inputSha256, desiredGrantId: null, graph })
}

const image = new Uint8Array([255, 216, 3, 4, 255, 217])
const imageBody = (bytes = image) => new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(bytes); controller.close() } })
async function imageRef(jobId: string): Promise<DerivedObjectRef> {
  const hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', image)), b => b.toString(16).padStart(2, '0')).join('')
  const job = await env.DB.prepare('SELECT recipe_sha256,input_sha256 FROM enrichment_jobs WHERE job_id=?').bind(jobId).first<{ recipe_sha256: string; input_sha256: string }>()
  return { kind: 'og', artifactId, revisionId, pageId, recipeSha256: job!.recipe_sha256, inputSha256: job!.input_sha256, contentSha256: hash, extension: 'jpg' }
}

describe('OG enrichment PUT', () => {
  it('freezes a durable intent only after a fresh graph assertion', async () => {
    const deps = await dependencies()
    const intent = { jobId: 'intent-a', artifactId, revisionId, pageId, expectedContentVersion: 0, expectedPolicyEpoch: 0, desiredGrantId: null, now: 10 }
    await env.DB.batch([ogIntentStatement(env.DB, intent), ogIntentStatement(env.DB, { ...intent, jobId: 'duplicate' })])
    expect(await env.DB.prepare('SELECT count(*) AS n FROM enrichment_jobs').first()).toEqual({ n: 1 })
    await expect(claimEnrichment(env.DB, instanceId, intent.jobId, 11, 20)).rejects.toMatchObject({ code: 'conflict' })
    const graph = await captureRenderGraph(deps, actor, { artifactId, revisionId, pageId, expectedContentVersion: 0, expectedPolicyEpoch: 0, recipeSha256: 'a'.repeat(64) })
    await env.DB.prepare("UPDATE revision_resources SET object_version='version-2' WHERE revision_id=?").bind(revisionId).run()
    await expect(prepareEnrichmentOg(deps, actor, intent.jobId, graph)).rejects.toThrow()
    expect(await env.DB.prepare('SELECT input_sha256,recipe_sha256 FROM enrichment_jobs WHERE job_id=?').bind(intent.jobId).first()).toEqual({ input_sha256: null, recipe_sha256: null })
    await env.DB.prepare("UPDATE revision_resources SET object_version='version-1' WHERE revision_id=?").bind(revisionId).run()
    await prepareEnrichmentOg(deps, actor, intent.jobId, graph)
    await env.DB.batch([ogIntentStatement(env.DB, { ...intent, jobId: 'duplicate-after-freeze' })])
    expect(await env.DB.prepare('SELECT count(*) AS n FROM enrichment_jobs').first()).toEqual({ n: 1 })
    expect(await claimEnrichment(env.DB, instanceId, intent.jobId, 20, 20)).toMatchObject({ jobId: intent.jobId })
  })
  it('admits pending and expired attempts without resetting live leases', async () => {
    const job = await enqueue(), input = { artifactId, revisionId, pageId, expectedContentVersion: 0, expectedPolicyEpoch: 0, kinds: ['og'] as const }
    await retryEnrichmentKinds(await dependencies(11), actor, input)
    await claimEnrichment(env.DB, instanceId, job, 20, 10)
    await expect(retryEnrichmentKinds(await dependencies(21), actor, input)).rejects.toThrow()
    await retryEnrichmentKinds(await dependencies(30), actor, input)
    expect(await claimEnrichment(env.DB, instanceId, job, 30, 10)).toMatchObject({ attempt: 2 })
  })
  it('rejects graph changes between capture and guarded enqueue', async () => {
    const deps = await dependencies()
    const graph = await captureRenderGraph(deps, actor, { artifactId, revisionId, pageId, expectedContentVersion: 0, expectedPolicyEpoch: 0, recipeSha256: 'a'.repeat(64) })
    await env.DB.prepare("UPDATE revision_resources SET object_version='version-2' WHERE revision_id=?").bind(revisionId).run()
    await expect(enqueueEnrichment(deps, actor, { artifactId, revisionId, pageId, expectedContentVersion: 0, expectedPolicyEpoch: 0, kind: 'og', inputSha256: graph.inputSha256, desiredGrantId: null, graph })).rejects.toThrow()
    expect(await env.DB.prepare('SELECT count(*) AS n FROM enrichment_jobs').first()).toEqual({ n: 0 })
  })
  it('refuses selection when a graph resource changes without target version changes', async () => {
    const job = await enqueue(), attempt = await claimEnrichment(env.DB, instanceId, job, 20, 100)
    const store = new DerivedStore(new RevisionStore(env.REVISION_BYTES, instanceId)), ref = await imageRef(job)
    const descriptor = await putEnrichmentOg(env.DB, instanceId, attempt, store, ref, { size: image.length, sha256: ref.contentSha256 }, imageBody(), () => 21, 10)
    await env.DB.prepare("UPDATE revision_resources SET object_version='version-2' WHERE revision_id=?").bind(revisionId).run()
    await expect(finalizeOg(env.DB, instanceId, attempt, store, descriptor, 22)).rejects.toMatchObject({ code: 'conflict' })
    expect(await env.DB.prepare('SELECT count(*) AS n FROM preview_selections').first()).toEqual({ n: 0 })
  })
  it('stores verified bytes and selects only while the target and lease remain current', async () => {
    const job = await enqueue(), attempt = await claimEnrichment(env.DB, instanceId, job, 20, 100)
    const store = new DerivedStore(new RevisionStore(env.REVISION_BYTES, instanceId)), ref = await imageRef(job)
    const descriptor = await putEnrichmentOg(env.DB, instanceId, attempt, store, ref, { size: image.length, sha256: ref.contentSha256 }, imageBody(), () => 21, 10)
    await env.DB.prepare('UPDATE pages SET policy_epoch=policy_epoch+1 WHERE page_id=?').bind(pageId).run()
    await expect(finalizeOg(env.DB, instanceId, attempt, store, descriptor, 22)).rejects.toMatchObject({ code: 'conflict' })
    expect(await env.DB.prepare('SELECT state FROM enrichment_jobs WHERE job_id=?').bind(job).first()).toEqual({ state: 'running' })
  })
  it('rejects corrupt input without selecting it', async () => {
    const job = await enqueue(), attempt = await claimEnrichment(env.DB, instanceId, job, 20, 100)
    const store = new DerivedStore(new RevisionStore(env.REVISION_BYTES, instanceId)), ref = await imageRef(job)
    await expect(putEnrichmentOg(env.DB, instanceId, attempt, store, ref, { size: image.length, sha256: ref.contentSha256 }, imageBody(new Uint8Array(image.length)), () => 21, 10)).rejects.toMatchObject({ code: 'integrity_error' })
    expect(await env.DB.prepare('SELECT state FROM enrichment_jobs WHERE job_id=?').bind(job).first()).toEqual({ state: 'running' })
  })
  it('does not return a receipt arriving at the deadline', async () => {
    const job = await enqueue(), attempt = await claimEnrichment(env.DB, instanceId, job, 20, 100)
    const store = new DerivedStore(new RevisionStore(env.REVISION_BYTES, instanceId)), ref = await imageRef(job)
    const times = [21, 21, 31]
    await expect(putEnrichmentOg(env.DB, instanceId, attempt, store, ref, { size: image.length, sha256: ref.contentSha256 }, imageBody(), () => times.shift()!, 10)).rejects.toMatchObject({ code: 'conflict' })
    expect(await env.DB.prepare('SELECT state FROM enrichment_jobs WHERE job_id=?').bind(job).first()).toEqual({ state: 'running' })
  })
})
describe('durable enrichment attempts', () => {
  it('rejects duplicate claims and expired handles, then permits guarded retry', async () => {
    const job = await enqueue()
    const first = await claimEnrichment(env.DB, instanceId, job, 20, 10)
    await expect(claimEnrichment(env.DB, instanceId, job, 21, 10)).rejects.toMatchObject({ code: 'conflict' })
    const second = await claimEnrichment(env.DB, instanceId, job, 30, 10)
    await expect(renewEnrichment(env.DB, instanceId, first, 31, 10)).rejects.toMatchObject({ code: 'conflict' })
    await expect(failEnrichment(env.DB, instanceId, first, 31, 'render_timeout', true)).rejects.toMatchObject({ code: 'conflict' })
    await failEnrichment(env.DB, instanceId, second, 31, 'render_timeout', true)
    await retryEnrichment(await dependencies(32), actor, job)
    expect(await claimEnrichment(env.DB, instanceId, job, 33, 10)).toMatchObject({ jobId: job, attempt: 3 })
    const attempts = await env.DB.prepare('SELECT attempt,outcome FROM enrichment_attempts WHERE job_id=? ORDER BY attempt').bind(job).all()
    expect(attempts.results).toEqual([{ attempt: 1, outcome: 'expired' }, { attempt: 2, outcome: 'failed' }, { attempt: 3, outcome: null }])
  })
  it('rejects renewal and retry after the policy epoch changes', async () => {
    const job = await enqueue()
    const attempt = await claimEnrichment(env.DB, instanceId, job, 20, 20)
    await env.DB.prepare('UPDATE pages SET policy_epoch=policy_epoch+1 WHERE page_id=?').bind(pageId).run()
    await expect(renewEnrichment(env.DB, instanceId, attempt, 21, 10)).rejects.toMatchObject({ code: 'conflict' })
    await failEnrichment(env.DB, instanceId, attempt, 22, 'target_changed', true)
    await expect(retryEnrichment(await dependencies(23), actor, job)).rejects.toMatchObject({ code: 'conflict' })
  })
  it('supersedes an in-flight attempt after the current page changes', async () => {
    const job = await enqueue()
    const attempt = await claimEnrichment(env.DB, instanceId, job, 20, 20)
    await expect(supersedeEnrichment(env.DB, instanceId, job, 21)).rejects.toMatchObject({ code: 'conflict' })
    await env.DB.prepare('UPDATE pages SET policy_epoch=policy_epoch+1 WHERE page_id=?').bind(pageId).run()
    await supersedeEnrichment(env.DB, instanceId, job, 22)
    await expect(failEnrichment(env.DB, instanceId, attempt, 23, 'render_timeout', true)).rejects.toMatchObject({ code: 'conflict' })
    expect(await env.DB.prepare('SELECT state,lease_token FROM enrichment_jobs WHERE job_id=?').bind(job).first()).toEqual({ state: 'superseded', lease_token: null })
    expect(await env.DB.prepare('SELECT outcome FROM enrichment_attempts WHERE job_id=?').bind(job).first()).toEqual({ outcome: 'superseded' })
  })
  it('finalizes only the exact requested shortlink identity and destination digest', async () => {
    const identity = { mappingId: 'mapping-a', providerOrigin: 'https://short.example', shortDomain: 'short.example', shortCode: 'code-a', destinationSha256: await shortlinkDestinationDigest('https://forge.example.test/a/sample/') }
    const job = await enqueueEnrichment(await dependencies(), actor, { artifactId, revisionId, pageId, expectedContentVersion: 0, expectedPolicyEpoch: 0, kind: 'shortlink', inputSha256: 'b'.repeat(64), desiredGrantId: null, ...identity })
    const attempt = await claimEnrichment(env.DB, instanceId, job, 20, 20)
    await env.DB.prepare(`INSERT INTO shortlink_mappings (mapping_id,provider_origin,short_domain,short_code,short_url,page_id,grant_id,destination,source,observed_at,destination_digest) VALUES (?,?,?,?,?,?,NULL,?,'created',1,?)`).bind(identity.mappingId,identity.providerOrigin,identity.shortDomain,identity.shortCode,'https://short.example/code-a',pageId,'https://forge.example.test/a/other/',await shortlinkDestinationDigest('https://forge.example.test/a/other/')).run()
    await expect(finalizeShortlink(env.DB, instanceId, attempt, 21)).rejects.toMatchObject({ code: 'conflict' })
    await env.DB.prepare('UPDATE shortlink_mappings SET destination=?,destination_digest=? WHERE mapping_id=?').bind('https://forge.example.test/a/sample/',identity.destinationSha256,identity.mappingId).run()
    await finalizeShortlink(env.DB, instanceId, attempt, 22)
    expect(await env.DB.prepare('SELECT state,result_source FROM enrichment_jobs WHERE job_id=?').bind(job).first()).toEqual({ state: 'ready', result_source: 'created' })
  })
  it('freshly authorizes compact status without exposing mapping intent', async () => {
    await env.DB.prepare("UPDATE revisions SET origin='imported' WHERE revision_id=?").bind(revisionId).run()
    await enqueueEnrichment(await dependencies(), actor, { artifactId, revisionId, pageId, expectedContentVersion: 0, expectedPolicyEpoch: 0, kind: 'shortlink', inputSha256: 'b'.repeat(64), desiredGrantId: null, mappingId: 'mapping-secret', providerOrigin: 'https://api.short.example', shortDomain: 'short.example', shortCode: 'private-code', destinationSha256: 'c'.repeat(64) })
    const status = await readEnrichments(await dependencies(), actor, { artifactId, revisionId })
    expect(status.items).toEqual([{ pageId, revisionId, og: { state: 'disabled', reason: 'not_requested' }, shortlink: { state: 'pending', attempt: 0 } }])
    expect(JSON.stringify(status)).not.toContain('private-code')
    expect(JSON.stringify(status)).not.toContain('mapping-secret')
    await env.DB.prepare("UPDATE role_grants SET revoked_at=11,revoked_by=? WHERE principal_id=?").bind(actor.principalId,actor.principalId).run()
    await expect(readEnrichments(await dependencies(), actor, { artifactId, revisionId })).rejects.toMatchObject({ code: 'forbidden' })
  })
})
