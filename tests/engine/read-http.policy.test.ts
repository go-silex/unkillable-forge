import { env } from "cloudflare:workers"
import { beforeEach, describe, expect, it } from "vitest"
import { handleRead } from "../../adapters/http/readWorker"
import { importShare, setVisibility } from "../../domains/catalogue/commands"
import { PublicationService } from "../../domains/publication"
import { RevisionStore } from "../../domains/store/revision-store"
import { actor, bootstrap, configs, instanceId, jwks, manageRequest } from "./fixtures/catalogue"
import { body, content, documentCommand, observeD1, publishDocument } from "./fixtures/publication"

beforeEach(async () => { await bootstrap() })

async function setup() {
  const config = await configs()
  const store = new RevisionStore(env.REVISION_BYTES, instanceId)
  const publication = new PublicationService({ db: env.DB, config: config.manage, jwks, now: () => 10_000, store, publication: { sessionTtlMs: 60_000, maxUploadTimeoutMs: 1000, retainMs: 900_000, marginMs: 1000, manageClockSkewMs: 0, readClockSkewMs: 0 } })
  const management = { db: env.DB, config: config.manage, jwks, now: () => 10_000 }
  const request = (path: string, init?: RequestInit) => handleRead(new Request(`https://forge.example.test${path}`, init), { db: env.DB, config: config.read, jwks, nowSeconds: () => 100, store })
  return { publication, management, request }
}

describe("read HTTP policy and representation semantics", () => {
  it("does not disclose private catalogue entries to a signed read identity expired within verification skew", async () => {
    const s = await setup()
    const privatePage = await documentCommand("policy-private", "/a/private-policy/index.html", "private")
    await publishDocument(s.publication, actor, privatePage.command, privatePage.bytes)
    const publicPage = await documentCommand("policy-public", "/a/public-policy/index.html", "public")
    const published = await publishDocument(s.publication, actor, publicPage.command, publicPage.bytes)
    await setVisibility(s.management, actor, { pageId: publicPage.pageId, artifactId: published.receipt.artifactId, expectedPolicyEpoch: 0, visibility: "public" })

    const catalogue = async (expiry: number) => {
      const signed = await manageRequest("reader", "reader", expiry)
      const response = await s.request("/api/catalogue", { headers: { "Cf-Access-Jwt-Assertion": signed.headers.get("Cf-Access-Jwt-Assertion")! } })
      expect(response.status).toBe(200)
      return await response.json() as { pageId: string }[]
    }
    const valid = await catalogue(101)
    expect(valid.map(entry => entry.pageId)).toContain(privatePage.pageId)
    expect(valid.map(entry => entry.pageId)).toContain(publicPage.pageId)
    for (const expiry of [100, 90]) {
      const expired = await catalogue(expiry)
      expect(expired.map(entry => entry.pageId)).toContain(publicPage.pageId)
      expect(expired.map(entry => entry.pageId)).not.toContain(privatePage.pageId)
    }
  })

  it("sets robots restrictions on keyed shares and not-found responses", async () => {
    const s = await setup()
    const page = await documentCommand("policy-share", "/a/robots/index.html", "<p>shared document</p>")
    const published = await publishDocument(s.publication, actor, page.command, page.bytes)
    await importShare(s.management, actor, { pageId: page.pageId, artifactId: published.receipt.artifactId, expectedPolicyEpoch: 0, key: "historical_123", mode: "follow_active" })
    const shared = await s.request("/s/robots/historical_123/")
    expect(shared.status).toBe(200)
    expect(await shared.text()).toContain("shared document")
    expect(shared.headers.get("x-robots-tag")).toMatch(/noindex/i)
    expect(shared.headers.get("x-robots-tag")).toMatch(/nofollow/i)
    expect(shared.headers.get("x-robots-tag")).toMatch(/noarchive/i)
    for (const path of ["/s/robots/incorrect_key/", "/manifest.json"]) {
      const missing = await s.request(path)
      expect(missing.status).toBe(404)
      expect(missing.headers.get("x-robots-tag")).toMatch(/noindex/i)
      expect(missing.headers.get("x-robots-tag")).toMatch(/nofollow/i)
    }
    const anonymous = await s.request("/a/nonexistent-policy/")
    expect(anonymous.status).toBe(302)
  })

  it("sets robots restrictions on anonymous public pin-namespace reads without marking the canonical URL", async () => {
    const s = await setup()
    const page = await documentCommand("policy-pin-robots", "/a/pin-robots/index.html", "<p>pinned public</p>")
    const published = await publishDocument(s.publication, actor, page.command, page.bytes)
    await setVisibility(s.management, actor, { pageId: page.pageId, artifactId: published.receipt.artifactId, expectedPolicyEpoch: 0, visibility: "public" })
    const pinPath = `/_revisions/${page.pageId}/${published.receipt.revisionId}/a/pin-robots/index.html`
    const pinned = await s.request(pinPath)
    expect(pinned.status).toBe(200)
    expect(await pinned.text()).toContain("pinned public")
    expect(pinned.headers.get("x-robots-tag")).toBe("noindex, nofollow, noarchive")
    const canonical = await s.request("/a/pin-robots/")
    expect(canonical.status).toBe(200)
    expect(canonical.headers.get("x-robots-tag")).toBeNull()
    const canonicalRedirect = await s.request("/a/pin-robots/index.html")
    expect(canonicalRedirect.status).toBe(308)
    expect(canonicalRedirect.headers.get("location")).toBe("/a/pin-robots/")
    expect(canonicalRedirect.headers.get("x-robots-tag")).toBeNull()
  })

  it("applies the full unlisted robots tag to every pinned-namespace status", async () => {
    const s = await setup()
    const page = await documentCommand("policy-pin-status", "/a/pin-status/index.html", "<p>pin status</p>")
    const published = await publishDocument(s.publication, actor, page.command, page.bytes)
    await setVisibility(s.management, actor, { pageId: page.pageId, artifactId: published.receipt.artifactId, expectedPolicyEpoch: 0, visibility: "public" })
    const prefix = `/_revisions/${page.pageId}/${published.receipt.revisionId}`
    const missing = await s.request(`${prefix}/a/pin-status/missing.bin`)
    expect(missing.status).toBe(404)
    expect(missing.headers.get("x-robots-tag")).toBe("noindex, nofollow, noarchive")
    const method = await s.request(`${prefix}/a/pin-status/index.html`, { method: "POST" })
    expect(method.status).toBe(405)
    expect(method.headers.get("allow")).toBe("GET, HEAD")
    expect(method.headers.get("x-robots-tag")).toBe("noindex, nofollow, noarchive")
    const config = await configs()
    const store = new RevisionStore(env.REVISION_BYTES, instanceId)
    const empty = await handleRead(new Request(`https://forge.example.test${prefix}/a/pin-status/index.html`), {
      db: env.EMPTY_DB, config: config.read, jwks, nowSeconds: () => 100, store,
    })
    expect(empty.status).toBe(503)
    expect(empty.headers.get("x-robots-tag")).toBe("noindex, nofollow, noarchive")
    const derived = await s.request(`${prefix}/_derived/original?path=/missing.png`)
    expect(derived.status).toBe(404)
    expect(derived.headers.get("x-robots-tag")).toBe("noindex, nofollow, noarchive")
  })

  it("applies ranges to GET but ignores them for HEAD, including unsatisfiable ranges", async () => {
    const s = await setup()
    const path = "/a/ranges/data.bin"
    const page = await documentCommand("policy-range", "/a/ranges/index.html", "<p>ranges</p>")
    const asset = await content("0123456789")
    const command = { ...page.command, files: [...page.command.files, { path, kind: "asset" as const, size: asset.size, sha256: asset.sha256, contentType: "application/octet-stream", source: "client" as const }], edges: [{ ownerPageId: page.pageId, path, providerArtifactId: null }] }
    const session = await s.publication.begin(actor, command)
    await s.publication.upload(actor, session.sessionId, command.files[0].path, body(page.bytes))
    await s.publication.upload(actor, session.sessionId, path, body(asset.bytes))
    await s.publication.seal(actor, session.sessionId)
    const receipt = await s.publication.commit(actor, session.sessionId)
    await setVisibility(s.management, actor, { pageId: page.pageId, artifactId: receipt.artifactId, expectedPolicyEpoch: 0, visibility: "public" })

    const partial = await s.request(path, { headers: { Range: "bytes=2-5" } })
    expect(partial.status).toBe(206)
    expect(partial.headers.get("content-range")).toBe("bytes 2-5/10")
    expect(partial.headers.get("content-length")).toBe("4")
    expect(new Uint8Array(await partial.arrayBuffer())).toEqual(asset.bytes.slice(2, 6))
    const unsatisfiable = await s.request(path, { headers: { Range: "bytes=20-25" } })
    expect(unsatisfiable.status).toBe(416)
    expect(unsatisfiable.headers.get("content-range")).toBe("bytes */10")
    const full = await s.request(path, { headers: { Range: "bytes=2-5", "If-Range": '"different"' } })
    expect(full.status).toBe(200)
    expect(full.headers.get("content-length")).toBe("10")
    expect(full.headers.get("content-range")).toBeNull()
    expect(new Uint8Array(await full.arrayBuffer())).toEqual(asset.bytes)
    for (const range of ["bytes=2-5", "bytes=20-25"]) {
      const head = await s.request(path, { method: "HEAD", headers: { Range: range } })
      expect(head.status).toBe(200)
      expect(head.headers.get("content-length")).toBe("10")
      expect(head.headers.get("content-range")).toBeNull()
      expect(await head.text()).toBe("")
    }
  })
  it("advertises read methods on POST without querying D1 or Store", async () => {
    const config = await configs()
    const observed = observeD1(env.DB)
    const actualStore = new RevisionStore(env.REVISION_BYTES, instanceId)
    let storeCalls = 0
    const store = new Proxy(actualStore, {
      get(target, property, receiver) {
        if (property === "head" || property === "get") return (...args: unknown[]) => {
          storeCalls++
          return Reflect.apply(Reflect.get(target, property), target, args)
        }
        return Reflect.get(target, property, receiver)
      },
    })
    const response = await handleRead(new Request("https://forge.example.test/api/catalogue", { method: "POST" }), { db: observed.db, config: config.read, jwks, nowSeconds: () => 100, store })
    expect(response.status).toBe(405)
    expect(response.headers.get("allow")?.split(/\s*,\s*/).sort()).toEqual(["GET", "HEAD"])
    expect(observed.calls()).toBe(0)
    expect(storeCalls).toBe(0)
    await response.arrayBuffer()
  })
})
