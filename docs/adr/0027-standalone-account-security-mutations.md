# One-time account-security mutations own their atomic unit

- **Status:** Accepted
- **Date:** 2026-09-23
- **Supersedes:** [ADR 0012](0012-canonical-mutations-are-transaction-composable.md)

Canonical mutations normally share one transaction-composable implementation for individual and
atomic-batch execution. A one-time account-security mutation is **standalone** when challenge issuance,
proof consumption, or single-use secret rotation must be coupled to its own atomic commit. It remains a
canonical mutation with a reusable implementation, but is excluded from the derived atomic-batch child
schema; its individual execution must commit its state change and durable follow-up work atomically.
This covers backup-recovery-code rotation and verified-email credential replacement request/completion.
No other mutation can opt out for implementation convenience.

Bundling a proof-bearing operation with unrelated changes would widen the proof and challenge
lifecycle to the caller-owned unit, including its delivery and one-time disclosure semantics. The
alternative was to make every proof-bearing mutation a child of that unit with composable proof checks,
consumption, and delivery hooks; it increases the lifetime and ownership of security-sensitive material
without a supported batch use case. Keep the exception narrow and test both the exclusion from the
batch input and each standalone operation's atomic unit.

A query observes domain state. Required credential-use, allowance and Audit accounting can
accompany that observation without becoming a domain transition. A mutation requests a domain
transition, retains durable work or causes an external effect. The atomic-batch schema derives
eligible child inputs from canonical operation policy and excludes queries and the batch itself.

Individual and batch execution share owner preparation. The UserStore commits admitted child
writes and their mandatory evidence in one transaction. Owners do not open nested commits.
Irreversible provider work runs from the committed intent under its matching idempotency and
reconciliation rules. [Batch accountability](0029-atomic-batch-accountability-boundaries.md)
describes failure attribution.
