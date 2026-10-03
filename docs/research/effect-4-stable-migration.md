# Coordinated stable Effect migration baseline (#978)

## Decision and blocking admission window

Recorded 2026-10-03 against Fidy `00f50e621c353d01d30781d2a00c77314394ace2`,
Bun 1.4.1, Node 26.5.0, macOS arm64. Parent #33's live body supersedes its old local-stdio
planning comment. This preparation introduces no MCP/OAuth authority or product behavior.

**There is no eligible coherent stable v4 graph today.** The candidate is exactly **4.0.0** for
all eight installed coordinated packages below, not stable v3/0.x alternatives. npm's `latest`
tag is 4.0.0 for each. Root `bunfig.toml` requires 604,800 seconds without exclusions.
The runtime is the latest publication in this family, so its earliest joint admission is
**2026-10-08T03:11:28.537Z**. Do not install the candidate before then, even in a migration
worktree. Reading registry metadata and integrity-verified source tarballs is not an install:
no candidate code or lifecycle script was executed for this assessment.

There is a second blocker: the currently pinned Alchemy 2.0.0-beta.79 and Distilled 1.0.0-rc.12
accept stable v4 in peer ranges but their published JS still imports `effect/unstable/*`.
Stable Effect has no compatibility exports for those paths. Keeping those pins unchanged is
not a viable migration. Alchemy **2.0.0-beta.80**, its same-version runtime/Floci/node-utils,
and Distilled **1.0.0-rc.13** are the pending infrastructure candidates; beta.80 declares
`effect: ^4.0.0` and stable-family platform/SQL/testing ranges. beta.80 was published
2026-10-02T12:20:38.000Z, so it cannot be installed before **2026-10-09T12:20:38.000Z**.
That is a lower bound, not proof that all its changed transitives are eligible or executable.
#980 must qualify the entire new graph, review/rebase the existing Alchemy patch and justify this
required provider upgrade without changing deployed resource identities. No alias, maintained
RC/stable fork, or admission bypass is an alternative.

**#978 remains blocked on eligible candidate selection/qualification.** These dates do not
close the ticket automatically. Re-fetch metadata at admission: a newer eligible release or
changed consumer graph requires renewed assessment. Preparation checks can run on the unchanged
RC graph; only #981 promises a completely green stable revision.

## Direct pins, locked packages and consumers

All current coordinated versions are 4.0.0-rc.115. The family check reports 11 direct pins and
8 locked packages. The pending selection for every row is 4.0.0.

| Package                        | Direct owners / locked consumer                                        | Stable publication (UTC) |
| ------------------------------ | ---------------------------------------------------------------------- | ------------------------ |
| `effect`                       | root scripts; server; web; Cloudflare infrastructure; all family peers | 2026-10-01T03:11:28.537Z |
| `@effect/platform-bun`         | server test/tool roots; infrastructure CLI/tests; Alchemy runtime peer | 2026-10-01T01:47:44.402Z |
| `@effect/platform-node`        | server tooling; Alchemy/runtime optional peer resolved by server pin   | 2026-10-01T01:48:35.463Z |
| `@effect/platform-node-shared` | Bun and Node platform dependencies; exact root override                | 2026-10-01T01:47:33.378Z |
| `@effect/sql-d1`               | server D1 adapter; Alchemy D1 dependency                               | 2026-10-01T01:48:23.983Z |
| `@effect/sql-sqlite-do`        | Alchemy dependency, currently transitive only                          | 2026-10-01T01:48:26.764Z |
| `@effect/vitest`               | server and infrastructure tests; current Alchemy dependency            | 2026-10-01T01:47:59.713Z |
| `@effect/atom-react`           | web state and session-scoped registries                                | 2026-10-01T01:48:50.279Z |

The installed lockfile also has these Effect consumers, all with the broad
`>=4.0.0-rc.115 || >=4.0.0` peer: `alchemy`, `@alchemy.run/cloudflare-runtime`,
`@alchemy.run/floci`, and `@distilled.cloud/{aws,axiom,cloudflare,core,fly-io,hetzner,neon,
planetscale,prisma,railway,stripe}`. This is dependency inventory, not permission to use those
providers. Scan both dependencies and peers, and use the resolved package identity rather than
Bun's placement key: nested/qualified entries can hide another Effect runtime.

No separate platform, AI or SQL base package is installed; their modules are in `effect`.
`@effect/tsgo` is independently versioned, **not** part of the 4.0.0 lockstep. Keep 0.46.1
(published 2026-09-26T13:14:12.351Z, already eligible). Its newer 0.48.0 is too young. Keep root
TypeScript 7.0.2 and both isolated tools' TypeScript 6.0.3; their documented deferrals still apply.
The isolated dependency-cruiser and mutation installs have no Effect dependency; their source
analysis and compiler compatibility must nevertheless rerun after import changes.

### Peer and non-family compatibility

- Stable platform packages peer `effect ^4.0.0`; both require node-shared `^4.0.0`. Retain its
  exact root override. Also pin transitive `@effect/sql-sqlite-do` to 4.0.0 during resolution so
  Alchemy's range cannot advance it independently. The checker rejects drift either way.
- Stable D1 requires `@cloudflare/workers-types ^5.20260926.1`, matching the server's direct pin.
  SQLite DO peers the same types range. D1 semantics still require real isolated adapter tests.
- Stable Vitest peers `>=5.0.0 <6.0.0`, matching Vitest and Istanbul provider 5.0.2. No Vitest
  major bump or native arbitrary rewrite is required merely by this selection.
- Stable Atom React peers React `>=19 <20` and scheduler `>=0.25 <0.28`. React 19.3.0 qualifies.
  Web's scheduler 0.28.0 does **not** satisfy the Atom peer; Bun currently places scheduler
  0.27.0 under Atom. Preserve and verify that nested resolution (or deliberately align the web
  pin after eligibility review), rather than falsely claiming the direct scheduler satisfies it.
- Stable platform-node changes Undici from `^8.10.2` to `^8.11.2` and node-shared changes ws
  from `^8.21.3` to `^8.22.0`. The existing `undici@^7` override does not cover that Node chain.
  Recheck publish age, engines, peer warnings and SCA for the actual resolved versions; do not
  reuse the current transitive lock blindly. Node 26.5.0 exceeds the declared Node >=18 minimum.
- Alchemy beta.80 introduces additional dependency families. A compatible peer manifest is
  evidence for a candidate only, not proof that its implementation, patch or transitives work.

## Source-backed breaking changes

The stable npm source tarballs were SHA-512 checked against their registry `dist.integrity`.
Use versioned source links below, not the installed RC or the stale vendored `.repos/effect`
snapshot, as authority for stable APIs. Upstream's release commit is
`67ba4e46a11ccda0b6761578bfd22c04ae00167d`; its migration guide is a general v3-to-v4 guide,
not a complete rc.115-to-stable delta. Diffing installed RC source against published 4.0.0
source identified the following applicable work:

| Change                                                                                                                                                 | Existing consumer / preservation checkpoint                                                                                                                                                                                                                   |
| ------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Remove `unstable/` from module imports; `httpapi` also becomes `http-api`                                                                              | server declarations and HTTP, native adapters, web Atom/HTTP, scripts and upstream Alchemy/Distilled. No old-path re-exports. `effect/unstable/schema` becomes `effect/schema`; arbitrary moves to top-level `effect/Arbitrary`, not `effect/arbitrary`.      |
| `Encoding` removed; use `Hex` / `Base64Url` from `effect/encoding` with `encode`, `decode`, `decodeString`                                             | PAT/web-session entropy, digests, webhook proof, Wompi, statement staging, admission, release smoke and web generated references. Retain exact encoding and Result-based rejection behavior.                                                                  |
| `Schema.isStartsWith` → `isStartingWith`; `isLengthBetween` → `isBetweenLength`                                                                        | secret-material and Outbound HTTP credential checks, native Wompi and forwarded-email time-zone length. Other upstream renames are `isEndingWith`, `isIncluding`, `isBetweenSize`, `isBetweenProperties`; repository has no current calls to their old names. |
| `Schema.brand` is type-only, requires a single concrete literal; brand no longer annotates the AST                                                     | 138 brand call sites; verify generated JSON Schema identifiers and nominal types. Do not assume all artifact changes preserve wire meaning.                                                                                                                   |
| `SchemaGetter.Getter` becomes a tagged union; instance `run`/composition moves to module functions; `SchemaTransformation.make` → `makeTransformation` | Money uses `SchemaGetter.transform`, which still exists. No repository calls to removed Getter constructor/onNone/onSome or Transformation.make were found. Keep Currency precision, plain decimal encoding and bidirectional rejection tests.                |
| partition results become success-first across modules                                                                                                  | No repository `.partition(` call was found; record non-applicability rather than swapping unrelated tuples.                                                                                                                                                   |
| HTTP API decoding gains slot-specific parse options; schema compiler and JSON Schema projection changed                                                | canonical reflection, emitted OpenAPI, clients, outgoing failures and checked boundary behavior need semantic review, not blanket artifact acceptance.                                                                                                        |

Source references:

- [Release and upstream migration entrypoint](https://effect.website/blog/releases/effect/40).
- [Release-pinned migration guide](https://github.com/Effect-TS/effect/blob/67ba4e46a11ccda0b6761578bfd22c04ae00167d/MIGRATION.md).
- [Published stable exports](https://unpkg.com/effect@4.0.0/package.json).
- [Schema](https://unpkg.com/effect@4.0.0/src/Schema.ts): brand 5072–5150;
  isStartingWith 6959; isBetweenLength and other renamed checks are in the same module.
- [SchemaGetter](https://unpkg.com/effect@4.0.0/src/SchemaGetter.ts) and
  [SchemaTransformation](https://unpkg.com/effect@4.0.0/src/SchemaTransformation.ts): makeTransformation 384.
- [Hex](https://unpkg.com/effect@4.0.0/src/encoding/Hex.ts): encode 32, decode 179;
  [Base64Url](https://unpkg.com/effect@4.0.0/src/encoding/Base64Url.ts): encode 40, decode 68, decodeString 122.
- [HTTP API](https://unpkg.com/effect@4.0.0/src/http-api/HttpApi.ts),
  [stable D1 manifest](https://unpkg.com/@effect/sql-d1@4.0.0/package.json),
  [stable Atom manifest](https://unpkg.com/@effect/atom-react@4.0.0/package.json).
- npm packuments: `https://registry.npmjs.org/<percent-encoded-package-name>`; read
  `time[version]`, `dist-tags.latest`, `versions[version].{dependencies,peerDependencies,engines,dist}`.
  Example: [Effect metadata](https://registry.npmjs.org/effect),
  [Alchemy metadata](https://registry.npmjs.org/alchemy).

## Pre-migration verification evidence

All successful behavioral/build checks below ran with unchanged rc.115 dependencies and
unchanged application sources. They are a focused baseline, **not a full verification claim**.
No stable tests or runtime probe ran before admission.

| Command                                                                                                   | Result                                                                              |
| --------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| `bun install --frozen-lockfile`                                                                           | 735 packages installed; no incorrect-peer warning, tracked lockfile unchanged       |
| `bun install --cwd tools/depcruise --frozen-lockfile`                                                     | passed; prerequisite for JS type-aware tooling                                      |
| `bun run check:effect-family`                                                                             | passed: 11 direct / 8 locked rc.115 packages                                        |
| `bun run typecheck`                                                                                       | passed                                                                              |
| `bun run lint:type-aware`                                                                                 | passed after isolated tool installation                                             |
| `bun run lint:dependencies`                                                                               | passed: 82 pins, 0 failing, 6 existing warnings/deferrals; no Effect deferral added |
| `bun run lint:deps`                                                                                       | passed, including server/web ownership and negative probes                          |
| `bun run contracts:check:freshness`                                                                       | passed                                                                              |
| `bun run --cwd apps/server check:browser-client`                                                          | passed                                                                              |
| `RELEASE_GIT_SHA=00f50e621c353d01d30781d2a00c77314394ace2 bun run --cwd apps/web build:production`        | passed                                                                              |
| `bun run --cwd apps/server test:core -- src/core/_shared/money.test.ts --coverage.enabled=false`          | 15 passed                                                                           |
| `bun run --cwd apps/server test -- src/shell/canonical-catalog/contract.test.ts --coverage.enabled=false` | 4 passed                                                                            |
| `bun run --cwd apps/server test:cloudflare -- cloudflare/web-session/operations.test.ts`                  | 7 passed                                                                            |
| `bun run --cwd apps/web test -- src/session/session.test.tsx src/transport/canonical-query.test.ts`       | 7 passed across 2 files                                                             |
| `bun run --cwd infra/cloudflare test -- production-preflight.test.ts`                                     | 8 passed                                                                            |

Initial typecheck/lint attempts before root installation lacked binaries; the first lint attempt
after root installation lacked the isolated compiler install and produced unsafe/error-type
reports in dependency-cruiser. Both were setup failures, resolved without source edits. The
first focused Money invocation enabled whole-core coverage and failed its global threshold
although all 15 assertions passed; the corrected focused command above disables coverage.
Do not lower coverage thresholds for full suites. No unresolved behavior failure was found in
these focused baseline checks. Full core/native/web coverage, actual browser journeys, live
Workers AI, Linux verification and SCA were **not run**; their absence is not a pass.

The preparation's CLI-seam tests use synthetic stable manifests/locks while executing the
checker on installed rc.115. Red-green probes demonstrated stable rejection before the change,
and previously missed stale workspace declarations and direct/qualified/locked overrides.
This is a coordination check, not an age or API compatibility checker; dependency policy,
frozen install, ownership and browser publication remain independent required gates.

## Repeatable integration procedure and handoff

The shared branch is **`integration/effect-4-stable`**, rooted at this preparation. The task
branch remains `978`; its preparation commit is also published to the shared integration
branch. #979 and #980 start from that branch and integrate reviewed batches there; #981
completes the same sequence. Do not merge any migration batch to trunk or deploy intermediate
mixed-family code. Do not confuse ready-for-agent with independent merge readiness. Only the
complete #981 revision is the merge gate. No PR to trunk, deployment, onboarding or launch is
authorized here. Existing trunk-only PR CI does not validate intermediate integration commits.

1. **Re-establish baseline.** Use an isolated task worktree at the integration tip, install root
   and dependency-cruiser with frozen locks, record revision/OS/Bun/Node, and rerun the matrix
   above. Investigate new failures against this baseline before attributing them to migration.
2. **Admission and coordinated resolution.** After all required candidates meet 604,800 seconds,
   re-fetch packuments; confirm latest/age, integrity, provenance, engines and peer ranges for
   every newly resolved dependency. Never add an exclusion or early-install flag. Update all
   eleven direct family pins together plus node-shared and SQLite DO exact overrides. Resolve
   Alchemy's necessary stable-compatible graph in this same integration sequence. Run normal
   `bun install`, inspect the entire lock diff, then reproduce with a clean frozen install.
   Reject peer warnings and any duplicate/mixed Effect family. Keep the independently versioned
   toolchain pins unless newly demonstrated incompatibility requires an eligible upgrade.
3. **#979 portable batch.** Migrate core/shell imports, Schema and canonical/browser-safe
   declarations at their owners. Run Money, changed owner, canonical catalog/policy, provider
   and contract test files with focused coverage disabled. Run typecheck regularly and lint
   type-aware after the first slice and final edit. Generate contracts on the candidate only
   after declarations load; inspect semantic input/output/access drift before accepting output.
   Record remaining native/web/tool errors explicitly; never claim full green from a filtered run.
4. **#980 native batch.** Migrate D1/Workers/coordinator/provider/runtime and infrastructure
   consumers, including required Alchemy/Distilled changes. Run changed adapter files through
   `test:cloudflare`, plus affected infrastructure tests. Preserve existing two-User, live
   revocation, rollback, replay, bounded-body, interruption and durable settlement cases. Do not
   rewrite D1 baselines, deploy, reset resources or change provider identities. Reconcile native
   interfaces with #979; commit the batch only on the integration sequence if others remain red.
5. **#981 web/tooling and final gate.** Migrate Atom/HTTP/auth-lifetime state, tests, root scripts
   and remaining source-analysis fixtures/rules. Refresh `.repos/effect` and affected `.patterns`
   references to the selected stable source rather than retaining RC guidance as current.
   Repeat session/canonical-query and changed web/tool tests, then build the actual artifact.
   Run all six default `bun run verify` groups (static, builds, unit, cloudflare-adapters,
   cloudflare-infra, browser), preserving full coverage thresholds and real ingress/Core
   browser journeys. Run affected mutation evidence through `--group mutation` where required;
   it is not included by default. Inspect generated-contract freshness, release/edge policy,
   dependency/ownership negative probes, browser publication and SCA at that exact revision.
6. **Final handoff.** Record every command/verdict and any unresolved limitation; no gate may be
   waived because a prior batch was intentionally red. Remove temporary probes, compatibility
   aliases and RC implementations. Review the entire integration diff against the original base,
   then obtain the complete required Linux CI checks before any trunk merge. Merge readiness
   still confers no Production or launch permission.
