import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
import { SOURCE_EXCLUDE, SOURCE_SRC } from "./source-scope.mjs";

// The WhatsApp acceptance release signal: public signed HTTP, real PostgreSQL, and the production
// coordination layers with only Kapso transport and language-model behavior substituted. It owns a
// separate coverage directory and never joins the unit/lower-seam integration run.
export default defineConfig({
  resolve: {
    alias: {
      "~": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  test: {
    include: ["src/**/*.acceptance.test.ts"],
    environment: "node",
    reporter: ["verbose"],
    pool: "forks",
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 60_000,
    coverage: {
      provider: "istanbul",
      enabled: true,
      all: true,
      reportsDirectory: "coverage/acceptance",
      reporter: ["text", "json-summary"],
      include: SOURCE_SRC.map((sourceDir) => `${sourceDir}/**/*.ts`),
      exclude: [...SOURCE_EXCLUDE],
      thresholds: {
        autoUpdate: true,
        branches: 29.86,
        lines: 63.35,
      },
    },
  },
});
