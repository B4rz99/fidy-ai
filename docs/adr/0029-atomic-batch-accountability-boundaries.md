# Atomic-batch accountability and abort attribution boundaries

- **Status:** Accepted; daily Audit quota policy revised on 2026-10-18
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

A body that fails the published request envelope (absent, empty, or oversized `calls`), or a child
that names no canonical operation, writes one metadata-only refusal AuditLogEntry naming the batch
operation when the WebSession or PAT credential remains live. These pre-admission envelope rows
do not consume a commercial allowance. Stable-User short-term request admission protects the
whole invocation before validation and bounds malformed attempts. Audit storage imposes no daily
quota; the former 256-per-day child/envelope counters and 100-per-day Transaction cap were removed
on 2026-10-18 because they duplicated admission controls and imposed hidden limits on paid work.
These refusal rows carry no input or child success; the PAT envelope needs no child scope, only a
live credential and Consent. A batch that already writes a child refusal never writes an envelope
row. Other pre-admission refusals record nothing: a child whose operation has no batch
adapter, a child below the required tier, a child outside the caller's credential scope (the same
`scope_missing` decision the individual ingress makes, reported through the batch failure
contract), a child whose encoded input outgrows the per-child body bound an individual call of that
operation accepts, a second staged statement child (one batch publishes at most one file, so
staging admission cannot be multiplied), and a repeated `callId`. None of these names work
the caller was allowed to do, and they do not need additional canonical accountability rows.

The batch operation writes no second row when a child refusal was recorded. The session audit
vocabulary includes the batch id for the envelope-only case. Successful child work retains its own
AuditLogEntry, while commercial external-call consumption is one admitted envelope.

## Attribution stops at what the unit can observe

When the D1 unit aborts, the batch reports the first child it can prove responsible: a stale
observed revision, a repeated observed revision of one Transaction (the later child's guard cannot
be satisfied), or an owner capacity assertion. The child's refusal AuditLogEntry is recorded whenever that
entry can commit. Audit persistence failure remains unavailable and rolls back domain work;
recording evidence does not exhaust a second product allowance.

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
one envelope AuditLogEntry only for a refusal naming no admissible child, an unattributable abort answering `unavailable`, AccessTier
resolved from catalog policy with a fail-closed `free` default until a Subscription adapter resolves
tiers at this seam, and no intra-batch reads (children are prepared before the unit, so a child
cannot correct a Transaction an earlier child creates).

## Rejected alternatives

Auditing every batch envelope in addition to its children: redundant with per-child attribution. Issue #794 adopted the narrower deferred alternative A2: only a pre-admission
refusal with no attributable child earns an envelope row.

Deriving typed child inputs from the catalog: parameterizing `CatalogOperation.input` across the
whole catalog to serve two consumers, instead of keeping the input codec beside the operation that
declares it.
