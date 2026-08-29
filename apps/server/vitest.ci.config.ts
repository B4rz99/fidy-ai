import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
import { SOURCE_EXCLUDE, SOURCE_SRC } from "./source-scope.mjs";

// CI shards the database-backed suite across isolated runners. Each shard emits
// raw Istanbul coverage; the Quality job merges every shard before enforcing
// repository-wide totals and per-function CRAP scores. A shard cannot enforce
// either aggregate gate on its partial view.
export default defineConfig({
  resolve: {
    alias: {
      "~": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  test: {
    include: ["src/**/*.test.ts"],
    exclude: ["src/**/*.acceptance.test.ts"],
    globalSetup: ["./tools/vitest-global-setup.ts"],
    environment: "node",
    pool: "forks",
    fileParallelism: false,
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
