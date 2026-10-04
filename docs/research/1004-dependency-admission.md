# Exact dependency snapshot admission for #1004

On 2026-10-04, after PR #1017's dependency-freshness gate blocked merging, the User explicitly
requested: “update, and bypass effect and alchemy blockers too.” This admits the refreshed frozen
snapshot below, carrying forward the existing Effect/Alchemy installation exception. It does not
extend the original **2026-10-10 UTC** expiry or relax the repository's ordinary seven-day policy.

The admitted root `bun.lock` SHA-256 is
`c0b5f4bd92ddbe3a3f4d370407f52ac5b187e9a6f1bca4b92142341aaeab9e60`.
The previous #996 snapshot was
`4bd4e37a9168d7eeff17772903f79f88edccb9c14caf5cedc22e14483119e876`.
Every Effect, `@effect/*`, Alchemy and `@alchemy.run/*` package resolution and integrity is unchanged.
The existing `alchemy@2.0.0-beta.80` patch and Workers-types resolution are unchanged.

## Newly resolved packages

All changed registry resolutions were checked against npm's publication timestamps and
`dist.integrity` on 2026-10-04 after 15:00 UTC. Every new resolution meets the unchanged
604800-second cooldown and its lock integrity equals the registry's integrity.

| Package              | Version            | Published (UTC)     | Primary registry evidence                                                 |
| -------------------- | ------------------ | ------------------- | ------------------------------------------------------------------------- |
| Wrangler             | 4.142.0            | 2026-09-27 14:01:42 | [metadata](https://registry.npmjs.org/wrangler)                           |
| React Router         | 1.170.40           | 2026-09-27 14:11:47 | [metadata](https://registry.npmjs.org/@tanstack%2Freact-router)           |
| Router Core          | 1.171.33           | 2026-09-27 14:09:47 | [metadata](https://registry.npmjs.org/@tanstack%2Frouter-core)            |
| Seroval              | 1.6.7              | 2026-09-08 14:00:32 | [metadata](https://registry.npmjs.org/seroval)                            |
| Seroval plugins      | 1.6.7              | 2026-09-08 13:59:51 | [metadata](https://registry.npmjs.org/seroval-plugins)                    |
| Workerd              | 1.20260926.1       | 2026-09-26 01:18:59 | [metadata](https://registry.npmjs.org/workerd)                            |
| Wrangler's Miniflare | 5.20260926.0-alpha | 2026-09-27 13:55:15 | [metadata](https://registry.npmjs.org/miniflare)                          |
| Workerd Darwin x64   | 1.20260926.1       | 2026-09-26 01:15:48 | [metadata](https://registry.npmjs.org/@cloudflare%2Fworkerd-darwin-64)    |
| Workerd Darwin arm64 | 1.20260926.1       | 2026-09-26 01:17:43 | [metadata](https://registry.npmjs.org/@cloudflare%2Fworkerd-darwin-arm64) |
| Workerd Linux x64    | 1.20260926.1       | 2026-09-26 01:18:53 | [metadata](https://registry.npmjs.org/@cloudflare%2Fworkerd-linux-64)     |
| Workerd Linux arm64  | 1.20260926.1       | 2026-09-26 01:15:48 | [metadata](https://registry.npmjs.org/@cloudflare%2Fworkerd-linux-arm64)  |
| Workerd Windows x64  | 1.20260926.1       | 2026-09-26 01:16:08 | [metadata](https://registry.npmjs.org/@cloudflare%2Fworkerd-windows-64)   |

The initial resolution selected Seroval and its plugins at 1.6.8, published on 2026-09-29 and
therefore still too young. Those resolutions were rejected in favor of eligible 1.6.7, which
satisfies Router Core's `^1.6.7` requirements. Frozen installation succeeded without changing the
admitted hash. Lock normalization also records the web workspace's already-declared
`@effect/platform-bun@4.0.0`; it introduces no new Effect package identity.

## Scope and enforcement

`scripts/install-workspace.sh` admits only this complete hash before 2026-10-10 UTC, uses
`--frozen-lockfile --minimum-release-age=0`, and accepts only optional `--ignore-scripts`.
At expiry or for another hash it returns to the ordinary cooldown. This replaces, rather than
adds to, the previous admitted hash. The existing installer tests protect exact-snapshot
admission, expiration, script suppression and refusal of graph-changing arguments.

`bunfig.toml`, dependency freshness checks, isolated tool locks, security scans and existing
unrelated dependency deferrals remain unchanged. This is not a floating Effect/Alchemy exemption,
authorization for future lock changes, or permission to bypass required CI checks. The PR may
merge only after all required checks pass. See the [original admission](969-release-age-exception.md).
