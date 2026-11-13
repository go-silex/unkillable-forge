import { env } from "cloudflare:workers"
import { applyD1Migrations, reset } from "cloudflare:test"
import { beforeEach } from "vitest"

// The plugin isolates storage per file, not per test.
beforeEach(async () => {
  await reset()
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS)
})
