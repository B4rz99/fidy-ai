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
      // Initial #120 baseline, re-recorded in #124 when the metadata-only Telemetry seam (#106)
      // entered the shared source scope of source-scope.mjs. No scenario regressed: the seam is a
      // shell capability nothing on the WhatsApp path constructs yet, so it only enlarges the
      // denominator this ratio is taken over. Vitest raises these values when coverage improves;
      // CI then requires the updated config to be committed, while any later decrease fails the
      // threshold check — so a drop is only ever recorded here deliberately, with the reason.
      thresholds: {
        autoUpdate: true,
        branches: 26.23,
        lines: 60.35,
      },
    },
  },
});
