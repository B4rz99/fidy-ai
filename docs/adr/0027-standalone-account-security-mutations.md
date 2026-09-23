# One-time account-security mutations own their atomic unit

- **Status:** Accepted
- **Date:** 2026-09-23
- **Supersedes:** ADR 0012

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
