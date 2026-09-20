import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
import { ServerTestSequencer } from "../../scripts/ci/server-test-sequencer";
import { SOURCE_EXCLUDE, SOURCE_SRC } from "./source-scope.mjs";
import { SLOW_SERVER_TEST_FILES } from "./slow-test-files";

// CI shards the database-backed shell suite across isolated runners using prior
// file timings instead of Vitest's equal-file-count hash ranges. Each shard instruments
// the repository source scope so integration coverage of core decisions is retained.
// The Quality job merges those reports with the core tier's artifact before enforcing
// repository-wide totals and per-function CRAP scores.
export default defineConfig({
  resolve: {
    alias: {
      "~": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  test: {
    include: ["src/shell/**/*.test.ts"],
    exclude: ["src/**/*.acceptance.test.ts", ...SLOW_SERVER_TEST_FILES],
    // Keep Vitest 5's test isolation explicit; suites must not inherit mock history, and every
    // asynchronous assertion must be awaited so failures remain attached to their test.
    clearMocks: true,
    globalSetup: ["./tools/vitest-global-setup-runtime.ts"],
    environment: "node",
    pool: "forks",
    fileParallelism: false,
    sequence: { sequencer: ServerTestSequencer },
    testTimeout: 15_000,
    hookTimeout: 30_000,
    reporters: [
      "default",
      [
        "junit",
        {
          // CI uploads this project-relative path from apps/server.
          outputFile: "reports/server-tests.xml",
          includeConsoleOutput: false,
          addFileAttribute: true,
        },
      ],
    ],
    coverage: {
      provider: "istanbul",
      enabled: true,
      all: true,
      reportsDirectory: "coverage",
      reporter: ["json"],
      // Vitest 5 resolves these globs from the apps/server project root. The JSON reporter writes
      // coverage/coverage-final.json there, matching the CI artifact path exactly.
      include: SOURCE_SRC.map((sourceDir) => `${sourceDir}/**/*.ts`),
      exclude: [...SOURCE_EXCLUDE],
    },
  },
});
