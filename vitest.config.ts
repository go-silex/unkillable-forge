import path from "node:path"
import { fileURLToPath } from "node:url"
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin"
import { defineConfig } from "vitest/config"

const root = path.dirname(fileURLToPath(import.meta.url))

export default defineConfig({
  test: {
    projects: [
      {
        resolve: { alias: { "@functions": path.join(root, "functions") } },
        test: {
          name: "legacy",
          environment: "node",
          include: ["tests/*.test.ts"],
          globals: true,
        },
      },
      {
        plugins: [cloudflareTest(async () => ({
          miniflare: {
            compatibilityDate: "2025-02-14",
            d1Databases: ["DB", "EMPTY_DB"],
            bindings: { TEST_MIGRATIONS: await readD1Migrations(path.join(root, "migrations")) },
          },
        }))],
        test: {
          name: "engine",
          include: ["tests/engine/**/*.test.ts"],
          setupFiles: ["tests/engine/setup/apply-migrations.ts"],
          globals: true,
        },
      },
    ],
  },
})
