# Budgets

Capability and verification map for `/app/budgets`. Product requirements remain in GitHub issues #1297 and #1291.

## Behaviour and owners

`feature.tsx` reads the authenticated User, selected monthly Budget report, Categories and Budgets through canonical queries. The current month uses the User's time zone; explicit month navigation uses calendar months. Reads do not initialize a plan. An initial failure displays retry feedback. A failed refresh retains existing figures but disables editing until a successful reread.

`workspace.tsx`, `row.tsx` and `editor.tsx` present grouped monthly caps, Category expenses and remaining Money. Amount edits commit on explicit submission; invalid or unsupported precision is rejected. Categories without caps remain available for assignment. The desktop editor is a side panel and the mobile editor a Sheet. Large reports initially collapse groups rather than truncate records.

`controller.ts` and `command.ts` serialize canonical writes. Pending writes lock editing and month navigation. A known refusal reports failure; an uncertain response blocks further writes until explicit refresh. Refresh rereads canonical state and discards unsent drafts instead of replaying the mutation.

The first write materializes the selected month's inherited plan. Caps are month-specific, while group names organize Categories across months. Group Currency changes affect later plans without rewriting previously frozen Money. No implicit Currency conversion occurs.

`presentation.ts` and `summary.tsx` calculate exact totals separately per Currency. Monthly expenses include uncapped Categories; monthly income allocation compares income to planned caps, not spending. A Dashboard Budget Widget consumes the same canonical Budget status and retains its own display Currency.

## Verified on 2026-10-14

Baseline: `a387f50fb5`. Three production-build browser journeys passed in `e2e/budgets.spec.ts`:

- Controlled HTTP figures in COP and USD, exact decimal entry, lost save acknowledgement, disabled controls, explicit refresh without replay, summary switching, desktop/mobile layout and zero serious or critical Axe findings at the checked states. The 390px layout had no document overflow; desktop and mobile screenshots were inspected separately.
- Actual local public/Core/D1 creation and reload persistence, independent previous-month editing, group rename, future group Currency changes preserving the earlier month's COP cap, and locked Currency for an existing cap.
- Controlled initial load failure and successful retry, followed by stale refresh failure with amounts retained and editing/month navigation locked until successful retry.

The actual Core/D1 Dashboard Budget Widget journey also passed, including cap updates and canonical Budget deletion with widget Currency isolation. The Budget and Transaction Worker/D1 files passed in the selected three-file run; onboarding passed separately after its fixture binding was corrected. All 16 pure Budget checks and three exact-Money presentation checks passed. The targeted pure Core invocation failed the global whole-Core coverage threshold because unrelated Core files were not selected; this is not a whole-Core coverage pass.

These local persisted and controlled-HTTP journeys do not establish a populated production monthly plan, physical touch behavior, or production latency under large reports. Production writes and cleanup remain separate checks; no production Budget was changed in this audit.

## Rerun

```sh
bun run --cwd apps/web test:browser budgets.spec.ts budget-widget.spec.ts --workers=1
bun run --cwd apps/web test src/features/budgets/presentation.test.ts
bun run --cwd apps/server test:core src/core/budgets --coverage.enabled=false
bun run --cwd apps/server test:cloudflare cloudflare/budgets/budgets.test.ts --maxWorkers=1
```

Production read-only observation, 2026-10-14: the signed-in account loaded the empty October plan, expanded Alimentación, opened and cancelled the Restaurantes editor, loaded November and returned to the current month. No cap was saved. This verifies navigation and cancellation for an empty plan; populated production calculations and writes remain separate checks.
