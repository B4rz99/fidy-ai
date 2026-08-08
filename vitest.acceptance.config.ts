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
      // Baselined in #120, re-recorded in #124 for the metadata-only Telemetry seam (#106) and
      // again here for the out-of-span failure fix. No scenario regressed either time: both only
      // add shell branches the WhatsApp path never reaches, enlarging the denominator this ratio is
      // taken over. Vitest raises these values when coverage improves; CI then requires the updated
      // config to be committed, while any later decrease fails the threshold check — so a drop is
      // only ever recorded here deliberately, with the reason.
      //
      // Lowered in #133, the one deliberate drop so far: partializing payloads once deletes a
      // ternary the WhatsApp path only ever took one side of, so that branch pair and its line
      // leave both halves of the ratio. Statements (58.57) and functions (42.31) are unchanged
      // either side of the fix, which is what says no scenario lost coverage — only arithmetic
      // moved. Measured against a real PostgreSQL, not copied from a CI log.
      thresholds: {
        autoUpdate: true,
        branches: 26.34,
        lines: 60.56,
      },
    },
  },
});
