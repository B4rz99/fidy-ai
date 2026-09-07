# Retain PostgreSQL admission rather than add a RateLimiter store

**Status:** Accepted — [#470](https://github.com/B4rz99/fidy-ai/issues/470), following ADR 0024.

Keep the existing PostgreSQL admission controls and Effect process-local resource bounds.
The [control inventory and executable evaluation](../research/distributed-admission-rate-limiter.md)
show that Effect RC.112's RateLimiter has no SQL store, and its single-key fixed-window/token-bucket
algorithms do not preserve our rolling windows, calendar boundaries, rejected-attempt accounting,
atomic multi-key charging, or transaction-coupled proof/replay/provider-spend controls unchanged.
Memory-backed RateLimiter is rejected wherever coordination across replicas or restart survival is
required. Adding Redis or a custom SQL store would add machinery without deleting the protected
PostgreSQL state. We therefore retain the counters, locks and expiry paths, with no dual writes or
memory fallback. The two-OS-process PATPairing HTTP proof validates this retained topology.

## Alternatives and consequences

- **Redis-backed Effect RateLimiter:** potentially appropriate for a future independent, explicitly
  token-bucket policy, but not a drop-in replacement for the controls audited here. Tighter parameters
  could conservatively bound traffic, but would change permitted bursts and Retry-After; that requires
  a separate product/security decision, not an equivalent implementation claim.
- **A Fidy SQL RateLimiterStore or custom multi-key/sliding-window Redis Lua:** rejected here because
  it still owns table/script, locking, counters and cleanup. Wrapping custom admission in Effect is
  not the required net deletion and does not remove atomic domain state.
- **Per-process limits only:** rejected. Additional processes or restart would grant fresh security
  and provider-spend allowances. Existing semaphores bound local concurrent resource usage only.

No Redis service is authorized for production by this decision. A later proposal must explicitly
resolve all of the following **before** production use:

1. Infrastructure ownership/cost, shared namespace and identical policy configuration across replicas,
   private authenticated transport and encryption, secret delivery/rotation, least-privilege ACLs,
   and whether Lua/multi-key topology requires a single primary or cluster hash-slot constraints.
2. Persistence, failover and backup/restore behavior: acceptable lost-permit budget, eviction policy,
   memory/key-cardinality ceilings, restart behavior, retention, and clock authority/skew. TTL alone
   is not durability; losing a key must not silently reset a security/spend control.
3. Fail-closed outage behavior without a memory fallback, bounded connection/request timeouts and
   concurrency, recovery/reconciliation of ambiguous consumption, and rollout/cutover without
   resetting live windows or weakening transaction coupling.
4. Closed, low-cardinality allowed/rejected/store-unavailable counts and latency, saturation/eviction,
   failover health and retention alerts. Keys, User ids, sources, mailbox HMACs and raw Redis errors
   are not telemetry. Store outages are not ordinary 429 responses.
5. Two-process burst/refill/rejection/restart **and store-failure** evidence for the proposed control,
   preserved stable-User/source anti-bypass and Retry-After, followed by deletion of the replaced
   custom table, lock, counter and expiry code. No new abstraction is justified by a wrapper alone.

This decision does not alter ADR 0024's SQL-backed durable execution adoption or the independent
migration of execution-only leases, claims and pollers.
