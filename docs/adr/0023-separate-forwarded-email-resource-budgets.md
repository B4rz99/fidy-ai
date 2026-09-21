# Separate forwarded-email resource budgets

- **Status:** Accepted
- **Date:** 2026-08-28

Forwarded email is an untrusted, bounded ingestion class. Cloudflare Email Worker admission applies
request and authentication limits before handoff; R2 retrieval applies independent byte, attachment,
and image limits; the application applies User allowance and deferred-work limits before creating
interpretation work.

The limits are separate because a cheap authenticated envelope, a large R2 object, and a model
interpretation consume different resources. One budget cannot safely represent the others. Every
limit is fail closed, visible in typed evidence, and enforced before the next resource is acquired.

The Cloudflare adapter owns platform admission and retention. The server package owns only the pure
allowance decisions and provider-neutral schemas; it does not implement a webhook verifier, a replay
ledger, a local queue, or a process-local rate limiter.
