# Effect 4.0.0-rc.112 admission evidence

Evidence collected on 2026-08-30 for issue #423, before accepting the candidate lockfile.

## Admission method

The candidate `bun.lock` was generated once in this isolated worktree by transiently changing only
this worktree's `bunfig.toml` from `minimumReleaseAge = 604800` to `minimumReleaseAge = 0` for one
`bun install`. Immediately afterward, `bunfig.toml` was restored from `origin/trunk` and compared
byte-for-byte. Both files had SHA-256
`2b722e6668912e0a8ff3a858b226f34a164804d7a96561f1e10eb25eb2c6dfea`; `git diff --exit-code
origin/trunk -- bunfig.toml` passed. No exclusion, reusable bypass, or policy change was added.

## Registry and verification evidence

Publish times, integrity values, signature counts, and attestation availability came independently
from the npm registry packuments and exact-version metadata. Every integrity below exactly matches
`bun.lock`.

`npm@11.17.0` then installed the exact candidate family in a temporary directory and ran
`npm audit signatures --include-attestations`. It exited 0: **87 packages had verified registry
signatures and 34 had verified attestations**. Thus every upgraded package has a verified registry
signature; all seven Effect-family packages also have verified npm publish and SLSA provenance
attestations. The three PostgreSQL packages publish registry signatures but no provenance
attestation, so provenance is recorded as unavailable rather than implied.

| Package                        | Version        | Published (UTC)            | Dist integrity                                                                                    | Provenance            | Verification                                      |
| ------------------------------ | -------------- | -------------------------- | ------------------------------------------------------------------------------------------------- | --------------------- | ------------------------------------------------- |
| `@effect/ai-openai`            | `4.0.0-rc.112` | `2026-08-25T00:01:08.000Z` | `sha512-j2X86xvgpAtNiusyESADHZn3PUzMVatE1zWXd0No2aybx/euKiVBVWZOtzq7ntJ5KvPHRBOFXTGPADdApQrwug==` | npm publish + SLSA v1 | registry signature and both attestations verified |
| `@effect/atom-react`           | `4.0.0-rc.112` | `2026-08-25T00:01:07.150Z` | `sha512-Ksf90KQa6D4UDnMj4M84arlVKNIuwxxF2GvgXBzuaYi2LsgririsUhKQ5SYaK1euf8oIYeamEuthoZSbUQmIhw==` | npm publish + SLSA v1 | registry signature and both attestations verified |
| `@effect/platform-bun`         | `4.0.0-rc.112` | `2026-08-25T00:01:25.653Z` | `sha512-Y5n2HhV/vsbrJls9ukX42RL7zqXQxISHegWFsP9njsCyDmGTnq7QYSO82rglwrLPwtTrv5dkSRTuGw4+oXxgMg==` | npm publish + SLSA v1 | registry signature and both attestations verified |
| `@effect/platform-node-shared` | `4.0.0-rc.112` | `2026-08-25T00:02:12.650Z` | `sha512-ttjz0xKamFN7vL8pNDYVwddJLjZvqKePc05djlz2VcdaKbLsnYbtMnL1rbOfHgEnIUSHGh7FkjaN4DM1Ov81sQ==` | npm publish + SLSA v1 | registry signature and both attestations verified |
| `@effect/sql-pg`               | `4.0.0-rc.112` | `2026-08-25T00:01:13.827Z` | `sha512-UYUA3LAGH1Pg88Yau7eTlTLHRrIb/uTdxdPGxVcRdIjjrTzxtA7iKHR4hcmUeq5lQEcGLCopN7E4ffsAKF8vEQ==` | npm publish + SLSA v1 | registry signature and both attestations verified |
| `@effect/vitest`               | `4.0.0-rc.112` | `2026-08-25T00:01:19.296Z` | `sha512-mEKh/FI64mt8JK1/v9mpOrJYdnp+UFZdRUBMEdZMiKz7klg6NPqVgg/oeAGH6wOOQc2iAPcfc2H9BbAv1KyzMQ==` | npm publish + SLSA v1 | registry signature and both attestations verified |
| `effect`                       | `4.0.0-rc.112` | `2026-08-25T00:41:14.148Z` | `sha512-wXxwuh1Ywnv4cPRM3Wfa0vDwuOHnZ1TsTgHJkG9XgzND6inhBH9n1vBxhg3iIXOia/OrpmvVmd3lrD4vq6bF3A==` | npm publish + SLSA v1 | registry signature and both attestations verified |
| `pg`                           | `8.23.0`       | `2026-08-08T19:27:05.108Z` | `sha512-Ip2EQCngowJLGOfCwkFhPXU7/ljlhn6Rxlmy4XYfL2Y+vyRM59+8uR2xqRWKdYmbXmxCFOAmKxBuSUCdF34qLg==` | unavailable           | registry signature verified                       |
| `pg-cursor`                    | `2.22.0`       | `2026-08-08T19:26:03.800Z` | `sha512-knzXLKqarTjOvb3qDSW0JiGsazmxwEKXrqHfWRte7XUsOYccQRafn3BLnQobWwInkzFJSyOej8y8cQRh2z3kGw==` | unavailable           | registry signature verified                       |
| `pg-protocol`                  | `1.16.0`       | `2026-08-08T19:26:03.882Z` | `sha512-sILXutLVjCLjcDuOmvhX5e2Z4cS5qG/6Bu3VkpFwdf/633ElGLpEh9bgmuI5I4sqKqkifQiGyiCcx1HdtrK7tg==` | unavailable           | registry signature verified                       |

## Resolved graph

The coordinated-family checker derives the graph from workspace manifests and `bun.lock`; it
reported **9 direct and 7 locked packages**, all exactly `4.0.0-rc.112`.

- Root: `effect`, `@effect/platform-bun`; override: `@effect/platform-node-shared`.
- Server: `effect`, `@effect/ai-openai`, `@effect/platform-bun`, `@effect/sql-pg`,
  `@effect/vitest`.
- Web: `effect`, `@effect/atom-react`.
- Every Effect adapter peers on `effect@^4.0.0-rc.112`; `@effect/platform-bun` resolves
  `@effect/platform-node-shared@4.0.0-rc.112` through the exact root override.
- `effect` resolves `fast-check@4.9.0` and `msgpackr@2.0.5` from the existing graph.
- `@effect/platform-node-shared` resolves existing `@types/ws@8.18.1` and `ws@8.21.3`.
- `@effect/sql-pg` resolves `pg@8.23.0`, `pg-cursor@2.22.0`, `pg-protocol@1.16.0`, and the
  unchanged `pg-connection-string@2.14.0`, `pg-pool@3.14.0`, `pg-types@4.1.0`, and related
  driver graph.
- The RC removes prior `effect` dependencies `@standard-schema/spec`, `kubernetes-types`, and
  `uuid`; the latter two therefore leave the candidate lockfile (the first remains required by
  another workspace dependency).

The checked-in source is the exact release commit `2600f62f4532026928454dcea8d1c48557b3f942`
from tag `effect@4.0.0-rc.112`; `.repos/effect/packages/effect/package.json` reports the same
version.

## Restored-policy and contract verification

With the original seven-day policy restored, pinned Bun `1.3.14` ran `bun install
--frozen-lockfile`. It exited successfully and left both inputs byte-identical: `bunfig.toml`
remained `2b722e6668912e0a8ff3a858b226f34a164804d7a96561f1e10eb25eb2c6dfea`, and `bun.lock`
remained `42a2db1cc8dab98fcefc511893622fe532d211978e1ec0eceb7b5e8517f75101` (SHA-256).

The canonical OpenAPI contract was regenerated with stable anonymous reference allocation. RC.112
flattens compatible JSON Schema constraints that the prior generator emitted under `allOf`; the
semantic compatibility boundary now normalizes that representation inside unchanged cyclic schema
graphs as well. The contract checker reports no breaking changes from
`89ff2017780ceb433519e9debe12ba5086bcd48825ffbad58d17ebae092df5de` to
`2217418396940a0c68b47d035c75894207ed89c577051adeba36b1cccd6d348e`, so no breaking-change
acknowledgement was created. Contract freshness and all 30 contract checker tests passed.

The complete repository verifier passed under pinned Bun `1.3.14` with local PostgreSQL enabled,
including lint, formatting, project references, dependency and browser graphs, generated contract
freshness and compatibility, unit/integration/acceptance/browser suites, coverage and CRAP ratchets,
observability compatibility, and the production image smoke test.

## Known RC.112 defect applicability

Effect issue [#7515](https://github.com/Effect-TS/effect/issues/7515) documents an active-invalidation
cleanup defect in `RcMap`, inherited by `LayerMap`. A repository-wide exact-symbol search over
application and repository scripts (`rg '\b(RcMap|LayerMap)\b' apps scripts`) returned no matches.
Fidy application source neither imports nor depends on that path, so the defect is non-applicable to
this upgrade. The exact RC.112 implementations reviewed are
`.repos/effect/packages/effect/src/RcMap.ts` and `LayerMap.ts`.
