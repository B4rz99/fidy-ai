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
      // Lowered in #133: partializing payloads once deleted a ternary the WhatsApp path only ever
      // took one side of, so that branch pair and its line left both halves of the ratio.
      //
      // Lowered again in #141 because the process-boot logging and listener configuration module is
      // deliberately outside the public-channel acceptance seam. Its dedicated tests cover the
      // environment choices and invalid-port failure; adding it only enlarges this denominator.
      //
      // Lowered in #140 because transaction-failure discrimination adds database-shell branches
      // that the WhatsApp acceptance path does not reach; focused database tests cover both paths.
      //
      // Lowered in #149 because request-scoped caller resolution and API recovery metadata add
      // shell branches outside the WhatsApp acceptance seam; focused API tests cover those paths.
      // Raised in #151 because WhatsApp acceptance now exercises mixed assistant context replay.
      // Lowered in #152 because retry policy and the production Sentry adapter add branches outside
      // the WhatsApp release seam; focused Agent and observability tests cover those paths.
      thresholds: {
        autoUpdate: true,
        branches: 28.04,
        lines: 61.81,
      },
    },
  },
});
