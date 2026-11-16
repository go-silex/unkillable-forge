import path from "node:path"
import { fileURLToPath } from "node:url"
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin"
import { defineConfig } from "vitest/config"
import { manageHttpBindings } from "./tests/engine/fixtures/manage-http-bindings.ts"
import { createNativeJwksFixture } from "./tests/engine/setup/native-jwks-outbound.ts"

const root = path.dirname(fileURLToPath(import.meta.url))
const nativeJwks = createNativeJwksFixture()

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
            compatibilityFlags: ["unhandled_rejection_after_microtask_checkpoint"],
            d1Databases: ["DB", "EMPTY_DB"],
            r2Buckets: ["REVISION_BYTES"],
            bindings: { TEST_MIGRATIONS: await readD1Migrations(path.join(root, "migrations")) },
          },
        }))],
        test: {
          name: "engine",
          include: ["tests/engine/**/*.test.ts"],
          exclude: ["tests/engine/manage-http.*.test.ts", "tests/engine/manage-web.*.test.ts", "tests/engine/native-jwks.test.ts"],
          setupFiles: ["tests/engine/setup/apply-migrations.ts"],
          globals: true,
        },
      },
      {
        plugins: [cloudflareTest(async () => ({
          main: "./adapters/http/manageWorker.ts",
          config: false,
          remoteBindings: false,
          miniflare: {
            compatibilityDate: "2025-02-14",
            compatibilityFlags: ["enable_request_signal", "unhandled_rejection_after_microtask_checkpoint"],
            d1Databases: ["DB", "EMPTY_DB", "OTHER_DB"],
            r2Buckets: ["REVISION_BYTES"],
            bindings: {
              ...manageHttpBindings,
              TEST_MIGRATIONS: await readD1Migrations(path.join(root, "migrations")),
            },
          },
        }))],
        test: {
          name: "manage-http",
          include: ["tests/engine/manage-http.*.test.ts", "tests/engine/manage-web.*.test.ts"],
          setupFiles: ["tests/engine/setup/apply-migrations.ts"],
          globals: true,
        },
      },
      {
        plugins: [cloudflareTest(async () => ({
          main: "./adapters/http/manageWorker.ts",
          config: false,
          remoteBindings: false,
          miniflare: {
            compatibilityDate: "2025-02-14",
            compatibilityFlags: ["enable_request_signal", "unhandled_rejection_after_microtask_checkpoint"],
            d1Databases: ["DB", "EMPTY_DB", "OTHER_DB"],
            r2Buckets: ["REVISION_BYTES"],
            serviceBindings: { NATIVE_JWKS_FIXTURE: nativeJwks.control },
            outboundService: nativeJwks.outbound,
            bindings: {
              ...manageHttpBindings,
              TEST_MIGRATIONS: await readD1Migrations(path.join(root, "migrations")),
            },
          },
        }))],
        test: {
          name: "native-jwks",
          include: ["tests/engine/native-jwks.test.ts"],
          setupFiles: ["tests/engine/setup/apply-migrations.ts"],
          globals: true,
        },
      },
    ],
  },
})
