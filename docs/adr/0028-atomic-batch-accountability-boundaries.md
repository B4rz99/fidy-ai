# Atomic-batch accountability and abort attribution boundaries

- **Status:** Accepted
- **Date:** 2026-09-24

An atomic batch composes canonical child operations into one subject-scoped D1 unit. Its failures
cross three boundaries that individual execution never exposes, so each boundary needs one written
rule instead of a per-case decision.

## Accountability is per child

The canonical child operation is the accountability unit. Once a child names a canonical mutation
this adapter composes, it is admitted: its authority is rechecked live, and every refusal it causes
is recorded as that child's metadata-only refusal AuditLogEntry under the exact capability the
caller presented. A child that commits contributes its success AuditLogEntry inside the same D1
unit.

Refusals decided before admission are request or policy decisions answered on the declared failure
contract and record nothing: a body that fails the published request envelope (absent, empty, or
oversized `calls`), a child that names no canonical operation, a child whose operation has no batch
adapter, a child below the required tier, a child outside the caller's credential scope (which
matches the individual ingress refusal exactly), and a repeated `callId`. None of these names work
the caller was allowed to do, and auditing them would let garbage requests consume the caller's own
daily audit budget.

The batch operation itself does not write a second envelope AuditLogEntry. Its accountability is
exactly the union of its children's; a batch-level row would duplicate evidence, require widening
`transaction_audit`'s closed operation CHECK for a non-domain operation id, and add a budget lever.

## Attribution stops at what the unit can observe

When the D1 unit aborts, the batch reports the first child it can prove responsible: a stale
observed revision, a repeated observed revision of one Transaction (the later child's guard cannot
be satisfied), or the daily budget trigger. That child's refusal AuditLogEntry is recorded.

An abort that maps to no child answers the canonical `unavailable` failure. Because the unit rolled
back, no child state and no child success AuditLogEntry exists to report; a misattributed refusal
row would be worse evidence than none. Guard-level identity (per-child trigger markers that make
mapping total) is deliberately deferred until a concrete unattributable abort class appears.

## Canonical inputs stay owned by the operation module

The module that declares a canonical operation owns the codec for its canonical input. Consumers of
one specific operation's input — today the batch adapter — import that codec; they do not restate
the envelope. `CatalogOperation.input` stays type-erased for generic catalog tooling.

## Consequences

Individual and batch execution owe each other the same decisions: authorization, AccessTier,
confirmation before this seam, domain checks, refusal codes, and audit obligations. A new batch
child cannot ship until its owner can execute it individually. The accepted residuals are explicit:
no batch-envelope AuditLogEntry, an unattributable abort answering `unavailable`, AccessTier
resolved from catalog policy with a fail-closed `free` default until a Subscription adapter resolves
tiers at this seam, and no intra-batch reads (children are prepared before the unit, so a child
cannot correct a Transaction an earlier child creates).

## Rejected alternatives

Auditing the batch envelope as its own canonical operation: redundant with per-child rows, a new
budget lever, and a migration for an operation id no domain owner writes.

Deriving typed child inputs from the catalog: parameterizing `CatalogOperation.input` across the
whole catalog to serve two consumers, instead of keeping the input codec beside the operation that
declares it.
