import { describe, expect, it } from 'vitest'
import { validateReaderProfile, parseManageConfig } from '../../domains/catalogue/instance-config'
import { orderedOriginalImageCandidatePaths } from '../../domains/catalogue/previews'
import { aliasLocation, aliasMatchesPath } from '../../domains/catalogue/alias-validation'
import { decideRead } from '../../domains/catalogue/read'
import { setAlias } from '../../domains/catalogue/commands'
import { actor, configs, jwks, teamIdentity } from './fixtures/catalogue'
import { manageHttpBindings } from './fixtures/manage-http-bindings'
import { env, setupHttp } from './fixtures/manage-http'

setupHttp()

describe('shared import catalogue rules', () => {
  it('rejects the same invalid reader profiles in the runtime parser', async () => {
    const valid = JSON.parse(manageHttpBindings.FORGE_INSTANCE)
    for (const change of [{ shellPaths: [] }, { shellPaths: ['/login', '/api/private'] }, { routeGrammars: ['subtree'], shareGrammars: ['page'] }, { aliasHosts: [valid.canonicalHost] }]) {
      const data = { ...valid, ...change }
      expect(validateReaderProfile(data).ok).toBe(false)
      expect((await parseManageConfig({ ...manageHttpBindings, DB: env.DB, FORGE_INSTANCE: JSON.stringify(data) })).ok).toBe(false)
    }
    expect(validateReaderProfile(valid).ok).toBe(true)
    expect((await parseManageConfig({ ...manageHttpBindings, DB: env.DB })).ok).toBe(true)
  })

  it('keeps native original candidate priority and alias suffix semantics', () => {
    expect(orderedOriginalImageCandidatePaths({ kind: 'tree_page', pageRef: 'docs/index.html' })).toEqual(['/docs/og.jpg', '/docs/og.jpeg', '/docs/og.png', '/docs/index.og.jpg', '/docs/index.og.jpeg', '/docs/index.og.png'])
    expect(orderedOriginalImageCandidatePaths({ kind: 'subtree', slug: 'sample' })).toEqual(['/a/sample/og.jpg', '/a/sample/og.jpeg', '/a/sample/og.png'])
    expect(aliasMatchesPath('redirect_exact', '/old/', '/old/nested')).toBe(false)
    expect(aliasMatchesPath('redirect_prefix', '/old/', '/old/nested')).toBe(true)
    expect(aliasLocation('redirect_prefix', '/old/', '/', '/old/nested')).toBe('/nested')
  })

  it('uses the shared suffix rule in the native indexed alias resolver', async () => {
    const { read, manage } = await configs()
    const deps = { db: env.DB, config: manage, jwks, now: () => 10 }
    await setAlias(deps, actor, { op: 'put', kind: 'redirect_prefix', key: '/old/', to: '/', status: 308, targetPageId: null })
    await setAlias(deps, actor, { op: 'put', kind: 'redirect_exact', key: '/old/exact', to: '/special', status: 301, targetPageId: null })
    const credentials = { team: teamIdentity, shareKey: null, shareCookie: null, pinnedProof: null, nowSeconds: 1 }
    expect(await decideRead(env.DB, read, { kind: 'resource', path: '/old/exact' }, credentials, '/old/exact')).toEqual({ kind: 'alias', status: 301, location: '/special' })
    expect(await decideRead(env.DB, read, { kind: 'resource', path: '/old/nested' }, credentials, '/old/nested')).toEqual({ kind: 'alias', status: 308, location: '/nested' })
  })
})
