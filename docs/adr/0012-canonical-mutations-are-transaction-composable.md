# Canonical mutations are transaction-composable by definition

- **Status:** Accepted
- **Date:** 2026-08-08

## Context

Atomic batches need a mechanically derived child-operation schema and one PostgreSQL transaction in
which every state change either commits or rolls back. A per-operation `eligible | ineligible`
policy would make transaction composability a second lifecycle state that can drift from an
operation's semantics and implementation. It would also permit canonical mutations that work only
individually, forcing callers to understand an implementation-readiness exception.

## Decision

Every canonical operation declares whether it is a **query** or **mutation**. A canonical query
observes domain state without requesting a domain transition or external effect; audit, quota, and
access-accounting writes do not change that classification. A canonical mutation requests a domain
transition, records durable work, or causes an external effect.

Every canonical mutation is transaction-composable by definition. Its individual operation and
`operations.executeAtomicBatch` call the same reusable implementation inside a caller-owned,
User-scoped PostgreSQL transaction. The implementation does not open or commit an inner
transaction. External work that must remain compatible with rollback is represented by a durable
job inserted in that transaction and performed after commit.

The atomic-batch child union is derived from every canonical mutation and its encoded input schema;
there is no independent eligibility allowlist. The batch operation excludes itself structurally so
nested batches are unrepresentable.

## Consequences

A new canonical mutation cannot ship until it has a transaction-aware implementation usable both
individually and in a batch. Adoption uses an expand sequence: kind records semantics immediately,
Transaction mutations establish the tracer, and the remaining pre-existing mutations migrate in the
follow-up slice issues linked from issue 137 before the batch operation is published. During that
migration, kind is not an implementation-readiness flag.

Operations requiring synchronous irreversible external success must be redesigned around durable
intent or cannot be modeled as canonical mutations under this contract. Queries remain outside
mutation batches unless a later concrete use case establishes transactional read semantics.

## Rejected alternative

A per-operation `atomicBatch: "eligible" | "ineligible"` policy was rejected. It supports incremental
enrollment, but keeps temporary implementation readiness as permanent metadata, introduces a
parallel allowlist to maintain, and weakens the invariant that canonical mutations compose.
