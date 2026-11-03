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
