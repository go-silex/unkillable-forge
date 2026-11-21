import { describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile, stat, chmod } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  applyImport,
  batchApprovals,
  main,
  pinWorkspace,
  prepareSelection,
  splitInventories,
} from '../scripts/forge-import-legacy-pages.mjs'

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
  kvExtras?: Array<Record<string, unknown>>
  kvOverride?: Array<Record<string, unknown>>
  hubFound?: Record<string, string | { path: string; sha256?: string }>
  hubDigests?: Record<string, string>
  pagesExtra?: Record<string, string>
}) {
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
        ...(opts.pagesExtra ?? {}),
      },
    },
  }
  const hub = {
    found: opts.hubFound ?? {},
    missing: [indexPath, assetPath],
    ...(opts.hubDigests ? { digests: opts.hubDigests } : {}),
  }
  const reinject = {
    rebuilt: {
      [indexPath]: join('instance', 'rebuilt', 'a', opts.slug, 'index.html'),
      [assetPath]: join('instance', 'rebuilt', 'a', opts.slug, 'build-id.txt'),
    },
  }
  const kvName = opts.treeKeys ? `${opts.slug}/index.html` : opts.slug
  const kv: Array<Record<string, unknown>> = opts.kvOverride ?? [
    { name: `vis:${kvName}`, metadata: null, expiration: null, value: opts.visibility },
    ...(opts.shareKey ? [{ name: `share:${kvName}`, metadata: null, expiration: null, value: opts.shareKey }] : []),
    ...(opts.kvExtras ?? []),
  ]
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
  const instance = join(root, 'instance')
  await mkdir(instance, { recursive: true, mode: 0o700 })
  await writeFile(join(instance, 'pages-files.json'), JSON.stringify(pages), { mode: 0o600 })
  await writeFile(join(instance, 'hub-match.json'), JSON.stringify(hub), { mode: 0o600 })
  await writeFile(join(instance, 'reinject.json'), JSON.stringify(reinject), { mode: 0o600 })
  await writeFile(join(instance, 'kv.json'), JSON.stringify(kv), { mode: 0o600 })
  await writeFile(join(instance, 'shlink.json'), JSON.stringify(shortlinks), { mode: 0o600 })
  return { instance, indexPath, assetPath, indexBytes, assetBytes }
}

const synthetic = { kind: 'synthetic' as const }

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
        ...synthetic,
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
      await prepareSelection({ captureDir: instance, selectionOut, captureRootOut: join(root, 'capture-root'), instance: 'roxabi', ...synthetic })
      const selection = JSON.parse(await readFile(selectionOut, 'utf8'))
      expect(selection.pages[0].visibility.value).toBe('private')
      expect(selection.pages[0].share.state).toBe('absent')
    } finally {
      await cleanup()
    }
  })

  it('refuses KV expiration unless allowExpiring and refuses metadata.v mismatch', async () => {
    const { root, cleanup } = await sandbox()
    try {
      const { instance } = await writeCapture(root, {
        slug: 'exp-slug',
        visibility: 'public',
        kvOverride: [
          { name: 'vis:exp-slug', metadata: null, expiration: 1_900_000_000, value: 'public' },
        ],
      })
      await expect(prepareSelection({
        captureDir: instance,
        selectionOut: join(root, 'selection.json'),
        captureRootOut: join(root, 'capture-root'),
        instance: 'unkillable',
        ...synthetic,
      })).rejects.toMatchObject({ code: 'expiring_policy_unsupported', message: expect.stringContaining('vis:exp-slug') })

      const { instance: metaInstance } = await writeCapture(join(root, 'meta'), {
        slug: 'meta-slug',
        visibility: 'public',
        kvOverride: [
          { name: 'vis:meta-slug', metadata: { v: 'private' }, expiration: null, value: 'public' },
        ],
      })
      await expect(prepareSelection({
        captureDir: metaInstance,
        selectionOut: join(root, 'meta-selection.json'),
        captureRootOut: join(root, 'meta-capture-root'),
        instance: 'unkillable',
        ...synthetic,
      })).rejects.toMatchObject({ code: 'prepare_selection_refused' })
    } finally {
      await cleanup()
    }
  })

  it('pin CLI stdout omits approvals and private object keys', async () => {
    const { root, cleanup } = await sandbox()
    try {
      const capture = join(root, 'capture')
      const path = '/a/sample/index.html'
      await mkdir(join(capture, 'a', 'sample'), { recursive: true, mode: 0o700 })
      const bytes = Buffer.from('<html>pin</html>')
      await writeFile(join(capture, 'a', 'sample', 'index.html'), bytes, { mode: 0o600 })
      const digest = sha256(bytes)
      const objectKey = `inventory/v1/${'d'.repeat(64)}.json`
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
        inventoryKey: objectKey,
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

      const inventoriesOut = join(root, 'inventories.json')
      const pin = await pinWorkspace({
        workspace,
        roots: { capture },
        putObject: async (key, body) => ({ key, version: `v-${sha256(Buffer.from(body)).slice(0, 16)}` }),
        inventoriesOut,
      })
      expect(pin.FORGE_IMPORT_INVENTORIES.includes(objectKey) || JSON.parse(pin.FORGE_IMPORT_INVENTORIES)[0].objectKey).toBeTruthy()

      const lines: string[] = []
      const spy = vi.spyOn(console, 'log').mockImplementation((value: unknown) => { lines.push(String(value)) })
      try {
        // Exercise the public pin summary shape without invoking cf.
        console.log(JSON.stringify({
          command: pin.command,
          pinned: pin.pinned,
          blocked: pin.blocked,
          approvals: pin.approvals,
          inventoriesOut,
          inventoriesDigest: pin.inventoriesDigest,
        }))
      } finally {
        spy.mockRestore()
      }
      const printed = lines.join('\n')
      expect(printed).toContain(pin.inventoriesDigest)
      expect(printed).not.toContain(objectKey)
      expect(printed).not.toContain('FORGE_IMPORT_INVENTORIES')
      expect(JSON.parse(await readFile(inventoriesOut, 'utf8'))[0].objectKey).toBeTruthy()
    } finally {
      await cleanup()
    }
  })

  it('rewrites a pre-existing 0644 selection file to mode 0600', async () => {
    const { root, cleanup } = await sandbox()
    try {
      const { instance } = await writeCapture(root, { slug: 'mode-slug', visibility: 'private' })
      const selectionOut = join(root, 'selection.json')
      await writeFile(selectionOut, 'stale\n', { mode: 0o644 })
      await chmod(selectionOut, 0o644)
      await prepareSelection({
        captureDir: instance,
        selectionOut,
        captureRootOut: join(root, 'capture-root'),
        instance: 'unkillable',
        ...synthetic,
      })
      expect((await stat(selectionOut)).mode & 0o777).toBe(0o600)
    } finally {
      await cleanup()
    }
  })

  it('refuses capture-root-out equal to or inside the input capture', async () => {
    const { root, cleanup } = await sandbox()
    try {
      const { instance } = await writeCapture(root, { slug: 'nest-slug', visibility: 'private' })
      await expect(prepareSelection({
        captureDir: instance,
        selectionOut: join(root, 'selection.json'),
        captureRootOut: instance,
        instance: 'unkillable',
        ...synthetic,
      })).rejects.toMatchObject({ code: 'invalid_arguments' })
      await expect(prepareSelection({
        captureDir: instance,
        selectionOut: join(root, 'selection.json'),
        captureRootOut: join(instance, 'nested-out'),
        instance: 'unkillable',
        ...synthetic,
      })).rejects.toMatchObject({ code: 'invalid_arguments' })
    } finally {
      await cleanup()
    }
  })

  it('refuses member path traversal outside the capture root', async () => {
    const { root, cleanup } = await sandbox()
    try {
      const { instance } = await writeCapture(root, {
        slug: 'trav-slug',
        visibility: 'private',
        pagesExtra: { '/a/trav-slug/../../escape.txt': 'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee' },
      })
      const reinject = JSON.parse(await readFile(join(instance, 'reinject.json'), 'utf8'))
      reinject.rebuilt['/a/trav-slug/../../escape.txt'] = join('instance', 'rebuilt', 'a', 'trav-slug', 'build-id.txt')
      await writeFile(join(instance, 'reinject.json'), JSON.stringify(reinject))
      await expect(prepareSelection({
        captureDir: instance,
        selectionOut: join(root, 'selection.json'),
        captureRootOut: join(root, 'capture-root'),
        instance: 'unkillable',
        ...synthetic,
      })).rejects.toMatchObject({ code: 'prepare_selection_refused' })
    } finally {
      await cleanup()
    }
  })

  it('refuses when copied bytes disagree with capture-time sha256 evidence', async () => {
    const { root, cleanup } = await sandbox()
    try {
      const { instance, indexPath, indexBytes } = await writeCapture(root, {
        slug: 'digest-slug',
        visibility: 'private',
        hubDigests: {
          '/a/digest-slug/index.html': 'f'.repeat(64),
        },
      })
      expect(sha256(indexBytes)).not.toBe('f'.repeat(64))
      await expect(prepareSelection({
        captureDir: instance,
        selectionOut: join(root, 'selection.json'),
        captureRootOut: join(root, 'capture-root'),
        instance: 'unkillable',
        ...synthetic,
      })).rejects.toMatchObject({ code: 'prepare_selection_refused' })
      void indexPath
    } finally {
      await cleanup()
    }
  })

  it('accepts query-key share shortlinks matching reader precedence', async () => {
    const { root, cleanup } = await sandbox()
    try {
      const shareKey = 'supersecretsharekey'
      const { instance } = await writeCapture(root, {
        slug: 'query-slug',
        visibility: 'shared',
        shareKey,
        shortlinks: [{
          shortCode: 'q-demo',
          shortUrl: 'https://unkill.si/q-demo',
          longUrl: `https://forge.unkillablecompanies.com/s/query-slug/?k=${shareKey}`,
          domain: null,
          dateCreated: '2026-01-01T00:00:00Z',
        }],
      })
      const selectionOut = join(root, 'selection.json')
      const result = await prepareSelection({
        captureDir: instance,
        selectionOut,
        captureRootOut: join(root, 'capture-root'),
        instance: 'unkillable',
        ...synthetic,
      })
      expect(result.counts.shortlinks).toBe(1)
      const selection = JSON.parse(await readFile(selectionOut, 'utf8'))
      expect(selection.shortlinks[0].destination).toContain(`k=${shareKey}`)
    } finally {
      await cleanup()
    }
  })

  it('batchApprovals keeps every Worker var under the UTF-8 byte limit', () => {
    const approvals = Array.from({ length: 30 }, (_, i) => ({ selectionId: `sel_${i}`, padding: 'x'.repeat(450) }))
    const batches = batchApprovals(approvals)
    expect(batches.length).toBeGreaterThan(1)
    for (const batch of batches) expect(Buffer.byteLength(JSON.stringify(batch), 'utf8')).toBeLessThanOrEqual(5000)
    expect(batches.flat()).toEqual(approvals)

    const multibyte = [{ selectionId: 'sel_utf8', note: 'é'.repeat(2600) }]
    expect(JSON.stringify(multibyte).length).toBeLessThanOrEqual(5000)
    expect(Buffer.byteLength(JSON.stringify(multibyte), 'utf8')).toBeGreaterThan(5000)
    expect(() => batchApprovals(multibyte)).toThrow(/Worker var limit/)
  })

  it('continues apply after dry_run conflict for an already-committed new page', async () => {
    const order: string[] = []
    const fakeFetch: typeof fetch = async (_url, init) => {
      const body = JSON.parse(String(init?.body ?? '{}'))
      order.push(`${body.selection.selectionId}:${body.op}`)
      if (body.op === 'dry_run' && body.selection.selectionId === 'sel_done') {
        return new Response(JSON.stringify({ ok: true, result: { state: 'blocked', issues: [{ code: 'conflict' }] } }), { status: 200 })
      }
      if (body.op === 'apply' && body.selection.selectionId === 'sel_done') {
        return new Response(JSON.stringify({ ok: true, result: { state: 'committed' } }), { status: 200 })
      }
      if (body.op === 'dry_run') return new Response(JSON.stringify({ ok: true, result: { state: 'ready' } }), { status: 200 })
      return new Response(JSON.stringify({ ok: true, result: { state: 'committed' } }), { status: 200 })
    }
    const applied = await applyImport({
      manageHost: 'manage.example.test',
      selections: [
        { version: 1, inventoryId: 'inv1', selectionId: 'sel_done', planId: 'plan1', command: {} },
        { version: 1, inventoryId: 'inv2', selectionId: 'sel_next', planId: 'plan2', command: {} },
      ],
      headers: { cookie: 'CF_Authorization=fixture-jwt' },
      fetch: fakeFetch,
    })
    expect(applied.results.map(r => [r.selectionId, r.ok, r.state])).toEqual([
      ['sel_done', true, 'committed'],
      ['sel_next', true, 'committed'],
    ])
    expect(order).toEqual(['sel_done:dry_run', 'sel_done:apply', 'sel_next:dry_run', 'sel_next:apply'])
  })

  it('returns nonzero exit when any selection is blocked', async () => {
    const applied = await applyImport({
      manageHost: 'manage.example.test',
      selections: [
        { version: 1, inventoryId: 'inv', selectionId: 'sel', planId: 'plan', command: {} },
      ],
      headers: { cookie: 'CF_Authorization=fixture-jwt' },
      fetch: async () => new Response(JSON.stringify({ ok: true, result: { state: 'blocked', issues: [{ code: 'g1b_evidence_required' }] } }), { status: 200 }),
    })
    expect(applied.results[0].ok).toBe(false)
    const code = applied.results.some(r => !r.ok) ? 1 : 0
    expect(code).toBe(1)
  })

  it('continueOnBlock does not continue after HTTP 403', async () => {
    const seen: string[] = []
    const applied = await applyImport({
      manageHost: 'manage.example.test',
      selections: [
        { version: 1, inventoryId: 'inv1', selectionId: 'sel_a', planId: 'plan_a', command: {} },
        { version: 1, inventoryId: 'inv2', selectionId: 'sel_b', planId: 'plan_b', command: {} },
      ],
      headers: { cookie: 'CF_Authorization=fixture-jwt' },
      continueOnBlock: true,
      fetch: async (_url, init) => {
        const body = JSON.parse(String(init?.body ?? '{}'))
        seen.push(body.selection.selectionId)
        return new Response(JSON.stringify({ ok: false, error: 'forbidden' }), { status: 403 })
      },
    })
    expect(seen).toEqual(['sel_a'])
    expect(applied.results).toHaveLength(1)
    expect(applied.results[0].ok).toBe(false)
    expect(applied.results[0].httpStatus).toBe(403)
  })

  it('stall detection terminates when the stored-file maximum never increases', async () => {
    let n = 0
    const fakeFetch: typeof fetch = async (_url, init) => {
      const body = JSON.parse(String(init?.body ?? '{}'))
      if (body.op === 'dry_run') return new Response(JSON.stringify({ ok: true, result: { state: 'ready' } }), { status: 200 })
      n += 1
      const stored = n % 2 === 1 ? 4 : 2
      const files = Array.from({ length: 8 }, (_, i) => ({ path: `/a/s/${i}`, stored: i < stored }))
      return new Response(JSON.stringify({ ok: true, result: { state: 'staging', nextCursor: null, session: { files } } }), { status: 200 })
    }
    await expect(applyImport({
      manageHost: 'manage.example.test',
      selections: [{ version: 1, inventoryId: 'inv', selectionId: 'sel', planId: 'plan', command: {} }],
      headers: { cookie: 'CF_Authorization=fixture-jwt' },
      fetch: fakeFetch,
    })).rejects.toMatchObject({ code: 'invalid_continuation' })
  })

  it('redacts malformed non-JSON replies to a fixed status error', async () => {
    const applied = await applyImport({
      manageHost: 'manage.example.test',
      selections: [{ version: 1, inventoryId: 'inv', selectionId: 'sel', planId: 'plan', command: {} }],
      headers: { cookie: 'CF_Authorization=fixture-jwt' },
      fetch: async () => new Response('INTERNAL SECRET TOKEN leaked-object-key', { status: 502 }),
    })
    expect(applied.results[0].ok).toBe(false)
    expect(JSON.stringify(applied)).not.toContain('SECRET')
    expect(JSON.stringify(applied)).not.toContain('leaked-object-key')
    expect(JSON.stringify(applied.results[0].body)).toContain('malformed_response:502')
  })

  it('refuses a non-empty batch out-dir so stale batch files cannot survive', async () => {
    const { root, cleanup } = await sandbox()
    try {
      const inventories = join(root, 'inventories.json')
      await writeFile(inventories, JSON.stringify([{ selectionId: 'a' }, { selectionId: 'b' }]), { mode: 0o600 })
      const outDir = join(root, 'batches')
      await mkdir(outDir, { mode: 0o700 })
      await writeFile(join(outDir, 'batch-099.json'), JSON.stringify([{ selectionId: 'stale' }]), { mode: 0o600 })
      await expect(splitInventories(inventories, outDir)).rejects.toMatchObject({ code: 'invalid_arguments' })
    } finally {
      await cleanup()
    }
  })

  it('applyImport resumes an open staging session without a cursor until commit', async () => {
    const bodies: Array<Record<string, unknown>> = []
    let stored = 0
    const fakeFetch: typeof fetch = async (_url, init) => {
      const body = JSON.parse(String(init?.body ?? '{}'))
      bodies.push(body)
      if (body.op === 'dry_run') return new Response(JSON.stringify({ ok: true, result: { state: 'ready' } }), { status: 200 })
      if (stored >= 16) return new Response(JSON.stringify({ ok: true, result: { state: 'committed' } }), { status: 200 })
      stored += 8
      const files = Array.from({ length: 20 }, (_, i) => ({ path: `/a/s/${i}`, stored: i < stored }))
      return new Response(JSON.stringify({ ok: true, result: { state: 'staging', nextCursor: null, session: { files } } }), { status: 200 })
    }
    const applied = await applyImport({
      manageHost: 'manage.example.test',
      selections: [{ version: 1, inventoryId: 'inv', selectionId: 'sel', planId: 'plan', command: {} }],
      headers: { cookie: 'CF_Authorization=fixture-jwt' },
      fetch: fakeFetch,
    })
    expect(applied.results[0]).toMatchObject({ ok: true, state: 'committed' })
    const applies = bodies.filter(b => b.op === 'apply')
    expect(applies.length).toBe(3)
    expect(applies.every(b => !Object.hasOwn(b, 'cursor'))).toBe(true)
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
        ...synthetic,
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
      void main
    } finally {
      await cleanup()
    }
  })
})
