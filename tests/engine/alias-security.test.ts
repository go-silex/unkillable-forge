import { env } from "cloudflare:workers"
import { beforeEach, describe, expect, it } from "vitest"
import { setAlias } from "../../domains/catalogue/commands"
import { resolveRead } from "../../domains/catalogue/resolve"
import { actor, artifactId, bootstrap, configs, jwks, pageFixture, pageId } from "./fixtures/catalogue"

beforeEach(async () => { await bootstrap(); await pageFixture() })

describe("alias destination and mutation boundaries", () => {
  it.each(["https://evil.example/", "//evil.example/", "/\\evil.example/", "/\t/evil.example/", "/%5cevil.example/", "/%2fevil.example/", "/%00evil.example/", "?", "#", "/a/sample?view=1", "/a/sample#fragment"])("rejects unsafe destination %s", async (to) => {
    const deps = { db: env.DB, config: (await configs()).manage, jwks, now: () => 10 }
    await expect(setAlias(deps, actor, { op: "put", kind: "redirect_exact", key: "/old", to, status: 302, targetPageId: pageId })).rejects.toMatchObject({ code: "invalid_state" })
    expect(await env.DB.prepare("SELECT count(*) AS n FROM routes WHERE route_key = '/old'").first()).toEqual({ n: 0 })
    await expect(env.DB.prepare("INSERT INTO routes (kind,route_key,redirect_to,redirect_status,created_at) VALUES ('redirect_exact','/old',?,302,1)").bind(to).run()).rejects.toThrow()
  })
  it("preserves a safe local destination and rejects a forged primary-route removal", async () => {
    const deps = { db: env.DB, config: (await configs()).manage, jwks, now: () => 10 }
    await setAlias(deps, actor, { op: "put", kind: "redirect_exact", key: "/old", to: "/a/sample/", status: 302, targetPageId: pageId })
    expect(await env.DB.prepare("SELECT redirect_to FROM routes WHERE kind = 'redirect_exact' AND route_key = '/old'").first()).toEqual({ redirect_to: "/a/sample/" })
    const forged = { op: "remove", kind: "subtree", key: "sample" } as unknown as Parameters<typeof setAlias>[2]
    await expect(setAlias(deps, actor, forged)).rejects.toMatchObject({ code: "invalid_state" })
    expect(await env.DB.prepare("SELECT page_id FROM routes WHERE kind = 'subtree' AND route_key = 'sample'").first()).toEqual({ page_id: pageId })
    expect(await env.DB.prepare("SELECT artifact_id FROM mounts WHERE path = '/a/sample/index.html'").first()).toEqual({ artifact_id: artifactId })
  })
  it("keeps observed anonymous exact, prefix-root and unknown-child aliases closed", async () => {
    const { manage, read } = await configs()
    const manageDeps = { db: env.DB, config: manage, jwks, now: () => 10 }
    await setAlias(manageDeps, actor, { op: "put", kind: "redirect_exact", key: "/legacy-file.html", to: "/docs/page", status: 301, targetPageId: pageId })
    await setAlias(manageDeps, actor, { op: "put", kind: "redirect_prefix", key: "/legacy/", to: "/docs/", status: 308, targetPageId: pageId })
    const readDeps = { db: env.DB, config: { ...read, routeGrammars: ["subtree"] as const }, jwks, nowSeconds: () => 1 }
    for (const path of ["/legacy-file.html", "/legacy/", "/legacy/unknown-child"]) {
      expect(await resolveRead(new Request(`https://forge.example.test${path}`), readDeps)).toMatchObject({ kind: "deny", status: 404 })
    }
    const treeDeps = { ...readDeps, config: read }
    expect(await resolveRead(new Request("https://forge.example.test/legacy/"), treeDeps)).toMatchObject({ kind: "login" })
    expect(await resolveRead(new Request("https://forge.example.test/unclaimed/"), treeDeps)).toMatchObject({ kind: "login" })
  })
})
