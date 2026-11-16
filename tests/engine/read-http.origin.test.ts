import { env } from "cloudflare:workers"
import { beforeEach, describe, expect, it } from "vitest"
import { handleRead } from "../../adapters/http/readWorker"
import { setVisibility } from "../../domains/catalogue/commands"
import { PublicationService } from "../../domains/publication"
import { RevisionStore } from "../../domains/store/revision-store"
import { actor, bootstrap, configs, instanceId, jwks } from "./fixtures/catalogue"
import { body, content, documentCommand } from "./fixtures/publication"

beforeEach(async () => { await bootstrap() })

async function publish(html: string, assets: { path: string; value: string; type: string }[]) {
  const config = await configs()
  const store = new RevisionStore(env.REVISION_BYTES, instanceId)
  const publication = new PublicationService({ db: env.DB, config: config.manage, jwks, now: () => 10_000, store, publication: { sessionTtlMs: 60_000, maxUploadTimeoutMs: 1000, retainMs: 900_000, marginMs: 1000, manageClockSkewMs: 0, readClockSkewMs: 0 } })
  const page = await documentCommand("origin-page", "/a/origin/index.html", html)
  const files = await Promise.all(assets.map(asset => content(asset.value)))
  const command = {
    ...page.command,
    files: [...page.command.files, ...assets.map((asset, i) => ({ path: asset.path, kind: "asset" as const, size: files[i].size, sha256: files[i].sha256, contentType: asset.type, source: "client" as const }))],
    edges: assets.map(asset => ({ ownerPageId: page.pageId, path: asset.path, providerArtifactId: null })),
  }
  const session = await publication.begin(actor, command)
  await publication.upload(actor, session.sessionId, "/a/origin/index.html", body(page.bytes))
  for (let i = 0; i < assets.length; i++) await publication.upload(actor, session.sessionId, assets[i].path, body(files[i].bytes))
  await publication.seal(actor, session.sessionId)
  const receipt = await publication.commit(actor, session.sessionId)
  await setVisibility({ db: env.DB, config: config.manage, jwks, now: () => 10_000 }, actor, { pageId: page.pageId, artifactId: receipt.artifactId, expectedPolicyEpoch: 0, visibility: "public" })
  const request = (url: string, init?: RequestInit) => handleRead(new Request(url, init), { db: env.DB, config: config.read, jwks, nowSeconds: () => 10, store })
  return { request, prefix: `/_revisions/${page.pageId}/${receipt.revisionId}/` }
}

function attribute(html: string, tag: string, name: string): string {
  const element = html.match(new RegExp(`<${tag}\\b[^>]*>`, "i"))?.[0]
  const value = element?.match(new RegExp(`(?:^|\\s)${name}="([^"]*)"`, "i"))?.[1]
  if (value === undefined) throw new Error(`Missing ${tag} ${name} in ${html}`)
  return value
}

function pinCookie(response: Response): string {
  const cookie = response.headers.get("set-cookie")
  if (!cookie) throw new Error("Missing pin cookie")
  return cookie.split(";", 1)[0]
}

describe("read HTTP browser origin and resource integrity", () => {
  it("preserves the Forge origin for local assets and navigation under an external base", async () => {
    const s = await publish('<base href="https://cdn.example.test/"><img src="https://forge.example.test/a/origin/image.png"><a href="https://forge.example.test/a/origin/next">Next</a>', [{ path: "/a/origin/image.png", value: "original image", type: "image/png" }])
    const document = await s.request("https://forge.example.test/a/origin/")
    expect(document.status).toBe(200)
    const cookie = pinCookie(document)
    const html = await document.text()
    const base = new URL(attribute(html, "base", "href"), document.url || "https://forge.example.test/a/origin/")
    expect(base.href).toBe("https://cdn.example.test/")
    const image = new URL(attribute(html, "img", "src"), base)
    expect(image.origin).toBe("https://forge.example.test")
    expect(image.pathname).toBe(`${s.prefix}a/origin/image.png`)
    const response = await s.request(image.href, { headers: { Cookie: cookie } })
    expect(response.status).toBe(200)
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(new TextEncoder().encode("original image"))
    expect(new URL(attribute(html, "a", "href"), base).href).toBe("https://forge.example.test/a/origin/next")
  })

  it("does not turn a same-origin double-slash pathname into a network-path navigation", async () => {
    const s = await publish('<a href="https://forge.example.test//outside.example.test/path">Next</a>', [])
    const response = await s.request("https://forge.example.test/a/origin/")
    expect(response.status).toBe(200)
    const target = new URL(attribute(await response.text(), "a", "href"), "https://forge.example.test/a/origin/")
    expect(target.href).toBe("https://forge.example.test//outside.example.test/path")
  })

  it("pins canonical-host assets to the requesting alias and serves their bytes", async () => {
    const s = await publish('<img src="https://forge.example.test/a/origin/image.png">', [{ path: "/a/origin/image.png", value: "alias image", type: "image/png" }])
    const response = await s.request("https://alias.example.test/a/origin/")
    expect(response.status).toBe(200)
    const cookie = pinCookie(response)
    const image = new URL(attribute(await response.text(), "img", "src"), "https://alias.example.test/a/origin/")
    expect(image.origin).toBe("https://alias.example.test")
    expect(image.pathname).toBe(`${s.prefix}a/origin/image.png`)
    const asset = await s.request(image.href, { headers: { Cookie: cookie } })
    expect(asset.status).toBe(200)
    expect(new Uint8Array(await asset.arrayBuffer())).toEqual(new TextEncoder().encode("alias image"))
  })

  it("pins SVG href and xlink:href resources while preserving their fragments", async () => {
    const s = await publish('<svg><use href="icons.svg#tick"></use><image xlink:href="diagram.png"></image></svg>', [
      { path: "/a/origin/icons.svg", value: '<svg xmlns="http://www.w3.org/2000/svg"><symbol id="tick"/></svg>', type: "image/svg+xml" },
      { path: "/a/origin/diagram.png", value: "diagram bytes", type: "image/png" },
    ])
    const response = await s.request("https://forge.example.test/a/origin/")
    expect(response.status).toBe(200)
    const cookie = pinCookie(response)
    const html = await response.text()
    const use = new URL(attribute(html, "use", "href"), "https://forge.example.test/a/origin/")
    const image = new URL(attribute(html, "image", "xlink:href"), "https://forge.example.test/a/origin/")
    expect(use.pathname).toBe(`${s.prefix}a/origin/icons.svg`)
    expect(use.hash).toBe("#tick")
    expect(image.pathname).toBe(`${s.prefix}a/origin/diagram.png`)
    for (const [url, expected] of [[use, '<svg xmlns="http://www.w3.org/2000/svg"><symbol id="tick"/></svg>'], [image, "diagram bytes"]] as const) {
      const asset = await s.request(url.href, { headers: { Cookie: cookie } })
      expect(asset.status).toBe(200)
      expect(new Uint8Array(await asset.arrayBuffer())).toEqual(new TextEncoder().encode(expected))
    }
  })

  it("does not deliver a stale integrity assertion for transformed CSS", async () => {
    const css = '.hero{background:url("hero.png")}'
    const originalHash = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(css)))
    const integrity = `sha256-${btoa(String.fromCharCode(...originalHash))}`
    const s = await publish(`<link rel="stylesheet" href="main.css" integrity="${integrity}">`, [
      { path: "/a/origin/main.css", value: css, type: "text/css" },
      { path: "/a/origin/hero.png", value: "hero image", type: "image/png" },
    ])
    const document = await s.request("https://forge.example.test/a/origin/")
    expect(document.status).toBe(200)
    const cookie = pinCookie(document)
    const html = await document.text()
    const stylesheetUrl = new URL(attribute(html, "link", "href"), "https://forge.example.test/a/origin/")
    expect(stylesheetUrl.pathname).toBe(`${s.prefix}a/origin/main.css`)
    const stylesheet = await s.request(stylesheetUrl.href, { headers: { Cookie: cookie } })
    expect(stylesheet.status).toBe(200)
    const delivered = await stylesheet.text()
    expect(delivered).toContain(`${s.prefix}a/origin/hero.png`)
    const tag = html.match(/<link\b[^>]*>/i)?.[0]
    if (!tag) throw new Error("Missing stylesheet link")
    const assertion = tag.match(/\sintegrity="([^"]*)"/i)?.[1]
    if (assertion !== undefined) {
      const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(delivered)))
      expect(assertion.split(/\s+/)).toContain(`sha256-${btoa(String.fromCharCode(...hash))}`)
    }
  })
})
