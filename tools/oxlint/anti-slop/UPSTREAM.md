# Upstream

- Source: https://github.com/k-mistele/anti-slop
- Commit: `13b020367525e8c6efe6cede8f387697b2a8d907` (2026-11-19). Copied from its `src/` by `.agents/skills/install-anti-slop/scripts/install.mjs` at that commit, without the `*.test.ts` files.
- Registered plugins in `.oxlintrc.json`: `index.ts` (`anti-slop`), `effect/index.ts` (`anti-slop-effect`), `plugins/landmines.ts`, `plugins/ai-guard.ts`, `plugins/enfect.ts` and `plugins/effect.ts`.
- `vendor/eslint-stylistic/` keeps its own `LICENSE` and `UPSTREAM.md`.

## Deviations

- `xstate/` is not copied.
- The diff rules (`diff-rules/`) are copied but not registered.
- `jev/`, `martinfowler/jev-rules.ts`, and `martinfowler/jev-plugin.ts` are not copied, and the `oxlint-plugin-jev` fork is not vendored. Their review questions live in `CODING_STANDARDS.md` for adversarial review instead.
- `anti-slop/no-unknown-parameters` is not enabled.
- `max-lines-per-function` sets `skipBlankLines`, so the blank lines `anti-slop/require-readable-spacing` adds do not count.
- Overrides at the end of `.oxlintrc.json` turn off rules for code areas that still have findings. Each cleanup PR deletes one of them (#2374).
