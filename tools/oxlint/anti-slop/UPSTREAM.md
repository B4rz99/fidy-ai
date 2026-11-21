# Upstream

- Source: https://github.com/k-mistele/anti-slop
- Commit: `13b020367525e8c6efe6cede8f387697b2a8d907` (2026-11-19). Copied from its `src/` by `.agents/skills/install-anti-slop/scripts/install.mjs` at that commit, without the `*.test.ts` files.
- Registered plugins in `.oxlintrc.json`: `index.ts` (`anti-slop`), `effect/index.ts` (`anti-slop-effect`), `plugins/landmines.ts`, `plugins/ai-guard.ts`, `plugins/enfect.ts`, `plugins/effect.ts`, `jev/plugin.ts` (`anti-slop-effect-jev`) and `martinfowler/jev-plugin.ts` (`anti-slop-martinfowler-jev`).
- `vendor/eslint-stylistic/` keeps its own `LICENSE` and `UPSTREAM.md`.

## Deviations

- `xstate/` is not copied.
- The diff rules (`diff-rules/`) are copied but not registered.
- The Jev plugins import the vendored fork at `tools/oxlint/oxlint-plugin-jev/dist/index.mjs` instead of the `oxlint-plugin-jev` package, so the root `package.json` pins the fork's dependencies (`ai`, `@ai-sdk/typesafe-ai`, `synckit`, `zod`) instead of using a `file:` range.
- Jev rules run with `mode: "changed"`; pre-commit strips the credentials through `modes/lint.ts commit`.
- `anti-slop/no-unknown-parameters` is not enabled.
- `max-lines-per-function` sets `skipBlankLines`, so the blank lines `anti-slop/require-readable-spacing` adds do not count.
- Overrides at the end of `.oxlintrc.json` turn off rules for code areas that still have findings. Each cleanup PR deletes one of them (#2374).
