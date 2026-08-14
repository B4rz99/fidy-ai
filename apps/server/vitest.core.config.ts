import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
import { CORE_EXCLUDE, CORE_SRC } from "./source-scope.mjs";

// The core tier (ARCHITECTURE.md §8): everything under src/core is a pure
// decision, so this run needs no Docker and no DATABASE_URL. That is the whole
// point of the command — it is the fast loop, and a "core" test that quietly
// reaches for the world fails here instead of passing inside the full run.
//
// Standalone rather than a mergeConfig of vitest.config.ts: Vite's merge
// concatenates arrays, so the base `include` would drag the shell tests back in
// and the run would need a database again.
export default defineConfig({
  resolve: {
    // `~/*` → `./src/*`, mirroring tsconfig `paths`. See vitest.config.ts.
    alias: {
      "~": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  test: {
    include: ["src/core/**/*.test.ts"],
    environment: "node",
    pool: "forks",
    coverage: {
      // istanbul, not v8 — see vitest.config.ts for why.
      provider: "istanbul",
      enabled: true,
      all: true,
      reporter: ["text"],
      include: CORE_SRC.map((sourceDir) => `${sourceDir}/**/*.ts`),
      exclude: [...CORE_EXCLUDE],
      thresholds: {
        lines: 90,
      },
    },
  },
});
