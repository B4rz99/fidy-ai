# Deep hosted-turn modules

- **Status:** Accepted
- **Date:** 2026-08-12

## Decision

`AgentService` is the hosted runtime's public lifecycle boundary. Its source-specific entrypoints own
Turn admission, bounded context construction, canonical execution, delivery, and terminalization.
WorkingContext and conversation continuity are private Agent concerns; executable lifecycle
capabilities do not cross that interface.

Hosted inference is a separate deep module with a provider-neutral contract. Prompt conversion, model
rounds, structured output, token accounting, provider failures, and context bounds stay behind that
contract. [ADR 0038](0038-openai-hosted-inference.md) owns the provider decision. Unavailable
configuration fails closed at that boundary.

Canonical authorization and confirmation policy apply identically to User calls and hosted-agent
calls. Model output is untrusted data and cannot grant identity, scope, or destructive authority.

## Consequences

Turn limits, tool-call limits, prompt bounds, cancellation, and terminal states remain explicit and
reviewable. UserStore owns serialized execution and retained state. Queue and Workflow handoffs
carry bounded subject data and gain no independent authority.

Tests cover portable context, schema, authorization, redaction, and model-boundary behavior directly.
Platform execution tests belong to the Cloudflare adapter and are not simulated by a process-local
agent loop.

## Durable Transcript and compaction evidence

Store User and Assistant text together with exact canonical tool call arguments and host-proved
results correlated by provider-issued call identity. A committed mutation for which the response
was lost has a separate outcome. Turn failure and interruption retain allowlisted lifecycle facts
without arbitrary error prose. Proactive delivery uses its own identity and verified evidence,
without inventing a requested Turn or requiring every message to be an InsightEvent.

The model window selects the newest contiguous complete Turns under independent character and
whole-Turn bounds. Compaction also starts before the retained-entry limit for a long low-token
session. Its replacement states the exact terminal prefix incorporated, excluding an active
Pending Turn. Recover an abandoned Pending Turn and recheck the current onboarding grant before
a subsequent admission. Evidence accepted for lossless replay excludes values that cannot
round-trip through storage and is bounded by encoded UTF-8 bytes.

## Admission, visible delivery and recovery

The User coordinator serializes admission and owns the queue through settlement, including when an
HTTP deadline ends the observation. Run complete model preflight before recording Pending and the
User entry. A failed wake after admission is recoverable abandoned work. Fence it through the
owning channel before releasing the queue. Recovery runs after Consent revocation without
admitting work or sending User content. It cannot race a late commit because a canonical mutation
and its Pending Turn fence share the atomic commit. Preserve exact result evidence or report only
the proven commit when the response is lost. Neither outcome permits repeating the mutation.

The host alone prepares visible confirmation text and opaque commands from validated inputs and the
owner revision. Persist the short-lived single-use challenge before presenting it. Redeem only an
exact User-authored command from the original channel. A resumed Turn can recover its own
consumption. Model prose and unrelated Turns cannot gain that authority. For statement actions,
the admitted same-channel Turn guard remains part of every owner write.

A browser receipt proves visible presentation of the exact staged reply under current WebSession
authority. A progress read buys no second Turn. Transcript stores confirmed visible text or the
fixed terminal marker in the settlement unit. Proactive channel evidence can join WorkingContext
only from an exact authorized same-User reference. It never creates a synthetic requested Turn
or session. Thirty-day retention runs independently of later activity. Compaction compares and
replaces only the same retained terminal prefix and its predecessor revision. Failure keeps the
original evidence. A newly admitted User request is supplied separately from retained history.
