# Recurrentes

Latest production audit, 22 October 2026: protected reads became unavailable after release
`ff37f818fbf86bc766e090dc5cba8ee746cdd80a`. The deployed standing query requires
`payment_source_context`, which is absent from production D1; read-only preparation reproduces the
missing-view error. This is confirmed code/schema mismatch evidence, not a renewed quota diagnosis.
The guarded rollback failed closed. [Incident evidence and deferred checks](../../../../../docs/operations/audit-20261022-schema-mismatch.md)
record the recovery boundary. Earlier successes below remain dated evidence; they do not establish
availability after this deployment. No further production financial or access mutation was attempted.

Current audit status, 22 October 2026, deployed release
`20fd17a37458f54031c771d0b9e1de24a5e98933`: fresh canonical reads returned HTTP 200.
`PRUEBA QA CHAT RECURRENTE 20261017` remained Activo in Todos los recurrentes, with its
18 October occurrence Sin confirmar and its 18 November occurrence Próximos. No plan mutation
was submitted. This independently establishes the expected maintained-plan lifecycle/date for the
hosted lookup comparison; the chat comparison itself remains open.

The first audit tab received repeated reads and `429 rate_limited`, retaining facts and disabling
editing. A fresh tab was quiet during idle observation, and a new isolated built-browser case also
stayed quiet after presentation and month changes. No uncontrolled render loop or cause was
reproduced; no cache/freshness policy was weakened. The observation must not be recorded as a
proven frontend fix or as D1 quota exhaustion. Chat processing observation is being fixed at its own
command seam; accepted hosted lifecycle approval and stopped-state persistence remain live gaps.
Native cancellation checks and revoked-grant cleanup below remain established.

Current audit status, 21 October 2026: the User confirmed that the latest production read failures
are caused by D1 quota exhaustion. Production testing is paused until database recovery. Native
Codex, Claude Code and corrected Inspector cancellation returned the declared refusal without an
accepted edit, and all audit grants were revoked. Hosted maintained-plan lookup still needs a
deployed fresh-read comparison; accepted hosted lifecycle approval and stopped-state persistence
remain unverified in production. Private-provider coverage does not close these browser gaps.

### Deployed reset continuation, 20-10-2026 Bogotá

[Deployment 39525764609](https://github.com/B4rz99/fidy-ai/actions/runs/39525764609)
passed and public API health reported `da6dc816e10655f8b21fe13d8e61801d0f9d4c1c`. This deploys the discovery follow-up
from PR #1389 and closes its earlier release blocker. Fresh November reads succeeded after D1's
reset. The ordinary-language stop request supplied the fixture name and local date only; it
returned HTTP 429 with provider-quota feedback before any host approval was displayed. The draft
remained editable and survived signed-in navigation without automatic resubmission. A separate
fresh page still showed `PRUEBA QA CHAT RECURRENTE 20261017` as Activo and its 18 November
occurrence as upcoming with unknown Money. No stopped-state or cleanup success is claimed.
Live host approval, stop persistence and historical preservation remain pending AI availability;
ordinary database reads are no longer the blocker.

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

The ingress fix merged in PR #1358, but its production run failed stable Worker-pair capture
before uploading a candidate. Production session binding and consent subsequently returned 503.
Read-only diagnostics found matching recovery generations and substantial D1 write volume;
write-quota exhaustion is suspected, not confirmed. The follow-up read-only recovery assertion
passed 25 combined native D1 checks, preserving generation refusal and atomic rollback while
eliminating assertion writes on successful reads. The [chat audit](../agent/FEATURE.md) records
the exact deployment and diagnostic limits. The hosted stop request and fixture cleanup remain
pending production recovery; local checks do not close those live gaps.

### Quota-reset verification, 20-10-2026

Rebased onto trunk `6ce993fdef95c12bc31f5656d801517e1f202a19`. Before that sync,
production health reported available at `82c937fbd410f89cdd9378ab12c58ec883929398`.
The existing signed-in browser completed a Bogotá date question (20/21 October) and a
November read of `PRUEBA QA CHAT RECURRENTE 20261017`. Each submission produced one
User/assistant pair with automatic delivery acknowledgement. Closing and reopening chat
across month navigation retained the conversation. The recurring workspace returned HTTP 200,
with one plan and document revision 1; the plan was still active.

A natural-language request to stop only that fixture from 17 October failed to produce a host
review. The agent asked the User for `expectedRevision`, although the canonical workspace already
supplies it. No edit executed. The former synthetic lifecycle check supplied the ID and revision
in its request, so it did not exercise this missing discovery step. Its replacement requires a
workspace read followed by the exact requested stop proposal using the returned ID and revision.
Negative cases reject asking for internal fields before or after the read, skipping discovery,
stale revisions, timestamps and the wrong calendar day.

The follow-up directs the model to execute necessary tools in the current response rather than
announcing a future lookup, and documents the recurring workspace's revision source. Canonical
validation and host-owned exact approval remain unchanged. All 59 deterministic inference checks
passed, including complete-catalog request capacity. A targeted live recurring probe passed, and
then the full strict live provider probe returned HTTP 200 / `outcome: conforming`. An intervening
full probe returned `canonical_correction / ProviderUnavailable`; it is not counted as passing.
These probes execute no canonical mutations. Production lifecycle approval and stopped-state
verification remain pending deployment of this follow-up.

### Release and broader rerun, 20-10-2026

The discovery follow-up merged in [PR #1389](https://github.com/B4rz99/fidy-ai/pull/1389)
as `7d755940e498551835327059ab70a9fefa9957c7`, after all CI checks passed. Its production
run stopped at the existing schema-baseline guard before candidate upload. The separate cosmetic
SQL comparison fix then merged in PR #1388 at `ef1005e310151e98ad946858051a0b8cffdaa945`.
The subsequent [deployment](https://github.com/B4rz99/fidy-ai/actions/runs/39454696608)
still failed during baseline adoption, without a new baseline ledger row.

Read-only diagnostics compared all 1,088 schema objects: the initial difference was comments and
whitespace in one table. Replaying the corrected adopter against captured metadata reached its
first requested write, where the diagnostic deliberately stopped. The native and external recovery
generations matched, foreign-key checking returned no violations, and the fixture account had no
erasure request. These checks made no production writes. The protected signed live database proof
in [inspection run 39455413477](https://github.com/B4rz99/fidy-ai/actions/runs/39455413477)
then explicitly reported daily D1 quota exhaustion. This is separate from the passing AI probe;
normal health remained available at release `82c937fbd410f89cdd9378ab12c58ec883929398`.

Dashboard catalog/view, Categories and Recurring reads returned HTTP 503. Recurring retained its
cached month, disabled creation and requested an explicit refresh rather than presenting stale
facts as current. A no-data greeting also returned 503: the failed submission was removed from
message history and its exact draft remained editable, without automatic replay. No stop mutation
was attempted after the database failure, and the recurring fixture is not claimed as cleaned up.

On the synchronized code, all 14 recurring Worker/D1 checks and all 69 Dashboard Worker/D1
checks passed. Dashboard catalog and uninitialized queries now also run through the production
recovery wrapper with isolated real R2 storage. The three built-browser hosted-review checks
passed: direct approval, recovered approval, and refusal to turn model prose into approval.
Those browser checks use controlled hosted replies and do not establish live model mutation.
A separate 11-test built-browser workspace rerun passed pagination across 100 items, real canonical
persistence, list/calendar consistency, separated summaries, uncertain-save recovery, tracking,
lifecycle reloads, forward-edit history and unavailable/malformed/limited/pressure read recovery.
Production host approval, durable stopped-state verification and Dashboard chat edits remain
blocked on database availability and deployment of the merged follow-up.

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
editing resumes. The same resume invalidation refreshes the current date, so a return after a local month boundary selects the current month and updates Hoy. Privacy navigation or authentication expiry disposes the retained workspace.
Unchanged retained review and recurring displays are memoized so showing them does not rebuild their
forms or calendars. The browser navigation benchmark uses independent Users and keeps its 10 ms
median target while withholding fresh network results; stale editing remains disabled.

External MCP continuation, 20 October 2026, release `eb9374c92dd97a63f45a6a108a8660b0cfe39842`:
the approved seven-day Inspector connection read the November workspace and its existing synthetic
monthly plan. Exact stop-tracking elicitation appeared, but client decline/acceptance timed out;
independent reads still showed document revision 1 and the active plan. A later mutation returned
safe unavailability. Tracking changes, client cancellation and retained history are therefore not
claimed as live passes. The owning [MCP audit](../../../../server/src/shell/mcp/FEATURE.md) records
the transport observations and pending grant cleanup. No Transaction deletion or external service
cancellation was performed.

The 20 October production browser follow-up also selected 15 July and 15 August 2026 in the
Transactions date picker. Both dates showed zero records in the current audit account, as did
15 September in the earlier check. This narrows fixture discovery to another account; it does not
prove that the three historical fixtures were deleted or are absent from all accounts.

Production retest, 21 October 2026, release `d50938e433193ba07e0207f0193f4f8881526f5a`:
Inspector read revision 1 and requested stopping the existing synthetic monthly plan. Decline
and acceptance both closed their native review, but neither produced a completed parent tool
result. Independent browser readback still displayed the November occurrence as upcoming.
The new seven-day test grant was revoked and both Inspector grant rows displayed Revocado.
Native cancellation/completion and the synthetic tracking change remain open; no Transaction
was deleted or external service cancelled.

A subsequent separately approved traced Inspector call again read revision 1 and displayed the
exact synthetic stop review. Decline started a reply fetch which received no headers until transport
disconnection, then returned 404; a subsequent native read was also delayed and returned 404.
The traced grant was revoked successfully. This identifies a transport symptom, not a completed
tracking change or a diagnosed production cause.

Supported Codex production cancellation, 21 October 2026, same deployed release: the separately
approved seven-day read/write grant completed native OAuth. Codex 0.160.0 invoked the exact
synthetic stop-tracking request and cancelled its native confirmation. The parent tool completed
with `user_action_required`; the diagnostic recorded one expected/received result and native form
answered. An independent November browser read still displayed
`PRUEBA QA CHAT RECURRENTE 20261017` as upcoming on 18 November. Accesos confirmed immediate
grant revocation, and native logout removed its isolated OAuth credentials. This closes the
Codex cancellation path for this plan, not accepted tracking changes, Claude Code production
completion, hosted inference, or the separate Inspector transport stall. No Transaction was
deleted and no payment or external service was cancelled.

The 21 October Inspector follow-up completed a delayed legacy cancellation and a concurrent read
using its installed SDK/fetch tracker against a synthetic Node server. This local client probe
does not establish the production Fidy continuation or accepted tracking change. The owning MCP
audit records the tooling fix and scope limits.

Claude Code production continuation, 21 October, same release: a separately approved seven-day
read/write connection completed native OAuth. Claude Code 2.1.289 cancelled the exact synthetic
stop-tracking review, and its parent tool returned `user_action_required`. The diagnostic recorded
one expected/received result, native form answered, and passed. Independent browser readback still
showed the November occurrence as upcoming on 18 November. The connection was immediately revoked
and its local credential removed. This closes cancellation for both supported clients on this
operation; it does not establish accepted tracking changes or resolve Inspector's legacy stall.

Inspector network comparison, 21 October, same release: another separately approved seven-day
connection requested only stopping the synthetic plan and cancelled the native review. The default
HTTP/2 client queued its cancellation POST locally until disconnect. A process-local HTTP/1.1
comparison dispatched cancellation and received HTTP 202, but its completed parent result was
`unavailable`; cancellation semantics therefore remain unverified for Inspector. Local synthetic
HTTP/2 comparisons passed and did not reproduce the live delay. Independent browser readback
still displayed `PRUEBA QA CHAT RECURRENTE 20261017` as upcoming on 18 November. No edit was
accepted. The client was stopped; the newest connection still requires identity confirmation for
revocation, tracked in the Accesos audit. This does not reopen the supported native-client passes.

Cleanup continuation, 21 October 2026: after the User completed the same-account Google popup,
a page refresh restored the authenticated Accesos list. Explicit individual revocation of the
newest Inspector connection returned “Acceso revocado. Las acciones ya realizadas se conservan.”
and changed its state to Revocado. All seven audit connection rows were then revoked. This
closes the pending cleanup above; it does not resolve the Inspector cancellation failure.

Inspector dispatch follow-up, 21 October: a corrected local baseline reproduces the cancellation
POST queue with Node 26.5.0's bundled dispatcher. The isolated Inspector launcher using pinned
Undici 8.12.3 passes cancellation-only and concurrent-read HTTP/2 tests with normal TLS verification.
The original nominal bundled baseline had imported external Undici first and was invalid. Fidy's
legacy integration separately retains data and returns `user_action_required` for delayed cancel
and decline. Production UI semantics remain pending a separately approved rerun; the earlier
HTTP/1.1 `unavailable` result is not a pass. All prior audit grants remain revoked.

The follow-up uses policy-eligible Inspector 2.11.0, MCP client 2.3.1 and Undici 8.12.3 in an
isolated development tool. Both baseline cases still fail without its preload; both pass with it.
The actual Inspector web UI also connected to a disposable local TLS HTTP/2 server, displayed the
native form, and completed Cancel with `user_action_required` (about four seconds including the
manual click). No production access was created by this local test. The full OAuth/MCP adapter
suite passed 227 tests with one existing skip; TypeScript, ordinary/type-aware lint, dependency
policy (zero failures) and both transport regressions passed. The npm bulk advisory endpoint
reported no advisories for the isolated tool's 118 installed package names. Workspace Gate runs
the new transport regressions on CI; production verification remains a distinct pending step.

Corrected Inspector production closure, 21 October 2026: the separately approved seven-day
read/write connection used Inspector 2.11.0 with the isolated Undici 8.12.3 dispatcher. November
workspace read returned revision 1. The native review for the exact synthetic stop-tracking
request was cancelled, and its original parent returned `user_action_required` with no timeout
or `unavailable` result. Total parent duration was 22,368 ms including manual review. Independent
browser readback still showed `PRUEBA QA CHAT RECURRENTE 20261017` upcoming on 18 November.
Accesos confirmed immediate grant revocation; all eight audit rows were revoked. The client was
stopped and its local credential state removed. This closes Inspector cancellation for this
operation through the corrected launcher, alongside the earlier Codex and Claude Code passes.
No edit was accepted, no Transaction was created/deleted, and no external service was cancelled.

Production availability follow-up, 21 October 2026: opening an uncached November workspace
returned HTTP 503 from `/recurring-plans` (trace `a4360d682e28cbd319419680a4cd7450`). The browser
showed its retry/error state without replacing retained data with an empty workspace. The earlier
populated October view was retained browser state, not proof of a healthy fresh read. Read-only
schema inspection found the checked-in objects present; same-UTC-day D1 analytics supports write
quota exhaustion after schema work as a hypothesis, without a classified provider error for this
request. The User was notified and no financial mutation was attempted. Hosted read guidance and
synthetic provider coverage are recorded in the [chat audit](../agent/FEATURE.md); its Production
rerun still requires backend recovery.
