import { env } from "cloudflare:workers"
import { beforeEach, describe, expect, it } from "vitest"
import { handleRead } from "../../adapters/http/readWorker"
import { setVisibility } from "../../domains/catalogue/commands"
import { RevisionStore } from "../../domains/store/revision-store"
import { actor, artifactId, bootstrap, configs, digest, instanceId, jwks, pageFixture, pageId, revisionId } from "./fixtures/catalogue"
import { body, content } from "./fixtures/publication"

beforeEach(async () => { await bootstrap() })

describe("read HTTP external fragment ownership", () => {
  it("uses the requesting page pin while following the mounted provider revision and revocation", async () => {
    const config = await configs()
    const store = new RevisionStore(env.REVISION_BYTES, instanceId)
    const request = (path: string, init?: RequestInit) => handleRead(new Request(`https://forge.example.test${path}`, init), { db: env.DB, config: config.read, jwks, nowSeconds: () => 10, store })
    const provider = `ar_${"b".repeat(26)}`
    const firstRevision = `rv_${"b".repeat(26)}`
    const nextRevision = `rv_${"c".repeat(26)}`
    const providerPage = `pg_${"b".repeat(26)}`
    const documentPath = "/docs/page.html"
    const fragmentPath = "/shared/fragment.html"
    const assetPath = "/shared/image.png"
    await pageFixture({ artifact: provider, revision: firstRevision, page: providerPage, route: { kind: "tree_page", pageRef: "provider/page.html" } })
    await pageFixture({ route: { kind: "tree_page", pageRef: "docs/page.html" }, ownership: [
      { path: fragmentPath, providerArtifactId: provider },
      { path: assetPath, providerArtifactId: provider },
    ] })

    const document = await content('<!doctype html><p>consumer page</p>')
    await store.put({ artifactId, revisionId, kind: "resource", path: documentPath }, document, body(document.bytes))
    await env.DB.prepare("UPDATE revision_resources SET sha256 = ?, size = ? WHERE revision_id = ? AND path = ?").bind(document.sha256, document.size, revisionId, documentPath).run()

    const firstFragment = await content('<p>provider first</p><img src="image.png">')
    const nextFragment = await content('<p>provider second</p><img src="image.png">')
    const firstAsset = await content("first-provider-image")
    const nextAsset = await content("second-provider-image")
    for (const [revision, fragment, asset] of [[firstRevision, firstFragment, firstAsset], [nextRevision, nextFragment, nextAsset]] as const) {
      await store.put({ artifactId: provider, revisionId: revision, kind: "resource", path: fragmentPath }, fragment, body(fragment.bytes))
      await store.put({ artifactId: provider, revisionId: revision, kind: "resource", path: assetPath }, asset, body(asset.bytes))
    }
    await env.DB.batch([
      env.DB.prepare("INSERT INTO revisions (revision_id,artifact_id,origin,manifest_sha256,manifest_object_key,sealed_at) VALUES (?,?,'published',?,'provider-next',2)").bind(nextRevision, provider, digest),
      ...([[firstRevision, firstFragment, firstAsset], [nextRevision, nextFragment, nextAsset]] as const).flatMap(([revision, fragment, asset]) => [
        env.DB.prepare("INSERT INTO revision_resources (revision_id,path,kind,object_key,sha256,size,content_type) VALUES (?,?,'fragment','fragment-object',?,?,'text/html')").bind(revision, fragmentPath, fragment.sha256, fragment.size),
        env.DB.prepare("INSERT INTO revision_resources (revision_id,path,kind,object_key,sha256,size,content_type) VALUES (?,?,'asset','asset-object',?,?,'image/png')").bind(revision, assetPath, asset.sha256, asset.size),
      ]),
      env.DB.prepare("INSERT INTO mounts (path,artifact_id,revision_id,kind) VALUES (?, ?, ?, 'fragment')").bind(fragmentPath, provider, firstRevision),
      env.DB.prepare("INSERT INTO mounts (path,artifact_id,revision_id,kind) VALUES (?, ?, ?, 'asset')").bind(assetPath, provider, firstRevision),
    ])
    const management = { db: env.DB, config: config.manage, jwks, now: () => 10 }
    await setVisibility(management, actor, { pageId, artifactId, expectedPolicyEpoch: 0, visibility: "public" })
    const page = await request("/docs/page")
    expect(page.status).toBe(200)
    const pin = page.headers.get("set-cookie")
    const prefix = `/_revisions/${pageId}/${revisionId}/`
    expect(pin).toContain(`Path=${prefix}`)
    if (!pin) throw new Error("page pin cookie missing")
    const headers = { Cookie: pin.split(";", 1)[0] }
    const fragmentUrl = `${prefix}shared/fragment.html`
    const assetUrl = `${prefix}shared/image.png`

    const first = await request(fragmentUrl, { headers })
    expect(first.status).toBe(200)
    const firstHtml = await first.text()
    expect(firstHtml).toContain("provider first")
    expect(firstHtml).toContain(`src="${assetUrl}"`)
    const image = await request(assetUrl, { headers })
    expect(image.status).toBe(200)
    expect(new Uint8Array(await image.arrayBuffer())).toEqual(firstAsset.bytes)

    await env.DB.prepare("UPDATE artifacts SET active_revision_id = ? WHERE artifact_id = ?").bind(nextRevision, provider).run()
    expect((await request(fragmentUrl, { headers })).status).toBe(404)
    await env.DB.prepare("UPDATE mounts SET revision_id = ? WHERE artifact_id = ? AND path IN (?, ?)").bind(nextRevision, provider, fragmentPath, assetPath).run()
    const next = await request(fragmentUrl, { headers })
    expect(next.status).toBe(200)
    const nextHtml = await next.text()
    expect(nextHtml).toContain("provider second")
    expect(nextHtml).not.toContain("provider first")
    expect(nextHtml).toContain(`src="${assetUrl}"`)
    const nextImage = await request(assetUrl, { headers })
    expect(nextImage.status).toBe(200)
    expect(new Uint8Array(await nextImage.arrayBuffer())).toEqual(nextAsset.bytes)
    const etag = nextImage.headers.get("etag")
    expect(etag).toBeTruthy()
    if (!etag) throw new Error("provider asset etag missing")
    expect((await request(assetUrl, { headers: { ...headers, "If-None-Match": etag } })).status).toBe(304)
    expect((await request(assetUrl, { headers: { ...headers, Range: "bytes=0-5" } })).status).toBe(206)

    await setVisibility(management, actor, { pageId, artifactId, expectedPolicyEpoch: 1, visibility: "private" })
    const cases: Record<string, string>[] = [{}, { "If-None-Match": etag }, { Range: "bytes=0-5" }]
    for (const path of [fragmentUrl, assetUrl]) {
      for (const extra of cases) {
        const denied = await request(path, { headers: { ...headers, ...extra } })
        expect(denied.status).toBe(404)
        expect(await denied.text()).not.toContain("provider second")
      }
    }
  })
})
