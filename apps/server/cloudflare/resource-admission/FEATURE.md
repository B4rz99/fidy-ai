# Resource Admission

The current owner exposes provider-spend admission for User-local and shared provider capacity.
It does not own commercial allowances or the former general-purpose rolling admission counters.
Those designs and their native D1 cost comparisons are historical; see the accepted [#1405 design](https://github.com/B4rz99/fidy-ai/issues/1405), [email/PAT counter issue history](https://github.com/B4rz99/fidy-ai/issues/1432), and the related issue history.

## Current implementation

[`contract.ts`](contract.ts) defines the admitted phases (`model`, `reminderGeneration`,
`reminderSend`), positive unit counts, and the User/WebSession event-owner shape. The active
provider-spend schema is `providerAllowanceSchema` in that contract; it retains only phase, time,
and units, with indexes for phase/window reads and bounded expiry cleanup.

[`internal/provider-allowance.ts`](internal/provider-allowance.ts) owns the rolling one-day limits
and charge. It prunes at most 128 expired rows per call, sums the active phase's attempt and unit
usage, refuses at the configured attempt limit, and records accepted units (or a zero-unit refused
attempt) within the configured User or shared SQLite store-capacity policy. Shared charging is
published through the Directory's private `provider-allowance` route; `operations.ts` exposes the
owner's narrow operation surface.

The owning inference or reminder flow must charge before provider work and stop on refusal or an
unavailable authority result. Admission records capacity accounting; it does not grant User
authority or establish a Consent basis. Those checks remain at the provider-call owner.

## Evidence

Current tests belong with the provider-spend consumer and native SQLite runtime. The earlier
counter-consolidation comparisons, D1 row-cost tables, and populated D1 conversions describe the
retired implementation only; they are retained in GitHub issue/cutover history and are not current
performance guarantees.
