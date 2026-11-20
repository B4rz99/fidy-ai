# OpenAI as the sole hosted inference provider

Fidy will replace Workers AI hosted inference completely with OpenAI `gpt-6-luna`, including
hosted-agent text and canonical tool-call rounds and structured conversation compaction. The
decision is driven by inference cost and existing OpenAI credits; it does not introduce a second
provider, fallback routing, or product-limit tuning.

This supersedes the Workers AI provider choice and prohibition of direct external inference in
[ADR 0014](0014-deep-hosted-turn-modules.md) and
[ADR 0026](0026-cloudflare-native-production-replatform.md). Cloudflare remains the application
runtime. Hosted inference retains its provider-neutral boundary, canonical execution authority,
Consent checks, bounded requests and responses, cancellation, safe failures, and resource admission.
Provider-specific mechanics must be adapted without changing the intended behavior of those controls.

Keep conversation state in Fidy and disable OpenAI response storage. Zero Data Retention is
preferred when approved and enabled by OpenAI, but its absence does not block migration. Standard
abuse-monitoring retention is accepted when ZDR is unavailable; disabling response storage alone
does not enable ZDR. See [OpenAI data controls](https://developers.openai.com/api/docs/guides/your-data).

The separate Workers AI `toMarkdown` document-conversion capability remains in place. It is outside
the hosted-inference replacement, so its binding must remain available independently.

Use Chat Completions with reasoning disabled, preserving the existing non-reasoning execution
policy. Function schemas retain canonical optional arguments using `strict: false`; OpenAI strict
function schemas require all properties to be required, which would change omission semantics.
Canonical Schema decoding remains mandatory before any operation can execute. Conversation
compaction uses strict structured output. Every request sets `store: false`.

Timestamp fields in provider-facing structured schemas require complete offset-bearing RFC 3339
input. Express the pattern without lookaround so the provider's validator can accept it.

## Prepared requests and continuations

A prepared execution owns its detached semantic request and the matching decoder. It has at
most two attempts and may retry only a typed retryable provider refusal. Invalid text output
can authorize one separately prepared repair. Put the safe repair feedback after initial
instructions and before the active request to preserve provider continuation framing.
Successful preparation consumes a continuation, including its retained provider state and
remaining tool policy. Failed preparation restores the continuation. Measuring a request
does not create executable authority.

Snapshot mutable context before executing it, and reconstruct Effect DateTime instants explicitly
because structured cloning loses their identity. Share the immutable Option for prior context
and clone its mutable entry array separately. Provider Transcript and tool evidence use the
encoded JSON representation. The local UTF-8 byte bound is conservative and keeps content out
of a second tokenizer. The hosted Turn owns the Work span and emits safe provider outcomes once.
Live conformance returns a closed capability failure instead of provider content.

Provider schema normalization may collapse a homogeneous tuple into its equivalent item schema
while preserving length bounds. Annotations and literal values are data outside this rewrite.

Production reserves worst-case provider work and rechecks purpose-specific Consent before each
egress, including failed calls. Only the exact still-Pending admitted Turn can retain its original
basis through withdrawal. Standalone work and preflight need current standing. Unmetered runs
belong to private provider-conformance fixtures, with no owner mutation bindings. Install no
inference for unavailable configuration while keeping unrelated canonical owners available.
