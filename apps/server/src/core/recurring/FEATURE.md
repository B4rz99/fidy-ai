# Recurring charges

Historical monthly charge patterns from effective Transactions, with an optional recurring
digest and authenticated report. A pattern does not establish that a charge remains active.
This feature does not manage the User's paid Subscription or authorize merchant payments.

The separately released user-maintained planning workspace has its own
[feature audit](../../../../web/src/features/recurring/FEATURE.md). Planning expectations do not
change the historical evidence or confirmation meaning described here.

| Functionality                        | Local verification                                                                                                                                                                           | Production verification, 2026-10-13                                                                                            |
| ------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| Detect monthly patterns              | Three distinct consecutive-month outflows; explicit normalized Counterparty; equal Currency; fixed-reference 5% Money tolerance; month-end clamping and three-day drift; ambiguity rejection | Three disposable July–September charges produced one monthly COP pattern through normal scheduled processing                   |
| Preserve and repair history          | Correction invalidation/restoration, resumed charges, stable series and immutable confirmations, changed-revision restart                                                                    | Removing August Counterparty removed the pattern; restoring it preserved series ID, confirmation, Money and suppression        |
| List historical patterns             | HTTP and hosted canonical parity, bounded pagination, revision-bound cursors, truthful evaluation status                                                                                     | Empty and populated reads succeeded; malformed cursor refused; reevaluation truthfully reported `updating` before `current`    |
| Authority and atomicity              | Foreign User, missing read scope, stale guards, malformed retained data, Audit rollback and shared admission                                                                                 | Both public reads returned 401 and `no-store` without credentials; absent report returned `not_found` with existing CLI access |
| Bound evaluation work                | Fact/series ceilings fail closed, no partial current result, independent User progress                                                                                                       | Capacity failures not induced                                                                                                  |
| Separate detection from announcement | Backfill and first-30-day cold-start suppression remain immutable; suppressed patterns stay visible                                                                                          | Backfill pattern remained visible and announcement suppression survived correction/restoration                                 |
| Recurring digest and opt-in          | Exact disclosed choices, independent category grants, decline/revoke/replay, complete closed ConfirmationDay, travel/DST, frozen Money and context                                           | Live opt-in and proactive delivery unverified                                                                                  |
| Deliver once and recover             | Queue/Workflow recovery, live permission recheck, rejected/ambiguous send handling and authenticated settlement                                                                              | Cannot establish template delivery through the available Kapso sandbox                                                         |
| Complete historical report           | Immutable source, all pages, long-list report URL, ownership/scope/revocation and retention after opt-out                                                                                    | Missing report and retry checked in the authenticated browser; populated rendered report pending                               |

## Evidence and reruns

The 2026-10-13 rerun passed **19 focused Core checks**, **34 recurring/digest Worker/D1
checks**, **four rendered browser checks**, and **30 shared opt-in/delivery Worker/D1 checks**. The unfiltered Core gate
passed **421 tests** and its coverage thresholds. D1, coordinator execution and persistence
are real local infrastructure; substituted provider responses do not prove live delivery.

```sh
bun run --cwd apps/server test:core
bun run --cwd apps/server test:cloudflare cloudflare/recurring/recurring.test.ts cloudflare/insights/recurring-digest.test.ts
bun run --cwd apps/server test:cloudflare cloudflare/consent/proactivity-consent.test.ts cloudflare/agent/proactivity-choice.test.ts cloudflare/insights/proactivity-runtime.test.ts --maxWorkers=1
bun run --cwd apps/web test:browser recurring-report.spec.ts --workers=1
```

Production checks used the signed-in browser and a separately approved seven-day Recurring QA
read/write grant. Three labeled disposable Transactions exercised public capture, normal scheduled
evaluation, correction and restoration. All three were deleted; the Transaction list is empty.
Final recurring reevaluation completed with an empty list. Existing financial data was not modified.
Recurring QA was revoked after fresh browser sign-in. A subsequent native CLI read returned
`unauthenticated`; the isolated local credential was cleared.

Closed local gaps: public Transaction capture/correction/restoration/deletion with recurring
reevaluation; complete 40-item historical report, loading/failure/explicit retry,
malformed-response refusal and unsafe-text rendering. Malformed links explain recovery
without a no-op retry; unavailable reports no longer ask an already signed-in User to
sign in; every amount carries its Currency code so COP and USD cannot share an ambiguous `$` label.
These browser fixes were committed as `83fd381b92` and are included in the deployed
`0f2df68a9233094e40223fab15d167b671cced24` release. This establishes release inclusion;
the populated production report still needs a live rerun.

Remaining live checks: a populated frozen report and disclosed opt-in. Historical fixtures are
correctly suppressed and cannot produce an eligible digest.
Proactive delivery additionally needs a connected WhatsApp number and approved template; the
current Kapso sandbox cannot prove it.

Owners: [detector decision](operations.ts), [native persistence](../../../cloudflare/recurring/operations.ts),
[digest](../../../cloudflare/insights/operations.ts) and
[browser report](../../../../web/src/features/recurring-digest/feature.tsx).
