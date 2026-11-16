import { env } from "cloudflare:workers"
import { beforeEach, describe, expect, it } from "vitest"
import { handleRead } from "../../adapters/http/readWorker"
import { importShare, rotateShare, setVisibility } from "../../domains/catalogue/commands"
import { PublicationService } from "../../domains/publication"
import { RevisionStore } from "../../domains/store/revision-store"
import { actor, artifactId, bootstrap, configs, instanceId, jwks, pageFixture, pageId } from "./fixtures/catalogue"
import { body, content, documentCommand, publishDocument } from "./fixtures/publication"

beforeEach(async () => { await bootstrap() })

async function setup() {
  const config = await configs()
  const store = new RevisionStore(env.REVISION_BYTES, instanceId)
  const publication = new PublicationService({ db: env.DB, config: config.manage, jwks, now: () => 10_000, store, publication: { sessionTtlMs: 60_000, maxUploadTimeoutMs: 1000, retainMs: 900_000, marginMs: 1000, manageClockSkewMs: 0, readClockSkewMs: 0 } })
  const deps = { db: env.DB, config: config.read, jwks, nowSeconds: () => 10, store }
  const request = (path: string, init?: RequestInit) => handleRead(new Request(`https://forge.example.test${path}`, init), deps)
  return { config, store, publication, request }
}

async function publishPage(publication: PublicationService, path: string, value: string) {
  const input = await documentCommand(`read-${path}`, path, value)
  const result = await publishDocument(publication, actor, input.command, input.bytes)
  return { ...result, pageId: input.pageId }
}

describe("read HTTP with native D1 and R2", () => {
  it.each(["marked", "unmarked"])("replaces the %s legacy share toolbar with a management link", async variant => {
    const s = await setup()
    const legacy = `<script>window.__FORGE_SHARE__={"slug":"toolbar"};</script>
<script>
  window.__FORGE_SHARE_BAR__ = true;
  fetch("/api/share", { method: "POST" });
  fetch("/api/visibility", { method: "POST" });
  document.body.insertAdjacentHTML("beforeend", '<button data-forge-share-bar>Change visibility</button>');
</script>`
    const toolbar = variant === "marked" ? `<!-- forge-share-bar -->${legacy}<!-- /forge-share-bar -->` : legacy
    const html = `<!doctype html><html><body><main>Page content</main>${toolbar}<script>window.keepDocumentScript = "preserved";</script></body></html>`
    const page = await publishPage(s.publication, "/a/toolbar/index.html", html)
    await setVisibility({ db: env.DB, config: s.config.manage, jwks, now: () => 10_000 }, actor, { pageId: page.pageId, artifactId: page.receipt.artifactId, expectedPolicyEpoch: 0, visibility: "public" })

    const response = await s.request("/a/toolbar/")
    expect(response.status).toBe(200)
    const rendered = await response.text()
    expect(rendered).toContain("<main>Page content</main>")
    expect(rendered).toContain('<script>window.keepDocumentScript = "preserved";</script>')
    for (const legacyContent of ["forge-share-bar", "__FORGE_SHARE__", "__FORGE_SHARE_BAR__", "/api/share", "/api/visibility", "Change visibility"]) {
      expect(rendered).not.toContain(legacyContent)
    }
    const link = rendered.match(/<a\b[^>]*href="https:\/\/manage\.example\.test\/manage\?pageId=[^"]+"[^>]*>/i)?.[0]
    expect(link).toBeDefined()
    expect(link).toContain(`href="https://manage.example.test/manage?pageId=${page.pageId}"`)
    expect(link).toMatch(/\brel="[^"]*\bnoopener\b[^"]*"/i)
  })

  it("rewrites HTML and stylesheet resources into the page's usable pinned namespace", async () => {
    const s = await setup()
    const html = '<!doctype html><base href="/a/rewrite/assets/"><link rel="stylesheet" href="main.css"><img src="hero.png" srcset="hero.png 1x, large.png 2x" style="background:url(hero.png)"><style>.banner{background:url(large.png)}</style><a href="../next">Next</a><img src="https://cdn.example.test/external.png">'
    const page = await documentCommand("rewrite-page", "/a/rewrite/index.html", html)
    const files = await Promise.all([
      content('@import "nested.css"; .hero{background:url("hero.png")}'),
      content(".nested{color:red}"),
      content("hero image"),
      content("large image"),
    ])
    const paths = ["/a/rewrite/assets/main.css", "/a/rewrite/assets/nested.css", "/a/rewrite/assets/hero.png", "/a/rewrite/assets/large.png"]
    const command = {
      ...page.command,
      files: [...page.command.files, ...files.map((file, index) => ({ path: paths[index], kind: "asset" as const, size: file.size, sha256: file.sha256, contentType: index < 2 ? "text/css" : "image/png", source: "client" as const }))],
      edges: paths.map(path => ({ ownerPageId: page.pageId, path, providerArtifactId: null })),
    }
    const session = await s.publication.begin(actor, command)
    await s.publication.upload(actor, session.sessionId, "/a/rewrite/index.html", body(page.bytes))
    for (let i = 0; i < files.length; i++) await s.publication.upload(actor, session.sessionId, paths[i], body(files[i].bytes))
    await s.publication.seal(actor, session.sessionId)
    const receipt = await s.publication.commit(actor, session.sessionId)
    await setVisibility({ db: env.DB, config: s.config.manage, jwks, now: () => 10_000 }, actor, { pageId: page.pageId, artifactId: receipt.artifactId, expectedPolicyEpoch: 0, visibility: "public" })

    const document = await s.request("/a/rewrite/")
    expect(document.status).toBe(200)
    const cookie = document.headers.get("set-cookie")
    const prefix = `/_revisions/${page.pageId}/${receipt.revisionId}/`
    expect(cookie).toContain(`Path=${prefix}`)
    const rendered = await document.text()
    expect(rendered).toContain('href="https://forge.example.test/a/rewrite/assets/"')
    expect(rendered).toContain(`href="${prefix}a/rewrite/assets/main.css"`)
    expect(rendered).toContain(`src="${prefix}a/rewrite/assets/hero.png"`)
    expect(rendered).toContain(`srcset="${prefix}a/rewrite/assets/hero.png 1x, ${prefix}a/rewrite/assets/large.png 2x"`)
    expect(rendered).toMatch(new RegExp(`style="[^"]*${prefix}a/rewrite/assets/hero\\.png`))
    expect(rendered).toMatch(new RegExp(`<style>[^<]*${prefix}a/rewrite/assets/large\\.png`))
    expect(rendered).toContain('href="/a/rewrite/next"')
    expect(rendered).toContain("https://cdn.example.test/external.png")

    const headers = { Cookie: cookie!.split(";", 1)[0] }
    const css = await s.request(`${prefix}a/rewrite/assets/main.css`, { headers })
    expect(css.status).toBe(200)
    const stylesheet = await css.text()
    expect(stylesheet).toContain(`${prefix}a/rewrite/assets/nested.css`)
    expect(stylesheet).toContain(`${prefix}a/rewrite/assets/hero.png`)
    const imported = await s.request(`${prefix}a/rewrite/assets/nested.css`, { headers })
    expect(imported.status).toBe(200)
    expect(await imported.text()).toContain("color:red")
    const image = await s.request(`${prefix}a/rewrite/assets/hero.png`, { headers })
    expect(image.status).toBe(200)
    expect(new Uint8Array(await image.arrayBuffer())).toEqual(files[2].bytes)
  })

  it("keeps two revision-scoped tabs isolated and denies their pinned conditionals and ranges after revocation", async () => {
    const s = await setup()
    const documentPath = "/a/tabs/index.html", assetPath = "/a/tabs/data.bin"
    const first = await documentCommand("tabs-first", documentPath, "<p>first tab</p>")
    const firstAsset = await content("first-asset")
    const firstCommand = { ...first.command, files: [...first.command.files, { path: assetPath, kind: "asset" as const, size: firstAsset.size, sha256: firstAsset.sha256, contentType: "application/octet-stream", source: "client" as const }], edges: [{ ownerPageId: first.pageId, path: assetPath, providerArtifactId: null }] }
    const session = await s.publication.begin(actor, firstCommand)
    await s.publication.upload(actor, session.sessionId, documentPath, body(first.bytes))
    await s.publication.upload(actor, session.sessionId, assetPath, body(firstAsset.bytes))
    await s.publication.seal(actor, session.sessionId)
    const receipt = await s.publication.commit(actor, session.sessionId)
    const management = { db: env.DB, config: s.config.manage, jwks, now: () => 10_000 }
    await setVisibility(management, actor, { pageId: first.pageId, artifactId: receipt.artifactId, expectedPolicyEpoch: 0, visibility: "public" })
    const firstTab = await s.request("/a/tabs/")
    expect(firstTab.status).toBe(200)
    const firstPin = firstTab.headers.get("set-cookie")
    const firstPrefix = `/_revisions/${first.pageId}/${receipt.revisionId}/`
    expect(firstPin).toContain(`Path=${firstPrefix}`)
    if (!firstPin) throw new Error("first revision pin cookie missing")
    const firstCookie = firstPin.split(";", 1)[0]

    const secondDocument = await content("<p>second tab</p>")
    const secondAsset = await content("second-asset")
    const secondCommand = {
      ...firstCommand, idempotencyKey: "tabs-second", artifactId: receipt.artifactId,
      expectedRevisionId: receipt.revisionId, expectedContentVersion: receipt.contentVersion,
      files: [
        { path: documentPath, kind: "document" as const, size: secondDocument.size, sha256: secondDocument.sha256, contentType: "text/html", source: "client" as const },
        { path: assetPath, kind: "asset" as const, size: secondAsset.size, sha256: secondAsset.sha256, contentType: "application/octet-stream", source: "client" as const },
      ],
      pages: [{ ...first.command.pages[0], disposition: "keep" as const, expectedPolicyEpoch: 1 }],
    }
    const next = await s.publication.begin(actor, secondCommand)
    await s.publication.upload(actor, next.sessionId, documentPath, body(secondDocument.bytes))
    await s.publication.upload(actor, next.sessionId, assetPath, body(secondAsset.bytes))
    await s.publication.seal(actor, next.sessionId)
    const secondReceipt = await s.publication.commit(actor, next.sessionId)
    const secondTab = await s.request("/a/tabs/")
    expect(secondTab.status).toBe(200)
    const secondPin = secondTab.headers.get("set-cookie")
    const secondPrefix = `/_revisions/${first.pageId}/${secondReceipt.revisionId}/`
    expect(secondPin).toContain(`Path=${secondPrefix}`)
    if (!secondPin) throw new Error("second revision pin cookie missing")
    const secondCookie = secondPin.split(";", 1)[0]
    expect(secondCookie).not.toBe(firstCookie)

    const oldAsset = await s.request(`${firstPrefix}a/tabs/data.bin`, { headers: { Cookie: firstCookie } })
    expect(oldAsset.status).toBe(200)
    expect(new Uint8Array(await oldAsset.arrayBuffer())).toEqual(firstAsset.bytes)
    const etag = oldAsset.headers.get("etag")
    expect(etag).toBeTruthy()
    const newAsset = await s.request(`${secondPrefix}a/tabs/data.bin`, { headers: { Cookie: secondCookie } })
    expect(newAsset.status).toBe(200)
    expect(new Uint8Array(await newAsset.arrayBuffer())).toEqual(secondAsset.bytes)
    const secondEtag = newAsset.headers.get("etag")
    expect(secondEtag).toBeTruthy()
    const wrongTab = await s.request(`${firstPrefix}a/tabs/data.bin`, { headers: { Cookie: secondCookie } })
    expect(wrongTab.status).toBe(404)
    expect((await s.request(`${firstPrefix}a/tabs/data.bin`, { headers: { Cookie: firstCookie, "If-None-Match": etag! } })).status).toBe(304)
    const range = await s.request(`${firstPrefix}a/tabs/data.bin`, { headers: { Cookie: firstCookie, Range: "bytes=0-4" } })
    expect(range.status).toBe(206)
    expect(new Uint8Array(await range.arrayBuffer())).toEqual(firstAsset.bytes.slice(0, 5))

    await setVisibility(management, actor, { pageId: first.pageId, artifactId: receipt.artifactId, expectedPolicyEpoch: 1, visibility: "private" })
    if (!etag || !secondEtag) throw new Error("asset etag missing")
    for (const [prefix, cookie, matchingEtag] of [[firstPrefix, firstCookie, etag], [secondPrefix, secondCookie, secondEtag]]) {
      const conditionals: Record<string, string>[] = [{ "If-None-Match": matchingEtag }, { Range: "bytes=0-4" }]
      for (const conditional of conditionals) {
        const denied = await s.request(`${prefix}a/tabs/data.bin`, { headers: { Cookie: cookie, ...conditional } })
        expect(denied.status).toBe(404)
        expect(await denied.text()).not.toContain("asset")
      }
    }
  })

  it("authorizes before HEAD, range and conditional responses and rechecks visibility", async () => {
    const s = await setup()
    const page = await publishPage(s.publication, "/a/guard/index.html", "<p>confidential guard document</p>")
    const headers = { Range: "bytes=0-3", "If-None-Match": "*" }
    for (const method of ["GET", "HEAD"]) {
      const denied = await s.request("/a/guard/", { method, headers })
      expect(denied.status).not.toBe(200)
      expect(denied.status).not.toBe(206)
      expect(denied.status).not.toBe(304)
      expect(await denied.text()).not.toContain("confidential guard document")
    }
    await setVisibility({ db: env.DB, config: s.config.manage, jwks, now: () => 10_000 }, actor, { pageId: page.pageId, artifactId: page.receipt.artifactId, expectedPolicyEpoch: 0, visibility: "public" })
    const allowed = await s.request("/a/guard/")
    expect(allowed.status).toBe(200)
    expect(await allowed.text()).toContain("confidential guard document")
    await setVisibility({ db: env.DB, config: s.config.manage, jwks, now: () => 10_001 }, actor, { pageId: page.pageId, artifactId: page.receipt.artifactId, expectedPolicyEpoch: 1, visibility: "private" })
    const revoked = await s.request("/a/guard/", { headers })
    expect([200, 206, 304]).not.toContain(revoked.status)
    expect(await revoked.text()).not.toContain("confidential guard document")
  })

  it("does not answer a conditional request for a missing R2 object", async () => {
    const s = await setup()
    const page = await publishPage(s.publication, "/a/missing/index.html", "<p>removed object</p>")
    await setVisibility({ db: env.DB, config: s.config.manage, jwks, now: () => 10_000 }, actor, { pageId: page.pageId, artifactId: page.receipt.artifactId, expectedPolicyEpoch: 0, visibility: "public" })
    if (!page.receipt.revisionId) throw new Error("published revision missing")
    const object = await s.store.head({ artifactId: page.receipt.artifactId, revisionId: page.receipt.revisionId, kind: "resource", path: "/a/missing/index.html" })
    if (!object) throw new Error("published object missing before fault injection")
    await env.REVISION_BYTES.delete(object.key)
    const cases: Record<string, string>[] = [{}, { "If-None-Match": "*" }, { Range: "bytes=0-3" }]
    for (const headers of cases) {
      const response = await s.request("/a/missing/", { headers })
      expect(response.status).toBe(404)
      expect(await response.text()).not.toContain("removed object")
    }
  })

  it("serves an externally owned asset from its provider and applies conditional and range semantics only while authorized", async () => {
    const s = await setup()
    const provider = `ar_${"b".repeat(26)}`
    const providerRevision = `rv_${"b".repeat(26)}`
    const providerPage = `pg_${"b".repeat(26)}`
    await pageFixture({ artifact: provider, revision: providerRevision, page: providerPage, route: { kind: "tree_page", pageRef: "provider/page.html" } })
    await pageFixture({ route: { kind: "tree_page", pageRef: "docs/page.html" }, ownership: [{ path: "/shared/app.js", providerArtifactId: provider }] })
    const file = await content("0123456789")
    await s.store.put({ artifactId: provider, revisionId: providerRevision, kind: "resource", path: "/shared/app.js" }, file, body(file.bytes))
    await env.DB.batch([
      env.DB.prepare("INSERT INTO revision_resources (revision_id,path,kind,object_key,sha256,size,content_type) VALUES (?, '/shared/app.js', 'asset', 'asset-object', ?, ?, 'application/javascript')").bind(providerRevision, file.sha256, file.size),
      env.DB.prepare("INSERT INTO mounts (path,artifact_id,revision_id,kind) VALUES ('/shared/app.js',?,?,'asset')").bind(provider, providerRevision),
    ])
    await setVisibility({ db: env.DB, config: s.config.manage, jwks, now: () => 10 }, actor, { pageId, artifactId, expectedPolicyEpoch: 0, visibility: "public" })
    const full = await s.request("/shared/app.js")
    expect(full.status).toBe(200)
    expect(await full.text()).toBe("0123456789")
    const etag = full.headers.get("etag")
    expect(etag).toBeTruthy()
    const conditional = await s.request("/shared/app.js", { headers: { "If-None-Match": etag! } })
    expect(conditional.status).toBe(304)
    const partial = await s.request("/shared/app.js", { headers: { Range: "bytes=2-5" } })
    expect(partial.status).toBe(206)
    expect(partial.headers.get("content-range")).toBe("bytes 2-5/10")
    expect(await partial.text()).toBe("2345")
    await setVisibility({ db: env.DB, config: s.config.manage, jwks, now: () => 11 }, actor, { pageId, artifactId, expectedPolicyEpoch: 1, visibility: "private" })
    if (!etag) throw new Error("asset etag missing")
    const cases: Record<string, string>[] = [{ "If-None-Match": etag }, { Range: "bytes=2-5" }]
    for (const headers of cases) {
      const denied = await s.request("/shared/app.js", { headers })
      expect(denied.status).toBe(404)
      expect(await denied.text()).not.toContain("2345")
    }
  })

  it("exchanges a page share for a cookie and rejects that cookie immediately after rotation", async () => {
    const s = await setup()
    const page = await publishPage(s.publication, "/docs/shared.html", "<p>shared tree page</p>")
    const deps = { db: env.DB, config: s.config.manage, jwks, now: () => 10_000 }
    const grant = await importShare(deps, actor, { pageId: page.pageId, artifactId: page.receipt.artifactId, expectedPolicyEpoch: 0, key: "historical_123", mode: "follow_active" })
    const exchange = await s.request("/s/docs/shared.html/historical_123", { headers: { "Sec-Fetch-Dest": "document" } })
    expect(exchange.status).toBe(302)
    expect(exchange.headers.get("location")).toBe("/docs/shared")
    const setCookie = exchange.headers.get("set-cookie")
    expect(setCookie).toMatch(/forge_share=/)
    expect(setCookie).toMatch(/HttpOnly/i)
    expect(setCookie).toMatch(/Secure/i)
    expect(setCookie).toMatch(/SameSite=Lax/i)
    const cookie = setCookie!.split(";", 1)[0]
    const allowed = await s.request("/docs/shared", { headers: { Cookie: cookie } })
    expect(allowed.status).toBe(200)
    expect(await allowed.text()).toContain("shared tree page")
    await rotateShare(deps, actor, { pageId: page.pageId, artifactId: page.receipt.artifactId, expectedPolicyEpoch: 1, grantId: grant.grantId })
    const denied = await s.request("/docs/shared", { headers: { Cookie: cookie, "If-None-Match": "*", Range: "bytes=0-3" } })
    expect([200, 206, 304]).not.toContain(denied.status)
    expect(await denied.text()).not.toContain("shared tree page")
  })

  it("enforces host, method and reserved paths before content delivery", async () => {
    const s = await setup()
    expect((await handleRead(new Request("https://other.example.test/a/sample/"), { db: env.DB, config: s.config.read, jwks, nowSeconds: () => 10, store: s.store })).status).toBe(403)
    expect((await s.request("/a/sample/", { method: "POST" })).status).toBe(405)
    for (const path of ["/manifest.json", "/registry/private", "/a/sample/%2fsecret"]) {
      expect((await s.request(path)).status).toBe(404)
    }
  })
})
