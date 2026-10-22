# Production audit: code/schema mismatch, 22 October 2026

Status: unresolved in production. Protected-read failures are confirmed schema mismatch evidence,
not renewed D1 quota exhaustion. Final-head CI remains required before merging the audit fixes.

## Production evidence

- Release `20fd17a37458f54031c771d0b9e1de24a5e98933` initially served fresh Accesos,
  Recurring and Budget reads. The browser created an October Restaurantes Budget cap, updated it
  to COP 23,456, reloaded it and observed November inheritance. Dashboard agreed with the cap and
  existing expense aggregation. No November plan was saved.
- [Release 39786448884](https://github.com/B4rz99/fidy-ai/actions/runs/39786448884)
  then promoted `ff37f818fbf86bc766e090dc5cba8ee746cdd80a` successfully. Its
  `activePaidSubscriptionCondition` joins `payment_source_context`; protected canonical reads
  prepare that standing dependency through allowance disclosure.
- Read-only production `sqlite_master` inspection found `card_enrollments` and
  `verified_payment_sources`, with none of `payment_enrollments`, `payment_sources`,
  `subscriptions` or `payment_source_context`. An `EXPLAIN QUERY PLAN` using the current standing
  join fails with `no such table: payment_source_context: SQLITE_ERROR`.
- Fresh Budget, Category and review reads returned HTTP 503 with closed `unavailable` feedback.
  Representative Category trace: `c0a6bbd9fcc0791de293fcf622700fe8`. Minimal D1 reads succeeded.
  Earlier HTTP 429 responses decoded as `rate_limited`; neither establishes daily quota exhaustion.
- [Guarded rollback 39789493011](https://github.com/B4rz99/fidy-ai/actions/runs/39789493011)
  failed closed. Its exact internal refusal was not exported. Repository compatibility policy
  also excludes schema-changing release pairs; that policy is not proof of the unexported cause.
- [Read-only inspection 39792941855](https://github.com/B4rz99/fidy-ai/actions/runs/39792941855)
  passed and reported no Worker topology drift. Database verification was not requested by that
  inspection, so it does not contradict or resolve the independently reproduced missing-view error.

After the incident, fresh Accesos navigation returned MCP metadata with eight revoked audit grants
(HTTP 200), while PAT metadata returned HTTP 503 with retry feedback. Viewing it did not request
fresh identity. The outage is not a universal browser-session failure.

A no-data greeting produced one hosted proposal HTTP 503. The composer retained the exact editable
draft, removed the temporary User entry and showed safe failure feedback. Closing chat, navigating
from Accesos to Dashboard and reopening retained the draft with no additional hosted request or
false assistant reply. Dashboard showed load-failure feedback. This proves proposal-failure
recovery, not successful inference or absence of all possible server-side work.

## Native release regression and limit

`smoke-schema.test.ts` executes the real private smoke protocol against native D1 with the complete
baseline. Removing `payment_source_context` originally still returned 202 and published work.
The corrected binding check prepares the actual standing SQL with `LIMIT 0`, a fixed synthetic
identity and no account-row output. The compatible baseline is accepted; the missing-view case
returns closed `schema` before another queue publication. This is a protected-read dependency check,
not complete schema equivalence. Existing recognized D1 quota deferral is unchanged: unavailable
verification remains deferred rather than proven.

## Completed local checks

Use reviewed Bun `1.4.3-canary.1+13a98b0db` and locked Effect 4.0.5. Counts below describe separate
runs; selected suites and prerequisites overlap and must not be summed as unique coverage.

| Check                                                                                    | Result and boundary                                                                                                                                        |
| ---------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Complete browser functional control, revision `de6cbc88d194c526975005d5e5733375220cf169` | 182 passed, three opt-in cost skips, 4.0 minutes; one worker and `--no-deps`                                                                               |
| Final normal-concurrency second browser partition                                        | All 91 passed; the first partition still failed four cases below                                                                                           |
| Selected native Recurring, Budget, OAuth-agent and PAT baseline                          | 373 passed, one existing skip, 19 files before the later Vitest update                                                                                     |
| Native missing-schema smoke/Worker checks after Vitest update                            | All 40 passed                                                                                                                                              |
| Hosted Turn/public recovery checks after Vitest update                                   | All 34 passed                                                                                                                                              |
| Web and CLI unit suites after Vitest update                                              | 256 and 98 passed respectively                                                                                                                             |
| Pairing/Consent browser checks after helper typing corrections                           | All eight passed                                                                                                                                           |
| Public site after Astro update                                                           | All 23 browser checks passed against a fresh build, including islands, CSP and accessibility                                                               |
| Opt-in resource investigations after typing corrections                                  | All three passed, 35.4 seconds; stronger positive settlement rerun passed in 18.7 seconds                                                                  |
| OS credential store and isolated CLI/browser journey                                     | Cross-process synthetic credential persistence/cleanup passed; browser-approved query/mutation/batch and attributable Audit journey passed in 12.3 seconds |
| Complete static gate                                                                     | Passed with updated compatible dependencies; no compiler or lint diagnostics suppressed                                                                    |
| Earlier fresh CI infrastructure job `39791951121`                                        | All 289 passed, including Alchemy local emulation; not final-head CI                                                                                       |

The resource probes separate visibility-triggered session binding from provider cancellation.
Payment resumption requires exactly one binding read and one payment-status read, successful HTTP
responses and rendered active-Subscription feedback before checking that polling stops. The probe
opens the settings menu when needed, preserves SPA navigation, handles an already available retained
view and uses bounded visible retry only after explicit 429 Consent refusal. Logout must be
acknowledged and the new login document ready before measuring the retired lifetime.

Simulated cancelled-provider (20 seconds), hidden-payment (60 seconds) and post-logout (60 seconds)
windows reported no requests and zero native D1 rows read or written. These are synthetic local
clock windows, not physical-device evidence or a production cost forecast. No production OAuth
connection or financial Transaction was created by these local checks.

## Failed controls retained as audit evidence

| Diagnostic                                                    | Observed result                                                                                                                                        |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Initial broad browser run                                     | 178 passed, three failed, three skipped: two obsolete token-duration selectors and an accepted OAuth operation receiving real canonical `rate_limited` |
| Broad run after isolated OAuth User                           | 174 passed, seven failed, three skipped; all 12 affected Pairing/Recurring cases then passed in isolation                                              |
| Earlier serial diagnostic                                     | 180 passed, one Microsoft Consent-read journey failed, three skipped                                                                                   |
| Traced parallel diagnostic                                    | 162 passed, 19 failed, three skipped; tracing changed workload and does not establish one common cause                                                 |
| Later broad run overlapping local type checking/push scanning | 168 passed, 14 failed, three skipped; not a clean timing control                                                                                       |
| Final first normal-concurrency partition                      | 87 passed, four failed, three skipped: native Accesos continuation, native Pairing redemption, Budget Widget changes and native monthly cap save       |

A trace established a real 429 Consent refusal during the recovery case's direct reload and a
separate mock-clock `Cannot fast-forward to the past` race. The reload now uses the existing
bounded visible read retry. The expiry mock uses known clock anchors. The accepted OAuth operation
has an independent synthetic User; no production limiter or mutation retry was changed. Final
serial success does not establish concurrency or production capacity.

Initial opt-in failures counted visibility binding as post-cancellation polling, assumed the
settings menu stayed open and omitted binding from resumed-payment cost. Corrected probes retain
strict endpoint counts and zero-poll assertions. Two blocked diagnostic iterations were interrupted;
they are not passing runtime evidence. Earlier broad native execution hit socket failures under
competing runtimes; the controlled reviewed-runtime runs above are the completed evidence. Local
Alchemy emulation was inconclusive after schema-style 503, sidecar failure and startup bounds;
the fresh CI infrastructure pass supersedes it for that tested revision without suppressing its gate.

## Compatible dependency gate

During the audit, Vitest 5.0.5 / matching coverage packages, Astro 7.4.0 and its React integration
7.1.0 crossed the unchanged seven-day eligibility threshold. Those compatible versions are pinned
and installed; existing major-version deferrals and the restricted shadcn exception are unchanged.
Vitest's [release notes](https://github.com/vitest-dev/vitest/releases/tag/v5.0.5) include preserving
Vite's filesystem deny rules; Astro's [7.4 notes](https://astro.build/blog/astro-740/) document its
release and supported Node baseline. Dependency policy reports zero failing pins and nine retained
review records. Final-head CI remains a merge requirement.

## Recovery and deferred live checks

The [D1 migration-history runbook](production-releases.md#d1-migration-history) explains that editing
an applied `0001_schema.sql` does not upgrade the existing database. The synchronized populated
transition ticket [#1494](https://github.com/B4rz99/fidy-ai/issues/1494) was still open when inspected.
The unapplied-migration repair workflow verifies unrecorded incremental-file repairs; it is not a
populated-baseline conversion.

Use the reviewed cutover in [the schema checklist](database-cutover-1428.md), with its fence, backup,
prerequisite checks and populated native proof, or establish an explicitly reviewed recovery path.
Coordinate the schema owner's test window and rerun fresh protected reads before financial or
access changes. Do not replay the fresh baseline over populated production, add compatibility
aliases, rewrite account identity or bypass the rollback guard. No production data/schema write,
ledger alignment, database recreation or billing change was performed by this audit.

Live automatic chat observation, maintained-plan lookup/lifecycle approval, Dashboard rename/restore
and an independent-month Budget write remain unverified after the incident. The sole new Budget
fixture is the October Restaurantes cap of COP 23,456; permanent cleanup requires the User's exact
deletion confirmation after healthy readback. Existing production Transactions were not modified.
Provider participation, new access grants and physical-device checks remain separate deferred work.
