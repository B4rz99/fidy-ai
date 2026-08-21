# Serialize consent revocation with consent-dependent work

- **Status:** Accepted
- **Date:** 2026-08-02
- **Amends:** [ADR-0007 PostgreSQL row-level User isolation](./0007-postgresql-row-level-user-isolation.md)

## Context

Current onboarding consent is an authorization precondition for reading a User's personal Transcript, sending that context to the hosted model, admitting a Hosted Agent Session, executing canonical operations, admitting a WhatsApp turn, and authorizing its exact free-form recipient/window projection. A check followed by a database effect in a separate transaction leaves a race in which revocation can commit between the check and that effect. Moving those operations into Consent would violate ownership. Holding a database transaction across a provider call would contradict the short RLS transaction model and allow provider latency to pin connections and delay revocation.

## Decision

Consent publishes a subject-scoped PostgreSQL advisory transaction lock. Each short consent-dependent database unit acquires that lock, verifies current consent, and invokes the relevant slice-owned operation before committing. Consent revocation acquires the same lock. If revocation wins, the later unit is rejected; if the unit wins, revocation waits for that already-authorized database effect to finish.

Hosted-model egress linearizes at the serialized consent check that loads its exact Transcript context. The database transaction commits before the provider call starts. Revocation after that point does not retroactively invalidate context whose egress was already authorized, but every later Transcript read or write, Hosted Agent Session admission, and canonical operation must pass a new serialized check. Each provider round has a fixed timeout and cancellation boundary.

Hosted work is serialized once, at Hosted Agent Session admission, rather than per canonical call: admission takes the subject lock, verifies current onboarding Consent, and captures the exact Consent basis the session runs under ([ADR 0019](0019-hosted-runtime-owns-conversation-continuity.md)). A canonical operation inside an already-admitted Turn is not re-serialized, so a revocation closes the session for future Turns without interrupting a Turn already admitted. PAT-authorized calls remain serialized per call.

This is a transaction-coordination exception to ADR 0003's single-slice atomicity check, alongside ADR 0005's canonical state-plus-Audit transaction and ADR 0009's bootstrap transaction. It does not transfer ownership or permit direct cross-slice table writes. Each participating slice remains the only implementation that writes its data. The exception is limited to one short consent-dependent database unit: one Transcript read or append, one Hosted Agent Session admission, one canonical authorization/execution/audit attempt including PAT renewal, one WhatsApp evidence/job/window admission, or one exact WhatsApp recipient/window authorization. Code must not infer unrelated cross-slice business invariants from the shared transaction.

## Consequences

No database transaction spans model, HTTP, channel, or provider network work. A hosted turn can retain already-authorized in-memory context during one bounded model round, while revocation remains able to commit. Canonical rejection rolls back PAT renewal and appends its metadata-only rejected Audit evidence separately, so a denied request neither consumes the token nor disappears from the audit trail.

## Rejected alternatives

- **Check consent and release the lock before a database effect:** rejected because revocation can commit before the protected read or write.
- **Hold the transaction lock across model or provider work:** rejected because an unbounded external wait can pin the connection and block revocation.
- **Use session locks outside transactions:** rejected because pooled connections make ownership and release failure-prone.
- **Move Transcript, Token, or canonical operation data into Consent:** rejected because authorization does not transfer data ownership.
