import { Response, type V4FetchHandler } from "miniflare"

const certificates = "https://team.cloudflareaccess.com/cdn-cgi/access/certs"
const redirectTarget = "https://untrusted-jwks.invalid/certs"

type Mode = "success" | "redirect"

export function createNativeJwksFixture(): { control: V4FetchHandler; outbound: V4FetchHandler } {
  let jwk: Record<string, unknown> | null = null
  let mode: Mode = "success"
  let jwksCalls = 0
  let redirectTargetCalls = 0
  let deniedCalls = 0
  const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } })

  const control: V4FetchHandler = async request => {
    if (request.method === "GET" && request.url === "http://fixture/state") {
      return json({ jwksCalls, redirectTargetCalls, deniedCalls })
    }
    if (request.method !== "POST" || request.url !== "http://fixture/reset") return new Response(null, { status: 404 })
    let input: unknown
    try { input = await request.json() } catch { return new Response(null, { status: 400 }) }
    if (!input || typeof input !== "object" || Array.isArray(input)) return new Response(null, { status: 400 })
    if (!("jwk" in input) || !input.jwk || typeof input.jwk !== "object" || Array.isArray(input.jwk) || !("kid" in input.jwk) || typeof input.jwk.kid !== "string" || !("mode" in input) || (input.mode !== "success" && input.mode !== "redirect")) return new Response(null, { status: 400 })
    jwk = input.jwk
    mode = input.mode
    jwksCalls = 0
    redirectTargetCalls = 0
    deniedCalls = 0
    return new Response(null, { status: 200 })
  }

  const outbound: V4FetchHandler = request => {
    if (request.method === "GET" && request.url === certificates) {
      jwksCalls++
      if (mode === "redirect") return new Response(null, { status: 302, headers: { location: redirectTarget } })
      return json({ keys: jwk ? [jwk] : [] })
    }
    if (request.method === "GET" && request.url === redirectTarget) {
      redirectTargetCalls++
      return json({ keys: jwk ? [jwk] : [] })
    }
    deniedCalls++
    return new Response(null, { status: 403 })
  }
  return { control, outbound }
}
