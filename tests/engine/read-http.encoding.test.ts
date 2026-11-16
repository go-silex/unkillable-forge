import { env } from "cloudflare:workers"
import { beforeEach, describe, expect, it } from "vitest"
import { handleRead } from "../../adapters/http/readWorker"
import { setVisibility } from "../../domains/catalogue/commands"
import { PublicationService } from "../../domains/publication"
import { RevisionStore } from "../../domains/store/revision-store"
import { actor, bootstrap, configs, instanceId, jwks } from "./fixtures/catalogue"
import { body, content, documentCommand, publishDocument } from "./fixtures/publication"

beforeEach(async () => { await bootstrap() })

async function bytesContent(bytes: Uint8Array<ArrayBuffer>) {
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))
  return { bytes, size: bytes.byteLength, sha256: Array.from(hash, byte => byte.toString(16).padStart(2, "0")).join("") }
}

async function setup() {
  const config = await configs()
  const store = new RevisionStore(env.REVISION_BYTES, instanceId)
  const publication = new PublicationService({ db: env.DB, config: config.manage, jwks, now: () => 10_000, store, publication: { sessionTtlMs: 60_000, maxUploadTimeoutMs: 1000, retainMs: 900_000, marginMs: 1000, manageClockSkewMs: 0, readClockSkewMs: 0 } })
  const request = (path: string, init?: RequestInit) => handleRead(new Request(new URL(path, "https://forge.example.test"), init), { db: env.DB, config: config.read, jwks, nowSeconds: () => 10, store })
  return { config, publication, request }
}

function decodeRepresentation(response: Response, bytes: ArrayBuffer): { text: string; encoding: string } {
  const type = response.headers.get("content-type") ?? ""
  const label = /charset\s*=\s*["']?([^;\s"']+)/i.exec(type)?.[1]
  expect(label).toBeTruthy()
  const decoder = new TextDecoder(label)
  return { text: decoder.decode(bytes), encoding: decoder.encoding }
}

describe("read HTTP encoded resource paths and representations", () => {
  it("retains literal percent escapes in stylesheet bases when following a pinned image", async () => {
    const s = await setup()
    const page = await documentCommand("encoded-path", "/a/encoded/index.html", '<link rel="stylesheet" href="dir%2541/main.css">')
    const css = await content('.hero{background:url("logo.png")}')
    const image = await content("literal percent directory image")
    const decoy = await content("wrong decoded directory image")
    const paths = ["/a/encoded/dir%41/main.css", "/a/encoded/dir%41/logo.png", "/a/encoded/dirA/logo.png"]
    const files = [css, image, decoy]
    const command = { ...page.command, files: [...page.command.files, ...files.map((file, index) => ({ path: paths[index], kind: "asset" as const, size: file.size, sha256: file.sha256, contentType: index === 0 ? "text/css" : "image/png", source: "client" as const }))], edges: paths.map(path => ({ ownerPageId: page.pageId, path, providerArtifactId: null })) }
    const session = await s.publication.begin(actor, command)
    await s.publication.upload(actor, session.sessionId, "/a/encoded/index.html", body(page.bytes))
    for (let i = 0; i < files.length; i++) await s.publication.upload(actor, session.sessionId, paths[i], body(files[i].bytes))
    await s.publication.seal(actor, session.sessionId)
    const receipt = await s.publication.commit(actor, session.sessionId)
    await setVisibility({ db: env.DB, config: s.config.manage, jwks, now: () => 10_000 }, actor, { pageId: page.pageId, artifactId: receipt.artifactId, expectedPolicyEpoch: 0, visibility: "public" })

    const document = await s.request("/a/encoded/")
    expect(document.status).toBe(200)
    const cookie = document.headers.get("set-cookie")
    expect(cookie).toBeTruthy()
    const headers = { Cookie: cookie!.split(";", 1)[0] }
    const documentText = await document.text()
    const cssPath = /href="([^"]*main\.css)"/.exec(documentText)?.[1]
    expect(cssPath).toContain("dir%2541/main.css")
    if (!cssPath) throw new Error("stylesheet reference missing")
    const stylesheet = await s.request(cssPath, { headers })
    expect(stylesheet.status).toBe(200)
    const cssText = await stylesheet.text()
    const imagePath = /url\(["']?([^"')]+)["']?\)/.exec(cssText)?.[1]
    expect(imagePath).toContain("dir%2541/logo.png")
    if (!imagePath) throw new Error("stylesheet image reference missing")
    const servedImage = await s.request(imagePath, { headers })
    expect(servedImage.status).toBe(200)
    expect(new Uint8Array(await servedImage.arrayBuffer())).toEqual(image.bytes)
  })

  it("preserves windows-1252 HTML and CSS text with matching charset labels and a usable image", async () => {
    const s = await setup()
    const page = await documentCommand("windows-1252", "/a/charset/index.html", "")
    // These are actual Windows-1252 bytes, including 0xe9 and 0x80, not UTF-8 encoding.
    const html = await bytesContent(Uint8Array.from([...new TextEncoder().encode('<!doctype html><meta charset="windows-1252"><p>caf'), 0xe9, 0x20, 0x80, ...new TextEncoder().encode('</p><link rel="stylesheet" href="main.css">')]))
    const css = await bytesContent(Uint8Array.from([...new TextEncoder().encode('@charset "windows-1252";.label{content:"caf'), 0xe9, 0x20, 0x80, ...new TextEncoder().encode('";background:url("logo.png")}')]))
    const image = await content("charset image bytes")
    const paths = ["/a/charset/main.css", "/a/charset/logo.png"]
    const files = [css, image]
    const command = { ...page.command, files: [{ ...page.command.files[0], size: html.size, sha256: html.sha256, contentType: "text/html; charset=windows-1252" }, ...files.map((file, index) => ({ path: paths[index], kind: "asset" as const, size: file.size, sha256: file.sha256, contentType: index === 0 ? "text/css; charset=windows-1252" : "image/png", source: "client" as const }))], edges: paths.map(path => ({ ownerPageId: page.pageId, path, providerArtifactId: null })) }
    const session = await s.publication.begin(actor, command)
    await s.publication.upload(actor, session.sessionId, "/a/charset/index.html", body(html.bytes))
    for (let i = 0; i < files.length; i++) await s.publication.upload(actor, session.sessionId, paths[i], body(files[i].bytes))
    await s.publication.seal(actor, session.sessionId)
    const receipt = await s.publication.commit(actor, session.sessionId)
    await setVisibility({ db: env.DB, config: s.config.manage, jwks, now: () => 10_000 }, actor, { pageId: page.pageId, artifactId: receipt.artifactId, expectedPolicyEpoch: 0, visibility: "public" })

    const document = await s.request("/a/charset/")
    expect(document.status).toBe(200)
    const cookie = document.headers.get("set-cookie")
    expect(cookie).toBeTruthy()
    const headers = { Cookie: cookie!.split(";", 1)[0] }
    const rendered = decodeRepresentation(document, await document.arrayBuffer())
    expect(rendered.text).toContain("café €")
    const metaCharset = /<meta\s+charset=["']([^"']+)/i.exec(rendered.text)?.[1]
    expect(metaCharset).toBeTruthy()
    expect(new TextDecoder(metaCharset).encoding).toBe(rendered.encoding)
    const cssPath = /href="([^"]*main\.css)"/.exec(rendered.text)?.[1]
    expect(cssPath).toBeTruthy()
    if (!cssPath) throw new Error("stylesheet reference missing")
    const stylesheet = await s.request(cssPath, { headers })
    expect(stylesheet.status).toBe(200)
    const renderedCss = decodeRepresentation(stylesheet, await stylesheet.arrayBuffer())
    expect(renderedCss.text).toContain("café €")
    const stylesheetHead = await s.request(cssPath, { method: "HEAD", headers })
    expect(stylesheetHead.status).toBe(200)
    expect(stylesheetHead.headers.get("content-type")).toBe(stylesheet.headers.get("content-type"))
    expect(new Uint8Array(await stylesheetHead.arrayBuffer())).toHaveLength(0)
    const cssCharset = /@charset\s+["']([^"']+)["']/i.exec(renderedCss.text)?.[1]
    if (cssCharset) expect(new TextDecoder(cssCharset).encoding).toBe(renderedCss.encoding)
    const imagePath = /url\(["']?([^"')]+)["']?\)/.exec(renderedCss.text)?.[1]
    expect(imagePath).toBeTruthy()
    if (!imagePath) throw new Error("stylesheet image reference missing")
    const servedImage = await s.request(imagePath, { headers })
    expect(servedImage.status).toBe(200)
    expect(new Uint8Array(await servedImage.arrayBuffer())).toEqual(image.bytes)
  })
  it.each([
    ["comment", '<!-- <meta charset="windows-1252"> -->'],
    ["non-declaring metadata", '<meta name="description" content="charset=windows-1252">'],
  ])("ignores %s when selecting the effective HTML encoding", async (_variant, inert) => {
    const s = await setup()
    const page = await documentCommand("effective-encoding", "/a/effective-encoding/index.html", `<!doctype html>${inert}<meta charset="utf-8"><p>café €</p>`)
    const published = await publishDocument(s.publication, actor, page.command, page.bytes)
    await setVisibility({ db: env.DB, config: s.config.manage, jwks, now: () => 10_000 }, actor, { pageId: page.pageId, artifactId: published.receipt.artifactId, expectedPolicyEpoch: 0, visibility: "public" })
    const response = await s.request("/a/effective-encoding/")
    expect(response.status).toBe(200)
    const rendered = decodeRepresentation(response, await response.arrayBuffer())
    expect(rendered.text).toContain("<p>café €</p>")
    expect(rendered.text).not.toContain("cafÃ")
  })

  it("reports transformed windows-1252 representation metadata consistently for HEAD", async () => {
    const s = await setup()
    const page = await documentCommand("head-encoding", "/a/head-encoding/index.html", "")
    const html = await bytesContent(Uint8Array.from([...new TextEncoder().encode('<meta charset="windows-1252"><p>caf'), 0xe9, ...new TextEncoder().encode("</p>")]))
    const command = { ...page.command, files: [{ ...page.command.files[0], size: html.size, sha256: html.sha256, contentType: "text/html; charset=windows-1252" }] }
    const published = await publishDocument(s.publication, actor, command, html.bytes)
    await setVisibility({ db: env.DB, config: s.config.manage, jwks, now: () => 10_000 }, actor, { pageId: page.pageId, artifactId: published.receipt.artifactId, expectedPolicyEpoch: 0, visibility: "public" })
    const get = await s.request("/a/head-encoding/")
    expect(get.status).toBe(200)
    const rendered = decodeRepresentation(get, await get.arrayBuffer())
    expect(rendered.text).toContain("café")
    const head = await s.request("/a/head-encoding/", { method: "HEAD" })
    expect(head.status).toBe(200)
    expect(head.headers.get("content-type")).toBe(get.headers.get("content-type"))
    expect(new Uint8Array(await head.arrayBuffer())).toHaveLength(0)
  })
  it.each([
    ["utf-8", "windows-1252"],
    ["windows-1252", "utf-8"],
  ])("honors actual %s HTTP charset outside quoted parameters in HTML and CSS", async (charset, decoy) => {
    const s = await setup()
    const note = `note="a; charset=${decoy}; \\"quoted\\"; b"`
    const bytes = (value: string) => charset === "utf-8"
      ? new TextEncoder().encode(value)
      : Uint8Array.from(Array.from(value, char => char === "é" ? 0xe9 : char === "€" ? 0x80 : char.charCodeAt(0)))
    const document = await bytesContent(bytes('<!doctype html><meta charset="utf-8"><p>café €</p><link rel="stylesheet" href="main.css">'))
    const css = await bytesContent(bytes('.label{content:"café €"}'))
    const page = await documentCommand(`quoted-charset-${charset}`, "/a/quoted-charset/index.html", "")
    const cssPath = "/a/quoted-charset/main.css"
    const command = { ...page.command, files: [
      { ...page.command.files[0], size: document.size, sha256: document.sha256, contentType: `text/html; ${note}; charset=${charset}` },
      { path: cssPath, kind: "asset" as const, size: css.size, sha256: css.sha256, contentType: `text/css; ${note}; charset=${charset}`, source: "client" as const },
    ], edges: [{ ownerPageId: page.pageId, path: cssPath, providerArtifactId: null }] }
    const session = await s.publication.begin(actor, command)
    await s.publication.upload(actor, session.sessionId, command.files[0].path, body(document.bytes))
    await s.publication.upload(actor, session.sessionId, cssPath, body(css.bytes))
    await s.publication.seal(actor, session.sessionId)
    const receipt = await s.publication.commit(actor, session.sessionId)
    await setVisibility({ db: env.DB, config: s.config.manage, jwks, now: () => 10_000 }, actor, { pageId: page.pageId, artifactId: receipt.artifactId, expectedPolicyEpoch: 0, visibility: "public" })
    const get = await s.request("/a/quoted-charset/")
    expect(get.status).toBe(200)
    const cookie = get.headers.get("set-cookie")
    if (!cookie) throw new Error("pin missing")
    expect(get.headers.get("content-type")).toBe(`text/html; ${note}; charset=utf-8`)
    const html = await get.text()
    expect(html).toContain("<p>café €</p>")
    const head = await s.request("/a/quoted-charset/", { method: "HEAD" })
    expect(head.headers.get("content-type")).toBe(get.headers.get("content-type"))
    expect(new Uint8Array(await head.arrayBuffer())).toHaveLength(0)
    const stylesheetPath = /href="([^"]*main\.css)"/.exec(html)?.[1]
    if (!stylesheetPath) throw new Error("stylesheet missing")
    const headers = { Cookie: cookie.split(";", 1)[0] }
    const stylesheet = await s.request(stylesheetPath, { headers })
    expect(stylesheet.status).toBe(200)
    expect(stylesheet.headers.get("content-type")).toBe(`text/css; ${note}; charset=utf-8`)
    expect(await stylesheet.text()).toContain("café €")
    const stylesheetHead = await s.request(stylesheetPath, { method: "HEAD", headers })
    expect(stylesheetHead.headers.get("content-type")).toBe(stylesheet.headers.get("content-type"))
    expect(new Uint8Array(await stylesheetHead.arrayBuffer())).toHaveLength(0)
  })

  it("honors the effective http-equiv charset", async () => {
    const s = await setup()
    const note = 'note="a; charset=windows-1252; b"'
    const page = await documentCommand("quoted-meta-charset", "/a/quoted-meta/index.html", `<!doctype html><meta http-equiv="Content-Type" content='text/html; ${note}; charset=utf-8'><p>café €</p>`)
    const published = await publishDocument(s.publication, actor, page.command, page.bytes)
    await setVisibility({ db: env.DB, config: s.config.manage, jwks, now: () => 10_000 }, actor, { pageId: page.pageId, artifactId: published.receipt.artifactId, expectedPolicyEpoch: 0, visibility: "public" })
    const response = await s.request("/a/quoted-meta/")
    expect(response.status).toBe(200)
    let text = ""
    await new HTMLRewriter()
      .on("p", { text(chunk) { text += chunk.text } })
      .transform(response).text()
    expect(text).toBe("café €")
    // Browser DOM attribute semantics are checked by the separate Chrome probe.
  })
})
