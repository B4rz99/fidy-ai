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
contract. Workers AI is the intended production authority. Until its adapter exists, hosted inference
returns the typed unavailable result; it must not fall back to direct external models or local state.

Canonical authorization and confirmation policy apply identically to User calls and hosted-agent
calls. Model output is untrusted data and cannot grant identity, scope, or destructive authority.

## Consequences

Turn limits, tool-call limits, prompt bounds, cancellation, and terminal states remain explicit and
reviewable. A future Durable Object or Workflow may own serialized or durable execution, but it must
receive bounded subject data and must not become a second domain or authorization authority.

Tests cover portable context, schema, authorization, redaction, and model-boundary behavior directly.
Platform execution tests belong to the Cloudflare adapter and are not simulated by a process-local
agent loop.
