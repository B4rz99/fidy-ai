import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
import { SOURCE_EXCLUDE, SOURCE_SRC } from "./source-scope.mjs";

// The CRAP run: the same suite over the same source scope as vitest.config.ts,
// measured for a different gate. It emits the json coverage report that crap4ts
// consumes (tools/crap/run.mjs) and gates on per-function CRAP score —
// complexity weighed against that one function's coverage — while the total
// line-coverage gate stays with the main run.
//
// Standalone rather than a mergeConfig of vitest.config.ts, for the same reason
// vitest.core.config.ts is: Vite's merge concatenates arrays instead of
// replacing them, and reads a key set to `undefined` as "no opinion" rather
// than as a removal. Deriving this config that way produced a `reporter` of
// ["text", "text", "json"], doubled `include`/`exclude` globs, and — silently —
// the base 90% line threshold that an explicit `thresholds: undefined` was
// meant to drop. A run that inherits another job's gate fails for reasons that
// have nothing to do with what it measures, so this config states its coverage
// settings outright and owns every gate it enforces.
export default defineConfig({
  resolve: {
    // `~/*` → `./src/*`, mirroring tsconfig `paths`. See vitest.config.ts.
    alias: {
      "~": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  test: {
    // The full suite, as vitest.config.ts runs it: a CRAP score is only
    // meaningful against the coverage the whole suite actually produces.
    include: ["src/**/*.test.ts"],
    // The OpenAI assembly test owns no behavioural function coverage and is
    // still enforced by the main suite. Istanbul's JSON reporter does not exit
    // when that Layer-construction test shares this full-suite worker.
    exclude: ["src/shell/agent/openai.test.ts"],
    environment: "node",
    reporter: ["dot"],
    pool: "forks",
    fileParallelism: false,
    testTimeout: 15_000,
    hookTimeout: 30_000,
    coverage: {
      // istanbul, not v8 — see vitest.config.ts for why.
      provider: "istanbul",
      enabled: true,
      all: true,
      // json writes coverage/coverage-final.json, the input tools/crap/run.mjs
      // hands to crap4ts. The main coverage job owns the human-readable report;
      // combining text and json here prevents Vitest's Bun process from exiting.
      reporter: ["json"],
      include: SOURCE_SRC.map((sourceDir) => `${sourceDir}/**/*.ts`),
      exclude: [...SOURCE_EXCLUDE],
      // No `thresholds`: total line coverage is the main run's gate
      // (vitest.config.ts). This run's gate is the CRAP score, enforced after
      // vitest exits by `tools/crap/run.mjs --strict`.
    },
  },
});
