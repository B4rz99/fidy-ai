# Effect 4.0.0-rc.112 upgrade assessment

_Research snapshot: 2026-08-30. The candidate was tested in a detached worktree at Fidy commit `fa1cc14a49`; the working tree was not modified by the probe._

## Recommendation

**Do not upgrade today.** The application code is source-compatible in the probes, but the upgrade is not currently admissible or merge-ready:

1. Fidy's mandatory seven-day package delay rejects every requested RC package. The latest coordinated package in this upgrade, `effect@4.0.0-rc.112`, was published at `2026-08-25T00:41:14.148Z`, so the earliest ordinary install is just after **2026-09-01T00:41:14Z**. Do not bypass the policy. `bunfig.toml:1-11`; [npm registry metadata](https://registry.npmjs.org/effect)
2. RC.112 changes the default Schema/OpenAPI reference policy. Regenerating Fidy's contract rewrites `openapi.json` by 8,153 insertions and 6,474 deletions and trips the compatibility gate. That output needs a deliberate migration decision; it must not be committed as incidental dependency churn. [Effect PR #7360](https://github.com/Effect-TS/effect/pull/7360); [RC.111 release notes](https://github.com/Effect-TS/effect/releases/tag/effect%404.0.0-rc.111); `apps/server/tools/contracts/generate.ts:69-93`; `apps/server/tools/contracts/check.ts:350-370`
3. Database-backed tests, browser acceptance, and the production image were unavailable in the local environment because PostgreSQL and Docker were not running. Those are mandatory acceptance evidence for this cross-application/runtime dependency change. `package.json:36-45,52`

**After the admission date, RC.112 looks like a small migration rather than a risky rewrite**, provided the OpenAPI representation issue is resolved intentionally and the full PostgreSQL/Linux image gates pass. Because RC.112 is still a prerelease and an RcMap defect is confirmed against it, prefer a newer admissible RC if one exists by then—after repeating the same probe.

## Scope of the coordinated upgrade

Fidy deliberately keeps the Effect family on one exact version. The upgrade must move all of these together:

- root `effect`, `@effect/platform-bun`, and the `@effect/platform-node-shared` override (`package.json:56-74`);
- server `effect`, `@effect/ai-openai`, `@effect/platform-bun`, `@effect/sql-pg`, and `@effect/vitest` (`apps/server/package.json:45-66`);
- web `effect` and `@effect/atom-react` (`apps/web/package.json:23-39`);
- the lockfile's coordinated transitive packages.

RC.112 exists for every package in that set, and their peer requirements agree on `effect@^4.0.0-rc.112`. [effect package metadata](https://registry.npmjs.org/effect/4.0.0-rc.112); [platform-bun metadata](https://registry.npmjs.org/@effect%2fplatform-bun/4.0.0-rc.112); [sql-pg metadata](https://registry.npmjs.org/@effect%2fsql-pg/4.0.0-rc.112); [ai-openai metadata](https://registry.npmjs.org/@effect%2fai-openai/4.0.0-rc.112); [vitest metadata](https://registry.npmjs.org/@effect%2fvitest/4.0.0-rc.112); [atom-react metadata](https://registry.npmjs.org/@effect%2fatom-react/4.0.0-rc.112)

The repository's family checker also needs to accept the `rc` prerelease identifier; it currently permits only `4.0.0-beta.N`. Its alignment checks should remain unchanged. `scripts/check-effect-family.ts:6-16,40-46,131-172`

## Probe results

The probe changed only the Effect-family pins and the family checker's prerelease regex. The age policy was disabled **only in the detached throwaway worktree** to answer the compatibility question.

| Probe                                                    | Result                                                         |
| -------------------------------------------------------- | -------------------------------------------------------------- |
| Install and family alignment                             | Passed: 9 direct and 7 locked Effect packages agreed on RC.112 |
| TypeScript project-reference build                       | Passed                                                         |
| Lint, type-aware lint, formatting, and module boundaries | Passed                                                         |
| Server and web production builds                         | Passed                                                         |
| Browser bundle boundaries                                | Passed                                                         |
| Server core tests                                        | 45 files / 337 tests passed                                    |
| Web unit tests                                           | 29 files / 161 tests passed                                    |
| Web coverage run                                         | 29 files / 161 tests passed                                    |
| Preview-policy tests                                     | 2 files / 17 tests passed                                      |
| Production-adapter tests                                 | 3 files / 12 tests passed                                      |
| CI-tool tests                                            | 2 files / 8 tests passed                                       |
| Contract-checker tests                                   | 3 files / 24 tests passed                                      |
| Generated contract freshness                             | Failed: `openapi.json` changed                                 |
| Contract compatibility after regeneration                | Failed with one reported `anyOf` removal                       |
| Complete PostgreSQL-backed server suite                  | Not run: database URLs unavailable                             |
| Browser acceptance                                       | Not run: its real API web server requires PostgreSQL           |
| Production image                                         | Not run: Docker daemon unavailable                             |

The reported contract removal appears to be a **representation false positive, not an actual removed canonical mutation**: both old and new atomic-batch schemas contain the same 25 operation variants in the same order. The shape moved from an anonymous shared component reference to an inline `anyOf`, which the current checker compares as a removal. This conclusion comes from direct comparison of the generated old and candidate documents; it still requires a code change or an explicit output-policy decision before merge.

## Relevant upstream changes

The five releases between beta.107 and RC.112 contain mostly fixes and additions. Changes most relevant to Fidy are:

- RC.108 fixes single-value array query decoding in HttpApi and moves `SchemaError` into `Schema`. Fidy already uses `Schema.SchemaError`, and the project-reference build passed. [RC.108 release notes](https://github.com/Effect-TS/effect/releases/tag/effect%404.0.0-rc.108)
- RC.109 preserves typed `SqlError` when `BEGIN` or `SAVEPOINT` fails. This strengthens Fidy's SQL error-classification seam. [RC.109 release notes](https://github.com/Effect-TS/effect/releases/tag/effect%404.0.0-rc.109)
- RC.111 changes Schema/JSON Schema/OpenAPI reference generation: by default, only schemas with resolved identifiers become references. This is the source of Fidy's generated-contract churn. [RC.111 release notes](https://github.com/Effect-TS/effect/releases/tag/effect%404.0.0-rc.111); [Effect PR #7360](https://github.com/Effect-TS/effect/pull/7360)
- RC.111 also changes AI toolkit handling to preserve encoded tool parameters when automatic resolution is disabled. Fidy's agent source compiled and its core/contract tests passed, but the complete PostgreSQL-backed hosted-agent tests remain required. [RC.111 release notes](https://github.com/Effect-TS/effect/releases/tag/effect%404.0.0-rc.111)
- RC.112 improves synchronous Schema parsing and pool/scope performance. It changes public `Pool.State`, `Pool.PoolItem`, and `Scope.State.Open`; Fidy has no direct use of those interfaces, and typechecking passed. [RC.112 release notes](https://github.com/Effect-TS/effect/releases/tag/effect%404.0.0-rc.112)
- `@effect/sql-pg` adds low-level protocol codecs but explicitly leaves `PgClient` using `pg`; its dependency range moves the resolved graph from `pg@8.22.0`/`pg-cursor@2.21.0` to `pg@8.23.0`/`pg-cursor@2.22.0`. [sql-pg RC.112 release notes](https://github.com/Effect-TS/effect/releases/tag/%40effect%2Fsql-pg%404.0.0-rc.112)
- `@effect/atom-react` only calls out relaxed React and Scheduler peer ranges in RC.112; Fidy's React 19.2.8 and Scheduler 0.27.0 satisfy them, and web tests/builds passed. [atom-react RC.112 release notes](https://github.com/Effect-TS/effect/releases/tag/%40effect%2Fatom-react%404.0.0-rc.112); `apps/web/package.json:27-39`

## Known RC.112 defects and applicability

- Effect issue #7515 reproduces an `RcMap`/`LayerMap` invalidation cleanup defect on RC.112 and remains open at this snapshot. Fidy application code does not import `RcMap` or `LayerMap`, so no direct exposure was found. [Effect issue #7515](https://github.com/Effect-TS/effect/issues/7515)
- A multipart chunking regression is reproducible on RC.112, but it began in beta.107—the version Fidy already runs—and the upstream issue is fixed on main. No Fidy application multipart endpoint was found, so this upgrade does not newly expose it. [Effect issue #7455](https://github.com/Effect-TS/effect/issues/7455)
- A read-only `@effect/sql-sqlite-bun` transaction regression also affects RC.112, but Fidy uses `@effect/sql-pg`, not the SQLite adapter. [Effect issue #7482](https://github.com/Effect-TS/effect/issues/7482); `apps/server/package.json:45-52`

## Required migration plan

1. Wait until after `2026-09-01T00:41:14Z`; retain `minimumReleaseAge = 604800` with no exclusion.
2. Recheck npm for a newer Effect RC. If one is old enough, assess that version rather than knowingly taking RC.112's RcMap defect.
3. Update all Effect-family pins and the platform-node-shared override together.
4. Generalize the family checker from beta-only to the intended prerelease phases, with its existing tests updated.
5. Choose and test an OpenAPI policy:
   - configure RC.112's `referencePolicy` to preserve a stable generated shape, if practical; or
   - accept the new canonical representation, then fix the compatibility checker so refactoring `$ref` versus inline schemas cannot create false removals.
     Do **not** add a breaking-change acknowledgement for the observed false positive.
6. Regenerate contracts and require both freshness and compatibility to pass.
7. Run the full verifier with PostgreSQL, browser acceptance, Docker production-image verification, and Linux CI.

## Unresolved questions

- Which RC.112 `referencePolicy` best preserves Fidy's prior OpenAPI allocation without depending on synthetic component names?
- Does the complete PostgreSQL-backed suite expose behavior changes in `@effect/sql-pg`, hosted tool decoding, transaction cleanup, or HttpApi?
- Will a newer admissible RC include the RcMap fix before this upgrade can legally be installed?
