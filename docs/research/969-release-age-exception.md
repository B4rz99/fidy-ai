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
After the exception expires, remove the obsolete admission branch and its focused tests in a
normal reviewed change. This authorization does not waive any required check or permit merging
with failing CI; the PR must still pass all required checks before squash merge.
