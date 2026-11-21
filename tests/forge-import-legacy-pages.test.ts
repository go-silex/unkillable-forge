import { describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { applyImport, batchApprovals, pinWorkspace, prepareSelection } from '../scripts/forge-import-legacy-pages.mjs'

const secretMarkers = ['supersecretsharekey', 'PRIVATE KEY', 'CF_ACCESS_CLIENT_SECRET']

async function sandbox() {
  const root = await mkdtemp(join(tmpdir(), 'forge-legacy-pages-'))
  return { root, cleanup: () => rm(root, { recursive: true, force: true }) }
}

function sha256(bytes: Buffer | string) {
  return createHash('sha256').update(bytes).digest('hex')
}

async function writeCapture(root: string, opts: {
  slug: string
  visibility: 'private' | 'public' | 'shared'
  shareKey?: string
  shortlinks?: Array<Record<string, unknown>>
  aliasHost?: boolean
  /** Write KV under Roxabi tree-layout names (`vis:<slug>/index.html`) instead of `vis:<slug>`. */
  treeKeys?: boolean
}) {
  const capture = join(root, 'capture-src')
  const rebuiltDir = join(root, 'instance', 'rebuilt', 'a', opts.slug)
  await mkdir(rebuiltDir, { recursive: true, mode: 0o700 })
  const indexBytes = Buffer.from('<html>legacy</html>')
  const assetBytes = Buffer.from('plain')
  await writeFile(join(rebuiltDir, 'index.html'), indexBytes, { mode: 0o600 })
  await writeFile(join(rebuiltDir, 'build-id.txt'), assetBytes, { mode: 0o600 })
  const indexPath = `/a/${opts.slug}/index.html`
  const assetPath = `/a/${opts.slug}/build-id.txt`
  // Digests are opaque 32-hex stand-ins; byte resolution uses reinject for this fixture.
  const pages = {
    result: {
      id: 'fixture-deployment',
      files: {
        [indexPath]: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        [assetPath]: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
        '/index.html': 'cccccccccccccccccccccccccccccccc',
      },
    },
  }
  const hub = { found: {}, missing: [indexPath, assetPath] }
  const reinject = {
    rebuilt: {
      [indexPath]: join('instance', 'rebuilt', 'a', opts.slug, 'index.html'),
      [assetPath]: join('instance', 'rebuilt', 'a', opts.slug, 'build-id.txt'),
    },
  }
  const kvName = opts.treeKeys ? `${opts.slug}/index.html` : opts.slug
  const kv: Array<{ name: string; metadata: null; expiration: null; value: string }> = [
    { name: `vis:${kvName}`, metadata: null, expiration: null, value: opts.visibility },
  ]
  if (opts.shareKey) kv.push({ name: `share:${kvName}`, metadata: null, expiration: null, value: opts.shareKey })
  const host = opts.aliasHost ? 'forge.gosilex.com' : 'forge.unkillablecompanies.com'
  const shortlinks = opts.shortlinks ?? (opts.visibility === 'shared' && opts.shareKey
    ? [{
        shortCode: 'f-demo',
        shortUrl: 'https://unkill.si/f-demo',
        longUrl: `https://${host}/s/${opts.slug}/${opts.shareKey}/`,
        domain: null,
        dateCreated: '2026-01-01T00:00:00Z',
      }]
    : [])
  await mkdir(capture, { recursive: true, mode: 0o700 })
  // Capture root for reinject resolution is parent of instance dir; put files under root/instance and capture dir sibling.
  const instance = join(root, 'instance')
  await writeFile(join(instance, 'pages-files.json'), JSON.stringify(pages), { mode: 0o600 })
  await writeFile(join(instance, 'hub-match.json'), JSON.stringify(hub), { mode: 0o600 })
  await writeFile(join(instance, 'reinject.json'), JSON.stringify(reinject), { mode: 0o600 })
  await writeFile(join(instance, 'kv.json'), JSON.stringify(kv), { mode: 0o600 })
  await writeFile(join(instance, 'shlink.json'), JSON.stringify(shortlinks), { mode: 0o600 })
  return { instance, indexPath, assetPath, indexBytes, assetBytes }
}

describe('forge-import-legacy-pages', () => {
  it('prepare-selection copies /a bytes, preserves share key, normalizes alias host', async () => {
    const { root, cleanup } = await sandbox()
    try {
      const shareKey = 'supersecretsharekey'
      const { instance, indexPath, assetPath, indexBytes, assetBytes } = await writeCapture(root, {
        slug: 'demo-slug',
        visibility: 'shared',
        shareKey,
        aliasHost: true,
      })
      const selectionOut = join(root, 'selection.json')
      const captureRootOut = join(root, 'capture-root')
      const result = await prepareSelection({
        captureDir: instance,
        selectionOut,
        captureRootOut,
        instance: 'unkillable',
      })
      expect(result.counts.slugs).toBe(1)
      expect(result.counts.entries).toBe(2)
      expect(result.counts.shortlinks).toBe(1)
      expect(result.refused.total).toBe(0)
      const selection = JSON.parse(await readFile(selectionOut, 'utf8'))
      expect(selection.version).toBe(1)
      expect(selection.kind).toBe('synthetic')
      expect(selection.sourceInstance).toBe('unkillable')
      expect(selection.reader).toMatchObject({
        canonicalHost: 'forge.unkillablecompanies.com',
        aliasHosts: ['forge-next.unkillablecompanies.com'],
        routeGrammars: ['subtree'],
        shareGrammars: ['slug'],
        shareCookie: false,
        shellPaths: ['/', '/index.html', '/login', '/login.html'],
      })
      expect(selection.pages[0].sourcePageId).toBe('demo-slug')
      expect(selection.pages[0].share.key).toBe(shareKey)
      expect(selection.shortlinks[0].destination).toBe(`https://forge.unkillablecompanies.com/s/demo-slug/${shareKey}/`)
      expect(selection.shortlinks[0].destination.includes('gosilex')).toBe(false)
      const indexDest = join(captureRootOut, indexPath.slice(1))
      const assetDest = join(captureRootOut, assetPath.slice(1))
      expect((await stat(indexDest)).size).toBe(indexBytes.length)
      expect(sha256(await readFile(indexDest))).toBe(sha256(indexBytes))
      expect(sha256(await readFile(assetDest))).toBe(sha256(assetBytes))
      expect(JSON.stringify(result).includes(shareKey)).toBe(false)
    } finally {
      await cleanup()
    }
  })

  it('keeps a subtree page private when only tree-layout share keys exist', async () => {
    const { root, cleanup } = await sandbox()
    try {
      const { instance } = await writeCapture(root, { slug: 'tree-slug', visibility: 'shared', shareKey: 'supersecretsharekey', treeKeys: true, shortlinks: [] })
      const selectionOut = join(root, 'selection.json')
      await prepareSelection({ captureDir: instance, selectionOut, captureRootOut: join(root, 'capture-root'), instance: 'roxabi' })
      const selection = JSON.parse(await readFile(selectionOut, 'utf8'))
      expect(selection.pages[0].visibility.value).toBe('private')
      expect(selection.pages[0].share.state).toBe('absent')
    } finally {
      await cleanup()
    }
  })

  it('batchApprovals keeps every Worker var under the limit without losing approvals', () => {
    const approvals = Array.from({ length: 30 }, (_, i) => ({ selectionId: `sel_${i}`, padding: 'x'.repeat(450) }))
    const batches = batchApprovals(approvals)
    expect(batches.length).toBeGreaterThan(1)
    for (const batch of batches) expect(JSON.stringify(batch).length).toBeLessThanOrEqual(5000)
    expect(batches.flat()).toEqual(approvals)
  })

  it('prepare-selection refuses unresolved bytes and unmappable shortlinks', async () => {
    const { root, cleanup } = await sandbox()
    try {
      const { instance } = await writeCapture(root, { slug: 'demo-slug', visibility: 'public' })
      const pages = JSON.parse(await readFile(join(instance, 'pages-files.json'), 'utf8'))
      pages.result.files['/a/demo-slug/missing.bin'] = 'dddddddddddddddddddddddddddddddd'
      await writeFile(join(instance, 'pages-files.json'), JSON.stringify(pages))
      const shlink = [{
        shortCode: 'orphan',
        shortUrl: 'https://unkill.si/orphan',
        longUrl: 'https://forge.unkillablecompanies.com/a/not-published/',
        domain: null,
        dateCreated: '2026-01-01T00:00:00Z',
      }]
      await writeFile(join(instance, 'shlink.json'), JSON.stringify(shlink))
      await expect(prepareSelection({
        captureDir: instance,
        selectionOut: join(root, 'selection.json'),
        captureRootOut: join(root, 'capture-root'),
        instance: 'unkillable',
      })).rejects.toMatchObject({ code: 'prepare_selection_refused' })
    } finally {
      await cleanup()
    }
  })

  it('pinWorkspace uploads sources+inventories and applyImport loops dry_run/apply cursors', async () => {
    const { root, cleanup } = await sandbox()
    try {
      const capture = join(root, 'capture')
      const path = '/a/sample/index.html'
      await mkdir(join(capture, 'a', 'sample'), { recursive: true, mode: 0o700 })
      const bytes = Buffer.from('<html>pin</html>')
      await writeFile(join(capture, 'a', 'sample', 'index.html'), bytes, { mode: 0o600 })
      const digest = sha256(bytes)
      const inventory = {
        version: 1,
        inventoryId: 'inv_test',
        selectionId: 'sel_test',
        sourceInstance: 'legacy-pages-unkillable',
        sourceArtifactId: 'slug:sample',
        approvalRef: 'apr',
        kind: 'synthetic',
        command: { artifactId: null },
        files: [{
          path,
          kind: 'document',
          contentType: 'text/html',
          size: bytes.length,
          sha256: digest,
          sourceRef: `capture/v1/${'a'.repeat(64)}/0`,
          sourceVersion: null,
          provenance: 'test',
        }],
        operations: [],
        evidence: {
          selectionDigest: 'b'.repeat(64),
          corpusDigest: 'c'.repeat(64),
          mappingRef: 'map',
          capturedAt: 1,
          complete: true,
          g1bRef: null,
        },
      }
      const unit = {
        status: 'representable',
        pinState: 'awaiting_source',
        unitId: 'slug:sample',
        inventoryKey: `inventory/v1/${'d'.repeat(64)}.json`,
        maxInventoryBytes: 1_000_000,
        inventory,
        selection: {
          version: 1,
          inventoryId: 'inv_test',
          selectionId: 'sel_test',
          planId: 'plan_test',
          command: { pages: [], files: [], edges: [] },
        },
      }
      const workspace = join(root, 'workspace')
      await mkdir(workspace, { mode: 0o700 })
      await writeFile(join(workspace, 'state.json'), JSON.stringify({
        version: 1,
        fatal: null,
        reader: { canonicalHost: 'forge.unkillablecompanies.com' },
        units: [unit],
        approvals: [],
        census: [],
      }), { mode: 0o600 })

      const putLog: string[] = []
      const pin = await pinWorkspace({
        workspace,
        roots: { capture },
        putObject: async (key, body) => {
          putLog.push(key)
          const version = `v-${sha256(Buffer.from(body)).slice(0, 16)}`
          return { key, version }
        },
      })
      expect(pin.pinned).toBe(1)
      expect(pin.approvals).toBe(1)
      expect(putLog.some(k => k.startsWith('capture/v1/'))).toBe(true)
      expect(putLog.some(k => k.startsWith('inventory/v1/'))).toBe(true)
      const approvals = JSON.parse(pin.FORGE_IMPORT_INVENTORIES)
      expect(approvals[0].inventoryId).toBe('inv_test')
      expect(approvals[0].objectVersion.startsWith('v-')).toBe(true)

      const calls: Array<{ op: string; cursor: string | null | undefined }> = []
      const fakeFetch: typeof fetch = async (_url, init) => {
        const body = JSON.parse(String(init?.body ?? '{}'))
        calls.push({ op: body.op, cursor: body.cursor })
        if (body.op === 'dry_run' && body.cursor == null) {
          return new Response(JSON.stringify({ ok: true, result: { state: 'checking', nextCursor: 'c1' } }), { status: 200 })
        }
        if (body.op === 'dry_run' && body.cursor === 'c1') {
          return new Response(JSON.stringify({ ok: true, result: { state: 'ready' } }), { status: 200 })
        }
        if (body.op === 'apply' && !Object.hasOwn(body, 'cursor')) {
          return new Response(JSON.stringify({ ok: true, result: { state: 'staging', nextCursor: 'a1' } }), { status: 200 })
        }
        if (body.op === 'apply' && body.cursor === 'a1') {
          return new Response(JSON.stringify({ ok: true, result: { state: 'committed' } }), { status: 200 })
        }
        return new Response(JSON.stringify({ ok: false }), { status: 500 })
      }
      const applied = await applyImport({
        manageHost: 'manage.example.test',
        selections: [{ ...unit.selection, version: 1 as const }],
        headers: { 'content-type': 'application/json', cookie: 'CF_Authorization=fixture-jwt' },
        fetch: fakeFetch,
      })
      expect(applied.results[0].ok).toBe(true)
      expect(calls.map(c => c.op)).toEqual(['dry_run', 'dry_run', 'apply', 'apply'])
      expect(calls[1].cursor).toBe('c1')
      expect(calls[3].cursor).toBe('a1')
      expect(secretMarkers.some(m => JSON.stringify(applied).includes(m))).toBe(false)
    } finally {
      await cleanup()
    }
  })
})
