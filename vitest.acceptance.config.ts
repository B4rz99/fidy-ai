import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
import { SOURCE_EXCLUDE, SOURCE_SRC } from "./source-scope.mjs";

const acceptanceExclude = [
  ...SOURCE_EXCLUDE,
  // Acceptance runs with disabled telemetry; enabled SDK behavior has its own integration suite.
  // Sentry account verification and smoke tooling is outside WhatsApp acceptance scope.
  "src/shell/observability/account-policy.ts",
  "src/shell/observability/canonical-api.ts",
  "src/shell/observability/deployment-smoke-command.ts",
  "src/shell/observability/deployment-smoke-gate.ts",
  "src/shell/observability/deployment-smoke.ts",
  "src/shell/observability/sentry-account-reader.ts",
  "src/shell/observability/sentry-account-smoke.ts",
  "src/shell/observability/envelope-recorder.ts",
  "src/shell/observability/projectors.ts",
  "src/shell/observability/scheduled-work.ts",
  "src/shell/observability/sentry-adapter.ts",
  "src/shell/observability/sentry-live.ts",
  "src/shell/observability/sentry-smoke-reader.ts",
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
        branches: 37.99,
        lines: 69.81,
      },
    },
  },
});
