import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
import { SOURCE_EXCLUDE, SOURCE_SRC } from "./source-scope.mjs";

const acceptanceExclude = [
  ...SOURCE_EXCLUDE,
  // Acceptance runs with disabled telemetry; enabled SDK behavior has its own integration suite.
  // Sentry account verification is outside WhatsApp acceptance scope.
  "src/shell/observability/account-policy.ts",
  "src/shell/observability/canonical-api.ts",
  "src/shell/observability/sentry-account-reader.ts",
  "src/shell/observability/sentry-account-smoke.ts",
  "src/shell/observability/envelope-recorder.ts",
  "src/shell/observability/projectors.ts",
  "src/shell/observability/scheduled-work.ts",
  "src/shell/observability/sentry-adapter.ts",
  "src/shell/observability/sentry-live.ts",
  "src/shell/observability/telemetry-bootstrap.ts",
  "src/shell/observability/telemetry-config.ts",
  // Acceptance substitutes provider transport; exact OpenAI behavior is covered by adapter tests.
  "src/shell/agent/openai.ts",
  // Hosted Turn orchestration is covered by its real-PostgreSQL integration suite; acceptance
  // substitutes model behavior and validates the WhatsApp transport lifecycle.
  "src/shell/agent/agent-service.ts",
  // HostedInference capability ownership and prompt projection are lower model seams covered by
  // focused suites; acceptance supplies an ApiHarness implementation instead.
  "src/shell/agent/hosted-inference.ts",
  "src/shell/agent/model-boundary.ts",
  // Dashboard reads are not reachable from the WhatsApp channel acceptance surface.
  "src/core/dashboard/**",
  "src/shell/dashboard/**",
  // Transcript lifecycle persistence is covered against PostgreSQL at its public service seam.
  "src/shell/transcript/conversation-continuity.ts",
  // Memory's canonical API and aggregate policy are covered by their real-PostgreSQL integration
  // suite; they are not part of the WhatsApp transport release signal.
  "src/core/memory/**",
  "src/shell/memory/**",
  // Statement ingestion is not reachable from the WhatsApp channel acceptance surface.
  "src/core/ingestion/**",
  "src/shell/ingestion/**",
  // Exact-origin CORS belongs to the browser/API boundary and has focused HTTP-edge tests; the
  // WhatsApp webhook acceptance surface sends no browser Origin and does not own that policy.
  "src/shell/_shared/exact-origin-cors.ts",
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
        branches: 43.76,
        lines: 73.61,
      },
    },
  },
});
