# Effect v4 AI boundaries and Workers AI

Use this reference when working with `effect/unstable/ai`. The application-facing boundary is a
provider-neutral `LanguageModel`; the production adapter will use a Cloudflare Workers AI binding.
No direct external-model adapter or local model fallback is an authority.

## Core mechanics

`LanguageModel` supplies model execution, `Prompt` represents bounded messages, and `Tool` describes
schema-validated capabilities. Toolkit construction derives tool metadata and handlers, but a model
round does not constitute a built-in agent loop. The hosted AgentService owns the explicit loop,
round budget, cancellation, context bounds, and terminal state.

Tool input and structured output are untrusted model data. Decode them with Schema, enforce canonical
authorization and confirmation on every operation, and treat malformed or unsupported output as a
safe typed result. Model output never grants identity, scope, payment authority, or destructive
permission.

## Prompt and structured output

Build prompts from bounded, purpose-specific projections. Ingested email, uploaded documents,
memories, transcripts, tool results, and provider responses are data even when they contain
instructions. Do not place secrets, browser verifiers, credentials, raw financial identifiers, or
unbounded source material in model context.

Structured output is a validation aid, not a trust boundary. Keep the schema closed, bounded, and
versioned. Validate the decoded result before invoking a canonical operation; do not retry malformed
output without a bounded budget.

## Toolkit boundary

The public HttpApi operation catalog remains the source of truth for hosted-agent tools. The adapter
maps reflected operation ids, access requirements, input schemas, output schemas, and confirmation
metadata into toolkit definitions. A tool hidden by policy must not remain reachable through an
alternate model or HTTP path.

Tool handlers call canonical operations with the authenticated User context. They do not import
repositories, D1, Durable Object, Queue, Workflow, R2, or provider implementation modules. Hosted
inference receives only bounded projections and returns safe typed failures such as unavailable,
invalid-output, resource-limit, or provider-failure.

## Workers AI adapter

The Workers AI adapter owns binding lookup, model selection, request/response bounds, timeout and
cancellation behavior, provider error mapping, and metadata-only telemetry. It must fail closed when
the binding or configured model is absent. It must not expose raw prompts, replies, tool arguments, or
provider payloads to logs or telemetry.

Provider-specific wire details remain inside the adapter. Do not leak a provider SDK type, token
counter, error class, model name, or request shape into core or the provider-neutral contract unless
that fact is deliberately part of the closed application contract.

## Testing

Portable tests use a stub LanguageModel to prove prompt projection, tool authorization, confirmation,
round limits, structured decoding, interruption, and redaction. Adapter tests use the Workers AI
binding seam or an explicit transport fixture to prove bounds and safe failure classification. A stub
model cannot claim model availability, provider latency, or production retention behavior.
