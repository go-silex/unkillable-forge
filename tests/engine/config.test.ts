import { env } from "cloudflare:workers"
import { describe, expect, it } from "vitest"
import { parseManageConfig, parseReadConfig } from "../../domains/catalogue/instance-config"

const valid = {
  instanceId: "test-forge", canonicalHost: "forge.example.test", aliasHosts: ["alias.example.test"], manageHost: "manage.example.test",
  accessTeamDomain: "team.cloudflareaccess.com", readAudiences: ["read"], manageAudiences: ["manage"], login: "serve-shell",
  routeGrammars: ["tree", "subtree"], shareGrammars: ["page", "card", "slug"], shareCookie: true, shellPaths: ["/", "/login"],
}
const key = btoa(String.fromCharCode(...new Uint8Array(32).fill(4))).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_")
function bindings(instance: unknown = valid) {
  return { DB: env.DB, FORGE_INSTANCE: JSON.stringify(instance), FORGE_SHARE_VERIFIER_KEYS: JSON.stringify([{ kid: "current", key }]) }
}

describe("instance config fails closed on either surface", () => {
  it("parses both surfaces without exposing the other surface's fields", async () => {
    const read = await parseReadConfig(bindings())
    const manage = await parseManageConfig(bindings())
    expect(read.ok).toBe(true)
    expect(manage.ok).toBe(true)
    if (read.ok && manage.ok) {
      expect(read.config).not.toHaveProperty("manageAudiences")
      expect(read.config).not.toHaveProperty("shareSealKey")
      expect(manage.config).not.toHaveProperty("readAudiences")
      expect(manage.config).not.toHaveProperty("login")
    }
  })
  it.each([
    ["instance identifier", { instanceId: "Bad" }],
    ["canonical host", { canonicalHost: "https://forge.example.test" }],
    ["preview host", { canonicalHost: "site.pages.dev" }],
    ["canonical alias collision", { aliasHosts: ["forge.example.test"] }],
    ["manage host collision", { manageHost: "alias.example.test" }],
    ["team domain", { accessTeamDomain: "elsewhere.example.test" }],
    ["empty read audience", { readAudiences: [] }],
    ["empty manage audience", { manageAudiences: [] }],
    ["overlapping audiences", { manageAudiences: ["read"] }],
    ["unknown route grammar", { routeGrammars: ["other"] }],
    ["duplicate grammar", { routeGrammars: ["tree", "tree"] }],
    ["page share without tree", { routeGrammars: ["subtree"] }],
    ["slug share without subtree", { routeGrammars: ["tree"], shareCookie: false, shareGrammars: ["slug"] }],
    ["cookie without page sharing", { shareGrammars: ["slug"] }],
    ["missing login shell", { shellPaths: ["/"] }],
    ["reserved shell", { shellPaths: ["/login", "/api/admin"] }],
    ["invalid login", { login: "unknown" }],
  ])("rejects %s in both parsers", async (_name, override) => {
    const input = bindings({ ...valid, ...override })
    expect((await parseReadConfig(input)).ok).toBe(false)
    expect((await parseManageConfig(input)).ok).toBe(false)
  })
  it("rejects missing bindings, malformed JSON, weak verifier keys and read-bound seal material", async () => {
    expect((await parseReadConfig({})).ok).toBe(false)
    expect((await parseReadConfig({ ...bindings(), FORGE_INSTANCE: "{" })).ok).toBe(false)
    expect((await parseManageConfig({ ...bindings(), FORGE_SHARE_VERIFIER_KEYS: JSON.stringify([{ kid: "bad!", key }]) })).ok).toBe(false)
    expect((await parseManageConfig({ ...bindings(), FORGE_SHARE_VERIFIER_KEYS: JSON.stringify([{ kid: "one", key: "eA" }]) })).ok).toBe(false)
    expect((await parseReadConfig({ ...bindings(), FORGE_SHARE_SEAL_KEY: JSON.stringify({ kid: "seal", key }) })).ok).toBe(false)
  })
})
