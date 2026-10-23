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
The gate requires 100% of scored mutants to be detected; surviving or uncovered mutants fail it.
The score excludes the existing StringLiteral/ObjectLiteral operators and the individually
reviewed equivalents in [`equivalents.json`](./equivalents.json). It is an eligible-mutant score,
not a claim that every syntactically possible mutation can be distinguished by a test.

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

Some mutations preserve behavior for every valid domain input. For example, the monthly date
projection's final ISO date bounds remove the injected `"Stryker was here"` array member;
removing an optional access on an index known to exist also leaves behavior unchanged.
The registry records each exact original fragment, replacement, source location, mutator,
complete-source SHA-256 and equivalence reason. It does not exempt entire expressions,
operators or files. Any source change stops its exclusions from matching until they are reviewed.
The full gate also rejects unused, stale or unexpected equivalent exclusions in its fresh report.

Stryker's built-in ignore plugins receive only an AST node, which would also exclude meaningful
mutations of that node. The small instrumenter patch exposes an optional `shouldIgnoreMutant`
hook after the original/replacement pair is generated, before instrumentation and test planning.
[`equivalents.mjs`](./equivalents.mjs) uses that hook to mark only exact reviewed replacements
Ignored, with their reasons retained in both reports. It never changes a test result or report score.
The runner regression verifies that another replacement at the same location remains active,
source changes invalidate a record, stale/full-report records fail, and deliberately unasserted
control mutations still survive.

Before recording a new equivalent, try a distinguishing test, including combined-invalid-input
precedence and schema/JSON Schema behavior. A survivor alone is not evidence of equivalence.
Prefer a behavior-preserving simplification when a redundant production branch can be removed
clearly. After any registry change, rerun the entire gate; do not reuse an incremental report.
