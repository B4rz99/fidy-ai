# Effect workflows at the Cloudflare boundary

Use this reference before introducing durable multi-step execution. A Workflow owns orchestration,
not Fidy domain authority. The Cloudflare Workflow adapter is the production seam; until it exists,
durable operations fail closed rather than using a process-local loop.

## Boundary and atomicity

A domain mutation followed by Workflow start is a dual write unless an outbox or a platform-proven
atomic submission couples them. Prefer:

1. commit the canonical state and a bounded outbox intent in one D1 atomic unit;
2. let a Queue or Worker claim the intent idempotently; and
3. start or resume the Workflow with a stable identity and bounded payload.

Never hold a D1 atomic unit across a provider call. Workflows may retry provider calls, but provider
ambiguity requires reconciliation rather than blind repetition. Persist correlation facts and
idempotency keys, not broad provider responses or personal content.

## Activities and durable waits

Use named activities for retry-sensitive steps. Activity names and attempt identities are persisted
contract data: keep them stable, unique, schema-versioned, and bounded. An activity must tolerate
redelivery and must not claim exactly-once external effects without provider evidence.

Use durable sleeps for business waits that must survive Worker replacement. Ordinary short pacing is
not durable and must not be mistaken for a schedule. Cancellation and suspension are explicit domain
outcomes; compensation is a reviewed operation, not an automatic assumption.

## Subject and security boundaries

Every Workflow execution carries an explicit authenticated `UserId` or a narrowly scoped non-User
correlation identity. A Workflow id or Durable Object key never authorizes a User. Reload current
subject state at each step and recheck revocation, consent, retention, and provider status before a
sensitive effect.

Payloads contain bounded identifiers and facts only. Do not persist credentials, browser verifiers,
raw email, prompts, replies, uploaded files, or unbounded provider bodies in Workflow state. Secrets
are loaded from Cloudflare bindings at the narrow adapter call.

## Testing and evolution

Portable tests cover activity contracts, state transitions, error classification, idempotency, and
schema evolution. Cloudflare adapter tests cover suspension/resume, retry, interruption, duplicate
messages, versioning, retention, and User isolation. A memory implementation may test pure workflow
logic but cannot claim durable execution evidence.

New workflow code needs an explicit payload version and a migration/retention decision. Do not silently
change the meaning of an existing execution id or activity name.
