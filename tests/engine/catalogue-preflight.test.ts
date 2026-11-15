import { env } from 'cloudflare:workers'
import { beforeEach, describe, expect, it } from 'vitest'
import { activePinnedGrantSql, livePagesFrom, livePagesStatement } from '../../domains/catalogue/artifact-pages'
import { assignRole, claimPageStatements, revokeRole, revokeShare, share } from '../../domains/catalogue/commands'
import { assertPrepareAuthority } from '../../domains/catalogue/read'
import { actor, artifactId, authenticatedActor, bootstrap, configs, digest, jwks, pageFixture, pageId, revisionId, syntheticCommitHistory } from './fixtures/catalogue'

beforeEach(async () => { await bootstrap(); await pageFixture() })

describe('Catalogue publication preflight', () => {
  it('requires current scope before inspecting a target and detects revocation', async () => {
    const deps = { db: env.DB, config: (await configs()).manage, jwks, now: () => 10 }
    const principal = `pr_${'b'.repeat(26)}`
    await env.DB.prepare("INSERT INTO principals (principal_id,issuer,subject,created_at) VALUES (?,'https://team.cloudflareaccess.com','publisher',1)").bind(principal).run()
    const roleless = await authenticatedActor('publisher')
    await expect(assertPrepareAuthority(deps, roleless, { artifactId, pageIds: [pageId], requireGlobal: false })).rejects.toMatchObject({ code: 'forbidden' })
    const grant = await assignRole(deps, actor, { targetPrincipalId: principal, expectedTargetAuthorityEpoch: 0, role: 'publisher', scope: { kind: 'page', pageId } })
    const scoped = await authenticatedActor('publisher')
    await expect(assertPrepareAuthority(deps, scoped, { artifactId, pageIds: [pageId], requireGlobal: false })).resolves.toBeUndefined()
    await expect(assertPrepareAuthority({ ...deps, config: { ...deps.config, instanceId: 'other-instance' } }, actor, { artifactId, pageIds: [pageId], requireGlobal: false })).rejects.toMatchObject({ code: 'unauthenticated' })
    await expect(assertPrepareAuthority(deps, scoped, { artifactId, pageIds: [pageId], requireGlobal: true })).rejects.toMatchObject({ code: 'forbidden' })
    await expect(assertPrepareAuthority(deps, scoped, { artifactId, pageIds: [`pg_${'c'.repeat(26)}`], requireGlobal: false })).rejects.toMatchObject({ code: 'forbidden' })
    await expect(assertPrepareAuthority(deps, { ...scoped }, { artifactId, pageIds: [pageId], requireGlobal: false })).rejects.toMatchObject({ code: 'unauthenticated' })
    const foreignArtifact = `ar_${'b'.repeat(26)}`
    await pageFixture({ artifact: foreignArtifact, revision: `rv_${'b'.repeat(26)}`, page: `pg_${'b'.repeat(26)}`, route: { kind: 'tree_page', pageRef: 'foreign/page.html' } })
    for (const target of [foreignArtifact, `ar_${'z'.repeat(26)}`]) {
      await expect(assertPrepareAuthority(deps, scoped, { artifactId: target, pageIds: [pageId], requireGlobal: false })).rejects.toMatchObject({ code: 'forbidden' })
    }
    const secondPage = `pg_${'c'.repeat(26)}`
    await env.DB.batch([
      env.DB.prepare("INSERT INTO revision_resources (revision_id,path,kind,object_key,sha256,size,content_type) VALUES (?,'/docs/second.html','document','second',?,1,'text/html')").bind(revisionId, digest),
      env.DB.prepare("INSERT INTO mounts (path,artifact_id,revision_id,kind) VALUES ('/docs/second.html',?,?,'document')").bind(artifactId, revisionId),
      ...claimPageStatements(deps, actor, { pageId: secondPage, artifactId, route: { kind: 'tree_page', pageRef: 'docs/second.html' }, at: 10 }),
      env.DB.prepare("INSERT INTO revision_pages (revision_id,page_id,document_path,metadata_json) VALUES (?,?,'/docs/second.html','{}')").bind(revisionId, secondPage),
    ])
    await expect(assertPrepareAuthority(deps, scoped, { artifactId, pageIds: [pageId], requireGlobal: false })).rejects.toMatchObject({ code: 'forbidden' })
    await revokeRole(deps, actor, { targetPrincipalId: principal, expectedTargetAuthorityEpoch: 1, roleGrantId: grant.roleGrantId })
    await expect(assertPrepareAuthority(deps, scoped, { artifactId, pageIds: [pageId], requireGlobal: false })).rejects.toMatchObject({ code: 'conflict' })
  })

  it('rejects a mismatched primary marker after authenticating the handle', async () => {
    const deps = { db: env.DB, config: (await configs()).manage, jwks, now: () => 10 }
    await expect(assertPrepareAuthority(deps, actor, { artifactId, pageIds: [pageId], requireGlobal: false })).resolves.toBeUndefined()
    // Test-only primary-marker fault injection, as in guard.test.ts and publication-abort.test.ts.
    await env.DB.prepare("UPDATE instance_meta SET instance_id = 'other-instance' WHERE singleton = 1").run()
    await expect(assertPrepareAuthority(deps, actor, { artifactId, pageIds: [pageId], requireGlobal: false })).rejects.toMatchObject({ code: 'instance_mismatch' })
  })

  it('selects live routes and follows real pinned grant revocation', async () => {
    const deps = { db: env.DB, config: (await configs()).manage, jwks, now: () => 10 }
    const selected = await env.DB.batch([livePagesStatement(env.DB, artifactId)])
    expect(livePagesFrom(selected[0])).toEqual([{ pageId, policyEpoch: 0, documentPath: '/a/sample/index.html', route: { kind: 'subtree', slug: 'sample' } }])
    const isPinned = async () => (await env.DB.prepare(`SELECT ${activePinnedGrantSql('?1')} AS pinned`).bind(revisionId).first<{ pinned: number }>())?.pinned
    expect(await isPinned()).toBe(0)
    await syntheticCommitHistory({ artifact: artifactId, revision: revisionId, at: 1 })
    const grant = await share(deps, actor, { pageId, artifactId, expectedPolicyEpoch: 0, mode: 'pinned', revisionId })
    expect(await isPinned()).toBe(1)
    await revokeShare(deps, actor, { pageId, artifactId, expectedPolicyEpoch: 1, grantId: grant.grantId })
    expect(await isPinned()).toBe(0)
    await env.DB.prepare("DELETE FROM routes WHERE page_id = ?").bind(pageId).run()
    const broken = await env.DB.batch([livePagesStatement(env.DB, artifactId)])
    expect(() => livePagesFrom(broken[0])).toThrowError(expect.objectContaining({ code: 'invariant_violation' }))
  })
})
