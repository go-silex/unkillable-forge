import { env } from 'cloudflare:workers'
import { describe, expect, it } from 'vitest'
import { command, receipt, setupHttp, signed, status, upload, uploaded } from './fixtures/manage-http'
import { documentCommand } from './fixtures/publication'

describe('HTTP commit intent', () => {
  setupHttp()
  it('keeps the receipt unchanged and persists an unprepared OG intent on commit and replay', async () => {
    const jwt = await signed(), path = '/a/intent-http/index.html'
    const doc = await documentCommand('intent-http', path, 'intent')
    const session = await status(await command(jwt, { op: 'begin', command: doc.command }))
    await uploaded(await upload(jwt, session.sessionId, path, doc.bytes), session.sessionId, path)
    await status(await command(jwt, { op: 'seal', sessionId: session.sessionId }))
    const first = await receipt(await command(jwt, { op: 'commit', sessionId: session.sessionId }))
    const replay = await receipt(await command(jwt, { op: 'commit', sessionId: session.sessionId }))
    expect(replay).toEqual(first)
    const jobs = await env.DB.prepare("SELECT page_id,state,input_sha256,recipe_sha256 FROM enrichment_jobs WHERE revision_id=? AND kind='og'").bind(first.revisionId).all()
    expect(jobs.results).toEqual([{ page_id: doc.pageId, state: 'pending', input_sha256: null, recipe_sha256: null }])
  })
})
