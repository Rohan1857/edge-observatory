import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [cloudflareTest({ wrangler: { configPath: "apps/worker/wrangler.test.jsonc" }, miniflare: {
    bindings: { TEST_MIGRATIONS: await readD1Migrations("apps/worker/migrations") },
  } })],
  test: { include: ["apps/worker/integration/**/*.test.ts"], fileParallelism: false },
});
