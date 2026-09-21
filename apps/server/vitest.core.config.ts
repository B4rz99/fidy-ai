import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
import { CORE_EXCLUDE, CORE_SRC } from "./source-scope.mjs";

// The core tier (ARCHITECTURE.md §8): everything under src/core is a pure
// decision, so this run needs no platform bindings. That is the whole point of
// the command — it is the fast loop, and a "core" test that quietly reaches for the
// world fails here instead of passing inside the full run.
//
// Standalone rather than a mergeConfig of vitest.config.ts: Vite's merge
// concatenates arrays, so the base `include` would drag the shell tests back in
// and the run would require adapter bindings again.
export default defineConfig({
  resolve: {
    // `~/*` → `./src/*`, mirroring tsconfig `paths`. See vitest.config.ts.
    alias: {
      "~": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  test: {
    include: ["src/core/**/*.test.ts"],
    // Isolate mock call history explicitly rather than relying on Vitest 5's default.
    clearMocks: true,
    // Vitest 5's failure for unawaited asynchronous assertions is deliberate.
    environment: "node",
    pool: "forks",
    coverage: {
      // istanbul, not v8 — see vitest.config.ts for why.
      provider: "istanbul",
      enabled: true,
      all: true,
      reportsDirectory: "coverage",
      reporter: ["text", "json"],
      // Vitest 5 resolves coverage paths from apps/server; CI uploads the JSON reporter's
      // coverage/coverage-final.json from that same project root.
      include: CORE_SRC.map((sourceDir) => `${sourceDir}/**/*.ts`),
      exclude: [...CORE_EXCLUDE],
      thresholds: {
        lines: 90,
      },
    },
  },
});
