import { env } from 'cloudflare:workers'
import { beforeEach, describe, expect, it } from 'vitest'
import { assertManagedAuthority, assertManagedInventoryPrincipal, decodeManagedRevisionAuthority, getManagedPage, listManagedCatalogue, managedAuthorityStatements, managedInventoryPrincipalStatements, managedRevisionAuthorityStatement } from '../../domains/catalogue/managed-state'
import { actor, artifactId, authenticatedActor, bootstrap, configs, jwks, pageFixture, pageId, revisionId } from './fixtures/catalogue'

const sibling = `pg_${'b'.repeat(26)}`
const scopedId = `pr_${'b'.repeat(26)}`
const roleId = `rg_${'b'.repeat(26)}`
const deps = async () => ({ db: env.DB, config: (await configs()).manage, jwks, now: () => 10 })

beforeEach(async () => {
  await bootstrap()
  await pageFixture()
  // This policy-only fixture has no native seal/session; model materialized imported history.
  await env.DB.prepare("UPDATE revisions SET origin = 'imported' WHERE revision_id = ?").bind(revisionId).run()
  await env.DB.batch([
    env.DB.prepare("INSERT INTO pages (page_id, artifact_id, visibility, policy_epoch, created_at, tombstoned_at) VALUES (?, ?, 'shared', 3, 1, 2)").bind(sibling, artifactId),
    env.DB.prepare("INSERT INTO principals (principal_id, issuer, subject, created_at) VALUES (?, 'https://team.cloudflareaccess.com', 'scoped', 1)").bind(scopedId),
    env.DB.prepare("INSERT INTO role_grants (role_grant_id, principal_id, role, scope_kind, scope_page_id, origin, granted_at, granted_by) VALUES (?, ?, 'publisher', 'page', ?, 'granted', 1, ?)").bind(roleId, scopedId, sibling, actor.principalId),
  ])
})

describe('managed catalogue state', () => {
  it('limits discovery and known lookups to authorized pages including tombstones', async () => {
    const publisher = await authenticatedActor('scoped'), d = await deps()
    const result = await listManagedCatalogue(d, publisher)
    expect(result.pages).toEqual([{ pageId: sibling, artifactId, visibility: 'shared', policyEpoch: 3, tombstoned: true, route: null }])
    expect(await getManagedPage(d, publisher, pageId)).toBeNull()
    expect(await getManagedPage(d, publisher, sibling)).toEqual(result.pages[0])
    const all = await listManagedCatalogue(d, actor)
    expect(all.pages.map(page => page.pageId)).toEqual([pageId, sibling])
    expect(all.pages[0].route).toEqual({ kind: 'subtree', slug: 'sample' })
  })
  it('binds discovery cursors to policy, principal and current authority', async () => {
    const d = await deps()
    const first = await listManagedCatalogue(d, actor, { limit: 1 })
    expect(first.nextCursor).not.toBeNull()
    expect((await listManagedCatalogue(d, actor, { limit: 1, cursor: first.nextCursor })).pages[0].pageId).toBe(sibling)
    await env.DB.prepare("UPDATE pages SET visibility = 'public', policy_epoch = policy_epoch + 1 WHERE page_id = ?").bind(sibling).run()
    await expect(listManagedCatalogue(d, actor, { cursor: first.nextCursor })).rejects.toMatchObject({ code: 'conflict' })
    await expect(listManagedCatalogue(d, actor, { cursor: 'bad!' })).rejects.toMatchObject({ code: 'invalid_state' })
  })
  it('checks current status and epoch, not the actor snapshot', async () => {
    const publisher = await authenticatedActor('scoped'), d = await deps()
    await env.DB.prepare('UPDATE principals SET authority_epoch = authority_epoch + 1 WHERE principal_id = ?').bind(scopedId).run()
    await expect(listManagedCatalogue(d, publisher)).rejects.toMatchObject({ code: 'conflict' })
    await env.DB.prepare("UPDATE principals SET status = 'disabled', disabled_at = 2 WHERE principal_id = ?").bind(scopedId).run()
    await expect(getManagedPage(d, publisher, sibling)).rejects.toMatchObject({ code: 'unauthenticated' })
  })
  it('authorizes the live and selected revision union within the projection batch', async () => {
    const publisher = await authenticatedActor('scoped'), d = await deps()
    const statements = managedAuthorityStatements(d, publisher, artifactId, revisionId)
    const results = await env.DB.batch([...statements, managedRevisionAuthorityStatement(d, publisher, artifactId)])
    expect(() => assertManagedAuthority(results, d, publisher)).toThrowError(expect.objectContaining({ code: 'forbidden' }))
    expect(decodeManagedRevisionAuthority(results[3])).toEqual([])
    const adminResults = await env.DB.batch([...managedAuthorityStatements(d, actor, artifactId, revisionId), managedRevisionAuthorityStatement(d, actor, artifactId)])
    expect(assertManagedAuthority(adminResults, d, actor).pages.map(page => page.pageId)).toEqual([pageId])
    expect(decodeManagedRevisionAuthority(adminResults[3]).map(revision => revision.revisionId)).toEqual([revisionId])
  })
  it('permits scoped inventory for an authorized retired revision but not a roleless principal', async () => {
    await env.DB.batch([
      env.DB.prepare('UPDATE role_grants SET scope_page_id = ? WHERE role_grant_id = ?').bind(pageId, roleId),
      env.DB.prepare('UPDATE pages SET tombstoned_at = 2 WHERE page_id = ?').bind(pageId),
      env.DB.prepare('UPDATE artifacts SET active_revision_id = NULL WHERE artifact_id = ?').bind(artifactId),
    ])
    const publisher = await authenticatedActor('scoped'), d = await deps()
    const results = await env.DB.batch(managedInventoryPrincipalStatements(d, publisher, artifactId))
    expect(() => assertManagedInventoryPrincipal(results, d, publisher)).not.toThrow()
    await env.DB.prepare('UPDATE role_grants SET revoked_at = 3, revoked_by = ? WHERE role_grant_id = ?').bind(actor.principalId, roleId).run()
    const revoked = await env.DB.batch(managedInventoryPrincipalStatements(d, publisher, artifactId))
    expect(() => assertManagedInventoryPrincipal(revoked, d, publisher)).toThrowError(expect.objectContaining({ code: 'forbidden' }))
  })
  it('does not grant empty artifacts through vacuous page authority', async () => {
    const d = await deps(), publisher = await authenticatedActor('scoped')
    const empty = `ar_${'c'.repeat(26)}`
    await env.DB.prepare("INSERT INTO artifacts (artifact_id, origin, created_at) VALUES (?, 'published', 1)").bind(empty).run()
    const results = await env.DB.batch(managedAuthorityStatements(d, publisher, empty, null))
    expect(() => assertManagedAuthority(results, d, publisher)).toThrowError(expect.objectContaining({ code: 'forbidden' }))
    const admin = await env.DB.batch(managedAuthorityStatements(d, actor, empty, null))
    expect(assertManagedAuthority(admin, d, actor).pages).toEqual([])
  })
})
