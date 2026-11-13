/* Roxabi routing and safeNext provenance: functions/_middleware.ts and functions/_lib/share-unfurl.ts, revision 9c7dda4fd6427dde7da5f474a4519fffefe3ba6a (MIT). */
import { describe, expect, it } from "vitest"
import { parseRequest, safeNext } from "../../domains/catalogue/routing/grammar"
import { configs } from "./fixtures/catalogue"

describe("route grammar and redirect boundaries", () => {
  it("checks host and method before any claimed route", async () => {
    const { read } = await configs()
    expect(parseRequest(new Request("https://other.example.test/login", { method: "POST" }), read).parsed).toMatchObject({ kind: "deny", status: 403, reason: "host" })
    expect(parseRequest(new Request("https://forge.example.test/login", { method: "POST" }), read).parsed).toMatchObject({ kind: "deny", status: 405, reason: "method" })
    expect(parseRequest(new Request("https://alias.example.test/login"), read).parsed).toMatchObject({ kind: "shell", path: "/login" })
  })
  it.each(["/manifest.json", "/asset-owners.json", "/registry/secret", "/api/admin"]) ("denies internal path %s", async (path) => {
    expect(parseRequest(new Request(`https://forge.example.test${path}`), (await configs()).read).parsed).toMatchObject({ kind: "deny", status: 404, reason: "internal" })
  })
  it.each(["/a/sample/%2fsecret", "/s/sample/validkey/file%2Ehtml", "/a/sample/a%5cb", "/a/sample//file"]) ("denies malformed path %s", async (path) => {
    expect(parseRequest(new Request(`https://forge.example.test${path}`), (await configs()).read).parsed).toMatchObject({ kind: "deny", status: 404, reason: "malformed" })
  })
  it("confines a share to the normalized slug and does not recover erased dot segments", async () => {
    const request = new Request("https://forge.example.test/s/sample/oldkey123/%2e%2e/newkey123")
    expect(new URL(request.url).pathname).toBe("/s/sample/newkey123")
    expect(parseRequest(request, (await configs()).read).parsed).toMatchObject({
      kind: "share", grammar: "slug", route: { kind: "subtree", slug: "sample" },
      key: "newkey123", candidates: ["/a/sample/index.html"],
    })
  })
  it.each(["https://evil.test/", "//evil.test/", "/\\evil.test/", "/a/../admin", "/login", "/login.html?next=/a"]) ("safeNext rejects %s", (next) => {
    expect(safeNext(next, "https://forge.example.test")).toBe("/")
  })
  it("keeps local query and fragment in a safe next", () => {
    expect(safeNext("/a/sample/?view=1#section", "https://forge.example.test")).toBe("/a/sample/?view=1#section")
  })
  it("parses page-key shares before slug shares and preserves the browser indication", async () => {
    const read = (await configs()).read
    const request = new Request("https://forge.example.test/s/folder/page.html/abc12345", { headers: { "Sec-Fetch-Dest": "document" } })
    expect(parseRequest(request, read).parsed).toMatchObject({ kind: "share", grammar: "page", route: { kind: "tree_page", pageRef: "folder/page.html" }, key: "abc12345", browser: true })
    expect(parseRequest(new Request("https://forge.example.test/s/sample/abc12345/index.html"), read).parsed).toMatchObject({ kind: "share", grammar: "slug", route: { kind: "subtree", slug: "sample" }, candidates: ["/a/sample/index.html"] })
    expect(parseRequest(new Request("https://forge.example.test/s/sample/?k=abc12345"), read).parsed).toMatchObject({ kind: "share", grammar: "slug", key: "abc12345" })
  })
  it("parses a share cookie only when page and key are valid", async () => {
    const read = (await configs()).read
    const valid = new Request("https://forge.example.test/folder/page", { headers: { Cookie: `forge_share=${encodeURIComponent("folder/page.html|abc12345")}` } })
    expect(parseRequest(valid, read).credentials.shareCookie).toEqual({ pageRef: "folder/page.html", key: "abc12345" })
    const invalid = new Request("https://forge.example.test/folder/page", { headers: { Cookie: `forge_share=${encodeURIComponent("../page.html|abc12345")}` } })
    expect(parseRequest(invalid, read).credentials.shareCookie).toBeNull()
  })
})
