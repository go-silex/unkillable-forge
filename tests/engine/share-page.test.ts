/* Roxabi card and page share provenance: functions/_lib/share-unfurl.ts and functions/s/[[path]].ts, revision 9c7dda4fd6427dde7da5f474a4519fffefe3ba6a (MIT). */
import { env } from "cloudflare:workers"
import { beforeEach, describe, expect, it } from "vitest"
import { importShare, ownershipStatements } from "../../domains/catalogue/commands"
import { resolveRead } from "../../domains/catalogue/resolve"
import { actor, artifactId, bootstrap, configs, digest, pageFixture, pageId, revisionId } from "./fixtures/catalogue"

beforeEach(async () => { await bootstrap(); await pageFixture({ route: { kind: "tree_page", pageRef: "docs/page.html" } }) })

describe("page-key and card shares", () => {
  it("exchanges a browser share, unfurls non-browser requests and never falls through for wrong keys", async () => {
    const { read, manage } = await configs()
    const deps = { db: env.DB, config: read, jwks: async () => [], nowSeconds: () => 1000 }
    await importShare({ db: env.DB, config: manage, now: () => 10 }, actor, { pageId, artifactId, expectedPolicyEpoch: 0, key: "history_key123", mode: "follow_active" })
    const url = "https://forge.example.test/s/docs/page.html/history_key123"
    expect(await resolveRead(new Request(url), deps)).toMatchObject({ kind: "share_unfurl", pageRef: "docs/page.html" })
    expect(await resolveRead(new Request(url, { headers: { "Sec-Fetch-Dest": "document" } }), deps)).toMatchObject({ kind: "share_exchange", location: "/docs/page", cookie: { pageRef: "docs/page.html", key: "history_key123" } })
    expect(await resolveRead(new Request("https://forge.example.test/s/docs/page.html/wrong_key123"), deps)).toMatchObject({ kind: "deny", status: 404 })
  })
  it("serves a card only when the matching page grants access and its card is an image", async () => {
    const { read, manage } = await configs()
    const deps = { db: env.DB, config: read, jwks: async () => [], nowSeconds: () => 1000 }
    await importShare({ db: env.DB, config: manage, now: () => 10 }, actor, { pageId, artifactId, expectedPolicyEpoch: 0, key: "history_key123", mode: "follow_active" })
    await env.DB.batch([
      env.DB.prepare("INSERT INTO revision_resources (revision_id,path,kind,object_key,sha256,size,content_type) VALUES (?, '/docs/page.og.jpg', 'asset', 'card', ?, 1, 'image/jpeg')").bind(revisionId, digest),
      env.DB.prepare("INSERT INTO mounts (path,artifact_id,revision_id,kind) VALUES ('/docs/page.og.jpg',?,?,'asset')").bind(artifactId, revisionId),
      ...ownershipStatements(env.DB, revisionId, [{ ownerPageId: pageId, path: "/docs/page.og.jpg" }]),
    ])
    const url = "https://forge.example.test/s/docs/page.og.jpg/history_key123"
    expect(await resolveRead(new Request(url), deps)).toMatchObject({ kind: "share_card", plan: { resource: { contentType: "image/jpeg" } } })
    expect(await resolveRead(new Request("https://forge.example.test/s/docs/page.og.jpg/wrong_key123"), deps)).toMatchObject({ kind: "deny", status: 404 })
    await env.DB.prepare("UPDATE revision_resources SET content_type = 'text/plain' WHERE revision_id = ? AND path = '/docs/page.og.jpg'").bind(revisionId).run()
    expect(await resolveRead(new Request(url), deps)).toMatchObject({ kind: "deny", status: 404 })
  })
})
