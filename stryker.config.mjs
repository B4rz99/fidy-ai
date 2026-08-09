import { CORE_SRC } from "./source-scope.mjs";

/**
 * The mutation run: every mutant Stryker can plant in the core tree must be
 * killed by the core tests. Line coverage says a line ran; a mutation score
 * says a test would have noticed if that line were wrong, which is the claim
 * ARCHITECTURE.md §8 actually makes about core ("prove the decision is right:
 * every branch and boundary").
 *
 * Scoped to src/core. A trial run over src/shell as well is described in
 * ARCHITECTURE.md §8 — it works, and it is not gated, because several shell
 * mutants cannot be killed from any seam a test can reach.
 */
export default {
  // The command runner, not @stryker-mutator/vitest-runner. The vitest runner
  // drives vitest through its Node API, so every mutant would be judged on
  // Node while the project ships on Bun — the runtime that decides what
  // `@effect/platform-bun` and the API seam even do. This runs the same command
  // `bun run test:core` runs, so a mutant survives or dies under the runtime
  // that would have shipped it. The cost is the whole core suite per mutant
  // instead of per-test selection, which at ~1s a suite is not yet a cost.
  //
  // Coverage is switched off for the run: the core config enforces a 90% line
  // threshold, and a mutant that drops coverage below it would fail the command
  // and be recorded as killed — a kill nothing actually noticed.
  testRunner: "command",
  commandRunner: {
    command: "bun --bun vitest run --config vitest.core.config.ts --coverage.enabled=false",
  },
  // A single runner avoids the resource contention that makes this full-suite
  // command time out when Stryker fans it out across the machine.
  concurrency: 1,
  // Only the behavioural core sources, matching source-scope.mjs so this gate
  // and the coverage gates measure the same files. Test files are mutated by
  // nobody: a mutant in a test is a broken test, not a surviving defect.
  mutate: CORE_SRC.flatMap((sourceDir) => [`${sourceDir}/**/*.ts`, `!${sourceDir}/**/*.test.ts`]),
  // "off", not "perTest": the command runner cannot report which test touched
  // which line, because all it sees is an exit code.
  coverageAnalysis: "off",
  mutator: {
    // Documentation, not behaviour. Core is mostly schema declaration, and a
    // StringLiteral or ObjectLiteral mutant there almost always lands inside an
    // `annotate({ description: … })` — emptying prose that no core test can
    // observe, because annotations reach a caller through the derived OpenAPI
    // spec, which only exists in the shell. Killing them from here would mean
    // asserting against `schema.ast.checks[…].annotations`, coupling tests to
    // Effect's AST internals to protect a string; and the shell has already
    // decided field descriptions are a review matter rather than a guard
    // (src/shell/testing/descriptions.test.ts).
    //
    // The price is real and worth naming: `Schema.Literals(["inflow", ""])` and
    // `Schema.Literal("")` for the currency are behaviour, and this gate stops
    // seeing them. src/core/transactions/model.test.ts covers both by hand —
    // and the ArrayDeclaration mutant that empties that same literal union is
    // still gated here, so the tests that kill it cannot quietly disappear.
    excludedMutations: ["StringLiteral", "ObjectLiteral"],
  },
  // The threshold. `break: 100` fails the command — and the nightly Mutation workflow — on a
  // single surviving mutant; `high`/`low` only colour the report, and are
  // pinned to the same number so the report never shows green below the threshold.
  //
  // 100 is affordable because the scope is pure decisions with no I/O, and it
  // is the only threshold that does not decay: any number below 100 is a quota
  // of unnoticed defects that fills up and then has to be argued down.
  thresholds: { high: 100, low: 100, break: 100 },
  // Clear-text for whoever is watching the run; html so a survivor can be read
  // in context instead of guessed at from a line number.
  reporters: ["clear-text", "html", "progress"],
  htmlReporter: { fileName: "reports/mutation/mutation.html" },
  // Stryker writes mutated copies of the project into this sandbox rather than
  // touching the working tree; it is gitignored alongside the report.
  tempDirName: ".stryker-tmp",
  // What gets copied into the sandbox. An allowlist — ignore everything, then
  // name the files the core run reads — rather than a list of things to skip:
  // Stryker does not read .gitignore, so a denylist silently starts copying
  // whatever lands in the tree next, and the tree already holds a 2000-file
  // Effect checkout under .repos and a Bun cache under .npm that broke the
  // sandbox copy outright. node_modules is symlinked in regardless of this.
  ignorePatterns: [
    "**",
    "!/src/core/**",
    "!/package.json",
    "!/tsconfig.json",
    "!/bunfig.toml",
    "!/vitest.core.config.ts",
    "!/source-scope.mjs",
  ],
};
