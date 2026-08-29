# Separate Forwarded Email Ingestion resource budgets

- **Status:** Accepted
- **Date:** 2026-08-28

Forwarded Email Ingestion uses distinct budgets for public request concurrency, authenticated Resend
recipient resolution, per-User admitted work, and durable system-wide outstanding work. Public bytes
and verification receive a small process-local concurrency lane and deadline; every verified event
then charges one fixed-size, cross-instance PostgreSQL resolution window before address lookup;
resolved work additionally charges stable-User limits and atomically enforced per-User and global
backlog capacity.

Recipient existence cannot be known before lookup, so signed unknown-recipient traffic and known
traffic necessarily share the finite resolution budget. Reserving known capacity before resolution
is impossible without duplicating the private address index outside its owner. An attacker able to
induce enough valid Resend deliveries may therefore cause temporary webhook retries, but cannot
create unbounded verification concurrency, address-resolution work, retained rows, or provider/model
spend. Resend retry behavior and a resolution budget deliberately larger than admitted-work budgets
make bounded temporary denial preferable to unbounded resource consumption.

## Owned limits and rationale

The Ingestion module owns these independently tuned resource classes:

| Class                     | Current bound                                                                             | Scope and rationale                                                                                                                    |
| ------------------------- | ----------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| Public webhook lane       | 32 concurrent requests per process; 64 KiB body; 1-second permit deadline                 | Bounds unauthenticated sockets, buffering, and signature work before provider proof is trusted.                                        |
| Svix proof input          | 128-character delivery ID, 32-character timestamp, 1024-character signature               | Bounds verifier inputs and keeps delivery IDs aligned with the durable replay ledger.                                                  |
| Authenticated resolution  | 1000 new deliveries/minute; at most 11,000 replay-ledger rows retained for 10 minutes     | Bounds cross-User address resolution while preserving completed replay detection through Resend's short retry window.                  |
| Known-recipient admission | 120/minute globally and 100/hour per stable User                                          | Bounds downstream database and provider/model demand independently of public traffic.                                                  |
| Durable unfinished work   | 100 per User and 200 globally                                                             | Retains at most the current 50-message Free allowance plus one 50-message deferred month per User while bounding total hosted work.    |
| Resend retrieval          | 3 minutes end to end; 14 seconds per request; 1 MiB metadata; 4 KiB attachment descriptor | The outer deadline includes streamed bodies and is shorter than the processing lease. Individual deadlines localize provider stalls.   |
| Inline-image evidence     | 8 images, 1 MiB each, two concurrent downloads, 4096×4096 and 16,777,216 pixels           | Bounds network, retained bytes, and Sharp's decoded allocation; ordinary attachments never cross the seam.                             |
| Model extraction          | 30 seconds                                                                                | Bounds the only model call made for one retained notification email.                                                                   |
| Processing claim          | recoverable after 5 minutes                                                               | Leaves two minutes beyond the complete retrieval deadline for persistence and scheduling while preventing overlapping live retrievals. |

Product/evidence bounds and the retrieval/lease relationship live in
`apps/server/src/core/ingestion/email-policy.ts`. Transport-only limits stay beside the shell adapter
that consumes the resource. Database-owned cross-instance limits live in migration 0041. Ingestion
maintainers own tuning: any change must update this ADR, its owning constant or migration, boundary
and recovery tests, and the production capacity assumptions together. Limits must not be increased
solely to silence overload signals; evidence retention, provider cost, denial-of-service exposure,
and the five-minute fencing lease must be reviewed as one change.
