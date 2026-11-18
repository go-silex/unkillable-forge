import { expect, it } from 'vitest'
import { createShortlink } from '../../adapters/shlink/client'
import { renderOgScreenshot } from '../../adapters/render/browser-run'

const input = { shortCode: 'f-code', shortDomain: 'short.example', destination: 'https://forge.example/s/page/secret/' }
const config = { collectionUrl: 'https://short.example/rest/v3/short-urls', apiKey: 'secret-api-key' }

it.each(['create', 'reconcile'] as const)('does not follow a Shlink %s redirect in workerd', async stage => {
  const requests: Request[] = []
  const fetcher: typeof fetch = async (url, init) => {
    const outbound = new Request(url, init)
    requests.push(outbound)
    if (stage === 'reconcile' && requests.length === 1) return new Response(null, { status: 409 })
    return new Response(null, { status: 307, headers: { location: 'https://other.example/collect' } })
  }
  expect(await createShortlink({ ...config, fetch: fetcher }, input)).toEqual({ state: 'failed', code: 'shortlink_unavailable', retryable: true })
  expect(requests).toHaveLength(stage === 'create' ? 1 : 2)
  expect(requests.map(outbound => [outbound.url, outbound.method, outbound.redirect])).toEqual(
    stage === 'create'
      ? [[config.collectionUrl, 'POST', 'manual']]
      : [[config.collectionUrl, 'POST', 'manual'], [`${config.collectionUrl}/f-code?domain=short.example`, 'GET', 'manual']],
  )
  expect(requests.every(outbound => outbound.headers.get('X-Api-Key') === config.apiKey)).toBe(true)
})

it('rejects a native Browser Run redirect without forwarding the credential', async () => {
  const accountId = '0123456789abcdef0123456789abcdef'
  const requests: Request[] = []
  const fetcher: typeof fetch = async (url, init) => {
    const outbound = new Request(url, init)
    requests.push(outbound)
    return new Response(null, { status: 307, headers: { location: 'https://other.example/collect' } })
  }
  await expect(renderOgScreenshot({ accountId, apiToken: 'credential', fetch: fetcher }, { documentPath: '/index.html', document: new TextEncoder().encode('<html></html>'), resources: [] })).rejects.toMatchObject({ code: 'render_unavailable' })
  expect(requests).toHaveLength(1)
  expect(requests[0].url).toBe(`https://api.cloudflare.com/client/v4/accounts/${accountId}/browser-rendering/screenshot?cacheTTL=0`)
  expect(requests[0].method).toBe('POST')
  expect(requests[0].redirect).toBe('manual')
  expect(requests[0].headers.get('Authorization')).toBe('Bearer credential')
})
