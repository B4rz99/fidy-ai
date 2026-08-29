# Atomically finalize ingested Transactions through owner-published operations

- **Status:** Accepted
- **Date:** 2026-08-28

Ingestion must not report durable work as completed unless the interpreted Transaction and its
SourceAttestation also commit, and it must not create that financial record while leaving the same
work claim open. The Ingestion-owned finalization transaction therefore composes the
Transactions-owned `captureNotificationEmailTransactionInScope` operation with an Ingestion-owned,
claim-fenced terminal transition under one matching User scope. Each slice retains its own writes;
the caller owns rollback across both owner-published operations.

Completing the receipt before Transaction capture could silently lose evidence, while committing the
Transaction first and closing the receipt later could duplicate financial records after recovery.
An outbox would avoid the cross-slice transaction but would add an observable intermediate state and
a second idempotency protocol without improving this single-PostgreSQL boundary.
