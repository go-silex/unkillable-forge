#!/usr/bin/env node
/**
 * Post-deploy targeted checks through the real publisher MCP stdio server.
 * Never logs share keys or Access cookies. Exits nonzero on any mismatch.
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { createWriteStream } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { isAbsolute, join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

function die(message) {
  process.stderr.write(`forge-smoke: ${message}\n`)
  process.exit(1)
}

function usage() {
  die('usage: forge-smoke.mjs --mcp-config <mcp.json> --server <name> --root-id <id> --root-dir <dir> --read-origin <url> --read-cookie-file <file> [--links <json>]')
}

function parseArgs(argv) {
  const flags = new Map()
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i]
    const value = argv[i + 1]
    if (!key?.startsWith('--') || value === undefined || flags.has(key)) usage()
    flags.set(key, value)
  }
  const required = ['--mcp-config', '--server', '--root-id', '--root-dir', '--read-origin', '--read-cookie-file']
  for (const key of required) {
    if (!flags.has(key)) usage()
  }
  return {
    mcpConfig: flags.get('--mcp-config'),
    server: flags.get('--server'),
    rootId: flags.get('--root-id'),
    rootDir: flags.get('--root-dir'),
    readOrigin: flags.get('--read-origin'),
    cookieFile: flags.get('--read-cookie-file'),
    linksFile: flags.get('--links') || null,
  }
}

function redact(value) {
  if (value == null) return value
  if (typeof value === 'string') {
    if (/cookie|authorization|bearer|share[_-]?key|grantKey/i.test(value)) return '[redacted]'
    if (value.length > 24 && /^[A-Za-z0-9_-]+$/.test(value)) return `[redacted:${value.length}]`
    return value
  }
  if (Array.isArray(value)) return value.map(redact)
  if (typeof value === 'object') {
    const out = {}
    for (const [k, v] of Object.entries(value)) {
      if (/key|cookie|token|authorization|secret/i.test(k)) out[k] = '[redacted]'
      else out[k] = redact(v)
    }
    return out
  }
  return value
}

async function callTool(client, name, args) {
  const result = await client.callTool({ name, arguments: args })
  const text = result.content?.find(c => c.type === 'text')?.text
  if (!text) throw new Error(`tool_${name}_empty`)
  let parsed
  try { parsed = JSON.parse(text) } catch { throw new Error(`tool_${name}_invalid_json`) }
  if (result.isError || parsed?.ok === false) {
    const code = parsed?.error?.code || 'tool_error'
    throw new Error(code)
  }
  return parsed.result ?? parsed
}

function schemaRequires(tool, pathKeys) {
  const schema = tool?.inputSchema
  if (!schema || typeof schema !== 'object') return false
  const required = Array.isArray(schema.required) ? schema.required : []
  return pathKeys.every(k => required.includes(k) || (schema.properties && k in schema.properties))
}

function buildShareArgs(tools, pageId, artifactId, policyEpoch) {
  const tool = tools.find(t => t.name === 'forge_share')
  if (!tool) throw new Error('forge_share_missing')
  const args = { pageId, artifactId, expectedPolicyEpoch: policyEpoch }
  if (schemaRequires(tool, ['grant']) || tool.inputSchema?.properties?.grant) {
    args.grant = { mode: 'follow_active' }
  } else if (tool.inputSchema?.properties?.mode) {
    args.mode = 'follow_active'
  }
  return args
}

function sameOriginHttps(url, origin) {
  let parsed
  try { parsed = new URL(url) } catch { return false }
  if (parsed.protocol !== 'https:') return false
  return parsed.origin === origin
}

async function fetchStatus(url, { cookie = null, redirect = 'manual', allowCookie = false } = {}) {
  const headers = {}
  if (cookie) {
    if (!allowCookie) throw new Error('cookie_without_allow')
    headers.cookie = cookie
  }
  const res = await fetch(url, { method: 'GET', redirect, headers })
  const location = res.headers.get('location')
  return { status: res.status, location }
}

function expectLoginRedirect(result, readOrigin) {
  if (result.status !== 302 && result.status !== 301 && result.status !== 303 && result.status !== 307 && result.status !== 308) {
    return false
  }
  if (!result.location) return false
  let loc
  try { loc = new URL(result.location, readOrigin) } catch { return false }
  if (loc.origin !== readOrigin) return false
  return loc.pathname === '/login' || loc.pathname === '/login.html'
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  for (const path of [args.mcpConfig, args.rootDir, args.cookieFile]) {
    if (!isAbsolute(path)) die(`path must be absolute: ${path}`)
  }
  if (args.linksFile && !isAbsolute(args.linksFile)) die('links path must be absolute')

  let readOrigin
  try {
    const u = new URL(args.readOrigin)
    if (u.protocol !== 'https:') die('--read-origin must be https')
    readOrigin = u.origin
  } catch {
    die('invalid --read-origin')
  }

  const cookie = (await readFile(args.cookieFile, 'utf8')).trim()
  if (!cookie) die('empty cookie file')

  const mcp = JSON.parse(await readFile(args.mcpConfig, 'utf8'))
  const servers = mcp.mcpServers || mcp.servers
  if (!servers || typeof servers !== 'object') die('mcp config missing mcpServers')
  const server = servers[args.server]
  if (!server || typeof server.command !== 'string') die(`server ${args.server} missing`)
  const command = server.command
  const commandArgs = Array.isArray(server.args) ? server.args.map(String) : []
  const env = { ...process.env, ...(server.env && typeof server.env === 'object' ? server.env : {}) }

  const utc = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z')
  const rand = randomBytes(3).toString('hex')
  const slug = `smoke-${utc}-${rand}`.toLowerCase().replace(/[^a-z0-9-]/g, '-')
  const pageRel = `smoke-${rand}.html`
  await mkdir(args.rootDir, { recursive: true })
  await writeFile(join(args.rootDir, pageRel), `<!doctype html><title>smoke ${slug}</title><p>ok</p>\n`, 'utf8')

  const transport = new StdioClientTransport({ command, args: commandArgs, env, stderr: 'pipe' })
  if (transport.stderr) {
    transport.stderr.pipe(createWriteStream('/dev/null'))
  }
  const client = new Client({ name: 'forge-smoke', version: '1.0.0' })
  await client.connect(transport)

  const report = { ok: true, slug, steps: [] }
  const step = (name, ok, detail = {}) => {
    report.steps.push({ name, ok, ...redact(detail) })
    if (!ok) report.ok = false
  }

  try {
    const listed = await client.listTools()
    const tools = listed.tools || []

    const publishResult = await callTool(client, 'forge_publish', {
      source: { rootId: args.rootId, relativePath: pageRel },
      target: { kind: 'new', route: { kind: 'subtree', slug } },
      metadata: { title: `smoke ${slug}` },
    })
    const publication = publishResult.publication || publishResult
    const artifactId = publication.artifactId
    const pages = publication.pages || []
    const page = pages[0]
    if (!artifactId || !page?.pageId || !page?.url) throw new Error('publish_incomplete')
    const pageUrl = new URL(page.url, readOrigin).href
    if (!sameOriginHttps(pageUrl, readOrigin)) throw new Error('page_url_origin')
    step('forge_publish', true, { artifactId, pageId: page.pageId, path: page.url })

    const auth = await fetchStatus(pageUrl, { cookie, allowCookie: true })
    step('authenticated_read', auth.status === 200, { status: auth.status })

    const anon = await fetchStatus(pageUrl)
    step('anonymous_login_redirect', expectLoginRedirect(anon, readOrigin), { status: anon.status, location: anon.location || null })

    let policyEpoch = 0
    const policy = await callTool(client, 'forge_page_policy', { pageId: page.pageId })
    if (typeof policy.policyEpoch === 'number') policyEpoch = policy.policyEpoch
    if (typeof policy.artifactId === 'string' && policy.artifactId !== artifactId) throw new Error('policy_artifact_mismatch')
    step('forge_page_policy', true, { policyEpoch })

    const shareArgs = buildShareArgs(tools, page.pageId, artifactId, policyEpoch)
    const share = await callTool(client, 'forge_share', shareArgs)
    const grantId = share.grantId
    const shareKey = share.key
    if (!grantId || !shareKey) throw new Error('share_incomplete')
    step('forge_share', true, { grantId, policyEpoch: share.policyEpoch })

    const sharePath = `/s/${encodeURIComponent(slug)}/${encodeURIComponent(shareKey)}/`
    const shareUrl = new URL(sharePath, readOrigin).href
    const shareOk = await fetchStatus(shareUrl)
    step('share_key_access', shareOk.status === 200, { status: shareOk.status })

    const revoke = await callTool(client, 'forge_revoke_share', {
      pageId: page.pageId,
      artifactId,
      expectedPolicyEpoch: typeof share.policyEpoch === 'number' ? share.policyEpoch : policyEpoch + 1,
      grantId,
    })
    step('forge_revoke_share', true, { policyEpoch: revoke.policyEpoch })

    const revoked = await fetchStatus(shareUrl)
    step('share_key_404', revoked.status === 404, { status: revoked.status })

    const unpublish = await callTool(client, 'forge_unpublish', {
      command: {
        idempotencyKey: `smoke-${rand}`,
        artifactId,
        expectedContentVersion: publication.contentVersion,
      },
    })
    step('forge_unpublish', true, { result: redact(unpublish) })

    const after = await fetchStatus(pageUrl, { cookie, allowCookie: true })
    step('unpublished_authenticated_404', after.status === 404, { status: after.status })

    if (args.linksFile) {
      const links = JSON.parse(await readFile(args.linksFile, 'utf8'))
      if (!Array.isArray(links)) throw new Error('links_not_array')
      let index = 0
      for (const entry of links) {
        const id = typeof entry.id === 'string' ? entry.id : `link-${index}`
        index += 1
        const path = entry.path
        const expectStatus = entry.expectStatus
        if (typeof path !== 'string' || typeof expectStatus !== 'number') throw new Error('invalid_link_entry')
        let url
        try { url = new URL(path, readOrigin) } catch { throw new Error('invalid_link_url') }
        const external = url.origin !== readOrigin
        if (!external && url.protocol !== 'https:') throw new Error('link_must_be_https')
        const useCookie = !external && entry.authenticated === true
        if (useCookie && !sameOriginHttps(url.href, readOrigin)) throw new Error('cookie_origin')
        const result = await fetchStatus(url.href, {
          cookie: useCookie ? cookie : null,
          allowCookie: useCookie,
          redirect: 'manual',
        })
        let ok = result.status === expectStatus
        if (ok && entry.expectLocation) {
          const expected = new URL(entry.expectLocation, readOrigin)
          const actual = result.location ? new URL(result.location, readOrigin) : null
          ok = !!actual && actual.href === expected.href
        }
        step(`fixture:${id}`, ok, {
          status: result.status,
          expectStatus,
          location: result.location || null,
          external,
        })
      }
    }
  } catch (error) {
    report.ok = false
    report.error = String(error && error.message ? error.message : error)
  } finally {
    try { await client.close() } catch { /* ignore */ }
  }

  process.stdout.write(`${JSON.stringify(report)}\n`)
  process.exit(report.ok ? 0 : 1)
}

main().catch(error => {
  process.stderr.write(`forge-smoke: ${error instanceof Error ? error.message : 'failed'}\n`)
  process.exit(1)
})
