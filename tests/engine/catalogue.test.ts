import { env } from "cloudflare:workers"
import { beforeEach, describe, expect, it } from "vitest"
import { listCatalogue } from "../../domains/catalogue/catalogue-list"
import { artifactId, bootstrap, configs, pageFixture, pageId, revisionId } from "./fixtures/catalogue"

beforeEach(async () => { await bootstrap(); await pageFixture({ visibility: "public" }) })

describe("catalogue primary reads", () => {
  it("maps a genuine missing schema and an instance mismatch distinctly", async () => {
    const config = (await configs()).read
    await expect(listCatalogue(env.EMPTY_DB, config, "anonymous", { after: null, limit: 10 })).rejects.toMatchObject({ code: "unavailable" })
    await expect(listCatalogue(env.DB, { ...config, instanceId: "other-instance" }, "anonymous", { after: null, limit: 10 })).rejects.toMatchObject({ code: "instance_mismatch" })
  })
  it("bounds limits and preserves pagination without returning hidden fields", async () => {
    const second = `pg_${"b".repeat(26)}`
    await pageFixture({ artifact: `ar_${"b".repeat(26)}`, revision: `rv_${"b".repeat(26)}`, page: second, route: { kind: "subtree", slug: "another" }, visibility: "public" })
    const config = (await configs()).read
    const first = await listCatalogue(env.DB, config, "anonymous", { after: null, limit: 0 })
    expect(first).toHaveLength(1)
    expect(first[0]).toMatchObject({ pageId, visibility: null })
    expect(await listCatalogue(env.DB, config, "anonymous", { after: pageId, limit: 1000 })).toMatchObject([{ pageId: second, visibility: null }])
    await expect(listCatalogue(env.DB, config, "anonymous", { after: null, limit: 1.5 })).rejects.toMatchObject({ code: "invalid_state" })
    expect(JSON.stringify(first)).not.toContain(artifactId)
    expect(JSON.stringify(first)).not.toContain(revisionId)
  })
  it("retains arbitrary valid JSON metadata map keys", async () => {
    const metadata = { "client-defined": { "nested-key": "value" } }
    await env.DB.prepare("UPDATE revision_pages SET metadata_json = ? WHERE revision_id = ? AND page_id = ?").bind(JSON.stringify(metadata), revisionId, pageId).run()
    expect(await listCatalogue(env.DB, (await configs()).read, "anonymous", { after: null, limit: 10 })).toMatchObject([{ pageId, metadata }])
  })
})
