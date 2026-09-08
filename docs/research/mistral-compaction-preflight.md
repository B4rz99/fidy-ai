# Mistral Compaction: exact-preflight feasibility checkpoint

## Status

**Issue #384 is blocked at exact structured-request preflight, not implemented.** No runtime
adapter, production assembly change, credential configuration, or live inference call was made.
This report records an evidence gap; it does not establish that exact counting is impossible.

The approved direction is Ministral 3 3B Instruct as the initial candidate, Bun-only execution,
unchanged continuity budgets, deterministic CI tests, and a separately invoked synthetic live
conformance command. Production model selection remains #390; cutover remains #393. The proposed
runtime acceptance may script unrelated text execution while exercising Mistral structured
preparation through the existing HostedInference and AgentService seams.

Requirements: [#384](https://github.com/B4rz99/fidy-ai/issues/384),
[parent #356](https://github.com/B4rz99/fidy-ai/issues/356).

## What the primary sources establish

### The selected checkpoint publishes its tokenization artifacts

Mistral's `Ministral-3-3B-Instruct-2512` checkpoint, revision
`b35d4dfe56c142746f54dbd64f579faab2744308`, publishes `tekken.json`, `tokenizer.json`,
`tokenizer_config.json`, and `chat_template.jinja`.

- [`tekken.json`](https://huggingface.co/mistralai/Ministral-3-3B-Instruct-2512/blob/b35d4dfe56c142746f54dbd64f579faab2744308/tekken.json)
  declares instruct version `v13`, a 131,072-token default vocabulary, 1,000 reserved special-token
  slots, and its text-splitting pattern.
- [`params.json`](https://huggingface.co/mistralai/Ministral-3-3B-Instruct-2512/blob/b35d4dfe56c142746f54dbd64f579faab2744308/params.json)
  declares `max_position_embeddings: 262144`. This is a checkpoint fact, not independent proof of
  the hosted API's effective capacity or tokenizer identity.
- The published
  [`chat_template.jinja`](https://huggingface.co/mistralai/Ministral-3-3B-Instruct-2512/blob/b35d4dfe56c142746f54dbd64f579faab2744308/chat_template.jinja)
  renders system/user/assistant/tool framing and available tools. It does not consume
  `response_format` or inject the structured-response schema. It also inserts a default system
  prompt when none is supplied, so raw text counting and complete chat counting are distinct.

**Conclusion:** a Bun-only implementation of vocabulary and ordinary instruct framing remains
plausible. No Bun tokenizer was installed or validated in this investigation; these artifacts alone
are not a verified counter for hosted strict structured requests.

### The hosted structured-output API adds prompt material

The [official custom structured-output documentation](https://docs.mistral.ai/capabilities/structured_output/custom)
says this is always prepended to the system prompt:

```text
Your output should be an instance of a JSON object following this schema: {{ json_schema }}
```

The inspected page does not specify the exact JSON serialization, separator joining this text to
an existing system prompt, or handling of multiple system messages. Those details can affect BPE
counts. Counting only caller messages and the published chat template would omit documented
provider-added material.

This observation comes from the page's rendered HTML code block; the readable-text extraction
omitted the code block. The documentation URL is mutable, unlike the source revisions below.

### The inspected official tokenizer does not accept strict schema format

At `mistral-common` revision `1fdcf24b5591bb882558336890d020a0ea756713`:

- [`request.py:51–65`](https://github.com/mistralai/mistral-common/blob/1fdcf24b5591bb882558336890d020a0ea756713/src/mistral_common/protocol/instruct/request.py#L51-L65)
  declares only `text` and `json_object` response formats.
- [`request.py:98–108`](https://github.com/mistralai/mistral-common/blob/1fdcf24b5591bb882558336890d020a0ea756713/src/mistral_common/protocol/instruct/request.py#L98-L108)
  defines `ResponseFormat` with that enum and no schema field.
- [`mistral.py:367–396`](https://github.com/mistralai/mistral-common/blob/1fdcf24b5591bb882558336890d020a0ea756713/src/mistral_common/tokens/tokenizers/mistral.py#L367-L396)
  validates and normalizes a `ChatCompletionRequest` before instruct encoding. It is not an
  independent hosted API request-count endpoint.

Thus the inspected official request type cannot directly encode the ticket's complete
`response_format: { type: "json_schema", ... }` request. This is source inspection, not an executed
Python failure test. Manually expanding the schema instruction before calling the tokenizer could
be a route forward, but requires establishing the hosted API's exact expansion first.

Upstream [PR #258](https://github.com/mistralai/mistral-common/pull/258), inspected while open and
unmerged at head `33ed101b0cb99f29cc818d5aca2a1c63cd95c55e`, proposes JSON-schema model settings for
**tokenizer v15 and later**. It is not evidence that the selected v13 checkpoint has that behavior.
Its status may change; the inspected head identifies the proposal considered here.

### The TypeScript SDK describes the wire format, not this injected prompt

At `client-ts` revision `f4f52c03c0867534e20d485b60bde1b76e6f709e`,
[`responseFormatFromZodObject`](https://github.com/mistralai/client-ts/blob/f4f52c03c0867534e20d485b60bde1b76e6f709e/src/extra/structChat.ts#L160-L174)
constructs the schema-format object with `strict: true`.
[`responseformat.ts`](https://github.com/mistralai/client-ts/blob/f4f52c03c0867534e20d485b60bde1b76e6f709e/src/models/components/responseformat.ts)
maps its fields to the HTTP wire format. Neither cited helper supplies the missing prompt expansion
contract. A compatible JSON request is not by itself evidence of exact prompt counting.

## Why this blocks the current implementation plan

The ticket requires exact complete structured-request admission, execution of the unchanged prepared
representation, and official-reference vectors for strict framing. A counter based on an assumed
separator or schema serialization cannot honestly satisfy those criteria, even if a deterministic
HTTP fixture returns success. Provider usage after execution cannot replace preflight.

Do not work around this by counting JSON characters, applying a safety multiplier, dropping the
response schema, switching to non-strict JSON output, silently reducing budgets, or shipping a
Mistral adapter that claims an unverified count is exact. Leave the existing OpenAI runtime intact.

This gate surfaced earlier than anticipated: live conformance was initially planned as final
validation, but the inspected reference leaves a serving-specific expansion to establish first.
Credentials alone do not establish that contract; representative usage comparisons would validate
an independently specified candidate expansion, not prove an arbitrary guessed algorithm correct.

## Resume conditions and implementation sequence

1. Obtain a provider-owned specification or reference implementation for the selected hosted
   model's schema serialization and system-prompt expansion, including separators and multiple
   system messages. Confirm the fixed hosted model id, tokenizer correspondence, and API capacity.
2. Implement that framing with the pinned vocabulary in Bun. Verify it against independently
   generated official-reference token vectors, including Unicode Spanish, Colombian financial
   terminology, roles, and strict schemas. Reject unsupported representations rather than omit them.
3. TDD the Mistral structured implementation through HostedInference with stub Effect HTTP. Keep
   schema derivation and the matching output decoder together; retain and send the same prepared
   request; prove capacity boundaries, bounded bodies, deadlines, error classification, and secrecy.
4. Prove maximum-budget startup admission and AgentService/PostgreSQL Compaction success and safe
   failure. Count operation definitions **in the full hosted startup request**, where they consume
   context; do not add them to the tool-free Compaction request.
5. Add a **separate, manually invoked** synthetic conformance command. It must not be collected by
   the default test suite or CI, nor activated just because an API key exists. Credentials have not
   been configured; do not request them in chat. Report case ids and safe counts/status only.
6. Require exact local/provider prompt-count agreement before claiming live conformance. Preserve
   the distinction between prompt usage and the separately reserved 16K output allowance. Perform
   Standards/Security/Spec review of the actual implementation before completion.

All feature acceptance criteria remain outstanding. No application test or typecheck was run for
this documentation-only checkpoint, and no provider conformance result is claimed.
