import { readFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it, vi } from "vitest"
import type { ForgeEnv } from "@functions/_lib/access"
import {
  enforceMutationGuard,
  mutationOriginAllowed,
  requiresJsonBody,
} from "@functions/_lib/csrf"
import { mockKv } from "./helpers/kv"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")

function forgeEnv(overrides: Partial<ForgeEnv> = {}): ForgeEnv {
  return {
    SHARES: mockKv(),
    ASSETS: { fetch: vi.fn() } as unknown as Fetcher,
    PUBLIC_HOST: "forge.example.com",
    ...overrides,
  }
}

describe("enforceMutationGuard (runtime module)", () => {
  const env = forgeEnv()

  it("allows POST with canonical Origin and JSON Content-Type", async () => {
    const req = new Request("https://forge.example.com/api/visibility", {
      method: "POST",
      headers: {
        Origin: "https://forge.example.com",
        "Content-Type": "application/json",
      },
      body: "{}",
    })
    expect(requiresJsonBody(req)).toBe(true)
    expect(mutationOriginAllowed(req, env)).toBe(true)
    expect(enforceMutationGuard(req, env)).toBeNull()
  })

  it("rejects missing Origin and Referer", async () => {
    const req = new Request("https://forge.example.com/api/visibility", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    })
    const blocked = enforceMutationGuard(req, env)
    expect(blocked?.status).toBe(403)
    expect(await blocked?.json()).toEqual({ error: "csrf_origin" })
  })

  it("rejects cross-origin Origin", async () => {
    const req = new Request("https://forge.example.com/api/visibility", {
      method: "POST",
      headers: {
        Origin: "https://evil.example.com",
        "Content-Type": "application/json",
      },
      body: "{}",
    })
    const blocked = enforceMutationGuard(req, env)
    expect(blocked?.status).toBe(403)
    expect(await blocked?.json()).toEqual({ error: "csrf_origin" })
  })

  it("rejects non-JSON Content-Type", async () => {
    const req = new Request("https://forge.example.com/api/visibility", {
      method: "POST",
      headers: {
        Origin: "https://forge.example.com",
        "Content-Type": "text/plain",
      },
      body: "slug=x",
    })
    const blocked = enforceMutationGuard(req, env)
    expect(blocked?.status).toBe(415)
    expect(await blocked?.json()).toEqual({ error: "invalid_content_type" })
  })

  it("accepts Referer when Origin is absent", async () => {
    const req = new Request("https://forge.example.com/api/visibility", {
      method: "POST",
      headers: {
        Referer: "https://forge.example.com/a/demo-deck/",
        "Content-Type": "application/json",
      },
      body: "{}",
    })
    expect(enforceMutationGuard(req, env)).toBeNull()
  })
})

describe("CSRF wired in mutation routes", () => {
  const routes = [
    "functions/api/visibility.ts",
    "functions/api/share.ts",
  ] as const

  for (const rel of routes) {
    it(`${rel} imports and calls enforceMutationGuard`, async () => {
      const src = await readFile(path.join(root, rel), "utf8")
      expect(src).toMatch(
        /import\s*\{[^}]*enforceMutationGuard[^}]*\}\s*from\s*["']\.\.\/_lib\/csrf["']/,
      )
      expect(src).toMatch(/enforceMutationGuard\s*\(/)
    })
  }
})
