# Effect v4 AI boundaries and OpenAI

Use this reference for `effect/ai`, backed by Effect 4.0.4's
`node_modules/effect/src/ai/{LanguageModel,Prompt,Tool,Toolkit}.ts`. Fidy's provider-neutral hosted
inference contract lives in `apps/server/src/shell/hosted-inference/operations.ts`; its implemented
OpenAI adapter lives under `apps/server/cloudflare/ai/`. Effect's `LanguageModel` is a library
service, not a second Fidy authority. OpenAI is the sole hosted inference provider under ADR 0038; no model fallback is installed.

## Core mechanics

`LanguageModel` supplies model execution, `Prompt` represents bounded messages, and `Tool` describes
schema-validated capabilities. Toolkit construction derives tool metadata and handlers, but a model
round does not constitute a built-in agent loop. The hosted AgentService owns the explicit loop,
round budget, cancellation, context bounds, and terminal state.

Tool input and structured output are untrusted model data. Decode them with Schema, enforce canonical
authorization and confirmation on every operation, and treat malformed or unsupported output as a
safe typed result. Model output never grants identity, scope, payment authority, or destructive
permission.

## Select execution and tool resolution

| API                            | Result and bound                                                                                                     |
| ------------------------------ | -------------------------------------------------------------------------------------------------------------------- |
| `LanguageModel.generateText`   | One complete response; bound prompt, provider output, tool count and deadline before retaining it                    |
| `LanguageModel.generateObject` | Schema-decoded structured response; decoding proves shape, not permission or factual correctness                     |
| `LanguageModel.streamText`     | Response parts; consume within the owner lifetime and cap accumulated bytes/parts instead of collecting indefinitely |

Supplying a toolkit normally lets `LanguageModel` resolve tool calls through its handlers. When
Fidy's owner must admit, confirm and schedule calls itself, pass `disableToolCallResolution: true`
and route returned calls through that existing pipeline. This switch disables resolution, not model
ability to request a tool. Otherwise every supplied handler must already enforce canonical access
and confirmation before side effects. Do not execute returned calls again after automatic resolution.

Set finite `concurrency` when using automatic resolution: the selected release defaults tool-call
concurrency to `"unbounded"`. Choose sequential execution for dependent mutations; a concurrency cap
alone does not bound rounds, total calls or output. Interrupt the model request and tool work with
the owning Turn; a cancelled remote operation may still have committed.

The concrete Fidy recipe is the [OpenAI inference adapter](../apps/server/src/shell/hosted-inference/internal/openai.ts):
keep bounded provider conversion below HostedInference, then use the canonical operation pipeline.
Use the library selection above only when implementing a LanguageModel-backed adapter, without
creating another AgentService loop.

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

## OpenAI adapter

The OpenAI adapter owns credential lookup, model selection, request/response bounds, timeout and
cancellation behavior, provider error mapping, and metadata-only telemetry. It must fail closed when
the credential or configured model is absent. It must not expose raw prompts, replies, tool arguments, or
provider payloads to logs or telemetry.

The [GPT-6 Luna model](https://developers.openai.com/api/docs/models/gpt-6-luna) supports
Chat Completions function calling with `reasoning_effort: "none"`. Keep the existing disabled
reasoning policy, output reserve and context ceiling. Use `max_completion_tokens` and `store: false`.
Do not supply provider-specific Gemma template options.

[OpenAI strict schemas](https://developers.openai.com/api/docs/guides/structured-outputs) require
all properties to be required and objects to disallow additional properties. Function tools use
`strict: false` to preserve canonical optional argument omission, then always decode against the
canonical Schema before returning a tool call. Compaction uses a closed strict output schema.
The portable adapter owns no credential or raw HTTP authority: the Cloudflare composition uses
published Outbound HTTP, whose policy fixes the OpenAI origin, secret, redirect refusal, tracing
and streamed-response bounds. Native tests replace that external HTTP seam.

Measure the serialized request after schema projection, including multi-Turn history. Numeric
refinements emitted under `allOf` can increase tool bytes after an Effect upgrade. The
[provider schema adapter](../apps/server/src/shell/hosted-inference/internal/provider-schema.ts)
compacts only equivalent finite inclusive numeric conjunctions and omits empty definition maps;
preserve richer constraints and referenced definitions. Test preservation and full-catalog capacity
instead of increasing the budget to absorb redundant guidance.

Provider-specific wire details remain inside the adapter. Do not leak a provider SDK type, token
counter, error class, model name, or request shape into core or the provider-neutral contract unless
that fact is deliberately part of the closed application contract.

## Testing

Portable tests substitute the owned HostedInference boundary to prove prompt projection, tool
authorization, confirmation, round limits, structured decoding, interruption, and redaction. Tests
specifically exercising Effect's model integration can stub LanguageModel below that boundary.
Adapter tests use the OpenAI
HTTP seam or an explicit transport fixture to prove bounds and safe failure classification. A stub
model cannot claim model availability, provider latency, or production retention behavior.
