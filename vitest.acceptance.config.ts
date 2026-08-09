import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
import { SOURCE_EXCLUDE, SOURCE_SRC } from "./source-scope.mjs";

const acceptanceExclude = [
  ...SOURCE_EXCLUDE,
  // Acceptance runs with disabled telemetry; enabled SDK behavior has its own integration suite.
  "src/shell/observability/envelope-recorder.ts",
  "src/shell/observability/sentry-adapter.ts",
  "src/shell/observability/sentry-live.ts",
  "src/shell/observability/telemetry-bootstrap.ts",
  "src/shell/observability/telemetry-config.ts",
];

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
      exclude: acceptanceExclude,
      thresholds: {
        autoUpdate: true,
        branches: 30.74,
        lines: 66,
      },
    },
  },
});
