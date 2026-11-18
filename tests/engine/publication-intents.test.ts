import { env } from 'cloudflare:workers'
import { beforeEach, describe, expect, it } from 'vitest'
import { enqueuePublicationIntents } from '../../domains/delivery/publication-intents'
import { actor, artifactId, bootstrap, configs, jwks, pageFixture, pageId, revisionId } from './fixtures/catalogue'
import { newId } from '../../domains/catalogue/ids'

const deps = async () => ({ db: env.DB, config: (await configs()).manage, jwks, now: () => 10 })
const committed = { artifactId, revisionId, contentVersion: 0, pages: [{ pageId, url: '/a/sample/' }] }

describe('publication OG intents', () => {
  beforeEach(async () => { await bootstrap(); await pageFixture() })
  it('enqueues an unprepared intent once on replay without reading the render graph', async () => {
    const d = await deps()
    await enqueuePublicationIntents(d, actor, committed)
    await enqueuePublicationIntents(d, actor, committed)
    const jobs = await env.DB.prepare("SELECT page_id,state,input_sha256,recipe_sha256 FROM enrichment_jobs WHERE kind='og'").all()
    expect(jobs.results).toEqual([{ page_id: pageId, state: 'pending', input_sha256: null, recipe_sha256: null }])
    expect(await env.DB.prepare('SELECT count(*) AS n FROM enrichment_graph_chunks').first()).toEqual({ n: 0 })
  })
  it('enqueues the entire 1000-page receipt in bounded batches', async () => {
    const extra = Array.from({ length: 999 }, (_, i) => ({ pageId: newId('pg'), path: `/a/intent-${i}/index.html` }))
    for (let start = 0; start < extra.length; start += 30) {
      const statements = extra.slice(start, start + 30).flatMap(page => [
        env.DB.prepare("INSERT INTO pages (page_id,artifact_id,created_at) VALUES (?,?,1)").bind(page.pageId, artifactId),
        env.DB.prepare("INSERT INTO revision_resources (revision_id,path,kind,object_key,sha256,size,content_type) VALUES (?,?,'document','document',?,1,'text/html')").bind(revisionId, page.path, 'a'.repeat(64)),
        env.DB.prepare("INSERT INTO revision_pages (revision_id,page_id,document_path,metadata_json) VALUES (?,?,?,'{}')").bind(revisionId, page.pageId, page.path),
      ])
      await env.DB.batch(statements)
    }
    await enqueuePublicationIntents(await deps(), actor, { ...committed, pages: [...committed.pages, ...extra.map(page => ({ pageId: page.pageId, url: page.path }))] })
    expect(await env.DB.prepare("SELECT count(*) AS n FROM enrichment_jobs WHERE kind='og' AND input_sha256 IS NULL AND recipe_sha256 IS NULL").first()).toEqual({ n: 1000 })
  })
  it('does not enqueue a stale content version', async () => {
    await expect(enqueuePublicationIntents(await deps(), actor, { ...committed, contentVersion: 1 })).rejects.toMatchObject({ code: 'conflict' })
    expect(await env.DB.prepare('SELECT count(*) AS n FROM enrichment_jobs').first()).toEqual({ n: 0 })
  })
})
