# Exact CLI integration dependency admission (#969)

On 2026-10-03, after PR #993 CI failed at dependency installation, the User explicitly authorized
this narrow temporary release-age exception and requested that CI and merging proceed.

The admitted root `bun.lock` SHA-256 is
`94b72b3fd23dc01a6e7eff93ed2f10546d17ca146b6ffcd1a71f67737b0d00d3`.
Its package resolutions reuse current trunk's reviewed stable Effect 4.0.0 snapshot; the added CLI
workspace consumes those same pinned packages. This does not authorize another package resolution.

`scripts/install-workspace.sh` owns the admission. Before 2026-10-10 UTC, and only when the entire
root lockfile matches that digest, it invokes Bun with `--frozen-lockfile --minimum-release-age=0`.
At expiry or for any changed digest it uses the ordinary cooldown. Only optional
`--ignore-scripts` is accepted; callers cannot request an updated or unfrozen install.
Repository CI and release workflows use this same bounded installer. Isolated tool locks remain
subject to their unchanged ordinary installation policy.

`bunfig.toml`, dependency freshness checking, security scans, and the no-exclusions policy remain
unchanged. A new lock snapshot requires new explicit admission, never a refreshed digest by habit.

## Explicit carry-forward for #973

On 2026-10-04 the User authorized upgrading the dependency pins blocking PR #1015, then explicitly
authorized carrying this exception to the new exact lockfile. The original 2026-10-10 UTC deadline
is unchanged. The current admitted root `bun.lock` SHA-256 is
`246e8700695a31b8b635630994261b78199bb95f421fadb17928eabb6789c868`, replacing the preceding #996
snapshot `4bd4e37a9168d7eeff17772903f79f88edccb9c14caf5cedc22e14483119e876`.

Wrangler advances to 4.142.0 in server, web and infrastructure; React Router advances to 1.170.40.
At 2026-10-04T14:46:19Z, npm registry publication timestamps proved that all twelve new package
identities meet the ordinary seven-day delay:

| Package versions                                    | Published UTC                    |
| --------------------------------------------------- | -------------------------------- |
| Wrangler 4.142.0                                    | 2026-09-27T14:01:42Z             |
| React Router 1.170.40 / Router Core 1.171.33        | 2026-09-27T14:11:47Z / 14:09:47Z |
| Seroval / Seroval Plugins 1.6.7                     | 2026-09-08T14:00:32Z / 13:59:51Z |
| Workerd 1.20260926.1 and its five platform packages | 2026-09-26, 01:15–01:19Z         |
| Miniflare 5.20260926.0-alpha                        | 2026-09-27T13:55:15Z             |

Seroval and Seroval Plugins are overridden to 1.6.7 because resolving Router Core's ranges with
the temporary age override would otherwise select under-age 1.6.8 releases. No new under-age
package version is admitted; existing Effect, Alchemy and Workers types resolutions remain unchanged.
The lock also records web's already-declared Effect Platform Bun dependency using the existing
admitted resolution. All other lockfiles and the ordinary release-age policy remain unchanged.

After the exception expires, remove the obsolete admission branch and its focused tests in a
normal reviewed change. This authorization does not waive any required check or permit merging
with failing CI; the PR must still pass all required checks before squash merge.
