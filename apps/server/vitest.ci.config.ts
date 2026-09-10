import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
import { ServerTestSequencer } from "../../scripts/ci/server-test-sequencer";
import { SOURCE_EXCLUDE, SOURCE_SRC } from "./source-scope.mjs";

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
    exclude: ["src/**/*.acceptance.test.ts"],
    globalSetup: ["./tools/vitest-global-setup.ts"],
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
      reporter: ["json"],
      include: SOURCE_SRC.map((sourceDir) => `${sourceDir}/**/*.ts`),
      exclude: [...SOURCE_EXCLUDE],
    },
  },
});
