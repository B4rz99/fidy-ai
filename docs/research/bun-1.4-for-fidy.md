# Bun 1.4 for Fidy

_Research snapshot: 2026-08-22. Primary sources: Bun's 1.4 release notes and upgrade tracker, the npm registry, and this repository. Local probes used Bun 1.4.0 on macOS arm64 at commit `51d5673236bd40c97b80e68510b821d6a8de7df4`._

## Recommendation

**Adopt Bun 1.4.0, but not today.** The migration is small rather than hard: the application, Vitest suites, Playwright suite, production bundles, and Sentry compatibility all worked in local probes. One repository-owned browser-client bundle guard needs a deliberate update because Bun 1.4 exposes five `multipasta` modules in the browser build metafile.

The immediate blocker is Fidy's seven-day dependency-admission policy. Fidy pins `bun-types` alongside Bun, and `bun-types@1.4.0` was published at `2026-08-20T14:11:33.785Z`; a normal Bun 1.4 install currently rejects it as too young. The earliest policy-compliant attempt is **2026-08-27 after 14:11:34 UTC**. Do not add an age-policy exception merely to upgrade early. [npm registry metadata](https://registry.npmjs.org/bun-types); `bunfig.toml:1-12`; `package.json:52-71`; `apps/server/package.json:50-58`

After that date, budget one focused migration PR and a full CI/image run. The known code work should be measured in hours, not days, unless Linux image verification reveals a platform-specific regression.

## Why 1.4 helps Fidy

### 1. Production resource use is the main benefit

Fidy's server runs directly on Bun through Effect's `BunHttpServer`, `BunHttpClient`, and `BunRuntime`; its production artifact is built for Bun and runs in a Bun Alpine image. Therefore Bun runtime improvements apply directly rather than only to development tooling. `apps/server/src/main.ts:1-18`; `apps/server/package.json:7-17`; `apps/server/Dockerfile:1-25`

Bun reports that 1.4 starts about twice as fast on Linux, lowers idle CPU substantially, and reduces peak memory for HTTP servers by 13–48% in its own workloads; `Bun.serve` itself measured 20% lower peak memory. These are vendor benchmarks, not Fidy measurements, so the direction is credible but the percentage must not be used as a Fidy capacity claim until measured in the production image. [Bun 1.4 production benchmarks](https://bun.sh/blog/bun-v1.4#production)

Bun 1.4 also makes Web Streams native and reports materially lower memory and higher throughput for fetch, file, compression, and subprocess pipelines. That is relevant to Fidy's HTTP traffic and document-ingestion path, but again should be treated as an expected runtime improvement rather than a guaranteed application-level number. [Bun 1.4 streams and bodies](https://bun.sh/blog/bun-v1.4#streams-and-bodies)

### 2. Existing test and browser dependencies become better-supported

Fidy deliberately runs Vitest and Playwright under Bun (`bun --bun`). Bun 1.4 explicitly supports Vitest, including Istanbul coverage and worker pools, and explicitly supports Playwright's test runner and configuration. Fidy currently uses both Vitest coverage and Playwright browser tests. [Bun 1.4 Vitest and Playwright](https://bun.sh/blog/bun-v1.4#node-js-compatibility); `apps/server/package.json:18-25`; `apps/web/package.json:12-21,40-55`

This does not justify replacing Vitest with `bun test`: Fidy uses `@effect/vitest`, Vitest configs, Istanbul thresholds, and browser/jsdom environments. Consequently the new `bun test --parallel`, sharding, timings, and changed-file selection are not directly usable without a separate test-runner migration that offers little current value. [Bun 1.4 parallel test runner](https://bun.sh/blog/bun-v1.4#bun-test-parallel)

### 3. Node compatibility lowers dependency risk

Bun added 1,517 more passing Node test-suite files and substantially improved `http`, `fs`, `tls`, streams, workers, and child processes. This should reduce compatibility risk for Node-oriented dependencies such as Sentry CLI/SDK, Vite, Vitest, Playwright, PostgreSQL drivers, and mutation tooling. Bun still says it is not 100% Node-compatible, so Fidy's compatibility and production-image tests remain necessary. [Bun 1.4 Node compatibility](https://bun.sh/blog/bun-v1.4#node-js-compatibility)

Bun also calls out working OpenTelemetry HTTP/fs instrumentation. Fidy currently uses `@sentry/bun`, not those OpenTelemetry npm instrumentations, so this is optional future capability—not a reason to replace the tested Sentry adapter. `apps/server/package.json:41-50`; `apps/server/src/shell/observability/sentry-adapter.ts:1`; [Bun 1.4 observability](https://bun.sh/blog/bun-v1.4#observability)

### 4. Diagnostics and package-management tools are useful additions

The most immediately useful new operational tools are:

- `--cpu-prof-md` and `--heap-prof-md`, which produce terminal/agent-readable profiles;
- `bun build --metafile-md`, which can supplement Fidy's existing machine-enforced bundle graph with human-readable dependency chains;
- `bun audit fix --dry-run`, `bun dedupe --check`, and `bun pm licenses --prod --json` as review aids. [Bun 1.4 observability](https://bun.sh/blog/bun-v1.4#observability); [Bun 1.4 package manager](https://bun.sh/blog/bun-v1.4#bun-install)

Do not automate `bun audit fix` in Fidy: it installs upgrades and can conflict with exact pins, the seven-day admission delay, and the repository's human review of major/security changes. Fidy's own dependency policy remains authoritative. `bunfig.toml:1-12`; `package.json:15-16`; `scripts/check-dependency-updates.ts:387-448`

A local 1.4 probe found no audit advisories, but `bun dedupe --check` found four removable duplicate versions (`@types/node`, `aria-query`, `undici-types`, and `ws`). That is a possible follow-up cleanup, not part of the runtime migration; deduplication changes the resolved graph and deserves its own verification.

### 5. Most headline APIs should not change Fidy now

- `Bun.cron()` should not replace Effect scheduling or the existing hosted `health-cron`; doing so would change ownership and deployment semantics. `docs/operations/production-releases.md:32`; [Bun.cron](https://bun.sh/blog/bun-v1.4#bun-cron)
- `Bun.markdown`, `Bun.Image`, `Bun.WebView`, `Bun.Terminal`, XML/JSON5 utilities, and built-in React Compiler are not needed by the current product path. Adopt them only for a concrete requirement, not to remove dependencies speculatively.
- `bun run --parallel` could improve local orchestration, but `bun run --filter '@fidy/*' dev` already owns workspace development and the mandatory verifier intentionally executes checks serially so failures remain isolated and resource use stays bounded. `package.json:16-18`; `scripts/verify.ts:54-75,210-229`; [Bun run parallel](https://bun.sh/blog/bun-v1.4#bun-run-parallel)
- `bun prune --production` does not improve the current final image: the final stage copies only built `dist`, not `node_modules`. `apps/server/Dockerfile:16-25`; [Bun prune](https://bun.sh/blog/bun-v1.4#bun-prune)

## Migration probe

The candidate runtime was injected through `PATH` so every nested `bun` and `bun --bun` invocation used 1.4.0. No repository files were changed.

| Probe                                           | Result under Bun 1.4.0                                                                   |
| ----------------------------------------------- | ---------------------------------------------------------------------------------------- |
| Frozen install against the current lockfile     | Passed; existing lockfile remained version 1                                             |
| Static verifier                                 | All checks passed except browser-client graph                                            |
| Typecheck with current `bun-types@1.3.14`       | Passed                                                                                   |
| Production server and web builds                | Passed                                                                                   |
| Server core tests                               | 33 files / 235 tests passed                                                              |
| Complete database-backed server tests           | 106 files / 910 tests passed                                                             |
| Web unit + Istanbul coverage                    | 13 files / 54 tests passed in both runs                                                  |
| Preview, production-adapter, and contract tests | Passed                                                                                   |
| Playwright                                      | 8 tests passed                                                                           |
| Sentry compatibility on the unmodified tree     | Only the intentional Bun-version pin assertion failed; every behavioral condition passed |
| `bun audit`                                     | No vulnerabilities reported                                                              |
| `bun dedupe --check`                            | Failed with four deduplication opportunities                                             |

A second detached-worktree probe changed the runtime pin, both `bun-types` pins, and the observability expected version to 1.4.0. With the age gate disabled **only for the throwaway probe**, install and TypeScript project-reference build passed, the existing v1 lockfile remained v1, and all four observability compatibility tests passed. The browser-client graph remained the only reproduced code-level failure.

These probes cover macOS arm64. The repository's mandatory Linux CI, Docker build, and production-image smoke remain the acceptance authority. `scripts/verify.ts:54-229`; `.github/workflows/ci.yml:1-80`; `apps/server/scripts/check-production-image.sh:1-37`

## Known migration work

1. **Wait for admission.** Retry after `2026-08-27T14:11:34Z`; keep `minimumReleaseAge = 604800` unchanged.
2. **Update all pins together:** root `packageManager`, both `bun-types` declarations, shared CI action, preview and production workflows, the observability expected version, and both Docker stages. Current pin locations are enumerated by `rg '1\.3\.14'`; the important ones are `package.json:52-71`, `apps/server/package.json:50-58`, `.github/actions/bun-install/action.yml:8-23`, `.github/workflows/preview.yml:26-34`, `.github/workflows/production.yml:26-32`, `apps/server/tools/observability-compatibility/fixture-process.test.ts:26-30`, and `apps/server/Dockerfile:1-16`.
3. **Refresh the immutable Docker digest.** At this snapshot, `oven/bun:1.4.0-alpine` resolves to multi-platform index digest `sha256:07235578f79ef8c6f97d94aee7938e76f5cdba5f21ae5dbfdd3d3d38058437eb`; verify it again at implementation time rather than copying a stale research value.
4. **Resolve the bundle-guard delta deliberately.** Bun 1.4 genuinely emits the five `multipasta` modules, not just extra metafile records: the probe measured 19,176 unminified output bytes attributed to them, alongside Effect's `Multipart` implementation. Fidy reaches this code through Effect's HTTP/HttpApi barrels even though its browser client does not use multipart parsing. Effect marks the package side-effect-free, and Bun 1.4 introduced automatic barrel-import optimization while retaining `export *` targets; the 1.3/1.4 output difference is therefore consistent with a Bun tree-shaking change or regression, not a newly added Fidy import. Do not merely admit `multipasta` to the allowlist—that would make the check pass while preserving unnecessary browser code. Prefer reproducing/reporting the Bun bundler issue or moving to an admitted Effect release that vendors its parser and tree-shakes correctly; verify output bytes in either case. `apps/server/scripts/check-browser-client.ts:12-47,82-116`; `node_modules/effect/package.json:1-29`; `.repos/effect/packages/effect/src/unstable/http/Multipasta.ts:1-15`; [Bun barrel-import optimization](https://github.com/oven-sh/bun/pull/26892); [Effect beta.104 parser change](https://github.com/Effect-TS/effect/releases/tag/%40effect/platform-browser%404.0.0-beta.104)
5. **Regenerate `bun.lock` with 1.4 and inspect the diff.** Bun 1.4 defaults new lockfiles to v2, but existing v0/v1 lockfiles continue to load; the probe retained Fidy's v1 lockfile. Older Bun versions cannot read newly written v2 lockfiles, so all CI/runtime pins must move atomically if the format ever changes. [Bun 1.4 breaking changes](https://github.com/oven-sh/bun/issues/28792#bun-install--cli); `bun.lock:1-4`
6. **Run the full repository verdict and image smoke on Linux.** In particular, keep the Sentry compatibility fixture and verify the bundled production process because Bun 1.4 changes its reported Node version to 26.3.0 and includes many stricter Node/fetch semantics. [Bun 1.4 breaking changes](https://github.com/oven-sh/bun/issues/28792); `apps/server/tools/observability-compatibility/fixture-process.test.ts:340-349`; `apps/server/Dockerfile:1-25`

## Risk assessment

**Migration difficulty: low-to-moderate.** There is one known policy wait, one known bundle-guard decision, mechanical pin/digest updates, and a full-platform verification run. There is no evidence of an application, Effect, Vitest, Playwright, PostgreSQL, Vite, or Sentry behavioral incompatibility in the exercised paths.

**Adoption value: high enough to do promptly after the age gate.** The production CPU/memory/startup improvements and broader compatibility matter more to Fidy than the new convenience APIs. Keep the migration narrowly scoped; evaluate deduplication, profiler integration, or any replacement of existing libraries separately.

## Unresolved questions

- Is the extra multipart output a Bun 1.4 bundler regression that upstream will fix, or an intended consequence of the new barrel optimization's conservative handling of `export *`? The minimal reproduction is tracked in [oven-sh/bun#40114](https://github.com/oven-sh/bun/issues/40114).
- Does the Bun 1.4 Alpine production image pass Fidy's complete Linux image smoke and exhibit lower RSS/idle CPU under a representative workload? The local macOS probes cannot answer that.
