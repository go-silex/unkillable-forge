import { env } from 'cloudflare:workers'
import { beforeEach, describe, expect, it } from 'vitest'
import { executeGuarded } from '../../domains/catalogue/guard'
import { actor, artifactId, bootstrap, configs, digest, jwks, pageFixture, pageId, revisionId } from './fixtures/catalogue'

beforeEach(async () => { await bootstrap(); await pageFixture() })

describe('F09 database guards', () => {
  it('requires current policy and content state for guarded enrichment admission', async () => {
    const deps = { db: env.DB, config: (await configs()).manage, jwks, now: () => 1 }
    const guard = { action: 'enrich_page' as const, pageId, artifactId, revisionId, expectedPolicyEpoch: 0, expectedContentVersion: 0, requestDigest: digest, occurredAt: 1 }
    await executeGuarded(deps, actor, [guard], [])
    await expect(executeGuarded(deps, actor, [{ ...guard, expectedPolicyEpoch: 1 }], [])).rejects.toMatchObject({ code: 'conflict' })
    await expect(executeGuarded(deps, actor, [{ ...guard, expectedContentVersion: 1 }], [])).rejects.toMatchObject({ code: 'conflict' })
  })

  it('rejects a reserved original resource at the database boundary', async () => {
    await expect(env.DB.prepare("INSERT INTO revision_resources (revision_id,path,kind,object_key,sha256,size,content_type) VALUES (?,'/_derived/x','asset','x',?,1,'image/png')").bind(revisionId, digest).run()).rejects.toThrow()
  })
})
