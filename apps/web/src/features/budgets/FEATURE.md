# Budgets

Local functional control, 22 October 2026, revision `de6cbc88d194c526975005d5e5733375220cf169`:
the complete browser project passed 182 checks with three opt-in cost checks skipped under
reviewed Bun and one worker. This is browser functional evidence, not production availability
or concurrency capacity. The [incident evidence](https://github.com/B4rz99/fidy-ai/blob/8ddab8fedb4f8e62837017f99f0484ca065bd80a/docs/operations/audit-20261022-schema-mismatch.md)
retains the failed parallel diagnostics and the required live recovery checks.

Latest production audit, 22 October 2026: protected reads became unavailable after release
`ff37f818fbf86bc766e090dc5cba8ee746cdd80a`. The deployed standing query requires
`payment_source_context`, which is absent from production D1; read-only preparation reproduces the
missing-view error. This is confirmed code/schema mismatch evidence, not a renewed quota diagnosis.
The guarded rollback failed closed. [Incident evidence and deferred checks](https://github.com/B4rz99/fidy-ai/blob/8ddab8fedb4f8e62837017f99f0484ca065bd80a/docs/operations/audit-20261022-schema-mismatch.md)
record the recovery boundary. Earlier successes below remain dated evidence; they do not establish
availability after this deployment. No further production financial or access mutation was attempted.

Current audit status, 22 October 2026, deployed release
`20fd17a37458f54031c771d0b9e1de24a5e98933`: the empty October plan loaded after D1 reset.
Through the production browser, the audit created one Restaurantes cap in Alimentación for
COP 12,345, reloaded and verified persistence, then updated it to COP 23,456. The existing cap
editor kept COP fixed. October showed COP 0 spent in Restaurantes; the all-expense summary
retained COP 10,103 spent and computed COP 13,353 remaining. November inherited COP 23,456,
labelled the plan as inherited, and showed COP 0 spent. No November plan was saved. These checks
close production cap create/update, reload persistence and read-only forward inheritance; they do
not establish independent future-month writes, Currency changes or cleanup.

The sole test cap remains COP 23,456 for Restaurantes, October 2026, pending exact permanent-deletion
approval. No production Transaction was created, edited or deleted by this Budget test. The current
browser editor has no Budget deletion action; canonical deletion is a separate capability. Cleanup
must use a supported authorized path, not a direct database write. Historical statements below that
no production cap was saved describe earlier runs and are superseded by this entry.

Current local audit, 21 October 2026: the isolated current Budget Worker/D1 file passed all
30 checks. Ten repeated built-browser cached-navigation journeys also passed with the existing
10 ms median limit unchanged. CI separately observed an 11 ms median; the navigation check now
preserves its five timing samples before asserting that same limit. The local passes do not
establish the cause or resolution of that CI observation. Production cap creation/editing and
cross-month inheritance remain unverified, and production testing is paused for the User-confirmed
D1 quota exhaustion.

Production D1-reset read verification, 20-10-2026 Bogotá, release
`da6dc816e10655f8b21fe13d8e61801d0f9d4c1c`: the October Budget view loaded without a database error and correctly
retained its no-cap state. Its summary showed COP 0 income and COP 10,103 spending, matching
the two current Transactions and the Dashboard metric; uncapped spending remained included.
No Budget amount, group or Currency was changed. This is current-release read/aggregation evidence,
not new production cap mutation or failure-injection evidence.

Capability and verification map for `/app/budgets`. Product requirements remain in GitHub issues #1297 and #1291.

## Behaviour and owners

`feature.tsx` reads the authenticated User and selects the router month; `controller.ts` owns the monthly Budget report, Categories and Budgets through canonical queries. The current month uses the User's time zone; explicit month navigation uses calendar months. Reads do not initialize a plan. An initial failure displays retry feedback. A failed refresh retains existing figures but disables editing until a successful reread.

`workspace.tsx`, `row.tsx` and `editor.tsx` present grouped monthly caps, Category expenses and remaining Money. Amount edits commit on explicit submission; invalid or unsupported precision is rejected. Categories without caps remain available for assignment. The desktop editor is a side panel and the mobile editor a Sheet. Large reports initially collapse groups rather than truncate records.

`controller.ts` owns canonical write construction, synchronous write admission, outcomes and query refresh. Presentation invokes Budget editing actions without assembling writes or coordinating reset identities. Pending writes lock editing and month navigation. A known refusal reports failure; an uncertain response blocks further writes until explicit refresh. Refresh rereads canonical state and discards unsent drafts instead of replaying the mutation.

The first write materializes the selected month's inherited plan. Caps are month-specific, while group names organize Categories across months. Group Currency changes affect later plans without rewriting previously frozen Money. No implicit Currency conversion occurs.

`presentation.ts` and `summary.tsx` calculate exact totals separately per Currency. Monthly expenses include uncapped Categories; monthly income allocation compares income to planned caps, not spending. A Dashboard Budget Widget consumes the same canonical Budget status and retains its own display Currency.

## Verified on 2026-10-14

Additional audit on Effect 4.0.2: the built-browser uncertain-save journey now checks both possible outcomes. The existing check rereads the unchanged cap; the new check rereads a committed COP 150,000 cap after losing its acknowledgement, updates the remaining total to COP 20,000, unlocks editing, and confirms that blurring the unchanged recovered input does not submit a second mutation. This is controlled HTTP evidence for browser recovery, not a production write or a simulated D1 commit.

A production-build fixture with 1,000 caps across 16 groups verifies that large reports start collapsed, the summary includes every cap, expanding a group exposes all 63 of its Categories including the final Category, and the 390px page does not overflow horizontally. It proves reachability and aggregation, not representative production latency or physical touch behavior. The fixtures remain inside the browser tests and are not shipped as production fallback data.

Effect 4.0.2 rerun at `30f585ceb1a811a97c523251ea6bd0bee13fc07f`: all seven deletion/Budget/Widget built-browser checks passed in 46.2 seconds, including the three Budget journeys and actual local Core/D1 Widget persistence. Production readback after capturing the fictional COP 1 Restaurantes expense showed COP 0 received income, COP 0 planned expenses, COP 1 spent and COP 1 exceeded in the October summary, with no cap configured. This establishes live uncapped expense aggregation; production cap creation/editing and cross-month inheritance remain unverified. No production Budget cap was saved. After the approved fixture deletion, navigating back to October displayed “Todavía no hay actividad este mes” instead of the COP 1 expense summary. No production Budget cap was changed.

Baseline: `a387f50fb5`. Three production-build browser journeys passed in `e2e/budgets.spec.ts`:

- Controlled HTTP figures in COP and USD, exact decimal entry, lost save acknowledgement, disabled controls, explicit refresh without replay, summary switching, desktop/mobile layout and zero serious or critical Axe findings at the checked states. The 390px layout had no document overflow; desktop and mobile screenshots were inspected separately.
- Actual local public/Core/D1 creation and reload persistence, independent previous-month editing, group rename, future group Currency changes preserving the earlier month's COP cap, and locked Currency for an existing cap.
- Controlled initial load failure and successful retry, followed by stale refresh failure with amounts retained and editing/month navigation locked until successful retry.

The actual Core/D1 Dashboard Budget Widget journey also passed, including cap updates and canonical Budget deletion with widget Currency isolation. The Budget and Transaction Worker/D1 files passed in the selected three-file run; onboarding passed separately after its fixture binding was corrected. All 16 pure Budget checks and three exact-Money presentation checks passed. The targeted pure Core invocation failed the global whole-Core coverage threshold because unrelated Core files were not selected; this is not a whole-Core coverage pass.

These local persisted and controlled-HTTP journeys do not establish a populated production monthly plan, physical touch behavior, or production latency under large reports. Production writes and cleanup remain separate checks; no production Budget was changed in this audit.

Latest focused verification, 2026-10-14: all 11 built-browser checks across `access-management.spec.ts`, `access-native-pagination.spec.ts` and `budgets.spec.ts` passed in 1.3 minutes on Effect 4.0.2. This includes actual local Core/D1 cap persistence and 26-connection continuation, alongside controlled browser recovery and identity-handoff checks. All six PAT draft/exact-Money unit checks passed. Web type checking and ordinary/type-aware lint for the changed browser specs passed. No new production token, MCP connection or Budget cap was created during this continuation.

The current Budget Worker/D1 file passed all 37 checks in 18.58 seconds when run alone. An earlier run overlapped the browser Core harness and ended with 36 passes and a 15-second timeout in the update/delete ownership check; the complete isolated rerun passed without changing code or increasing timeouts. This is local platform evidence for persistence, ownership, reconciliation and group Currency boundaries, not production load evidence.

## Rerun

```sh
bun run --cwd apps/web test:browser budgets.spec.ts budget-widget.spec.ts --workers=1
bun run --cwd apps/web test src/features/budgets/presentation.test.ts
bun run --cwd apps/server test:core src/core/budgets --coverage.enabled=false
bun run --cwd apps/server test:cloudflare cloudflare/budgets/budgets.test.ts --maxWorkers=1
```

Production read-only observation, 2026-10-14: the signed-in account loaded the empty October plan, expanded Alimentación, opened and cancelled the Restaurantes editor, loaded November and returned to the current month. No cap was saved. This verifies navigation and cancellation for an empty plan; populated production calculations and writes remain separate checks.
