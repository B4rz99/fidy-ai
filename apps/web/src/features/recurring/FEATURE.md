# Recurrentes

User-maintained recurring expectations, separate from historical RecurringSeries and the User's
paid Subscription. The workspace does not execute payments or cancel services. Specification:
[#1320](https://github.com/B4rz99/fidy-ai/issues/1320); design:
[ADR 0036](../../../../../docs/adr/0036-recurring-planning.md).

## Audit, 2026-10-15

Audited after synchronizing with trunk `5d3db388ee`, including the released planning workspace
`7823f9ff37`. Browser acceptance uses a production-mode static artifact with real loopback
public/Core Workers and isolated D1. Explicit HTTP fixtures cover malformed/unavailable reads and
the 100-plan presentation case; those fixtures do not prove persistence or production capacity.

| Capability                          | Verified behavior and seam                                                                                                                                                                                                                                         |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Create and retain plans             | Real browser/API creation, reload, optional Account/Counterparty, fixed/unknown Money and Currency selection. D1 revision conflicts, foreign identities and unavailable Account refusal.                                                                           |
| Calendar projection                 | Core checks for all seven cadences, fourteen-day versus twice-monthly, leap days, clamping without anchor drift, start bounds and effective occurrence time zones. Real browser list/calendar share the same occurrence and details.                               |
| Monthly totals                      | Real browser income, expense, transfer and unknown-amount separation; USD filtering changes rows and totals together. Core separates card payments from expenses and excludes omitted Money.                                                                       |
| Tracking and financial history      | Real browser partial amounts, reload and reversal. D1 proves a manual mark creates no Transaction, automatic matching does not duplicate it, and explicit replacement by a captured payment counts only one fulfillment.                                           |
| Scoped edits                        | Real browser one-occurrence and forward edits preserve the earlier month's name and amount. Core and D1 preserve prior completions and effective settings after forward changes.                                                                                   |
| Lifecycle                           | Real browser omit/include, pause, resume and stop, including reload and management status. Core regression checks suppress future retained exceptions after pause/stop while keeping recorded fulfillment.                                                         |
| Transaction association             | D1 checks exact automatic matches, competing plans, Correction invalidation, reversal, cross-month exceptions and foreign/absent Transaction refusal without partial effects. Core checks three-day boundaries, exact Money and ambiguity.                         |
| Discovery review                    | Real detector/D1 creates historical evidence from three captured Transactions without creating a plan. Explicit dismiss, restore and link persist; linking an existing plan does not create another. Foreign/absent suggestion references are refused identically. |
| Complete traversal                  | A 100-plan HTTP fixture verifies all five list pages, complete totals, a crowded calendar day's paginated agenda, and access to the last item's details. Earlier-month reads expose matching incompleteness rather than claiming complete matches.                 |
| Recovery                            | Real browser committed mutation with a lost acknowledgement locks saving until an explicit reread. Malformed and unavailable workspace reads display safe recovery, never a false empty result or partial financial facts.                                         |
| Mobile, rendering and accessibility | Real browser mobile details sheet; 100-item desktop/mobile overflow and accessibility checks; markup-like plan names remain text.                                                                                                                                  |
| Authority and atomicity             | D1 tests User isolation, stale revisions, revoked sessions and Audit rollback. OAuth confirmation suite exercises the catalog-declared recurring mutation through the existing native confirmation boundary.                                                       |
| Historical regression               | Existing Core, D1 and browser suites retain monthly detection, immutable confirmation, digest and frozen-report behavior.                                                                                                                                          |

### Defects found

Omit an occurrence, include it again, then pause or stop before its expected date: the retained
exception bypassed lifecycle filtering, leaving the future expectation in rows and totals. The
same problem affected a once-edited future expectation. Projection now applies the plan's tracking
interval to retained exceptions while retaining fulfillment history independently. Domain regressions
failed before the fix; the real browser lifecycle journey passes afterward. This audit's fix has
not been released to production.

The populated workspace also lacked a main landmark. The content container now uses `main`,
preserving its layout while making the page navigable through assistive-technology landmarks.
The populated desktop and mobile detail states are scanned with Axe; the mobile scan waits for the
sheet's opening transition to settle so it measures final contrast rather than a translucent frame.

### Production evidence

The signed-in production browser created the fictional `PRUEBA QA RECURRENTES 20261015` with a
COP 100 fixed monthly expectation on 15-10-2026. Manual COP 40 tracking produced Parcial, COP 40
registered and COP 60 remaining. Reload preserved it; calendar opened the same detail. Reversal
restored COP 0 registered / COP 100 remaining. Stopping tracking and reloading removed the monthly
projection; management retained the plan as Dejado de seguir. Transactions showed zero records.
The stopped test plan remains in management history because the feature has no plan-deletion action.

The first creation attempt was refused after the observed document revision changed. Explicit
refresh recovered; only the second, freshly reviewed creation succeeded. No uncertain mutation was
replayed, and no existing financial Transaction was changed or deleted.

### Limits and remaining evidence

- Live rerun of the retained-exception fix awaits release; local passing checks do not establish
  production deployment.
- Production did not exercise captured-Transaction association, populated discovery review,
  mixed-Currency plans, all cadences, or two concurrent clients. Their local seams are recorded
  above; no claim of complete live verification is made.
- A live WhatsApp/hosted-model planning conversation and a real external MCP client's planning
  confirmation remain separate from the local canonical/OAuth tests.
- There is no authoritative Account domain to select from. Planning without an Account works;
  unavailable Accounts are not fabricated from hints.
- New planning does not enable reminders or change existing discovery delivery. Live WhatsApp
  opt-in/template delivery and populated frozen-report evidence remain with the
  [historical recurring audit](../../../../server/src/core/recurring/FEATURE.md).

## Rerun

Final feature verification passed **440 Core tests** with the whole-Core coverage thresholds,
**72 Worker/D1/OAuth checks**, and **12 browser checks**. One optional external native-host bridge
check was skipped because its bridge was not configured; local OAuth confirmation checks ran.
The browser stress case reported zero Axe violations on the populated page and the settled mobile
detail sheet. These counts include historical recurring/report regressions, not just new planning.
Repository type checking, ordinary/type-aware lint, formatting and module-dependency checks passed.

```sh
bun run --cwd apps/server test:core
bun run --cwd apps/server test:cloudflare cloudflare/recurring-plans/recurring-plans.test.ts cloudflare/recurring/recurring.test.ts cloudflare/insights/recurring-digest.test.ts cloudflare/oauth-agents/oauth-confirmation.test.ts --maxWorkers=1
bun run --cwd apps/web test:browser recurring-plans.spec.ts recurring-recovery.spec.ts recurring-pagination.spec.ts recurring-report.spec.ts --workers=1
```
