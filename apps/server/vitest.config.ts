import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
import { SOURCE_EXCLUDE, SOURCE_SRC } from "./source-scope.mjs";

export default defineConfig({
  resolve: {
    alias: {
      "~": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  test: {
    include: ["src/**/*.test.ts"],
    exclude: ["src/**/*.acceptance.test.ts"],
    clearMocks: true,
    environment: "node",
    pool: "forks",
    fileParallelism: false,
    testTimeout: 15_000,
    hookTimeout: 30_000,
    coverage: {
      provider: "istanbul",
      enabled: true,
      all: true,
      reporter: ["text"],
      include: SOURCE_SRC.map((sourceDir) => `${sourceDir}/**/*.ts`),
      exclude: [...SOURCE_EXCLUDE],
      thresholds: {
        branches: 80,
        functions: 75,
        lines: 85,
        statements: 85,
      },
    },
  },
});
