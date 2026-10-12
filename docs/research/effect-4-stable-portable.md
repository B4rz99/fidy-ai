# Portable stable Effect migration (#979)

**Historical intermediate checkpoint (2026-10-03), not an outstanding portable migration.**
The complete migration subsequently merged and released through [PR #992](https://github.com/B4rz99/fidy-ai/pull/992).
See [the integration report's final outcome](effect-4-stable-integration.md#final-outcome) for review,
CI, and release evidence. Pending review, failed full-graph checks, branch names, and retained old
patches below describe this intermediate batch, not the final result or current worktree.

## Scope and integration state

Implemented against preparation tip `e5635f5f6a528f4154ee433e4e583828ed2d56f3`, on the
current task branch `978`, for publication to `integration/effect-4-stable`. The authoritative
scope is #979 and the live body/comments of parent #33. This batch adds no MCP/OAuth authority,
product feature, Production deployment, onboarding or launch enablement.

The admitted [candidate snapshot](https://github.com/B4rz99/fidy-ai/blob/e5635f5f6a528f4154ee433e4e583828ed2d56f3/docs/research/effect-4-stable-candidate.patch) is now **applied**: all
11 direct pins and eight locked coordinated packages use exactly 4.0.0, with Alchemy beta.80
and Distilled rc.13. Do not apply that preparation snapshot again to this revision. Its lock
SHA-256 remains `21e35b52db3930feea44ee9e4f921a81e88a28153a23042faecdab711ce199e1`.
The rebased beta.80 patch is installed; the unused beta.79 patch is retained for #980 to remove.
The patch is byte-exact to the admitted snapshot. Git flags its blank unified-diff context line
as trailing whitespace; that significant patch syntax is preserved, not stripped to appease
`diff --check`. The whitespace check passes for the rest of the staged change.
The web and infrastructure manifest changes are the already-qualified coordinated resolution,
not implementation of their remaining migration slices. Independent toolchain pins are unchanged.

Installation used the User's recorded one-time release-age exception:
`bun install --frozen-lockfile --minimum-release-age=0 --ignore-scripts`, followed explicitly by
`bun run postinstall`. No permanent age exclusions, install scripts or CI waivers were added.
The original [#978 report](effect-4-stable-migration.md) describes the historical RC baseline
and candidate qualification; this document records the subsequent applied portable batch.

## Changes and preservation checkpoints

- Portable core/shell consumers now import `effect/http-api`, `effect/http`, `effect/sql`,
  `effect/ai`, `effect/schema` and `effect/Arbitrary` directly. There are no old-path aliases,
  forwarding wrappers or alternate RC implementations.
- Wompi credential-prefix checks use `Schema.isStartingWith`. The portable PAT digest,
  outbound payment signature and WhatsApp proof decoder use `Hex.encode` / `Hex.decode`
  from `effect/encoding`. Entropy, digest algorithms, bytes, lowercase spelling, safe failures,
  limits, interruption and authoritative access decisions are unchanged.
- Money retains its bidirectional Schema transformation, exact BigDecimal arithmetic,
  Currency precision and normalized non-exponent decimal wire encoding. A new encoding
  negative test complements existing decoding, property-roundtrip and CurrencyMismatch tests.
- Stable `Schema.brand` no longer adds AST annotations. Existing nominal brands use concrete
  literals and existing explicit identifiers; the portable compiler reports no brand/type errors.
  No Published Trio boundaries, declarations, caller classes or ownership publications changed.
- Contract generation imports the stable public API. The browser still publishes only its
  declaration graph, not server operations, persistence, runtime construction or raw SQL.

Source authority is the installed, integrity-verified **effect@4.0.0** source, not the stale
vendored RC reference. In particular: `src/Schema.ts` brand at 5118, pattern projection at
6656, prefix check at 6959, UTF-16 length projection at 8146; `src/encoding/Hex.ts` encode
at 32 and decode at 179; and `src/http-api/OpenApi.ts`. The topic patterns were consulted;
#981 still owns refreshing the upstream checkout and pattern citations.

## Generated artifact review

A new assembled-OpenAPI test failed when stable Effect dropped the Money, canonical-operation-id
and PAT text patterns. Stable `Schema.isPattern` exports a JSON Schema pattern only for supported
Unicode-mode regexes. Adding `u` to these ASCII-only patterns and PAT regex constructors restores
those constraints without changing their accepted text. The test then passes. No hand-written
parallel JSON Schema or artifact patch was used.

The generated PAT-pairing OpenAPI is byte-for-byte unchanged. The operation-policy artifact is
byte-for-byte unchanged, including all **55** identities, access, tier and confirmation policies.
The canonical OpenAPI has additional anonymous object components and renumbered local references.
A reference-resolving comparison of every path, reachable schema, security declaration and API
metadata made 9,842 comparisons and found only these four projected differences:

1. Search `q` changes `minLength: 2` to `1`, both in its query parameter and its nested suggested
   call schema. Stable projects the safe code-point lower bound for a two-UTF-16-unit runtime
   check. It does **not** relax runtime validation. A catalog-input test still rejects one ASCII
   unit, accepts a two-unit supplementary character and rejects 81 units.
2. The two review-list paging parameters change `required: true` to `false`. Their existing
   `OptionFromOptionalKey` codecs already permit omission. A catalog-input test decodes the
   omitted values to `Option.none()`; no new default, permission or pagination behavior is added.

These are explicit corrections to the description of existing accepted input, not blanket
acceptance of artifact churn or changes to wire decoding. The PAT-pairing reference comparison
made 288 comparisons with no differences. Regex constraints, exact Money encoding, canonical
failure envelopes and operation-policy meaning are preserved. No semantic contract change was
accepted merely because generation produced it.

## Ownership protection

The old namespace-specific rules silently admitted stable raw HTTP/model imports, and the
browser checker admitted a SQL re-export. Before correction, three targeted illegal graphs
passed and a temporary SQL re-export built a 147-module "browser-safe" graph. Rules now target
stable paths; the same probes reject with the exact raw-HTTP, hosted-model and native-agent rule
names, and the SQL re-export is rejected. All temporary exports/probes were removed.

Existing enduring dependency-probe imports and the exact expected HTTP edge were migrated too.
This narrow guard maintenance is required to preserve #979's ownership/browser-safe acceptance,
not a waiver of #981's complete source-analysis verification. No ownership rule was disabled
or loosened. The clean portable graph contains 313 modules and 1,314 dependencies; the real
browser declaration graph contains 131 bundled modules.

## Verification evidence

Recorded on macOS arm64, Bun 1.4.1 / Node 26.5.0. Logs and the temporary reference comparator
are under `/tmp/fidy-979-evidence/`. Focused coverage is disabled only for focused invocations;
full-suite thresholds are unchanged.

| Check                                                                           | Result                                                         |
| ------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| frozen candidate install, explicit compiler patch, Effect-family checker        | passed; 11 direct / eight locked 4.0.0 packages                |
| `bun test scripts/check-effect-family.test.ts`                                  | 22 passed                                                      |
| focused pure Money/PAT/canonical-capability files                               | five files, 36 passed                                          |
| focused portable owner/provider/catalog/codec files listed below                | 24 files, 130 passed                                           |
| `bun run test:contracts`                                                        | two files, four passed                                         |
| `bun run contracts:check:freshness`                                             | passed                                                         |
| `bun run --cwd apps/server email-formats:check`                                 | passed; interpretation artifact unchanged                      |
| `bun run --cwd apps/server check:browser-client`                                | passed; 131 modules                                            |
| `bun tools/depcruise/run.mjs apps/server src tools/contracts`                   | passed; full requested portable graph                          |
| scoped typecheck using the disposable config below                              | passed; no portable diagnostics                                |
| scoped type-aware lint with the unchanged root config, plus `check:lint-guards` | passed                                                         |
| scoped namespace/SQL negative probes                                            | demonstrated red before rule changes and exact rejection after |
| `bun run format:check`                                                          | passed                                                         |

The pure files are `src/core/_shared/money.test.ts`, `src/core/tokens/{model,pairing,rules}.test.ts`
and `src/core/canonical-operations/contract.test.ts`, run through server `test:core` with
`--coverage.enabled=false`.

The 24 focused server `test` files are:

```text
src/shell/canonical-catalog/contract.test.ts
src/shell/canonical-operations/{implementation,registry,suggested-operations}.test.ts
src/shell/canonical-policy/operations.test.ts
src/shell/tokens/pairing-contract.test.ts
src/shell/partial-input/contract.test.ts
src/shell/observability/registry.test.ts
src/shell/memory/operations.test.ts
src/shell/subscription/queries.test.ts
src/shell/ingestion/internal/column-mapper.test.ts
src/shell/hosted-inference/{conformance,operations,workers-ai}.test.ts
src/shell/email-authentication/runtime.test.ts
src/shell/outbound-http/operations.test.ts
src/shell/channels/whatsapp/{kapso-client,kapso-webhook,image-webhook}.test.ts
src/shell/schema-codecs/contract.test.ts
src/shell/public-http/operations.test.ts
src/shell/budgets/operations.test.ts
src/shell/dashboard/{operations-view,errors}.test.ts
```

For the scoped typecheck, create a disposable JSON config inside `apps/server`, extending the
unchanged application config (the compiler's alias, strictness, library and diagnostic policies
are retained):

```json
{
  "extends": "./tsconfig.json",
  "compilerOptions": { "composite": false, "noEmit": true },
  "include": ["src/**/*.ts", "src/**/*.tsx", "src/**/*.json", "tools/contracts/**/*.ts"],
  "exclude": ["node_modules", "cloudflare", "scripts"]
}
```

Run `bun node_modules/typescript/bin/tsc -p apps/server/<disposable-config>.json`, then remove
the config. This is scoped evidence, not an altered project-reference gate. Scoped lint command:

```sh
bunx --no-install oxlint --deny-warnings --config .oxlintrc.json --type-aware \
  apps/server/src apps/server/tools/contracts \
  apps/server/scripts/check-browser-client.ts \
  apps/server/scripts/check-dependency-guards.ts apps/server/.dependency-cruiser.mjs
bun run --cwd apps/server check:lint-guards
```

## Remaining integration gates and review status

The mandatory first and final full-root lint/typecheck commands were run, not omitted:

- `bun run lint`: fails on two unchanged native checks (`isLengthBetween` in forwarded email,
  `isStartsWith` in Wompi). These belong to #980.
- `bun run lint:type-aware`: fails in the unmigrated native, infrastructure, web and tooling
  slices; no diagnostics in the changed portable source, contract generator or guard files.
- `bun run typecheck`: 446 diagnostics: 49 native server, 199 web, 182 infrastructure, 16 tooling;
  zero portable-source diagnostics. The applied candidate started with 750 diagnostics.
- The full server ownership graph and dependency-probe batch fail on unresolved imports in
  the remaining slices. The empty-graph fail-closed probe succeeds; the allowed full batch
  cannot pass yet. Scoped guard evidence does not replace this final gate.
- `bun run lint:dependencies` cannot load the unmigrated root checker's old HTTP import. #981
  must migrate it and recheck the admitted graph; its age policy must remain unchanged.
- The pre-existing high `braces` SCA advisory recorded by #978 is not waived and remains a
  complete-#981 merge requirement.

**The three-axis `/code-review` is blocked at its mechanical-gate step.** Its rules prohibit
spawning reviewers while full-root lint/typecheck fail. No independent no-findings review is
claimed. #979 remains open pending that review; implementing outside-scope slices merely to
make this batch independently green is not authorized. The final integration review must include
this batch against preparation tip `e5635f5f6a` (and the entire migration against #978's original
base), not omit it because its focused tests passed.

#980 consumes the migrated declarations/SQL types and installed beta.80 patch, migrates native
HTTP/encoding/checks and infrastructure, removes the unused beta.79 patch, and proves D1/provider
parity. #981 consumes the unchanged `@fidy/server/client` publication using stable HTTP API/Atom
modules, migrates tooling/fixtures and patterns, completes every root/Linux/security/browser
verification gate, and finishes independent review. No new public signature or caller authority
is introduced for those consumers. This revision is an integration batch, **not merge-ready or
deployable**; no intermediate trunk PR or deployment is authorized.
