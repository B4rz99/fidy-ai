# Atomically finalize ingested Transactions through owner-published operations

- **Status:** Accepted
- **Date:** 2026-08-28

Ingestion must not report durable work as completed unless the interpreted Transaction and its
SourceAttestation also commit, and it must not create that financial record while leaving the same
work claim open. The Cloudflare ingestion adapter composes the Transactions-owned
`captureNotificationEmailTransactionInScope` operation with the Ingestion-owned, claim-fenced
terminal transition in one matching User-scoped D1 atomic unit. Each slice retains its own writes;
the adapter owns rollback across the published operations.

Completing the receipt before Transaction capture could silently lose evidence, while committing the
Transaction first and closing the receipt later could duplicate financial records after recovery. A
bounded outbox record committed with the state change lets a Queue or Workflow continue external work
without weakening the atomic domain result. If the adapter is unavailable, ingestion does not claim
success.
