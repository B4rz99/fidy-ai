import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
import { SOURCE_EXCLUDE, SOURCE_SRC } from "./source-scope.mjs";

// The main run (`bun run test`, CI's Test job): the whole suite, gated on total
// line coverage. The core and sharded CI configurations are standalone rather
// than derived from this file, and each states its own purpose; the only shared
// input is the source scope in source-scope.mjs. Changing a runner setting here
// therefore does not silently change another gate.
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
    // Isolate mock call history explicitly rather than relying on Vitest 5's default.
    clearMocks: true,
    // Vitest 5's failure for unawaited asynchronous assertions is deliberate: assertion failures
    // must remain attached to their owning test.
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
      // Vitest 5 matches coverage globs from the project root; source-scope paths are deliberately
      // relative to apps/server, which is also the command's working directory.
      include: SOURCE_SRC.map((sourceDir) => `${sourceDir}/**/*.ts`),
      exclude: [...SOURCE_EXCLUDE],
      // The Cloudflare contraction intentionally removes infrastructure runtime owners and their
      // tests. Keep a meaningful floor for the remaining shell evidence without requiring replacement
      // tests for deleted authorities.
      thresholds: {
        branches: 80,
        functions: 75,
        lines: 85,
        statements: 85,
      },
    },
  },
});
