# Mistral Compaction: exact-preflight feasibility checkpoint

## Status

**The Bun v13 counter and an explicitly manual conformance command now exist, but selected-model
hosted parity remains unverified.** No runtime adapter, production assembly change, credential
configuration, or live inference call was made. The initial evidence gap was narrowed by an official
worked usage example; credentials are still required to validate the fixed candidate model.

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

**Conclusion:** the checked-in Bun implementation can reproduce the checkpoint's vocabulary and
ordinary v13 instruct framing. These artifacts alone are still not a verified counter for hosted
strict structured requests.

### The hosted structured-output API adds prompt material

The [official custom structured-output documentation](https://docs.mistral.ai/capabilities/structured_output/custom)
says this is always prepended to the system prompt:

```text
Your output should be an instance of a JSON object following this schema: {{ json_schema }}
```

The same pinned documentation source includes a complete Book request and response whose
`usage.prompt_tokens` is **23**. Encoding that request's messages with the selected checkpoint's
published vocabulary and v13 controls also yields 23: five system-text tokens, thirteen User-text
tokens, and five control tokens. Prefixing one compact schema serialization and the documented
sentence would yield 91 instead. This is evidence compatible with out-of-band schema accounting for
the documented `ministral-8b-latest` example, but one aggregate value cannot rule out undocumented
framing differences or establish the selected 3B deployment's behavior. The local counter therefore
counts only explicit messages; it makes no claim about hosted response-format metadata. Controlled
absent/small/large-schema comparisons remain the decision gate.

The source is pinned at
[`platform-docs-public@2e094f7.../custom/page.mdx`](https://github.com/mistralai/platform-docs-public/blob/2e094f7bbe1395de4a738a3483def3573143d973/src/content/en/docs/studio/conversations/structured-output/custom/page.mdx).
The selected model still requires a live comparison because the worked example uses
`ministral-8b-latest`, not `ministral-3b-2512`.

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

## Bun reproduction and evidence

`apps/server/src/shell/agent/mistral-tokenizer.ts` implements the pinned v13 text and role framing in
Bun with `js-tiktoken`. Its bundled vocabulary is derived from the selected checkpoint's
[`tekken.json`](https://huggingface.co/mistralai/Ministral-3-3B-Instruct-2512/blob/b35d4dfe56c142746f54dbd64f579faab2744308/tekken.json):

- upstream `tekken.json` SHA-256: `600bb27946565481ecf51ba8aee252e49b9a68507866080ac9c30185bb312843`;
- transformed rank text SHA-256: `a437159c587e82ed8fc7e0dc7cfd0df5db0e3eccd323ce718bdcb0c0b3674bcf`;
- deterministic gzip SHA-256: `94190b1851d64902c4e30567e0415fcb27d7f9918c0eace1e0f3de3d070ad418`.

`apps/server/tools/mistral/generate-vocabulary.mjs` owns the reproducible transformation: it fetches
only that pinned revision, verifies the upstream and transformed hashes, applies the reserved-token
offset, and emits the checked-in compressed module. Regenerate it explicitly with
`bun apps/server/tools/mistral/generate-vocabulary.mjs`; ordinary builds and tests perform no fetch.

The transformation preserves every published BPE byte token and offsets ordinary ranks by the
checkpoint's 1,000 reserved control slots, matching Mistral's
[`Tekkenizer.encode`](https://github.com/mistralai/mistral-common/blob/1fdcf24b5591bb882558336890d020a0ea756713/src/mistral_common/tokens/tokenizers/tekken.py#L420-L438).
The framing follows v13's system/User/assistant controls and consecutive-message normalization in
[`normalize.py`](https://github.com/mistralai/mistral-common/blob/1fdcf24b5591bb882558336890d020a0ea756713/src/mistral_common/protocol/instruct/normalize.py#L100-L251)
and
[`instruct.py`](https://github.com/mistralai/mistral-common/blob/1fdcf24b5591bb882558336890d020a0ea756713/src/mistral_common/tokens/tokenizers/instruct.py#L790-L953).

The focused test uses literals independent of the production implementation:

- the official Book request: 23 tokens and token-id digest
  `0c467ee75e8ba4f12d9432ce82ee20d931a6f99d7b24547366eba1cb2a93c642`;
- an `es-CO` Unicode/Colombian-finance vector: 65 tokens and digest
  `3c96fc68f1c50da14a37aa7170a6a4df0617936578cb31d03d7d1f212c5c8ce8`;
- a continued system/User/assistant/User vector: 61 tokens and digest
  `3b00a9437c0a0dd4269b6bc4a983d19348c793ac7078dd6452c547af6effb715`.

The latter two were independently generated in Bun using Hugging Face Transformers 3.8.1 against
the checkpoint's pinned `tokenizer.json`, then frozen as counts and token-id digests; the production
implementation uses `js-tiktoken` and transformed `tekken.json` instead. They are reference vectors
from an official model artifact, not hosted-usage evidence.

`bun run mistral:conformance` is the separate manual command. Against only the fixed
`ministral-3b-2512` model, it first sends identical messages with absent, small, and large schema
metadata; all three hosted prompt counts must equal the pinned local message count. It then sends a
synthetic production-shaped Compaction request using the real system instruction, canonical output
schema, and 16K output reserve. Strict outputs and provider envelopes reject excess fields. Responses
are bounded, failures contain no request or response content, and the shared Mistral
credential-redaction/telemetry policy applies. The command prints only numeric reports after every
case succeeds. Default tests and CI never invoke it; credential presence alone never invokes it.
Running it without a configured credential failed closed before network work, as intended.

## Remaining block before adapter implementation

Selected-model hosted parity has not passed because `MISTRAL_API_KEY` is absent. The 23-token
official worked example suggests, but does not establish, schema-free hosted accounting. Do not
claim live conformance or wire this message counter into production until the manual command proves
exact equality across the baseline, both schema differentials, and the production-shaped Compaction
case.

Do not work around a mismatch by counting JSON characters, applying a safety multiplier, dropping
the response schema, switching to non-strict JSON output, silently reducing budgets, or changing a
fixture to match unexplained provider usage. Leave the existing OpenAI runtime intact.

## Resume conditions and implementation sequence

1. Configure the credential outside chat/source and explicitly run `bun run mistral:conformance`.
   Require exact local/provider prompt equality for all four cases and equality across the controlled
   schema differential; investigate rather than bless any mismatch. Confirm the API's fixed model
   capacity separately before production admission.
2. TDD the Mistral structured implementation through HostedInference with stub Effect HTTP. Keep
   schema derivation and the matching output decoder together; retain and send the same prepared
   request; prove capacity boundaries, bounded bodies, deadlines, error classification, and secrecy.
3. Prove maximum-budget startup admission and AgentService/PostgreSQL Compaction success and safe
   failure. Count operation definitions **in the full hosted startup request**, where they consume
   context; do not add them to the tool-free Compaction request.
4. Preserve the distinction between prompt usage and the separately reserved 16K output allowance.
   Perform Standards/Security/Spec review of the actual adapter implementation before completion.

The counter/reference-vector and manual-workflow slices pass focused deterministic tests and server
typecheck. The Mistral adapter, Compaction integration acceptance, maximum-budget startup proof, and
live conformance remain outstanding; no provider conformance result is claimed.
