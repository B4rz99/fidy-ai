# Bun 1.4 and 1.4.1 adoption for Fidy

Research date: 2026-09-07. Issue: [#357](https://github.com/B4rz99/fidy-ai/issues/357).
Baseline: `8e01a87b28d31c2cc440f0b0ce02cc78b905639e`. This supersedes the adoption
recommendation in [the August 1.4 probe](bun-1.4-for-fidy.md), not its historical results.

## Decision

Upgrade the runtime, CI, production image, observability compatibility fixture, and both
`bun-types` pins together to **1.4.1**. Keep Effect RC.112, Vitest, Vite, the browser-module
allowlist, and the ordinary seven-day admission policy unchanged. Adopt the runtime's automatic
improvements first; new APIs must solve an existing Fidy problem before replacing an adapter.
This is an engineering recommendation based on the release facts and repository seams below,
not a claim of measured production savings.

## What is actually new and useful

Bun's [1.4 overview](https://bun.sh/blog/bun-v1.4) covers everything since **1.3.0**, not just
changes since Fidy's **1.3.14** pin. Its version badges matter: Markdown profiles, metafile
Markdown, and several headline APIs already existed in the 1.3 series. Do not count all of
those as newly unlocked by this upgrade.

| Change                                                                                                      | Fidy relevance and disposition                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| ----------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1.4 Linux startup, idle CPU/memory, native Web Streams, and broader Node compatibility                      | Adopt through the runtime pin. The API and production build run on Bun; Vitest and Vite run with `bun --bun`. Vendor benchmark percentages are not Fidy capacity estimates. [1.4 production](https://bun.sh/blog/bun-v1.4#production), [streams](https://bun.sh/blog/bun-v1.4#streams-and-bodies), [Node compatibility](https://bun.sh/blog/bun-v1.4#node-js-compatibility); `apps/server/package.json:13-37`, `apps/web/package.json:7-22`.                           |
| 1.4.1 computed-class-key and `export * as` tree-shaking fixes                                               | Directly relevant to Effect and the prior upgrade blocker. Keep the browser guard unchanged and exercise the bundled server, not just TypeScript source. [1.4.1 bundler fixes](https://bun.sh/blog/bun-v1.4.1#bun-build), [namespace tree-shaking](https://bun.sh/blog/bun-v1.4.1#smaller-bundles-for-libraries-that-use-export-as); `apps/server/scripts/check-browser-client.ts:18-50,79-133`.                                                                       |
| 1.4.1 idle JIT-code reclamation, Buffer access, AsyncLocalStorage allocation/context-isolation improvements | Automatic runtime benefits. Retain the Sentry fixture to prove observed work, context isolation, and redaction still behave correctly. [idle memory](https://bun.sh/blog/bun-v1.4.1#reduced-idle-memory-usage), [Buffer](https://bun.sh/blog/bun-v1.4.1#up-to-9x-faster-buffer-reads-and-writes), [AsyncLocalStorage](https://bun.sh/blog/bun-v1.4.1#faster-asynclocalstorage); `apps/server/tools/observability-compatibility/fixture-process.test.ts:29-31,313-399`. |
| 1.4.1 fetch backpressure, disconnect cancellation, short-timeout and streamed-body regression fixes         | Useful to the API and bounded outbound providers. Bun's transport buffering is not a substitute for Fidy's streamed byte budgets, cancellation, or Schema decoding. [streaming/backpressure](https://bun.sh/blog/bun-v1.4.1#bun-write-path-response-streams-to-disk), [Bun API fixes](https://bun.sh/blog/bun-v1.4.1#bun-apis), [Web API fixes](https://bun.sh/blog/bun-v1.4.1#web-apis); `apps/server/ARCHITECTURE.md:263-290`.                                       |
| 1.4.1 TLS identity fix                                                                                      | `fetch` verifies against the URL hostname rather than a custom Host header unless `tls.servername` is explicit. Adopt the safer default; do not add Host-header workarounds. [release explanation](https://bun.sh/blog/bun-v1.4.1#localhost-and-localhost-resolve-to-loopback-everywhere).                                                                                                                                                                             |
| 1.4.1 Node compatibility fixes                                                                              | Includes the 1.4.0 socket regression affecting testcontainers, Vite port retry, Vitest coverage recursion, and worker compatibility. Useful runtime compatibility, but Fidy's actual integration/coverage/browser gates remain the evidence. [Node fixes](https://bun.sh/blog/bun-v1.4.1#node-js-compatibility-improvements); `.github/workflows/ci.yml:99-243`.                                                                                                       |

## The old blocker is fixed upstream

[oven-sh/bun#40116](https://github.com/oven-sh/bun/pull/40116) merged on 2026-08-22 as
`94024bd768b7a39f110193ec59f3213fe5081721`. GitHub's
[comparison to the 1.4.1 tag](https://github.com/oven-sh/bun/compare/94024bd768b7a39f110193ec59f3213fe5081721...bun-v1.4.1)
reports `ahead`, 352 commits ahead and zero behind: the release contains the fix.
The [release notes](https://bun.sh/blog/bun-v1.4.1#bun-build) explicitly identify the computed-key
regression bloating Effect bundles. This resolves the upstream question in the August report.

The current tree has independently moved from Effect beta.98 to RC.112, so a passing current-tree
guard alone cannot prove what the old beta.98 bundle would emit. The upstream ancestry and actual
current-tree browser guard are separate evidence. No Effect migration or allowlist expansion is
part of this change. Source: `package.json:56-66`; issue #357's implementation-probe comment.

## Deliberately not adopting

- **Bun HTTP/2:** 1.4.1 supports it in `Bun.serve`, but Fidy's public TLS terminates at its hosting
  ingress. Do not force `http1: false`, change TLS ownership, or claim end-to-end HTTP/2 gains
  without testing Railway's upstream protocol. WebSockets and trailers are not supported on
  Bun's HTTP/2 path yet. [HTTP/2](https://bun.sh/blog/bun-v1.4.1#bun-serve-supports-http-2);
  `ARCHITECTURE.md:33-49`.
- **Bun.Image for sharp:** Fidy now uses sharp to validate hostile inline-image metadata with a
  pixel budget and media-type agreement. A replacement needs equivalent malformed-image,
  format, dimension, and cancellation evidence; it is not a runtime-pin cleanup. [Bun.Image](https://bun.sh/blog/bun-v1.4#bun-image);
  `apps/server/src/shell/ingestion/resend-receiving-client.ts:159-188`.
- **Bun.cron / Bun.sql:** retain Effect-owned durable execution, SQL transactions, and RLS.
  Changing the underlying APIs would be an architecture migration, not a free runtime benefit.
  [cron](https://bun.sh/blog/bun-v1.4#bun-cron), [SQL fixes](https://bun.sh/blog/bun-v1.4.1#sql-sqlite-s3-clients);
  `apps/server/ARCHITECTURE.md:292-359`.
- **Bun test / WebView:** retain `@effect/vitest`, Istanbul thresholds, and real Playwright
  acceptance. The native test runner's new parallelism/isolation does not implement Fidy's
  Effect test contract. [native test isolation](https://bun.sh/blog/bun-v1.4.1#bun-test-isolate-no-longer-leaks-between-files);
  `.patterns/testing.md:185-195`; `apps/web/playwright.config.ts:1-33`.
- **Bun React Compiler / chunking / preload options:** the web artifact is built by Vite, not
  Bun's browser bundler. These flags are not drop-in Vite optimizations. [Bun compiler](https://bun.sh/blog/bun-v1.4#built-in-react-compiler),
  [1.4.1 chunking](https://bun.sh/blog/bun-v1.4.1#fewer-smaller-chunks-with-splitting);
  `apps/web/package.json:7-12`.
- **Offline installs / self-contained workspaces / production prune:** no demonstrated need to
  alter the hoisted workspace layout or cache-miss behavior. The final image copies built
  artifacts, not the installed workspace tree. [offline](https://bun.sh/blog/bun-v1.4.1#bun-install-offline),
  [self-contained workspaces](https://bun.sh/blog/bun-v1.4.1#self-contained-node-modules-for-workspace-packages);
  `bunfig.toml:1-11`, `.github/actions/bun-install/action.yml:4-21`, `apps/server/Dockerfile:16-30`.
- **Automatic audit fix / dedupe:** these change the dependency graph beyond the runtime update.
  Keep them separate and reviewed. Markdown CPU profiles and bundle reports are useful manual
  diagnostics already available in 1.3; profile only synthetic workloads, and never upload heap
  snapshots containing User data or Secrets. [diagnostics](https://bun.sh/blog/bun-v1.4#observability),
  [package tooling](https://bun.sh/blog/bun-v1.4#bun-install); `SECURITY_STANDARDS.md:303-330`.

## One-time early admission authorized by the owner

The [npm registry](https://registry.npmjs.org/bun-types) reports `bun-types@1.4.1` published at
`2026-09-04T08:36:48.390Z`; ordinary eligibility starts at `2026-09-11T08:36:48.390Z`.
The owner explicitly authorized an exception in this implementation session on 2026-09-07:
“let's do the exception for this case”. This approval is for **1.4.1 only**, not future Bun
versions, other packages, or the carried CVE fixes in `dependency-policy.json`.

The lockfile was resolved using a temporary external Bun config with the normal hoisted linker,
`minimumReleaseAge = 604800`, and `minimumReleaseAgeExcludes = ["bun-types"]`, with both manifests
pinned exactly to 1.4.1. The config was deleted immediately and the lockfile delta reviewed before
installation. Besides the types upgrade, Bun removed the `yaml@2.9.0` optional-peer resolution;
there are no other version upgrades. No exclusion or shortened delay is retained in the repository,
dependency checker, CI, or production image. There is no standing permission or expiry cleanup.

This relies on Bun's documented distinction: the [minimum release age](https://bun.sh/docs/pm/cli/install#minimum-release-age)
applies to **new resolution**; existing lockfile entries remain unchanged. Normal frozen installs
can use the deliberately admitted graph without an exception. Deleting the lockfile and resolving
from scratch before September 11 is intentionally still refused by the ordinary policy.

## Runtime provenance

- [Bun 1.4.1 release](https://github.com/oven-sh/bun/releases/tag/bun-v1.4.1): published
  `2026-09-04T08:33:19Z`, commit `4661e494f052c83c80dade1318e5710238340be6`.
- Docker Hub `oven/bun:1.4.1-alpine`, inspected with `docker buildx imagetools inspect` on
  2026-09-07: multi-platform index
  `sha256:2ef545220f7a886f22fcb3f2309bbd6bcf1c0aa04b7d79c31765c7aa4a13aac1`;
  amd64 manifest `sha256:5f0ede16ed67c3e50b8919358bd7de77d8fa9b0ba4f523500e21196b5b050da9`;
  arm64 manifest `sha256:d7cc0ffdc52236b1ed19132c6ff4ce8efd726690fef4ac98c656e76d86348af2`.
  Both Dockerfile stages pin that index.
- Local runtime installed outside the repo/global Bun installation from the
  [official platform package](https://registry.npmjs.org/@oven/bun-darwin-aarch64/1.4.1).
  This keeps nested validation commands on 1.4.1 via PATH without changing unrelated worktrees.

## Validation

### Confirmed so far

- Ordinary frozen installs succeed on macOS arm64 and Debian Linux arm64 with Bun 1.4.1 and the
  unmodified repository admission policy. Linux uses `--ignore-scripts` followed by the explicit
  Effect TypeScript postinstall; Git hooks are not installed into the read-only host checkout.
- macOS lint, formatting, type checking, production builds, and unchanged browser-module guards
  pass: **143** server-client modules and **820** web modules. No allowlist changes were made.
- Core tests (**341**), web tests (**174**, including coverage), preview policy, deployment-adapter,
  CI-tooling and contract-checker tests pass. All **17** Playwright browser tests pass on macOS.
- All **four** observability compatibility tests pass on the pinned Bun 1.4.1 / Effect RC.112 /
  Sentry 10.71.0 combination.
- The complete Dashboard file passes independently (**25** tests). All **10** WhatsApp acceptance
  assertions pass on fresh databases, both without coverage and with the ordinary acceptance config.
  The coverage-enabled command still fails its unchanged thresholds (see below).

### Local verification gaps before syncing with trunk

The full verifier is **not green**. Its dependency-freshness gate reports nine unrelated outdated
pins: `@sentry/bun`, `svix`, `@sentry/cli`, `@testing-library/react`, `@vitejs/plugin-react`, `shadcn`,
`wrangler`, `@effect/tsgo`, and `lefthook`. Each manifest value was compared with the baseline commit
and is unchanged. They were neither upgraded nor waived. A separate network-bound baseline policy
rerun was stopped; the comparison establishes unchanged inputs, not a second completed gate run.

The first server run reported a Dashboard query-plan assertion failure. A parallel diagnostic run
also collided with its coverage directory, invalidating that run's coverage; this was an experiment
error, not evidence of a Bun regression. A non-overlapping rerun against the reused database exposed
onboarding delivery failures and a retained test rejection trigger cascading into later suites.
The initial WhatsApp run failed three onboarding-proof checks, while its fresh-database diagnostic
rerun passed. These full-suite versus isolated discrepancies are not resolved by a focused pass.

For comparison, Bun **1.3.14** running the current application source on a fresh database also failed
its full server suite: **4 failed / 151 passed files**, **11 failed / 1,356 passed tests**. That run used
the ordinary test configuration without coverage and reported different Consent, ingestion, browser
login and email-authentication failures. This is not a clean, equivalent baseline and does not prove
that every 1.4.1 failure predates the upgrade.

The final fresh-database acceptance run passes all ten assertions but fails the existing coverage
thresholds: **75.45% lines versus 76.91% required**, and **47.59% branches versus 48.1% required**.
No coverage thresholds or source exclusions were changed. The owner clarified that this standalone
acceptance coverage is not a GitHub merge gate and need not block this upgrade. CI instead runs
three isolated server shards and gates their merged coverage/CRAP results; those still need valid
completed evidence (`.github/workflows/ci.yml:132-243`). The earlier unsharded server runs are not
CI-equivalent; shared-state/order dependence is plausible, but flakiness has not been established.

The Debian Linux arm64 verifier attempt passed frozen installation, plain lint, formatting, module
graph and browser-client guards, but type-aware lint and TypeScript checking were killed by the
kernel. Docker exposed only **969.4 MiB** total memory; the Linux container's cgroup recorded
**`oom_kill 2`**. Concurrent PostgreSQL connection timeouts invalidated the fresh server rerun.
The heavy checks were stopped rather than relaxing limits or attributing OOMs to Bun.

### Serial retry — 2026-09-07

**Production-image smoke now passes.** Running `bun run verify -- --group image` alone completed the
pinned Alpine image's frozen install in about 13 seconds, built the production artifacts, prepared
the release, passed HTTP smoke checks, and booted with all migrations and restricted runtime
authority. No Dockerfile or smoke-test changes were needed.

Linux was retried only after that image run and its cleanup completed, without starting another
test database or overlapping heavy checks. `bun run lint:type-aware` was still SIGKILLed; the new
container recorded **`oom_kill 1`**. Docker still exposed **969.4 MiB**. The retry stopped there,
before type checking, builds or tests, rather than repeating resource-exhausted runs. The unrelated
running containers were left alone. Increase Docker's memory allocation (for example to 4 GiB)
or use an adequately resourced supported Linux CI runner to finish the required checks.

Local logs are under `/tmp/fidy-bun-357/`, with this retry under `retry/`; temporary verification
containers were cleaned up. Production RSS, CPU, and latency improvements remain unmeasured for Fidy.

### PR preparation — 2026-09-07

The owner increased Docker's memory to 4 GB, then requested that remaining validation run in GitHub
CI instead. The upgrade branch was synced onto trunk commit
`44e67d19f4` before opening the PR. Trunk now includes dependency updates, including Sentry 10.72.0,
so the earlier nine-pin freshness result and local compatibility/smoke results above describe the
original baseline, not the rebased PR head. The PR retains trunk's dependency updates and changes
only the Bun runtime/types pins and their documentation. Required GitHub jobs will grade that exact
updated tree; the earlier local results are not substitutes for those verdicts.
