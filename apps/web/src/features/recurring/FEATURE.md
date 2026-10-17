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
interval to effective expected dates while retaining fulfillment history independently. Displaced
past unresolved occurrences stay inspectable; displaced future expectations respect pause/stop. Domain regressions
failed before the fix; the real browser lifecycle journey passes afterward. The fix was squash-merged in [PR #1340](https://github.com/B4rz99/fidy-ai/pull/1340) and
released as `d4a7c1cc0dd7bf59aa0e6389f5064189b8385895` by
[Production run 38840874441](https://github.com/B4rz99/fidy-ai/actions/runs/38840874441).
Normal-traffic health reported that exact revision; the reloaded browser exposed one main landmark.

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

### Production rerun after PR #1340

On the same signed-in account, the fictional `PRUEBA QA CICLO 20261015` reproduced the defect
before release: omit/include/pause left its 31-10-2026 COP 100 expectation in rows and totals,
while management reported Pausado. After release, the same retained state disappeared from the
monthly projection. Resume restored it. A once edit displaced that occurrence to 14-10-2026;
pause preserved this past unresolved occurrence. November retained its original 30-day clamped
anchor. A forward November edit to USD 3 preserved October's COP 100 and kept separate COP/USD
totals; filtering USD changed both rows and summaries.

The same plan exercised every cadence through real production reads after explicit forward edits:

| Cadence                        | Observed projection from 30-11-2026            |
| ------------------------------ | ---------------------------------------------- |
| Weekly                         | 07/14/21/28-12-2026                            |
| Every fourteen days            | 14/28-12-2026                                  |
| Twice monthly, day 15 and last | 15/31-12-2026                                  |
| Monthly                        | 30-11-2026 after the earlier 31-10-2026 anchor |
| Quarterly                      | 28-02-2027                                     |
| Half-yearly                    | 30-05-2027                                     |
| Yearly                         | 30-11-2027                                     |

Two browser tabs reviewed the same November occurrence. The second tab's once edit committed;
the first tab's stale draft was refused with explicit refresh recovery and did not overwrite it.
The audit name was restored. Stopping and reloading suppressed the future once-edited occurrence.

Three fictional COP 1 Transactions with Counterparty `PRUEBA QA PATRON 20261015`, dated
15-07/08/09-2026, produced one historical monthly suggestion through normal scheduled evaluation.
The UI disclosed incomplete evaluation before it was ready. No plan was created automatically.
Dismissal and restoration persisted; explicitly linking the suggestion to the existing CICLO plan
left the plan count unchanged after reload.

The fictional `PRUEBA QA ASOCIACION 20261015` had a COP 2 September expectation. A COP 1 manual
mark produced partial tracking. Linking the September Transaction without naming the manual mark
to replace was refused; explicit replacement retained exactly COP 1 registered, COP 1 remaining,
and one Transacción vinculada instead of adding the two records. The linked state survived release
and reload. No additional Transaction was created by either tracking action.

A once edit changed the October association expectation to Por confirmar. Its row and summary
retained the unknown state explicitly; no amount was invented. Restoring fixed COP 2 saved
successfully. The stopped CICLO plan's historical October expectation was then omitted, returning
its contribution to zero without deleting management history.

The production hosted agent answered a read-only November planning request with the exact two
plans and dates, COP 2 and USD 3 separately, as one assistant response without a confirmation button.
This establishes live hosted planning reads, independently of the deterministic canonical tests.
A subsequent explicit stop request exposed a separate UX defect: an informal model question preceded
a generic host challenge containing operation JSON and a long command. The follow-up fix gives
browser lifecycle reviews a host-owned plan name/action/date and explicit approval button while
retaining exact-input, same-User/channel/session, expiry and one-use authority. Model prose cannot
produce approval metadata. Direct and recovered browser proposals are covered locally; this UX
fix is now released; the live write rerun is tracked separately below. Other operation families retain their existing
confirmation presentation.

The follow-up was merged in [PR #1349](https://github.com/B4rz99/fidy-ai/pull/1349) as
`db0e731ad95a6e6f971e64bd136951c66f65433f`, with all Required Checks passing. Its production
release stopped before promotion because the separately introduced Titular-erasure recovery
registry had not received its first operator initialization. Read-only checks confirmed an initial
native generation, no approved case and a missing external checkpoint. This is independent of AI
quota. The ingress bootstrap-routing fix and operator procedure are recorded in the
[erasure runbook](../../../../../docs/operations/titular-erasure-1274.md). The protected operator
bootstrap returned 204 on 16-10-2026. [Production run 38899280216](https://github.com/B4rz99/fidy-ai/actions/runs/38899280216)
passed both candidate/intermediate pairings and normal-traffic smoke; live health reported
`available` at exact revision `0f2df68a9233094e40223fab15d167b671cced24`. The overnight Fidy session was recovered through ordinary existing-account sign-in; a
reloaded workspace retained the expected fictional audit plans. The signed-in lifecycle approval is
a separate live check; release success alone does not establish it.

### Hosted lifecycle schema follow-up, 16-10-2026

After the release above, a production greeting and a read of the ASOCIACION plan each produced one
assistant response. The read correctly reported October's COP 2 expectation as unconfirmed. A stop
request failed before canonical execution: both model rounds rejected tool arguments. A later
attempt asked an informal question instead of preparing the host review. No lifecycle write ran.

A synthetic live provider probe reproduced a timestamp where the command requires a calendar day.
The date and month regexes lacked the Unicode flag required by Effect's JSON Schema exporter;
adding it publishes their patterns without changing accepted runtime values. One probe then passed,
but the newly added strict lifecycle conformance case caught a second failure: omitted `kind` and
`date`, with an invented `stopDate` field. Gemma's tool template omits union branches. The adapter now
derives compact descriptions of those branches from the canonical schema, retaining canonical
decoding and the existing confirmation authority. Local tests cover the visible discriminants,
date/month patterns, rejected timestamps, and complete-catalog request capacity.

The expanded deterministic hosted-inference suite passes 47 tests. The strict live rerun then stopped
at `canonical_query / ProviderQuotaExceeded`; it did not reach the corrected lifecycle case. The
provider translation fix and natural-language lifecycle approval therefore still require live
verification after quota is available. Quota exhaustion is not recorded as a passing model check.

The follow-up merged in [PR #1353](https://github.com/B4rz99/fidy-ai/pull/1353) and deployed through
[production run 38906832229](https://github.com/B4rz99/fidy-ai/actions/runs/38906832229). All CI checks,
both Worker pairings, normal traffic and drift checks passed. Public health reported `available`
at exact revision `84743a04f96685670f240cf7d69935b20c064e68`, with contract digest
`cf1813f589f1c81fc8e96b395631f1fafdfb128e99c2557709b6b1b5a50cd812`.

The reloaded production page showed the empty recurring workspace for the account used by the
separate Subscription audit. Its chat was empty after the account switch; it did not retain the
previous account's transcript. A single greeting request returned HTTP 429 with
`status: provider_quota_exceeded`. The UI explained the daily limit and preserved the exact draft
in an enabled composer. This verifies deployed quota recovery, not successful model output or the
pending lifecycle approval.

The original fixture account was then restored through the in-app Google login. Through normal
production controls, the remaining ASOCIACION plan was stopped from 16-10-2026. November showed no
occurrences, while the earlier September and October occurrences remained. The September Transaction
association was reversed, then the September and October expectations were omitted. Both months
showed no expected or registered spending, and no previous-month pending count remained. These are
direct web lifecycle/association observations, not hosted-model approval evidence. The three
fictional July–September Transactions still await irreversible cleanup; the Transactions date picker
was found to filter only the current-month result instead of loading the selected historical month.

A later recurring/category reread returned HTTP 503 at release `17d62a7a`. Scoped read-only D1
diagnostics confirmed exactly 256 canonical calls for this User on 16-10-2026, matching
`dailyAuditBudget`; D1 itself remained readable and public health remained available. The canonical
Audit triggers refuse additional work atomically, but these two read adapters present that refusal
as unavailable. No Audit counters were reset, limits changed or failed mutations replayed. This
separate daily canonical budget now blocks historical fixture reads/cleanup until its UTC reset.
The diagnostic read wrote zero rows. The follow-up preserves the D1 trigger refusal, classifies only the known Audit-budget error as
canonical HTTP 429, and publishes seconds until the next UTC day. Recurrentes shows a clear request-limit message instead of an outage. It does not infer a daily
reset from the general ResourceLimited tag, which also covers temporary request pressure. The 16-check recurring D1 suite covers exhausted and prior-day
budgets, unaffected foreign Users, unchanged Audit counts and genuine storage failures remaining 503. Four built-browser recovery journeys cover unavailable, malformed, daily-limited and temporary-pressure reads;
39 transport checks include immediate return of long Retry-After refusals without automatic replay.
The first follow-up merged in [PR #1355](https://github.com/B4rz99/fidy-ai/pull/1355) and deployed
at `db48c4146f7a363c84afcda9ebfe88323e9645d7` through
[production run 38918190752](https://github.com/B4rz99/fidy-ai/actions/runs/38918190752).
Public health was available at that exact revision, but the exhausted account still received 503
for both reads. A scoped read-only diagnostic confirmed the canonical count remained 256 with
zero rows written. The production erasure-recovery database wrapper was replacing native batch
refusals with a generic error before either owner could classify them. Running the budget
regression through that wrapper reproduced the live 503-versus-429 defect. The wrapper follow-up
preserves native D1 failures for the operation owner while retaining the generation assertion as
the first statement in the same atomic unit. Unrelated storage failures remain sanitized 503;
missing or mismatched recovery generations still refuse reads, writes and native Sessions.
The corrected wrapper is locally verified. Its deployment and live rerun status are tracked in
[PR #1356](https://github.com/B4rz99/fidy-ai/pull/1356), separately from successful AI lifecycle
output and irreversible fixture cleanup.

### Quota-reset verification, 17-10-2026

Public production health reported `available` at
`15a3408c229e9e4365da4c6ccba377a6d8865010`, the merged PR #1356 release. The prior
exhausted-account rerun returned HTTP 429 for both Categories and the recurring workspace,
with matching Retry-After/body delays and no false empty result. On 17 October, a scoped
read-only D1 diagnostic found five canonical Audit calls for the fixture User in the new UTC
day, rather than the preceding day's exhausted 256. It wrote zero rows and changed no database
state. This establishes budget reset, not a successful browser reread.

All 47 deterministic inference checks passed. The strict remote Workers AI conformance probe
then returned HTTP 200 with `outcome: conforming` and approval revision
`workers-ai-gemma-4-2026-09-22`. It exercised canonical query and mutation proposals, exact Money
and timestamp checks, Correction, deletion, date-only mutation, recurring lifecycle arguments,
bounded invalid-output recovery and Colombian Spanish structured output. These synthetic
proposals execute no canonical mutations and change no financial records. This closes the
previously blocked live provider-schema check, while the actual hosted lifecycle approval and
saved-result browser journey still need their own production rerun. The initial script attempts
timed out during local harness readiness; the subsequent ready harness completed the strict
probe in approximately 29 seconds. A harness startup timeout is not evidence of provider quota
exhaustion.

The 16 recurring Worker/D1 regressions also passed, including the guarded production database
wrapper and prior-day budget reset. On the current signed-in production account the workspace
loaded successfully, and a hosted November read correctly returned no plans. A new fictional
`PRUEBA QA CHAT RECURRENTE 20261017` was saved through the browser with unknown COP Money,
monthly cadence and first date 18 October. The subsequent hosted stop request entered processing,
then exposed a public-ingress progress-route omission: browser preflight returned 404 and blocked
the actual recovery request. Its reproduction and fix are recorded in the
[chat audit](../agent/FEATURE.md). The plan's final stopped state and live lifecycle approval remain
unverified until deployment and recovery; no financial Transaction was created for this test.

The follow-up browser rerun passed 14 journeys across recurring plans, direct/recovered hosted
approval and privacy recovery. Its lost-acknowledgement fixture now forwards temporary 429
responses to the actual client retry policy and drops the response only after a successful save;
it no longer mistakes a refused write for a committed one. The existing request limits and test
timeouts are unchanged. The ingress progress route is also included in the existing production
edge IP budget, with 38 focused infrastructure checks passing after the reviewed manifest update.

### Limits and remaining evidence

- Cleanup of the three fictional Transactions awaits action-time deletion confirmation. Test plans
  are retained management history because the product has no plan-deletion action.
- A real external MCP client's planning confirmation and a live WhatsApp planning conversation
  remain separate from the local canonical/OAuth tests and the hosted browser conversation.
- There is no authoritative Account domain to select from. Planning without an Account works;
  unavailable Accounts are not fabricated from hints.
- New planning does not enable reminders or change existing discovery delivery. Live WhatsApp
  opt-in/template delivery and populated frozen-report evidence remain with the
  [historical recurring audit](../../../../server/src/core/recurring/FEATURE.md).

## Rerun

Final feature verification passed **442 Core tests** with the whole-Core coverage thresholds,
**72 Worker/D1/OAuth checks**, and **12 browser checks**. One optional external native-host bridge
check was skipped because its bridge was not configured; local OAuth confirmation checks ran.
The browser stress case reported zero Axe violations on the populated page and the settled mobile
detail sheet. These counts include historical recurring/report regressions, not just new planning.
Repository type checking, ordinary/type-aware lint, formatting and module-dependency checks passed.
The lifecycle approval follow-up additionally passed **120 hosted-turn/recurring Worker checks**
and **15 browser checks**, including direct delivery, interrupted delivery recovery and rejection of
model-written approval prose.

```sh
bun run --cwd apps/server test:core
bun run --cwd apps/server test:cloudflare cloudflare/recurring-plans/recurring-plans.test.ts cloudflare/recurring/recurring.test.ts cloudflare/insights/recurring-digest.test.ts cloudflare/oauth-agents/oauth-confirmation.test.ts --maxWorkers=1
bun run --cwd apps/web test:browser recurring-plans.spec.ts recurring-recovery.spec.ts recurring-pagination.spec.ts recurring-report.spec.ts --workers=1
```

The application frame retains a visited recurring workspace within the current authentication
lifetime. Its filters survive navigation, with the active route’s month remaining
authoritative. Hidden workspaces are inert and their portaled sheets dismiss while inactive. Returning refreshes the profile, Category list, and recurring projection together before
editing resumes. Privacy navigation or authentication expiry disposes the retained workspace.
Unchanged retained review and recurring displays are memoized so showing them does not rebuild their
forms or calendars. The browser navigation benchmark uses independent Users and keeps its 10 ms
median target while withholding fresh network results; stale editing remains disabled.
