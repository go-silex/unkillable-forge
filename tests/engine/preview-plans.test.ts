import { env } from 'cloudflare:workers'
import { beforeEach, describe, expect, it } from 'vitest'
import { importShare, rotateShare, share, setVisibility } from '../../domains/catalogue/commands'
import { resolvePagePreview, resolveSharedPreview } from '../../domains/catalogue/previews'
import { resolvePreviewCard } from '../../domains/catalogue/preview-cards'
import { actor, artifactId, bootstrap, configs, digest, jwks, pageFixture, pageId, revisionId, syntheticCommitHistory, teamIdentity } from './fixtures/catalogue'

const route = { kind: 'subtree' as const, slug: 'sample' }
const candidates = ['/a/sample/index.html']
const recipe = 'b'.repeat(64), inputHash = 'c'.repeat(64), content = 'd'.repeat(64)
const selection = { kind: 'derived' as const, recipeSha256: recipe, inputSha256: inputHash, contentSha256: content, extension: 'jpg' as const }
const credentials = (key: string | null = null) => ({ team: null, shareKey: key, shareCookie: null, pinnedProof: null, nowSeconds: 10 })
const request = (key: string | null = null) => ({ route, candidates, credentials: credentials(key) })
const target = { pageId, artifactId, expectedPolicyEpoch: 0 }
async function deps() { return { db: env.DB, config: (await configs()).manage, jwks, now: () => 10 } }
async function selectDerived(revision = revisionId) {
  await env.DB.batch([
    env.DB.prepare('INSERT INTO preview_objects (page_id,revision_id,artifact_id,recipe_sha256,input_sha256,content_sha256,extension,size,object_version) VALUES (?,?,?,?,?,?,?,1,?)').bind(pageId, revision, artifactId, recipe, inputHash, content, 'jpg', 'version'),
    env.DB.prepare('INSERT INTO preview_selections (page_id,revision_id,recipe_sha256,input_sha256,content_sha256,extension) VALUES (?,?,?,?,?,?)').bind(pageId, revision, recipe, inputHash, content, 'jpg'),
  ])
}
async function card(key: string | null = null, revision = revisionId) {
  return resolvePreviewCard(env.DB, (await configs()).read, { ...request(key), pageId, revisionId: revision, selection })
}
beforeEach(async () => { await bootstrap(); await pageFixture() })

describe('fresh preview and card authority', () => {
  it('admits a shared unfurl without an image, then exact derived selection, and revokes both on rotation', async () => {
    const grant = await importShare(await deps(), actor, { ...target, key: 'historical_123', mode: 'follow_active' })
    const config = (await configs()).read
    expect((await resolveSharedPreview(env.DB, config, { route, candidates, key: 'historical_123', nowSeconds: 10 }))?.image).toBeNull()
    await selectDerived()
    expect((await card('historical_123'))?.descriptor.kind).toBe('derived')
    expect(await resolvePreviewCard(env.DB, config, { ...request('historical_123'), pageId, revisionId, selection: { ...selection, inputSha256: digest } })).toBeNull()
    await rotateShare(await deps(), actor, { ...target, expectedPolicyEpoch: 1, grantId: grant.grantId })
    expect(await card('historical_123')).toBeNull()
    expect(await resolvePagePreview(env.DB, config, request('historical_123'))).toBeNull()
  })

  it('does not rescue a wrong share key with team or public authority', async () => {
    await setVisibility(await deps(), actor, { ...target, visibility: 'public' })
    await selectDerived()
    const config = (await configs()).read
    expect((await card())?.authority.basis).toBe('public')
    expect(await resolvePagePreview(env.DB, config, { ...request('wrong_key123'), credentials: { ...credentials('wrong_key123'), team: teamIdentity } })).toBeNull()
    expect((await resolvePagePreview(env.DB, config, { ...request(), credentials: { ...credentials(), team: teamIdentity } }))?.authority.basis).toBe('team')
  })

  it('never substitutes another page or revision selection', async () => {
    await importShare(await deps(), actor, { ...target, key: 'historical_123', mode: 'follow_active' })
    await selectDerived()
    const config = (await configs()).read
    expect(await resolvePreviewCard(env.DB, config, { ...request('historical_123'), pageId: `pg_${'b'.repeat(26)}`, revisionId, selection })).toBeNull()
    expect(await card('historical_123', `rv_${'b'.repeat(26)}`)).toBeNull()
  })

  it('admits only the selected original image', async () => {
    await setVisibility(await deps(), actor, { ...target, visibility: 'public' })
    await env.DB.batch([
      env.DB.prepare("INSERT INTO revision_resources (revision_id,path,kind,object_key,sha256,size,content_type,object_version) VALUES (?,?,'asset','image',?,1,'image/png','v1')").bind(revisionId, '/a/sample/og.png', digest),
      env.DB.prepare('INSERT INTO preview_selections (page_id,revision_id,original_path) VALUES (?,?,?)').bind(pageId, revisionId, '/a/sample/og.png'),
    ])
    const config = (await configs()).read
    const base = { ...request(), pageId, revisionId }
    expect((await resolvePreviewCard(env.DB, config, { ...base, selection: { kind: 'original', path: '/a/sample/og.png' } }))?.descriptor.kind).toBe('original')
    expect(await resolvePreviewCard(env.DB, config, { ...base, selection: { kind: 'original', path: '/a/sample/other.png' } })).toBeNull()
    expect(await resolvePreviewCard(env.DB, config, { ...base, selection })).toBeNull()
  })

  it('follow-active stops admitting the previous card after activation', async () => {
    await importShare(await deps(), actor, { ...target, key: 'historical_123', mode: 'follow_active' })
    await selectDerived()
    const next = `rv_${'b'.repeat(26)}`
    await env.DB.batch([
      env.DB.prepare("INSERT INTO revisions (revision_id,artifact_id,origin,manifest_sha256,manifest_object_key,sealed_at) VALUES (?,?,'published',?,'next',2)").bind(next, artifactId, digest),
      env.DB.prepare("INSERT INTO revision_resources (revision_id,path,kind,object_key,sha256,size,content_type) VALUES (?,?,'document','next',?,1,'text/html')").bind(next, candidates[0], digest),
      env.DB.prepare("INSERT INTO revision_pages (revision_id,page_id,document_path,metadata_json) VALUES (?,?,?,'{}')").bind(next, pageId, candidates[0]),
      env.DB.prepare('UPDATE artifacts SET active_revision_id = ? WHERE artifact_id = ?').bind(next, artifactId),
      env.DB.prepare('UPDATE mounts SET revision_id = ? WHERE artifact_id = ?').bind(next, artifactId),
    ])
    expect(await card('historical_123')).toBeNull()
    const preview = await resolvePagePreview(env.DB, (await configs()).read, request('historical_123'))
    expect(preview?.revisionId).toBe(next)
    expect(preview?.image).toBeNull()
  })

  it('selects a pinned retained revision rather than the active revision', async () => {
    await selectDerived()
    await syntheticCommitHistory({ revision: revisionId, artifact: artifactId, at: 2 })
    const grant = await share(await deps(), actor, { ...target, mode: 'pinned', revisionId })
    const next = `rv_${'b'.repeat(26)}`
    await env.DB.batch([
      env.DB.prepare("INSERT INTO revisions (revision_id,artifact_id,origin,manifest_sha256,manifest_object_key,sealed_at) VALUES (?,?,'published',?,'next',2)").bind(next, artifactId, digest),
      env.DB.prepare("INSERT INTO revision_resources (revision_id,path,kind,object_key,sha256,size,content_type) VALUES (?,?,'document','next',?,1,'text/html')").bind(next, candidates[0], digest),
      env.DB.prepare("INSERT INTO revision_pages (revision_id,page_id,document_path,metadata_json) VALUES (?,?,?,'{}')").bind(next, pageId, candidates[0]),
      env.DB.prepare('UPDATE artifacts SET active_revision_id = ? WHERE artifact_id = ?').bind(next, artifactId),
      env.DB.prepare('UPDATE mounts SET revision_id = ? WHERE artifact_id = ?').bind(next, artifactId),
    ])
    expect(grant.key).not.toBeNull()
    expect((await card(grant.key!))?.revisionId).toBe(revisionId)
    expect(await card(grant.key!, next)).toBeNull()
  })
})
