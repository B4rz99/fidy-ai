# Core mutation gate

From the repository root:

```sh
bun install --cwd tools/mutation --frozen-lockfile
node --test tools/mutation/runner.test.mjs
bun run test:mutation
```

The gate mutates all server core TypeScript except tests. Its existing StringLiteral and
ObjectLiteral exclusions remain in place. Reports are written under
`apps/server/reports/mutation/`. The gate always performs a fresh run so newly added
schema tests also retest mutations made during module initialization.
`bun run verify -- --group mutation` installs and runs the complete gate.
The gate requires at least 95%; 100% is the reporting target. Surviving mutants remain
visible in the reports rather than being excluded to meet that target.

Stryker runs on Node with classic TypeScript from this isolated install. Its Vitest runner
selects covered tests instead of launching the entire suite for every mutant. The separate
mutation Vitest configuration isolates modules so instrumentation and coverage stay with
the correct test file; ordinary core tests continue using their normal configuration.

The Vitest runner patch joins nested names with a greater-than sign surrounded by spaces, as implemented
by `getTestName` in the installed `vitest/dist/task-utils.js`. Stryker 10 otherwise builds
space-separated filters and reports nested-suite mutants as surviving after executing zero
tests. Both coverage identities and test-selection identities must use the same separator.
The runner regression mutates a small module across multiple test files and nested suites,
including a mutation made during module initialization. It requires asserted behavior mutants
to be killed and deliberately unasserted control mutants to survive, preventing inflated scores.

The patch also retains Vitest file-level failures when module initialization prevents tests from
being registered. Such a failure rejects the baseline run or kills the active mutant; it must
not become a surviving mutant merely because the failed file contains no runnable test tasks.
The regression uses an unmutated validator that throws when its mutated configuration is invalid.

Some mutations preserve behavior for every valid domain input. For example, in
[`monthlyDates`](../../apps/server/src/core/recurring-plans/operations.ts), changing the initial
empty dates array to `["Stryker was here"]` cannot change the output: the final ISO date range
filter always removes that sentinel. The weekly and fortnightly fallback inside the same
helper is unreachable because `projectDates` handles those frequencies in its other branch.
Such equivalent mutants prevent a raw 100% score without exclusions or production refactoring.
The report also retains any remaining test gaps; an equivalent example does not classify every
survivor as equivalent.
