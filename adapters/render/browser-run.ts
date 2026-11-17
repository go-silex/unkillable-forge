// The caller must supply only immutable, Catalogue-admitted bytes. Browser Run
// executes trusted author scripts; these controls are not an all-protocol sandbox.
// API: https://developers.cloudflare.com/api/resources/browser_rendering/subresources/screenshot/methods/create/
export const OG_RECIPE = 'browser-run-og-v1;strip=forge-share-bar+forge-og;inline=admitted-src-href-css-url-import-depth3;network=csp-data-inline-worker-none+reject-http-ws+reject-xhr-fetch-websocket-eventsource;viewport=1920x1080;clip=0,36,1920,1008,0.625;jpeg=80;settle=2500;navigation=30000;action=30000;deadline=90000;payload=47185920;response=10485760'

export class RenderError extends Error {
  constructor(readonly code: 'render_timeout' | 'render_rejected' | 'render_unavailable', message: string) {
    super(message)
    this.name = 'RenderError'
  }
}

export interface BrowserRunConfig {
  readonly accountId: string
  readonly apiToken: string
  readonly fetch?: typeof fetch
}
export interface RenderGraph {
  readonly documentPath: string
  readonly document: Uint8Array
  readonly resources: readonly { readonly path: string; readonly contentType: string; readonly bytes: Uint8Array }[]
}

const MAX_PAYLOAD = 45 * 1024 * 1024
const MAX_RESPONSE = 10 * 1024 * 1024
const decoder = new TextDecoder()
const encoder = new TextEncoder()
const csp = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline' data:; style-src 'unsafe-inline' data:; img-src data:; font-src data:; media-src data:; connect-src 'none'; worker-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'">`
const captureStyle = `<style id="forge-og-capture">html,body{margin:0!important;padding:0!important;overflow:hidden!important}.edit-toggle,.edit-hotzone,[data-forge-share-bar],[data-forge-toast]{display:none!important}.deck-viewport{background:transparent!important;inset:0!important}.deck-stage{transform:none!important;left:0!important;top:0!important;width:1920px!important;height:1080px!important}.slide.active{visibility:visible!important;opacity:1!important;pointer-events:auto!important}</style>`

function base64(bytes: Uint8Array): string {
  let text = ''
  for (let i = 0; i < bytes.length; i += 8192) text += String.fromCharCode(...bytes.subarray(i, i + 8192))
  return btoa(text)
}

function renderHtml(graph: RenderGraph): string {
  let spent = graph.document.byteLength
  const resources = new Map<string, (typeof graph.resources)[number]>()
  for (const resource of graph.resources) {
    if (resources.has(resource.path)) throw new Error('Duplicate render resource path')
    resources.set(resource.path, resource)
    spent += resource.bytes.byteLength
    if (spent > MAX_PAYLOAD) throw new Error('Render input exceeds payload limit')
  }
  const origin = 'https://forge-render.invalid'
  const cache = new Map<string, string>()
  const rewrite = (text: string, source: string, depth: number, stack: Set<string>): string => {
    if (depth >= 3) return text
    // Same deliberately limited reference shapes as the legacy inliner, plus CSS @import.
    return text.replace(/((?:src|href)\s*=\s*["'])([^"']+)(["'])|(url\(\s*["']?)([^"')]+)(["']?\s*\))|(@import\s+["'])([^"']+)(["'])/gi,
      (match, a: string, av: string, az: string, b: string, bv: string, bz: string, c: string, cv: string, cz: string) => {
        const value = (av ?? bv ?? cv).trim()
        if (/^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/i.test(value)) return match
        let url: URL
        try { url = new URL(value, origin + source) } catch { return match }
        if (url.origin !== origin) return match
        const item = resources.get(url.pathname)
        if (!item || /\.html?$/i.test(url.pathname) || stack.has(url.pathname)) return match
        let uri = cache.get(url.pathname)
        if (!uri) {
          let bytes = item.bytes
          if (item.contentType.split(';')[0].trim().toLowerCase() === 'text/css') {
            const next = new Set(stack); next.add(url.pathname)
            bytes = encoder.encode(rewrite(decoder.decode(bytes), url.pathname, depth + 1, next))
          }
          if (!/^[\w.+-]+\/[\w.+-]+$/.test(item.contentType.split(';')[0].trim())) throw new Error('Invalid render resource content type')
          uri = `data:${item.contentType.split(';')[0].trim()};base64,${base64(bytes)}`
          cache.set(url.pathname, uri)
        }
        spent += uri.length
        if (spent > MAX_PAYLOAD) throw new Error('Render payload exceeds limit')
        return `${a ?? b ?? c}${uri}${az ?? bz ?? cz}`
      })
  }
  if (spent > MAX_PAYLOAD) throw new Error('Render input exceeds payload limit')
  let html = decoder.decode(graph.document)
    .replace(/\n?<!-- forge-share-bar -->[\s\S]*?<!-- \/forge-share-bar -->\n?/gi, '')
    .replace(/\s*<script>\s*window\.__FORGE_SHARE__\s*=[\s\S]*?<\/script>(?:\s*<script>[\s\S]*?__FORGE_SHARE_BAR__[\s\S]*?<\/script>)+/gi, '')
    .replace(/\s*<div[^>]*data-forge-(?:share-bar|toast)[^>]*>[\s\S]*?<\/div>/gi, '')
    .replace(/\n?<!-- forge-og:start -->[\s\S]*?<!-- forge-og:end -->\n?/gi, '')
  html = rewrite(html, graph.documentPath, 0, new Set([graph.documentPath]))
  // The policy must precede any author-controlled element, including scripts/base.
  const doctype = html.match(/^\s*<!doctype\s+html\s*>/i)
  const at = doctype ? doctype[0].length : 0
  return html.slice(0, at) + csp + captureStyle + html.slice(at)
}

async function boundedResponse(response: Response): Promise<Uint8Array> {
  const declared = response.headers.get('content-length')
  if (declared && (!/^\d+$/.test(declared) || Number(declared) > MAX_RESPONSE)) throw new Error('Browser Run response exceeds limit')
  if (!response.body) throw new Error('Browser Run returned an empty response')
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      size += value.length
      if (size > MAX_RESPONSE) { await reader.cancel(); throw new Error('Browser Run response exceeds limit') }
      chunks.push(value)
    }
  } finally { reader.releaseLock() }
  const result = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.length }
  return result
}

// Read only length-delimited JPEG headers, never scan compressed image data.
// This verifies the declared dimensions, not that the compressed image decodes.
function hasOgJpegDimensions(jpeg: Uint8Array): boolean {
  if (jpeg.length < 4 || jpeg[0] !== 0xff || jpeg[1] !== 0xd8 || jpeg[jpeg.length - 2] !== 0xff || jpeg[jpeg.length - 1] !== 0xd9) return false
  let offset = 2
  while (offset < jpeg.length - 2) {
    if (jpeg[offset++] !== 0xff) return false
    while (offset < jpeg.length && jpeg[offset] === 0xff) offset++
    if (offset >= jpeg.length) return false
    const marker = jpeg[offset++]
    if (marker === 0xda || marker === 0xd9 || marker === 0x00 || marker === 0xd8) return false
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue
    if (offset + 2 > jpeg.length) return false
    const length = (jpeg[offset] << 8) | jpeg[offset + 1]
    if (length < 2 || offset + length > jpeg.length - 2) return false
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      if (length < 8) return false
      const components = jpeg[offset + 7]
      if (components === 0 || length !== 8 + 3 * components) return false
      const height = (jpeg[offset + 3] << 8) | jpeg[offset + 4]
      const width = (jpeg[offset + 5] << 8) | jpeg[offset + 6]
      return width === 1200 && height === 630
    }
    offset += length
  }
  return false
}

export async function renderOgScreenshot(config: BrowserRunConfig, graph: RenderGraph): Promise<Uint8Array> {
  if (!/^[a-f0-9]{32}$/i.test(config.accountId) || !config.apiToken || /[\r\n]/.test(config.apiToken)) throw new RenderError('render_rejected', 'Invalid Browser Run configuration')
  let body: string
  try {
    body = JSON.stringify({
      html: renderHtml(graph), viewport: { width: 1920, height: 1080 },
      gotoOptions: { waitUntil: 'networkidle0', timeout: 30000 }, actionTimeout: 30000, waitForTimeout: 2500,
      rejectRequestPattern: ['^https?://', '^wss?://'],
      rejectResourceTypes: ['xhr', 'fetch', 'websocket', 'eventsource'],
      screenshotOptions: { type: 'jpeg', quality: 80, clip: { x: 0, y: 36, width: 1920, height: 1008, scale: 0.625 } },
    })
    if (encoder.encode(body).byteLength > MAX_PAYLOAD) throw new Error('Render payload exceeds limit')
  } catch (error) {
    throw new RenderError('render_rejected', error instanceof Error ? error.message : 'Invalid render input')
  }
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 90000)
  try {
    const response = await (config.fetch ?? fetch)(`https://api.cloudflare.com/client/v4/accounts/${config.accountId}/browser-rendering/screenshot?cacheTTL=0`, {
      method: 'POST', headers: { Authorization: `Bearer ${config.apiToken}`, 'Content-Type': 'application/json' }, body, signal: controller.signal, redirect: 'manual',
    })
    if (response.status >= 300 && response.status < 400) throw new RenderError('render_unavailable', 'Browser Run redirected')
    if (!response.ok) throw new RenderError(response.status === 408 || response.status === 504 ? 'render_timeout' : response.status < 500 && response.status !== 429 ? 'render_rejected' : 'render_unavailable', `Browser Run HTTP ${response.status}`)
    const jpeg = await boundedResponse(response)
    if (!hasOgJpegDimensions(jpeg)) throw new RenderError('render_unavailable', 'Browser Run returned invalid JPEG or dimensions')
    return jpeg
  } catch (error) {
    if (controller.signal.aborted) throw new RenderError('render_timeout', 'Browser Run deadline exceeded')
    if (error instanceof RenderError) throw error
    throw new RenderError('render_unavailable', 'Browser Run unavailable or invalid response')
  } finally { clearTimeout(timer) }
}
