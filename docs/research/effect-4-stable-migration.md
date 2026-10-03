# Coordinated stable Effect migration baseline (#978)

## Decision and explicit admission exception

Recorded 2026-10-03 against Fidy `00f50e621c353d01d30781d2a00c77314394ace2`,
Bun 1.4.1, Node 26.5.0, macOS arm64. Parent #33's live body supersedes its old local-stdio
planning comment. This preparation introduces no MCP/OAuth authority or product behavior.

**Selected graph: Effect 4.0.0, Alchemy 2.0.0-beta.80 and Distilled 1.0.0-rc.13.**
All eight coordinated packages use exactly 4.0.0, not stable v3/0.x alternatives. npm's `latest`
tag is 4.0.0 for each. The User explicitly authorized bypassing the seven-day cooldown in this
session; the exception is recorded in [#978's admission comment](https://github.com/B4rz99/fidy-ai/issues/978#issuecomment-5970385461).
This is a one-time admission exception for this recorded candidate, **not normal policy eligibility**.
Root `bunfig.toml` still requires 604,800 seconds without exclusions. No age-policy checker,
CI configuration, ownership check or browser-publication gate is weakened. A subsequent candidate
or unrelated upgrade does not inherit this authorization. Full stable verification, trunk merge,
deployment and launch remain separate gates.

Without the exception, the family is admitted no earlier than **2026-10-08T03:11:28.537Z**;
Alchemy beta.80 no earlier than **2026-10-09T12:20:38.000Z**. The earlier assessment only read
registry metadata and integrity-verified tarballs. The executable qualification below ran later,
in an isolated detached worktree, with explicit `--minimum-release-age=0 --ignore-scripts`;
the only lifecycle command then run explicitly was the repository's TypeScript compiler patch.
The normal preparation checkout remains on rc.115.

The currently pinned Alchemy beta.79 and Distilled rc.12 accept stable peers but import removed
`effect/unstable/*` paths. Their selected replacements use stable namespaces. beta.80 declares
`effect: ^4.0.0` and stable-family platform/SQL/testing ranges; its same-version runtime, Floci
and node-utils and every resolved Distilled consumer are included in the frozen candidate.
The old Alchemy patch **cannot be reused unchanged**: Bun accepts its old offsets but creates
invalid TypeScript. The candidate snapshot includes an equivalent patch rebased onto beta.80;
a clean frozen replay and upstream import probe pass. #980 must still prove provider behavior
and preservation of deployed resource identities. No aliases or RC/stable implementation fork
are introduced.

**The admission and dependency-load blockers are removed for this candidate.** #978 now has an
exact replayable selection, but the untouched application is intentionally not stable-compatible:
#979–#981 own those API migrations and only #981 promises a completely green stable revision.
An existing SCA finding is recorded below, not waived by the cooldown exception.

## Direct pins, locked packages and consumers

All current coordinated versions are 4.0.0-rc.115. The family check reports 11 direct pins and
8 locked packages. The selected version for every row is 4.0.0.

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
- Alchemy beta.80 introduces additional dependency families. The frozen resolution and module-load
  probes below establish installation/import compatibility, not live provider or resource parity.

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
No stable tests or runtime probe ran before the explicit admission exception.

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

## Admitted candidate qualification and replay

The generated [`effect-4-stable-candidate.patch`](effect-4-stable-candidate.patch) freezes the
four manifest changes, complete lockfile delta, and rebased beta.80 patch against preparation
commit `2a3b0e7ce267e008f2d2ab30ed6c6a357c98029b`. It is evidence and an integration input,
not an applied runtime upgrade in this preparation branch. Apply it only in the shared migration
sequence. The resulting `bun.lock` SHA-256 is
`21e35b52db3930feea44ee9e4f921a81e88a28153a23042faecdab711ce199e1`.

The actual delta has **38 new resolved package identities**. Registry version records and
`dist.integrity` match each new lock entry; Bun's normal integrity verification was retained.
All declared Node engine minima are satisfied by Node 26.5.0. This is not a cryptographic
provenance-attestation verification claim. Source scans found no removed `effect/unstable` or
`effect/Encoding` JS imports in the installed Alchemy/Distilled packages; no incorrect-peer
warning appeared. The family checker confirms one exact family. Nested Atom scheduler 0.27.0
is retained; Node resolves Undici 8.11.2 and node-shared resolves ws 8.22.0.

The additional consumers are `@alchemy.run/node-utils@2.0.0-beta.80`,
`@alchemy.run/sigil@0.1.0-alpha.1`, `@neon/functions@0.11.0`, and Distilled
`{acme,doppler,gcp,infisical,zerossl}@1.0.0-rc.13`. All previously inventoried Distilled
packages move to rc.13. Alchemy runtime resolves workerd and its five platform binaries to
1.20260918.1; the other new identities are the eight coordinated packages, four beta.80
Alchemy packages, Undici and ws. No independent TypeScript, tsgo, Vitest or React pin changes.
Provider inventory does not authorize using additional providers.

Replay in an isolated checkout at that preparation revision (or its unchanged-manifest descendants):

```sh
git apply --check docs/research/effect-4-stable-candidate.patch
git apply docs/research/effect-4-stable-candidate.patch
bun install --frozen-lockfile --minimum-release-age=0 --ignore-scripts
bun run postinstall
bun run check:effect-family
bun -e 'await import("alchemy"); await import("alchemy/Cloudflare"); await import("@effect/sql-d1"); await import("@effect/platform-node/NodeHttpClient"); await import("@effect/platform-bun/BunRuntime"); console.log("stable upstream module imports passed")'
```

Use the explicit age flag only under the recorded exception, and omit it once the entire graph
is normally eligible. Do not turn it into a committed install script or CI setting. Applying the
patch intentionally makes untouched application sources red; it is not a deployable revision.
At the original preparation commit, obtain the evidence patch from this document's follow-up
commit before replaying. The exact patch leaves the old beta.79 patch file unused; #980 removes
that obsolete file when adopting the beta.80 patch into the real integration manifests.

| Candidate command / probe                                                                                 | Result                                                                                                       |
| --------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `git apply --check` and actual application after resetting the probe to its base                          | passed; nested patch context blank lines produce a harmless Git whitespace warning                           |
| clean `bun install --frozen-lockfile --minimum-release-age=0 --ignore-scripts` plus `bun run postinstall` | passed; lock checksum unchanged, compiler patch applied                                                      |
| `bun run check:effect-family`                                                                             | passed: 11 direct / 8 locked 4.0.0 packages                                                                  |
| upstream import command above, after that clean replay                                                    | passed, including Alchemy's Cloudflare Worker provider and selected D1/Bun/Node platform modules             |
| `bun run --cwd infra/cloudflare test -- production-preflight.test.ts`                                     | 8 passed after rebased frozen replay                                                                         |
| `bun run typecheck`                                                                                       | fails: 750 diagnostics on unchanged application/fixture imports and API changes; this is migration work      |
| focused Money command from the RC baseline                                                                | fails before collecting tests: removed `effect/unstable/arbitrary/Arbitrary` import; not a passing Money run |
| `bun audit`, on both RC and selected stable locks                                                         | both fail on the same existing high `braces@3.0.3` advisory via web/shadcn/fast-glob/micromatch              |

The SCA finding is [GHSA-vfj7-8cjw-p6xm](https://github.com/advisories/GHSA-vfj7-8cjw-p6xm).
It is pre-existing and not caused by this graph delta, but must be addressed before the final
merge gate; this exception does not waive SCA. Full stable owner/native/browser suites,
Linux verification, provider read/rollout behavior and provenance-attestation checks are still
unverified. The TypeScript and Money failures are migration regressions relative to the green
RC baseline, not pre-existing failures. No semantic contract regeneration was accepted here.

Registry/source references for the selected graph:
[Alchemy beta.80](https://unpkg.com/alchemy@2.0.0-beta.80/package.json),
[unpatched Worker provider](https://unpkg.com/alchemy@2.0.0-beta.80/src/Cloudflare/Workers/WorkerProvider.ts)
(read observation at 5587–5710; compiled counterpart at 4133–4240),
[Distilled core rc.13](https://unpkg.com/@distilled.cloud/core@1.0.0-rc.13/package.json),
[Alchemy runtime](https://unpkg.com/@alchemy.run/cloudflare-runtime@2.0.0-beta.80/package.json),
[Alchemy node-utils](https://unpkg.com/@alchemy.run/node-utils@2.0.0-beta.80/package.json),
[Sigil](https://unpkg.com/@alchemy.run/sigil@0.1.0-alpha.1/package.json),
[Neon Functions](https://unpkg.com/@neon/functions@0.11.0/package.json).
The candidate patch records every exact package identity, integrity, dependency and peer edge;
registry packuments cited above own the publish times.

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
2. **Admission and coordinated resolution.** Replay the recorded candidate above under the
   explicit admission exception, or use normal age-enforcing installation after every package
   qualifies. Keep the exact snapshot rather than freshly resolving ranges under the exception.
   Any changed candidate requires renewed admission assessment. Confirm integrity, provenance,
   engines and peer ranges for every newly resolved dependency; retain all eleven direct family
   pins together plus node-shared and SQLite DO exact overrides. Alchemy's required replacement
   graph and rebased patch belong in this same integration sequence. Inspect the entire lock diff
   and reproduce with a clean frozen install. Reject peer warnings and any duplicate/mixed Effect
   family. Keep independently versioned toolchain pins unless demonstrated incompatibility
   requires an admitted upgrade. Do not add reusable age exclusions or weaken CI/install policy.
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
