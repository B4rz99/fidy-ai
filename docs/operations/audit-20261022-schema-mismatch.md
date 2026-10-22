# Production audit: code/schema mismatch, 22 October 2026

Status: unresolved in production. Do not interpret the protected-read failures as D1 quota exhaustion.

## Evidence

- Release `20fd17a37458f54031c771d0b9e1de24a5e98933` initially served fresh Accesos,
  Recurring and Budget reads successfully. The browser created an October Restaurantes Budget cap,
  updated it to COP 23,456, reloaded it and observed November inheritance. Dashboard agreed with
  the cap and the existing COP 10,103 expense total.
- [Release 39786448884](https://github.com/B4rz99/fidy-ai/actions/runs/39786448884)
  subsequently promoted `ff37f818fbf86bc766e090dc5cba8ee746cdd80a` successfully.
- That revision's `activePaidSubscriptionCondition` joins `payment_source_context`. Every
  protected canonical read prepares the standing dependency through allowance disclosure.
- Read-only production `sqlite_master` inspection found `card_enrollments` and
  `verified_payment_sources`, with none of `payment_enrollments`, `payment_sources`,
  `subscriptions` or `payment_source_context`. An `EXPLAIN QUERY PLAN` using the current standing
  join fails with `no such table: payment_source_context: SQLITE_ERROR`.
- Fresh browser Budget, Category and review reads returned HTTP 503 with closed `unavailable`
  feedback. Representative Category trace: `c0a6bbd9fcc0791de293fcf622700fe8`.
  Minimal D1 reads succeeded. Earlier HTTP 429 responses decoded as `rate_limited`; neither
  observation establishes renewed daily quota exhaustion.
- [Guarded rollback 39789493011](https://github.com/B4rz99/fidy-ai/actions/runs/39789493011)
  failed closed. Its exact internal refusal was not exported; the repository compatibility policy
  also excludes schema-changing release pairs. No guard was
  weakened, and no direct production data or schema write was performed by this audit.

A fresh Accesos navigation after the incident returned OAuth connection metadata with eight revoked
audit grants (HTTP 200), while PAT metadata returned HTTP 503 with retry feedback. Viewing the page
did not request a fresh sign-in. The outage is therefore not a universal browser-session failure.
A no-data greeting returned one hosted proposal HTTP 503; the composer retained the exact editable
draft and removed the temporary User entry, with no successful assistant reply. This proves safe
proposal-failure feedback, not successful inference or absence of all possible server-side work.
After closing chat, navigating from Accesos to Dashboard and reopening it, the exact greeting draft
remained editable and no new hosted request appeared. Dashboard itself showed safe load-failure
feedback. The same failure did not become a false successful assistant entry.

## Regression and limit

`smoke-schema.test.ts` executes the real private smoke protocol against native D1 with the complete
baseline. Removing `payment_source_context` initially still returned 202 and published work.
The corrected binding check prepares the actual standing SQL with `LIMIT 0`, using a fixed synthetic
identity and no account-row output. It accepts the compatible baseline and refuses the missing view
with the closed `schema` stage before another queue publication. This is a protected-read dependency
check, not a complete schema equivalence proof. Existing explicitly recognized D1 quota deferral is
unchanged; when D1 cannot execute checks, synthetic verification remains deferred rather than proven.

## Required recovery and deferred live checks

Use the reviewed, synchronized database cutover in `database-cutover-1428.md`, with the prescribed
fence, backup, prerequisite checks and populated native proof, or establish an explicitly reviewed
code rollback path. Do not replay the baseline over populated production, add compatibility aliases,
rewrite account identity or bypass the rollback guard. Then rerun fresh protected reads before any
financial mutation, token issuance or recurring approval.

The live automatic chat-observation rerun, maintained-plan lookup/lifecycle change, Dashboard
rename/restore and independent-month Budget write remain unverified after this incident.
The October Restaurantes Budget cap of COP 23,456 remains the single Budget fixture created in this
continuation; permanent cleanup requires the User's exact deletion confirmation. No November plan
was saved. Existing Transactions were not deleted or modified.

## Local verification boundary

With locked Effect 4.0.5 and the reviewed Bun `13a98b0db`, the selected native Recurring,
Budget, OAuth-agent and PAT run passed 373 checks with one existing skip (19 files).
The selected browser runs passed 31 and 54 checks respectively; shared admission/performance
prerequisites overlap. Native smoke/Worker checks passed 40, and the infrastructure suite excluding
local Alchemy emulation passed 288. The complete static gate passed. The reviewed-runtime hosted Turn and public recovery checks
passed all 34 cases. The broad initial local native
run hit socket failures under competing runtimes; the controlled reviewed-runtime rerun above is
the completed evidence. Local Alchemy emulation failed first with stale-schema-style 503, then
with a provider-sidecar connection failure and startup time bound in isolated stages. It remains
inconclusive locally; do not report its failure as a production fix or suppress its CI gate.

The fresh CI infrastructure job in run `39791951121` passed all 289 cases, including Alchemy local
emulation. Its broad browser shard passed 97 cases and correctly refused the Recurring list's
visible-name mismatch exposed by axe-core 4.14. The already reviewed shared control-name fix from
PR1508 is incorporated without disabling accessibility checks. All 15 chat/Recurring checks pass
on that corrected baseline. Full final-head CI must still complete before merge.
