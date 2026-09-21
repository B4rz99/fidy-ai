# Effect 4.0.0-rc.116 and Vitest 5.0.0 admission evidence

Evidence collected on 2026-09-20 and 2026-09-21 for issue #670, before accepting the candidate
lockfile. The coordinated Effect family and Vitest were taken under the explicit release-age
authorization recorded in #664: rc.116 published on 2026-09-18 and is admissible from 2026-09-25.

## Admission method

Taking the family ahead of its admission date was explicitly authorized in #664, applying the
release-age bypass only while resolving this coordinated upgrade. The pins moved on the dedicated
integration branch (`upgrade`) for that one resolution, and no exclude list, reusable bypass, or
policy change was added to any `bunfig.toml`.

With the original seven-day policy restored, `bunfig.toml` is byte-identical to `origin/trunk`
(SHA-256 `2b722e6668912e0a8ff3a858b226f34a164804d7a96561f1e10eb25eb2c6dfea`), and
`bun install --frozen-lockfile` passes. The candidate `bun.lock` has SHA-256
`f04d514feaa4baa34bfabf86a2ed511f4a1d2f054e8c8f8a99bc5eb5e51205c0`.

## Registry and verification evidence

Publish times and integrity values came independently from the npm registry packuments and
exact-version metadata. Every integrity below exactly matches `bun.lock`.

`npm@11.17.0` on Node `26.5.0` installed the exact candidate family in a temporary directory and ran
`npm audit signatures --include-attestations`. It exited 0: **96 packages had verified registry
signatures and 60 had verified attestations**; each package below individually reports a registry
signature and npm publish provenance attestations.

| Package                        | Version        | Published (UTC)            | Dist integrity                                                                                    | Verification                                 |
| ------------------------------ | -------------- | -------------------------- | ------------------------------------------------------------------------------------------------- | -------------------------------------------- |
| `@effect/ai-openai`            | `4.0.0-rc.116` | `2026-09-18T19:47:31.455Z` | `sha512-+fquqrde4qq28isIR2TCmCTaU0aKHr7hoSjVyzgWfe4rXiBfbaL39ZI2vm06ijXnPQaUcbD6Amm2vo1Vs50Njg==` | registry signature and attestations verified |
| `@effect/atom-react`           | `4.0.0-rc.116` | `2026-09-18T19:46:09.141Z` | `sha512-Kk5tEw0U5PoAcUaELWwQ34wuCVyLFZsjyyRePSIh3hL6rjORLamPfigJ8xDqYZS3CJg8HMtbND1eVethv404Jw==` | registry signature and attestations verified |
| `@effect/platform-bun`         | `4.0.0-rc.116` | `2026-09-18T21:34:16.977Z` | `sha512-gV94s1JJS92xQELdHTOEKHU/QvkGhXxZQ4LI8aBRo9QCy0wyvYNklFYOKXFZQNwp31su2LOYnMf0g1nJZOwYHw==` | registry signature and attestations verified |
| `@effect/platform-node-shared` | `4.0.0-rc.116` | `2026-09-18T19:47:01.244Z` | `sha512-4FB6UriGqArWFUaFqVchhfCRmmtOVzmD/k/bH6LErlKY8a9amt5dk6c3Arsi7AvUpChsdO+3jsG+P85HsxMkNA==` | registry signature and attestations verified |
| `@effect/sql-pg`               | `4.0.0-rc.116` | `2026-09-18T19:46:35.416Z` | `sha512-cnvH+XyNsCfd+m6buOzVpuYUyQYWC9pkkC6L6J+gQXrogcZ3O/WAxlcaxsEMC4Ru66vO0PZiWBUzhee5jh3KRQ==` | registry signature and attestations verified |
| `@effect/vitest`               | `4.0.0-rc.116` | `2026-09-18T19:47:13.351Z` | `sha512-q42ue4hAa5AcPBwqi8rvMvR1Jstr+JjsyyxEBUoBk+WWm8otnqFxQ+XbWslW1QSwdg5+2Fdgd7z59IValt9Oiw==` | registry signature and attestations verified |
| `effect`                       | `4.0.0-rc.116` | `2026-09-18T20:02:01.599Z` | `sha512-nawqJHSjHV8XIBRZNZ+D7cLZpN3kkSjzy6aiT9ofKENsl7xAMFKEoDa0itN5JFl3GUQ1PIN1T1HNlva5+xyO/A==` | registry signature and attestations verified |
| `vitest`                       | `5.0.0`        | `2026-09-03T12:24:30.312Z` | `sha512-gpsMNoRhMjMktVxPtstOH4/PJuPyovVaMDr4oDilXaGH1EcqM2OE96SoHT2VIQ6fTGtTjqmHDrEu2X9RQiXf8Q==` | registry signature and attestations verified |
| `@vitest/coverage-istanbul`    | `5.0.0`        | `2026-09-03T12:21:10.985Z` | `sha512-L0Rh+O61F2FV3+Xc3iGqeW5Tp0fs41VXy0hth84UCcMZGqlTjM1n5PUDqdaJD2xmQ/jZY3SJ9k7A2IKpKZRT8A==` | registry signature and attestations verified |

## Resolved graph

The coordinated-family checker derives the graph from workspace manifests and `bun.lock`; it
reported **9 direct and 7 locked packages**, all exactly `4.0.0-rc.116`.

- Root: `effect`, `@effect/platform-bun`; override: `@effect/platform-node-shared`.
- Server: `effect`, `@effect/ai-openai`, `@effect/platform-bun`, `@effect/sql-pg`,
  `@effect/vitest`, plus `vitest` and `@vitest/coverage-istanbul`.
- Web: `effect`, `@effect/atom-react`, plus `vitest` and `@vitest/coverage-istanbul`.
- Mutation tool: `vitest@5.0.0`, matching the workspace for Stryker's runner resolution, with
  `@stryker-mutator/core@10.0.0` and `@stryker-mutator/vitest-runner@10.0.0` satisfying their
  Vitest peer range.
- Every Effect adapter peers on `effect@^4.0.0-rc.116`; `@effect/platform-bun` resolves
  `@effect/platform-node-shared@4.0.0-rc.116` through the exact root override.
- The isolated `tools/depcruise` install moved `dependency-cruiser` from `18.2.0` to `18.3.0`
  (published 2026-09-13, inside the restored delay) so the module-graph gate runs its current
  admissible release; no other tooling pin moved.
- The published rc.116 `@effect/sql-pg` is the native client: the lockfile has no `pg`,
  `pg-cursor`, or `pg-protocol` entries; the driver ships its own protocol, connection, and codec
  catalogue.

The vendored source is the in-repo refresh commit `9c1eef9a6e`
(`chore(deps): #664 refresh vendored Effect checkout`), an upstream `main` snapshot after
`effect@4.0.0-rc.116` that still carries the unreleased `pg-regclass-codec` changeset. The exact
release commit for the published family tag is
`d62dd0d65252e5d3635538f0e41adc7c08aa9beb`.

## Restored-policy and contract verification

`bun.lock` was accepted with the restored seven-day delay. `bun run check:effect-family` reports 9
direct and 7 locked coordinated packages at `4.0.0-rc.116`. `bun run lint:dependencies` passes with
no Vitest or coverage-provider pins reported (three deferred classic TypeScript majors remain
reported and unchanged by this upgrade).

The canonical OpenAPI contract is fresh, and the compatibility checker reports no breaking change
against the trunk contract, so no breaking-change acknowledgement was needed.

## Known RC.116 defect applicability

The published rc.116 codec catalogue omits `regclass` (OID 2205) even though Effect's own Migrator
probes its ledger table with a relation cast; the unregistered-OID fallback then reads the binary
OID as UTF-8 text and closes the connection. The fix (`pg-regclass-codec`) is present in the
vendored snapshot but was not in the published release. The application installs its own
`pgTypeRegistry` (`apps/server/src/shell/database/internal/pg-type-registry.ts`) registering the
`regclass` and `regclass[]` codecs on both pools until the published catalogue carries them.

The rc.116 `PersistedQueue` store also changes two behaviours this repository had to restate:

- A payload that is not valid JSON, or that the queue schema cannot decode, is dead-lettered on its
  first claim (`state = 'failed'`, `last_failure` recorded) instead of consuming the retry budget;
  only handler failures exhaust `maxAttempts` and retry with the declared schedule.
- `int8` columns decode as `bigint`, and `regclass` casts decode as a numeric OID, so queue
  cursors and `to_regclass` assertions were restated against those representations.

Both pools pin the session `TimeZone` to `UTC` and every timestamp parameter is bound as a
JavaScript `Date` through `DateTime.toDateUtc`, because the driver no longer infers an encoding
for a `DateTime` value and would reject the bind.

## Quality ratchet interaction

The CRAP ratchet pairs each TypeScript function's span with its Istanbul coverage span and requires
0.8 line overlap. Istanbul starts an arrow function's coverage span at its body, so a helper whose
signature spans more lines than its body scores as uncovered regardless of its real coverage.
`prepareForwardedEmailReview` in `apps/server/src/shell/ingestion/email-forwarding-repo.ts` was
reshaped to a single-line signature returning the explicit `PreparedReview` type the lint rule
requires; its coverage span then pairs with its TypeScript span, its merged coverage is complete,
and its CRAP score is below the threshold.

## Gate matrix

| Gate                                                    | Result                                                                                                                                                                                                                                  |
| ------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Static (`bun run verify -- --group static`)             | Passed: all 18 checks (lint, lint suppressions, type-aware lint, format, project references, dependency and browser graphs, contract freshness and compatibility, Effect family, dependency policy, migration ids, credential evidence) |
| Builds                                                  | Passed: server production, production web, and portable web builds                                                                                                                                                                      |
| Unit                                                    | Passed: 130 files, 903 tests across the core, interpretation, web, coverage, preview-policy, deployment-adapter, CI-tooling, and contract tiers                                                                                         |
| Browser                                                 | Passed: 17 of 17 Playwright checks                                                                                                                                                                                                      |
| Server fast shards (all files, PostgreSQL)              | Passed: 164 files, 1275 tests                                                                                                                                                                                                           |
| Server durable-runtime (slow)                           | Passed: 9 files, 101 tests                                                                                                                                                                                                              |
| Quality thresholds                                      | Passed: branches 90.02%, functions 91.92%, lines 95.66%, statements 95.03%; 0 functions above CRAP 8 (worst 8.0)                                                                                                                        |
| Production image                                        | Passed: image build and deployment smoke checks                                                                                                                                                                                         |
| Mutation (nightly, runs without blocking pull requests) | Not part of pull-request CI; the nightly workflow owns it                                                                                                                                                                               |
