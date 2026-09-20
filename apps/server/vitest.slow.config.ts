import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
import { SOURCE_EXCLUDE, SOURCE_SRC } from "./source-scope.mjs";
import { SLOW_SERVER_TEST_FILES } from "./slow-test-files";

// Durable-runtime loss, restart, and live transport scenarios intentionally use real process time.
// They run together outside the fast shards so CI load cannot consume a unit-sized outer budget.
export default defineConfig({
  resolve: {
    alias: {
      "~": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  test: {
    include: [...SLOW_SERVER_TEST_FILES],
    globalSetup: ["./tools/vitest-global-setup-runtime.ts"],
    environment: "node",
    pool: "forks",
    fileParallelism: false,
    testTimeout: 45_000,
    hookTimeout: 60_000,
    reporters: [
      "default",
      [
        "junit",
        {
          outputFile: "reports/server-slow-tests.xml",
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
