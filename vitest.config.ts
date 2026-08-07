import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
import { SOURCE_EXCLUDE, SOURCE_SRC } from "./source-scope.mjs";

// The main run (`bun run test`, CI's Test job): the whole suite, gated on total
// line coverage. Its two siblings — vitest.core.config.ts and
// vitest.crap.config.ts — are standalone rather than derived from this file,
// and each states its own gate; the only thing all three share is the source
// scope in source-scope.mjs. Changing a runner setting here therefore does not
// reach them, which is the point: a gate you cannot see in the config that
// enforces it is a gate nobody can debug.
export default defineConfig({
  resolve: {
    // `~/*` → `./src/*`, mirroring tsconfig `paths`. tsc, Bun and oxlint's
    // resolver read tsconfig directly; Vite does not, so the alias has to be
    // restated here or aliased imports fail to resolve under vitest.
    alias: {
      "~": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  test: {
    include: ["src/**/*.test.ts"],
    exclude: ["src/**/*.acceptance.test.ts"],
    environment: "node",
    pool: "forks",
    fileParallelism: false,
    testTimeout: 15_000,
    hookTimeout: 30_000,
    coverage: {
      // istanbul (source-instrumented via Babel), not v8: the v8 provider reads
      // coverage from Node's V8 inspector (NODE_V8_COVERAGE), which the Bun
      // runtime does not expose, so `bun --bun vitest --coverage` reports 0%.
      // istanbul instruments the source directly and is runtime-agnostic.
      provider: "istanbul",
      enabled: true,
      all: true,
      reporter: ["text"],
      include: SOURCE_SRC.map((sourceDir) => `${sourceDir}/**/*.ts`),
      exclude: [...SOURCE_EXCLUDE],
      // Fail the suite (and CI's Test job) when any overall coverage metric drops below
      // 90% across the behavioural source in source-scope.mjs.
      thresholds: {
        branches: 90,
        functions: 90,
        lines: 90,
        statements: 90,
      },
    },
  },
});
