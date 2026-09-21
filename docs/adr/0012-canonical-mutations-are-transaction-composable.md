# Canonical mutations are transaction-composable by definition

- **Status:** Accepted
- **Date:** 2026-08-08

## Context

Atomic batches need a mechanically derived child-operation schema and one Cloudflare D1 atomic unit
in which every state change either commits or rolls back. A per-operation `eligible | ineligible`
policy would make composability a second lifecycle state that can drift from the operation's meaning.

## Decision

Every canonical operation declares whether it is a **query** or **mutation**. A query observes domain
state without requesting a domain transition or external effect; audit, quota, and access-accounting
writes do not change that classification. A mutation requests a domain transition, records durable
work, or causes an external effect.

Every canonical mutation is composable by definition. Its individual operation and
`operations.executeAtomicBatch` use the same reusable implementation inside one subject-scoped D1
atomic unit. The implementation does not open or commit a nested unit. External work that must remain
compatible with rollback is represented by bounded outbox work committed with the state change and
executed by the owning Queue or Workflow after commit.

The atomic-batch child union is derived from every canonical mutation and its encoded input schema;
there is no independent eligibility allowlist. The batch operation excludes itself structurally so
nested batches are unrepresentable. If the Cloudflare adapter is absent, the operation fails closed
rather than executing locally.

## Consequences

A new canonical mutation cannot ship until its Cloudflare adapter can execute it individually and in
a batch. Irreversible provider work must use an idempotent intent and reconciliation design; it may
not be hidden inside an atomic state operation. Queries remain outside mutation batches.

## Rejected alternative

A per-operation `atomicBatch: "eligible" | "ineligible"` policy was rejected because it creates a
second allowlist and permanently encodes temporary implementation readiness.
