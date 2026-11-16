import { describe, expect, it, vi } from 'vitest'
import { OG_RECIPE, renderOgScreenshot } from '../../adapters/render/browser-run'

const encode = (s: string) => new TextEncoder().encode(s)
// Header fixture: APP segment followed by a baseline 1200x630 SOF and EOI.
const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00, 0xff, 0xc0, 0x00, 0x0b, 0x08, 0x02, 0x76, 0x04, 0xb0, 0x01, 0x01, 0x11, 0x00, 0xff, 0xd9])
const accountId = '0123456789abcdef0123456789abcdef'
const input = {
  documentPath: '/a/demo/index.html',
  document: encode('<!doctype html><head><!-- forge-og:start -->secret<!-- forge-og:end --><link href="style.css"></head><body><img src="image.png"><!-- forge-share-bar -->secret<!-- /forge-share-bar --></body>'),
  resources: [
    { path: '/a/demo/style.css', contentType: 'text/css', bytes: encode('body{background:url(image.png)}') },
    { path: '/a/demo/image.png', contentType: 'image/png', bytes: new Uint8Array([1, 2, 3]) },
  ],
}

describe('Browser Run screenshot', () => {
  it('sends only admitted bytes with early CSP, filtering and legacy crop', async () => {
    const transport = vi.fn(async () => new Response(jpeg))
    expect(await renderOgScreenshot({ accountId, apiToken: 'control-secret', fetch: transport as typeof fetch }, input)).toEqual(jpeg)
    const [url, init] = transport.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe(`https://api.cloudflare.com/client/v4/accounts/${accountId}/browser-rendering/screenshot?cacheTTL=0`)
    expect(init.redirect).toBe('error')
    expect(init.headers).toEqual({ Authorization: 'Bearer control-secret', 'Content-Type': 'application/json' })
    const payload = JSON.parse(init.body as string)
    expect(payload.html).not.toContain('secret')
    expect(payload.html.indexOf('Content-Security-Policy')).toBeLessThan(payload.html.indexOf('<head>'))
    expect(payload.html).toContain('data:image/png;base64,AQID')
    expect(payload.html).toContain('data:text/css;base64,')
    expect(payload.rejectRequestPattern).toEqual(['^https?://', '^wss?://'])
    expect(payload.rejectResourceTypes).toEqual(['xhr', 'fetch', 'websocket', 'eventsource'])
    expect(payload.screenshotOptions).toEqual({ type: 'jpeg', quality: 80, clip: { x: 0, y: 36, width: 1920, height: 1008, scale: 0.625 } })
    expect(payload.viewport).toEqual({ width: 1920, height: 1080 })
    expect(OG_RECIPE).toContain('clip=0,36,1920,1008,0.625')
  })

  it('places the policy before author scripts even with malformed or absent doctypes', async () => {
    for (const prefix of ['<!doctype html>', '', '<!doctype <script>ignored</script>']) {
      const transport = vi.fn(async () => new Response(jpeg))
      const document = `${prefix}<script>window.authorCode = true</script>`
      await renderOgScreenshot({ accountId, apiToken: 'control-secret', fetch: transport as typeof fetch }, {
        documentPath: input.documentPath, document: encode(document), resources: [],
      })
      const [, init] = transport.mock.calls[0] as unknown as [string, RequestInit]
      const payload = JSON.parse(init.body as string)
      expect(payload.html.indexOf('Content-Security-Policy')).toBeLessThan(payload.html.indexOf('<script>'))
      for (const directive of ['connect-src', 'worker-src', 'frame-src', 'object-src', 'base-uri', 'form-action']) {
        expect(payload.html).toContain(`${directive} 'none'`)
      }
      expect(init.body).not.toContain('control-secret')
      expect(payload.html).not.toContain(accountId)
      expect(payload.html).not.toContain('control-secret')
    }
  })

  it('does not follow redirects or accept non-JPEG responses', async () => {
    const transport = vi.fn(async () => new Response('{"success":false}'))
    await expect(renderOgScreenshot({ accountId, apiToken: 'token', fetch: transport as typeof fetch }, input)).rejects.toThrow('invalid JPEG')
  })

  it('rejects mismatched and malformed frame dimensions', async () => {
    const wrongWidth = jpeg.slice()
    wrongWidth[16] = 0xaf
    const badLength = jpeg.slice()
    badLength[11] = 0xff
    const noFrame = new Uint8Array([0xff, 0xd8, 0xff, 0xd9])
    for (const bytes of [wrongWidth, badLength, noFrame]) {
      const transport = vi.fn(async () => new Response(bytes))
      await expect(renderOgScreenshot({ accountId, apiToken: 'token', fetch: transport as typeof fetch }, input)).rejects.toMatchObject({ code: 'render_unavailable' })
    }
  })

  it('rejects bad configuration and duplicate paths before transport', async () => {
    const transport = vi.fn()
    await expect(renderOgScreenshot({ accountId: 'x/../../', apiToken: 'token', fetch: transport }, input)).rejects.toThrow('configuration')
    await expect(renderOgScreenshot({ accountId, apiToken: 'token', fetch: transport }, { ...input, resources: [...input.resources, input.resources[0]] })).rejects.toThrow('Duplicate')
    expect(transport).not.toHaveBeenCalled()
  })

  it('classifies provider failures and bounds returned bytes', async () => {
    for (const [status, code] of [[400, 'render_rejected'], [408, 'render_timeout'], [429, 'render_unavailable'], [503, 'render_unavailable']] as const) {
      const transport = vi.fn(async () => new Response(null, { status }))
      await expect(renderOgScreenshot({ accountId, apiToken: 'token', fetch: transport as typeof fetch }, input)).rejects.toMatchObject({ code })
    }
    const large = vi.fn(async () => new Response(jpeg, { headers: { 'content-length': '10485761' } }))
    await expect(renderOgScreenshot({ accountId, apiToken: 'token', fetch: large as typeof fetch }, input)).rejects.toMatchObject({ code: 'render_unavailable' })
  })
})
