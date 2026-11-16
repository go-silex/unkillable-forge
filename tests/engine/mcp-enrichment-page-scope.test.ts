import { expect, it, vi } from 'vitest'
import { handleMcp } from '../../adapters/mcp/handler'
import { runtimeFor } from '../../adapters/http/manage-config'
import { claimPageStatements } from '../../domains/catalogue/commands'
import { shortlinkDestinationDigest } from '../../domains/catalogue/shortlinks'
import { claimEnrichment, enqueueEnrichment, failEnrichment } from '../../domains/delivery/enrichments'
import { readPageEnrichment } from '../../domains/delivery/enrichment-status'
import { actor, artifactId, authenticatedActor, configs, digest, instanceId, jwks, pageFixture, pageId, revisionId } from './fixtures/catalogue'
import { env, request, setupHttp, signed } from './fixtures/manage-http'
import { manageHttpBindings } from './fixtures/manage-http-bindings'

setupHttp()

it('returns a page-scoped retry observation without granting access to its sibling or the full inventory', async () => {
  await pageFixture({ visibility: 'public' })
  const sibling = `pg_${'b'.repeat(26)}`
  const publisher = `pr_${'b'.repeat(26)}`
  const deps = { db: env.DB, config: (await configs()).manage, jwks, now: () => 10 }
  await env.DB.batch([
    env.DB.prepare("UPDATE revisions SET origin='imported' WHERE revision_id=?").bind(revisionId),
    env.DB.prepare("INSERT INTO revision_resources (revision_id,path,kind,object_key,sha256,size,content_type) VALUES (?, '/a/sibling/index.html', 'document', 'sibling', ?, 1, 'text/html')").bind(revisionId, digest),
    env.DB.prepare("INSERT INTO mounts (path,artifact_id,revision_id,kind) VALUES ('/a/sibling/index.html', ?, ?, 'document')").bind(artifactId, revisionId),
    ...claimPageStatements(deps, actor, { pageId: sibling, artifactId, route: { kind: 'subtree', slug: 'sibling' }, at: 1 }),
    env.DB.prepare("INSERT INTO revision_pages (revision_id,page_id,document_path,metadata_json) VALUES (?, ?, '/a/sibling/index.html', '{}')").bind(revisionId, sibling),
    env.DB.prepare("INSERT INTO principals (principal_id,issuer,subject,created_at) VALUES (?, 'https://team.cloudflareaccess.com', 'publisher', 1)").bind(publisher),
    env.DB.prepare("INSERT INTO role_grants (role_grant_id,principal_id,role,scope_kind,scope_page_id,origin,granted_at,granted_by) VALUES (?, ?, 'publisher', 'page', ?, 'granted', 1, ?)").bind(`rg_${'b'.repeat(26)}`, publisher, pageId, actor.principalId),
  ])
  const destination = 'https://forge.example.test/a/sample/'
  const job = await enqueueEnrichment(deps, actor, { artifactId, revisionId, pageId, expectedContentVersion: 0, expectedPolicyEpoch: 1, kind: 'shortlink', inputSha256: 'a'.repeat(64), desiredGrantId: null, providerOrigin: 'https://short.example', shortDomain: 'short.example', mappingId: 'target-mapping', shortCode: 'target-code', destinationSha256: await shortlinkDestinationDigest(destination) })
  const attempt = await claimEnrichment(env.DB, instanceId, job, 20, 100)
  await failEnrichment(env.DB, instanceId, attempt, 21, 'shortlink_unavailable', true)
  const runtime = await runtimeFor({ ...manageHttpBindings, DB: env.DB, REVISION_BYTES: env.REVISION_BYTES })
  if (!runtime) throw new Error('test runtime unavailable')
  const fetcher = vi.fn().mockResolvedValue(Response.json({ shortCode: 'target-code', shortUrl: 'https://short.example/target-code', longUrl: destination }))
  const token = await signed('publisher')
  async function call(name: string, args: object) {
    const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } })
    const response = await handleMcp(request('/mcp', 'POST', token, body, { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' }), { ...runtime!, shlink: { collectionUrl: 'https://short.example/rest/v3/short-urls', apiKey: 'secret', fetch: fetcher as typeof fetch } })
    expect(response.status).toBe(200)
    const envelope = await response.json() as { result: { isError?: boolean; content: { text: string }[] } }
    return { isError: !!envelope.result.isError, value: JSON.parse(envelope.result.content[0].text) }
  }
  const retry = { artifactId, revisionId, pageId, expectedContentVersion: 0, expectedPolicyEpoch: 1, kinds: ['shortlink'] }
  expect(await call('forge_retry_enrichments', retry)).toEqual({ isError: false, value: { ok: true, result: { pageId, revisionId, og: { state: 'disabled', reason: 'not_requested' }, shortlink: { state: 'ready', source: 'created' } } } })
  expect(fetcher).toHaveBeenCalledTimes(1)
  expect(await call('forge_retry_enrichments', { ...retry, pageId: sibling, expectedPolicyEpoch: 0 })).toEqual({ isError: true, value: { ok: false, error: { code: 'forbidden' } } })
  await expect(readPageEnrichment(deps, await authenticatedActor('publisher'), { artifactId, revisionId, pageId: sibling })).rejects.toMatchObject({ code: 'forbidden' })
  expect(await call('forge_enrichments', { artifactId, revisionId })).toEqual({ isError: true, value: { ok: false, error: { code: 'forbidden' } } })
})
