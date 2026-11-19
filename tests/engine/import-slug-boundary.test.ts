import { describe, expect, it } from 'vitest'
import worker from '../../adapters/http/manageWorker'
import { importResult, syntheticImport } from './fixtures/import'
import { content } from './fixtures/publication'
import { env, request, setupHttp, signed } from './fixtures/manage-http'

setupHttp()

describe('native import subtree slug boundary', () => {
  it.each([200, 201])('plans a %i-character slug against the durable route bound', async length => {
    const seed = await syntheticImport()
    const slug = 'x'.repeat(length)
    const path = `/a/${slug}/index.html`
    const command = { ...seed.selection.command, files: seed.selection.command.files.map(file => ({ ...file, path })), pages: seed.selection.command.pages.map(page => ({ ...page, documentPath: path })) }
    const selection = { ...seed.selection, command }
    const inventory = { ...seed.inventory, command, files: seed.inventory.files.map(file => ({ ...file, path })), pageMappings: seed.inventory.pageMappings.map(mapping => ({ ...mapping, documentPath: path, route: `/a/${slug}/` })) }
    const encoded = JSON.stringify(inventory)
    const object = await env.FORGE_IMPORT_SOURCE.put(`synthetic/slug-${crypto.randomUUID()}.json`, encoded)
    if (!object) throw new Error('inventory upload failed')
    const approval = { ...seed.approval, objectKey: object.key, objectVersion: object.version, sha256: (await content(encoded)).sha256 }
    const bindings = { ...seed.bindings, FORGE_IMPORT_INVENTORIES: JSON.stringify([approval]) }
    const jwt = await signed()
    let cursor: string | null = null
    const before = await env.DB.prepare('SELECT count(*) AS n FROM publication_sessions').first()
    for (let i = 0; i < 256; i++) {
      const response = await worker.fetch(request('/api/maintenance/import', 'POST', jwt, JSON.stringify({ op: 'dry_run', selection, cursor }), { 'Content-Type': 'application/json' }), bindings)
      const result = await importResult(response)
      if (result.state === 'checking') { cursor = result.nextCursor; continue }
      expect(result.state).toBe(length === 200 ? 'ready' : 'blocked')
      if (length === 201) expect(result.issues).toContainEqual({ code: 'selection_graph_mismatch' })
      expect(await env.DB.prepare('SELECT count(*) AS n FROM publication_sessions').first()).toEqual(before)
      return
    }
    throw new Error('dry run did not complete')
  })
})
