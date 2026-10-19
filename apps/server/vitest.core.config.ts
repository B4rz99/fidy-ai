import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
import { CORE_EXCLUDE, CORE_SRC } from "./source-scope.mjs";

export default defineConfig({
  resolve: {
    alias: {
      "~": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  test: {
    include: ["src/core/**/*.test.ts"],
    clearMocks: true,
    environment: "node",
    pool: "forks",
    // Core tests have no platform state or module mocks; reuse imports within each worker.
    isolate: false,
    coverage: {
      provider: "istanbul",
      enabled: true,
      all: true,
      reportsDirectory: "coverage",
      reporter: ["text", "json"],
      include: CORE_SRC.map((sourceDir) => `${sourceDir}/**/*.ts`),
      exclude: [...CORE_EXCLUDE],
      thresholds: {
        lines: 90,
      },
    },
  },
});
