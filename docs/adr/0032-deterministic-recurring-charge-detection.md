# ADR 0032: Deterministic recurring-charge detection

## Status

Accepted — implements [issue #24](https://github.com/B4rz99/fidy-ai/issues/24).

## Context

Recurring charges are historical financial patterns, not Subscription billing, merchant authorizations, or proof that a service remains active. Detection must use exact Money and effective Transactions, be explainable, preserve User isolation and processing Consent, and not add a history scan to capture requests. Messaging and opt-in belong to #29/#26.

## Decision

Create a Recurring owner with a pure, deterministic monthly-v1 detector. Transactions publishes decoded effective outflow facts, a bounded cursor, fact-revision identities, the first financial capture time and its interpretation zone, and a revision/Consent commit guard. Recurring never reads Transaction persistence or reconstructs Reconciliation policy.

### Detector policy

- Require three distinct effective outflows in consecutive calendar months with explicit Counterparty and the same Currency. Missing Counterparty means skip, not infer from Notes or Category.
- Normalize Counterparty using Unicode NFKC, case and whitespace only. No fuzzy matching or LLM.
- Anchor to the first supporting local calendar day. Clamp that day to each month's last day; permit at most three days of drift. Calendar months are not thirty-day intervals.
- Compare amounts using exact BigDecimal arithmetic: `abs(candidate - reference) * 100 <= reference * 5`. The initial supporting charge is the fixed reference; do not compound tolerance or average Money. The latest compatible supporting charge supplies displayed Money.
- A Transaction supports at most one proposed series. Reject ambiguous candidate assignments rather than choosing greedily. Deduplicate repeated Transaction identities.
- Later compatible observations can update a confirmed pattern after a gap without needing another consecutive triple. Missing future charges neither expire a pattern nor imply cancellation.
- Re-evaluate effective history after Corrections and reversible Reconciliation. Shared supporting identities preserve the series identity even when a Correction changes the original reference amount; that corrected observation supplies the repaired fixed reference. Invalid patterns become unavailable; restoring supporting evidence retains the original confirmation. Evidence and detector revision stay private.

### Persistence and coordination

Transaction-owned D1 triggers atomically invalidate the fact revision with retained financial changes, including SourceAttestations and Reconciliation. Existing history receives an initial revision. The first capture establishes the cold-start clock; historical captured context establishes its interpretation zone.

Maintenance discovers four pending User identities per invocation using a persisted round-robin cursor. Each bounded step enters the existing User Durable Object, verifies the addressed User, and checks current processing Consent. Persisted phases initialize/reset, scan effective facts in pages of 128, detect one Counterparty/Currency group, and atomically cut over series, evidence, immutable first confirmations, and completed progress. A changed revision restarts evaluation; stale or revoked commits roll back. Capture requests perform no detection or history scan.

Private v1 resource ceilings are 512 facts per Counterparty/Currency group and 128 retained series per User. Exceeding either fails closed and does not publish a partial/current evaluation. Previously published historical pages remain distinguishable as updating. These are conservative evaluation limits, not claims that every history can be evaluated; raising them requires revisiting detector cost and bounded commit size.

### Public behavior

`recurring.listRecurringSeries` is a Free canonical read requiring PAT `read` scope, with no agent confirmation. Public HTTP and hosted execution use the same owner. Pages contain at most 32 historical patterns ordered by Currency, normalized Counterparty and stable identity. A cursor is pinned to a completed evaluation revision; mixing completed revisions is rejected. Status distinguishes not-evaluated, updating and current. Decode retained output before accepting Audit or PAT-use effects; recheck live authority, Consent and financial/evaluation revisions in the final D1 unit.

First confirmations retain exact Money, cadence, stable identity, eligibility, explicit User subject and a historical UserContext snapshot. Eligibility is immutable: backfill takes precedence, otherwise confirmations within thirty days of first financial capture are cold-start suppressed. Backfill is capture lag greater than thirty days, not statement-import classification. Suppressed confirmations stay visible but never become delayed announcements. A private bounded confirmation reader checks current processing Consent and a complete evaluation at the current financial revision; it fails closed while evidence awaits repair and excludes invalid patterns. It exposes no scores or clustering internals.

No delivery, digest schedule, totals, weekly/yearly cadence, FX, missed-charge scheduler, active/cancelled status or Subscription behavior is introduced. A later detector revision must explicitly migrate/reset its retained evaluation state; it cannot reinterpret an immutable first confirmation or reuse its identity to announce again.

## Consequences

The detector is inexpensive, testable without infrastructure and replaceable behind detector-independent facts, series and confirmation interfaces. Monthly-only, exact matching and ambiguity rejection deliberately favor false negatives over unsupported announcements. Evaluation is eventually consistent and its incompleteness is visible. Users with histories above the private caps require a later resource-policy/detector refinement rather than a silently truncated result.

## References

- [ADR 0026: Cloudflare-native production replatform](0026-cloudflare-native-production-replatform.md)
- [ADR 0031: Published owner interfaces](0031-published-owner-interfaces-and-visible-internals.md)
- [Server architecture](../../apps/server/ARCHITECTURE.md)
