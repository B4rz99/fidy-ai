# Effect family bump for Vitest 5 — upgrade assessment

_Research snapshot: 2026-09-20. Probed in a detached worktree at Fidy commit `4f01bfa6dc`, with the coordinated family at `4.0.0-rc.115`, `vitest@5.0.0`, and `@vitest/coverage-istanbul@5.0.0`. The probe ran on the local Bun `1.3.13`, not CI's pinned `1.4.1`; every result below needs a confirming run on the CI toolchain before it is treated as settled._

Fidy's dependency policy reports Vitest `4.1.11 → 5.0.0` for both applications. Vitest 5 is not takeable on its own: `@effect/vitest` peers `vitest <5.0.0` through rc.112, and rc.113 onwards peers `vitest >=5.0.0` — which in turn requires `effect ^4.0.0-rc.113` from every coordinated package. The family bump and Vitest 5 are one change.

## Recommendation

**Wait for `4.0.0-rc.116` to clear the seven-day delay (2026-09-25), then probe rc.116 in a throwaway worktree and take that — not rc.115.** Two behaviours probe as regressions in rc.115 and both are restored in rc.116, and one of them breaks the durable runtime outright:

1. **rc.115 ignores the connection URL's `options`.** Fidy's runtime URL carries `options=-c search_path=fidy_durable,public` so the restricted runtime role resolves the durable schema. Probed against the same database: rc.112 yields `search_path = fidy_durable,public`; rc.115 yields `"$user", public`. rc.116 restores URL `options`.
2. **rc.115 returns `timestamptz`/`timestamp` as epoch milliseconds**, so all 166 `Schema.DateTimeUtcFromDate` row mappings across 30 non-test files fail to decode. rc.116 decodes them as `Date` again.

rc.116 also carries its own breaking changes (below), so it is not a free step — it is the cheaper one. Until its admission date, the prefactors and unrelated updates can land.

## Scope of the coordinated upgrade

- Root: `effect`, `@effect/platform-bun`, and the `@effect/platform-node-shared` override.
- Server: `effect`, `@effect/ai-openai`, `@effect/platform-bun`, `@effect/sql-pg`, `@effect/vitest`, plus `vitest` and `@vitest/coverage-istanbul`.
- Web: `effect`, `@effect/atom-react`, plus `vitest` and `@vitest/coverage-istanbul`.
- Mutation tool: the `vitest` pin that deliberately matches the workspace for Stryker's runner resolution.
- The lockfile's coordinated transitive packages.

## Probe results

The probe changed only the family pins and the Vitest packages; no application migration was applied beyond the mechanical constructor renames.

| Probe                                                | Result                                                                                                                                                                      |
| ---------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Install and family alignment                         | Passed: 9 direct and 7 locked coordinated packages agree on rc.115; no incorrect-peer-dependency warning                                                                    |
| Project-reference build                              | 611 errors; 209 after the mechanical constructor renames (78 occurrences)                                                                                                   |
| Web suite                                            | 33 files / 228 tests passed                                                                                                                                                 |
| Server core suite                                    | 48 of 49 files / 342 tests passed; the exception imports the removed fast-check bridge                                                                                      |
| Server PostgreSQL suite                              | Not run end to end: the harness aborts at import on the removed `SchemaTransformation.transformOrFail` before reaching the row codecs                                       |
| Generated contract freshness                         | Failed: `openapi.json` changes (15 insertions, 120 deletions — duplicate `$ref`s collapse)                                                                                  |
| Contract compatibility                               | 15 `response-body-type-changed` findings on 400 responses across 15 operations, asking for a breaking-change acknowledgement                                                |
| Driver column types (same database, rc.112 → rc.115) | `timestamptz`/`timestamp`: `Date` → epoch millis; `date`: `Date` → `string`; `int8`: `string` → `bigint`; `bytea`: `Buffer` → `Uint8Array`; `numeric` and `jsonb` unchanged |
| Timestamp row decoding                               | `DateTimeUtcFromDate` accepts a `Date` and rejects epoch millis ("Expected a valid Date"); `DateTimeUtcFromMillis` accepts the millis form                                  |
| Runtime `search_path` through the URL                | rc.112 `fidy_durable,public`; rc.115 `"$user", public`                                                                                                                      |

## Migration items discovered

Ordered by the size of the change, each with the evidence that found it.

### Database

- Row schemas must follow the driver. On rc.115 that is 166 timestamp mappings in 30 non-test files; on rc.116 the timestamp portion collapses to verification, leaving `date`, `int8`, and `bytea` representations and the write path for timestamp parameters to confirm.
- Eight parameter sites bind a plain object as `jsonb` and rely on node-postgres inference the native client no longer performs.
- The client's notification surface changed shape; Fidy has no `listen` call sites, so this needs no work.

### Effect APIs removed or renamed

- Config constructors are PascalCase (`Config.String`, `Config.Redacted`, `Config.Literals`, `Config.Port`, `Config.Boolean`, `Config.URL`, `Config.NonEmptyString`, `Config.LogLevel`, `Config.Finite`) and `Config.mapOrFail` becomes `Config.mapEffect` — 78 occurrences.
- `PersistedQueue.take` no longer takes its retry options; the policy moves to queue construction. Fidy's own `handleNext` contract, its implementation, and its tests encode that policy.
- `SchemaTransformation.transformOrFail` is removed (two sites in the consent row codec), and the surrounding transformation surface changes again in rc.116.
- `LanguageModel.Service` is removed and the AI toolkit's tool definitions changed shape.
- The socket address union no longer has `TcpAddress`.
- The RPC serialization entry point used for the cluster HTTP boundary changed.
- Schema union discriminators are no longer exposed as before.

### Test tooling

- `effect/testing/FastCheck` and `Schema.toArbitrary` are deleted. One core property suite generates its inputs with the bridge and needs a real migration to native Schema/Arbitrary inputs; one other property call site needs its options renamed.
- Vitest 5 behaviour changes that need deliberate acceptance or restating: mock history cleared before every test by default, unawaited asynchronous assertions failing, coverage include/exclude matched by project-relative path, and the JUnit/JSON reporters writing files rather than stdout.
- `describe.sequential` is removed; three server suites use it.

### Documentation and reference material

- The SQL pattern document's column-codec idioms describe the node-postgres driver.
- The persisted-queue pattern document describes the option surface that moved.
- The vendored Effect checkout is pinned to the previous RC.

## What rc.116 changes for this plan

- `timestamp`/`timestamptz` decode as `Date` again; their encoders accept either form, and numeric readers must call `date.getTime()` or register numeric codecs explicitly.
- URL `options` is restored; `startupParameters`/`startupOptions` are added for structured startup packets.
- Unregistered OIDs decode as UTF-8 text, so scalar enums return string labels; other binary user-defined types may fail to decode, and a decode failure closes the connection. Fidy's use of enum or array column types must be checked.
- Its own breaking changes: `SchemaGetter.Getter` becomes a tagged union with standalone combinators, `Transformation#compose` becomes `SchemaTransformation.composeTransformation`, `SchemaTransformation.make` becomes `makeTransformation`, `Effect.orElseSucceed` passes the error to its fallback, `Effect.isEffect` narrows differently, and several `Stream` signatures align with `Effect`.

## Admission windows

- `effect` family rc.116: published 2026-09-18, admissible from 2026-09-25.
- `vitest` 5.0.1: published 2026-09-15, admissible from 2026-09-22. 5.0.0 is admissible now.

## Required migration plan

1. Keep the seven-day delay intact; do not exempt any package.
2. Probe rc.116 in a throwaway worktree with the same probes recorded here, plus the PostgreSQL-backed suite, once it is admissible.
3. Take the prefactors that land green on the current pins first: explicit JSONB parameters and the non-sequential suites.
4. Move all family pins and both applications' Vitest packages together on one branch; keep the family checker green.
5. Migrate the row codecs and the parameter sites the target RC still changes, and confirm the write path for timestamp parameters.
6. Migrate the removed and renamed Effect APIs, including the persisted-queue policy surface and its tests.
7. Migrate the test tooling, preserving the property coverage the fast-check bridge provided.
8. Regenerate the contracts and settle the response-body findings deliberately — never with a blanket acknowledgement.
9. Refresh the vendored checkout and the pattern documents.
10. Run the full gate matrix and record admission evidence as the rc.112 upgrade did.

## Unresolved questions

- Does the compatibility checker need to compare response bodies in a way that duplicate `$ref` collapse cannot register as a removal, or is an output policy the better answer?
- Which column representations still change on rc.116 in Fidy's actual schema, and what representation do timestamp parameters need on the write path?
- Does Fidy rely on enum or array column types that rc.116's unregistered-OID decoding would change or break?
- How much of rc.116's Schema getter and transformation change reaches Fidy's codecs, and does it interact with the consent row codec?
- Do any of the probe's results differ on the CI toolchain (Bun 1.4.1) rather than the local Bun 1.3.13?
