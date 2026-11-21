# Atomic child guard inventory

This inventory follows the current User Store SQLite implementation. Public canonical batches are
admitted in [`canonical-admission/internal/local-batch.ts`](../../canonical-admission/internal/local-batch.ts)
and prepared/committed by `local-batch-plans.ts`. The owner resolves each child against the
installed catalog, reserves its owner route, prepares it against the shared User Store snapshot,
then commits the selected children together through the owner SQLite transaction. Owner-specific
authority, stale revision, capacity, and refusal decisions remain with the child operation.

The native batch result is classified only from trusted indexed evidence and statement results.
Unknown, ambiguous, or unproved failures fail closed as unavailable; a rolled-back child is not
identified by recounting committed state. Metadata-only refusal evidence is recorded only when the
owner can attribute the refusal safely. External provider work is not performed inside the SQLite
transaction; durable intent and reconciliation belong to the owning feature.

| Concern                                                              | Current authority                                                                                                                                        |
| -------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Request admission, child selection, same-User routing, atomic commit | [`local-batch.ts`](../../canonical-admission/internal/local-batch.ts), [`local-batch-plans.ts`](../../canonical-admission/internal/local-batch-plans.ts) |
| Owner-specific prepare, commit, refusal and accountability           | The selected canonical operation owner and its User Store adapter                                                                                        |
| Store transaction/capacity and native schema lifecycle               | [`runtime/sqlite/operations.ts`](../../runtime/sqlite/operations.ts), the SQLite runtime and per-owner schema declarations                               |
| Public behavior and regression evidence                              | [`canonical-operations/user-store.test.ts`](../user-store.test.ts) and the owning feature's native tests                                                 |

When changing an atomic child, update the owning operation and its tests. Preserve each owner's
authority and refusal semantics, ensure conditional writes prove the expected transition, and cover
mixed-child rollback through the public request path. The pre-refactor trigger and D1 guard design
is historical; see [issue #1405](https://github.com/B4rz99/fidy-ai/issues/1405) and the relevant
database cutover evidence for that implementation history.
