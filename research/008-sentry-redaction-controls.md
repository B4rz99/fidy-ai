# Sentry redaction and metadata-allowlist controls

- **Ticket:** [#97 — Establish Sentry redaction and metadata-allowlist controls](https://github.com/B4rz99/fidy-ai/issues/97)
- **Map:** [#91 — Sentry end-to-end observability for Fidy](https://github.com/B4rz99/fidy-ai/issues/91)
- **Research snapshot:** 2026-08-04
- **Research source set:** Sentry documentation, the candidate Sentry SDK data-collection specification, and a pinned first-party `sentry-javascript` source snapshot at [`5e76abe234ff0117cccb042ad1140c5a4e11dde6`](https://github.com/getsentry/sentry-javascript/tree/5e76abe234ff0117cccb042ad1140c5a4e11dde6) (`develop`, package version `10.67.0` at the snapshot).
- **Status:** planning source; this report proposes controls and experiments but does not instrument Fidy.

## Executive decision

**[Design conclusion]** Fidy should treat Sentry as an operator-only, metadata-only sink and enforce the boundary in four layers:

1. **Do not create payload telemetry.** Never pass financial facts, conversation text, uploaded media, provider bodies, credentials, User identifiers, prompts, tool arguments/results, database values, queue arguments, or arbitrary log/breadcrumb data to Sentry.
2. **Use explicit SDK opt-outs, not defaults.** Set every relevant `dataCollection` category explicitly to off, disable logs/metrics/replay/profiling/attachments, disable automatic breadcrumbs, and set the Node HTTP body limit to `none`. The explicit configuration is necessary because Sentry's defaults are changing and an empty `dataCollection: {}` is permissive in the current candidate specification. [S14]
3. **Run a final event-type-specific allowlist scrubber.** `beforeSend`, `beforeSendSpan`, `beforeSendLog`, `beforeSendMetric`, and `beforeBreadcrumb` have different coverage. Remove or replace dynamic fields rather than relying on Sentry's sensitive-key denylist. Sentry's own specification says explicit scope data is not gated by `dataCollection`, and user-set data is attached as-is. [S14]
4. **Keep server-side scrubbing enabled as a backstop.** Configure organization/project rules for request, user, breadcrumb, message, exception, span, AI, database, and custom fields. Server-side scrubbing occurs just before storage, so it cannot replace SDK-side prevention. If the account-level guarantee is insufficient, evaluate a local Relay boundary. [S10]

The central invariant is: **an event may contain only stable operational metadata and protocol identifiers; any unknown or dynamic application value is removed or the event is dropped.** A scrubber that merely searches for words such as `password` or `token` is not sufficient for Fidy.

## Fidy boundary and terminology

Fidy's `Transaction` contains normalized financial facts such as Money, merchant, and Category ([`CONTEXT.md:38-42`](../CONTEXT.md#L38-L42)). A `Transcript` is the exact accepted User text, assistant text, canonical tool calls, and outcomes ([`CONTEXT.md:129-134`](../CONTEXT.md#L129-L134)); `UserNote` is user-requested free text ([`CONTEXT.md:136-139`](../CONTEXT.md#L136-L139)); and `IngestSample` retains raw or derived ingestion material ([`CONTEXT.md:93-98`](../CONTEXT.md#L93-L98)). These are all payloads, not observability metadata.

The architecture already defines `AuditLogEntry` as metadata-only and explicitly says it never contains bodies ([`CONTEXT.md:167-170`](../CONTEXT.md#L167-L170)). It also requires provider edges to stay narrow and bounds provider response bytes before SDK decoding ([`ARCHITECTURE.md:127-137`](../ARCHITECTURE.md#L127-L137)). **[Design conclusion]** The Sentry boundary should be at least as strict as that audit boundary, and should not use Sentry to mirror AuditLogEntries, Transcripts, queue jobs, or provider evidence.

### Proposed Sentry allowlist

The exact list still needs product/security approval, but a safe starting point is:

- release, environment, SDK name/version, service/component name;
- generated Sentry event/trace/span identifiers;
- fixed operation/error/outcome codes from an exhaustive enum;
- HTTP method and status code, duration, retry count, and bounded payload-size **numbers** where useful;
- provider kind, database system, queue kind, and other static infrastructure names;
- optionally model name and token counts, only if the observability decision accepts those as non-sensitive metadata. Sentry documents that model/token metadata remains available even when generative-AI content is disabled. [S14]

The allowlist must exclude UserId, email, phone/E.164/WhatsApp identifiers, IP address, cookies, authorization/session identifiers, raw URLs and query values, Money amounts, merchant/category/transaction data, prompts, tool arguments/results, User text, assistant text, uploaded media, raw webhook/request/response bodies, database parameters/results, and queue task arguments. This follows Fidy's domain model and the Sentry data categories described below; it is a Fidy design decision, not a claim that Sentry recognizes these domain names automatically.

## Sourced Sentry behavior

### Defaults and version/precedence rules

Sentry's candidate data-collection specification is marked **candidate**, version `0.11.0`, dated 2026-07-30. It replaces the broad `sendDefaultPii` switch with independent `dataCollection` categories. The specification says omitted fields use documented defaults, and its current defaults collect rich context including user identity and HTTP bodies. [S14]

The reviewed JavaScript source resolves the following defaults ([`datacollection.ts:18-106`](https://github.com/getsentry/sentry-javascript/blob/5e76abe234ff0117cccb042ad1140c5a4e11dde6/packages/core/src/types/datacollection.ts#L18-L106), [`resolveDataCollectionOptions.ts:3-45`](https://github.com/getsentry/sentry-javascript/blob/5e76abe234ff0117cccb042ad1140c5a4e11dde6/packages/core/src/utils/data-collection/resolveDataCollectionOptions.ts#L3-L45)):

| Category                         | Candidate/SDK default                                  | Explicit Fidy setting                                                                                                                           |
| -------------------------------- | ------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| Automatic `user.*` fields        | `true`                                                 | `userInfo: false`                                                                                                                               |
| Cookies                          | collect with built-in sensitive-value filtering        | `cookies: false`                                                                                                                                |
| Request/response headers         | both directions enabled with sensitive-value filtering | `httpHeaders: { request: false, response: false }`                                                                                              |
| HTTP bodies                      | all valid body types                                   | `httpBodies: []`                                                                                                                                |
| URL query parameters             | collect with sensitive-value filtering                 | `urlQueryParams: false`                                                                                                                         |
| GraphQL document and variables   | both enabled                                           | `graphQL: { document: false, variables: false }`                                                                                                |
| Generative-AI inputs and outputs | both enabled                                           | `genAI: { inputs: false, outputs: false }`                                                                                                      |
| Database query data              | enabled                                                | `databaseQueryData: false`                                                                                                                      |
| Queue task arguments             | `true` in the candidate specification                  | disable with `queues: false` when the selected SDK exposes it; otherwise do not install payload-capturing queue instrumentation and scrub spans |
| Stack-frame local variables      | enabled                                                | `stackFrameVariables: false`                                                                                                                    |
| Source context lines             | `5`                                                    | `frameContextLines: 0`                                                                                                                          |

The JavaScript source snapshot has no `queues` field in its `DataCollection` type, despite the candidate cross-SDK specification having one. That is a version/implementation gap to test, not permission to send queue arguments. [S14] [J1]

Important precedence rules are:

1. **Explicit `dataCollection` overrides SDK defaults.** The source resolver merges explicit fields over its defaults. [J2]
2. **Legacy `sendDefaultPii` is version-dependent.** The JavaScript 10.57 changelog says `sendDefaultPii` is deprecated, `true` maps to enabling all `dataCollection` categories, and `dataCollection` takes precedence when both exist. If `dataCollection` is absent, the legacy behavior is retained for compatibility; an empty `dataCollection: {}` is more permissive than legacy `sendDefaultPii: false`. [J3] The candidate v11 specification instead documents omission as equivalent to an empty object and therefore permissive. [S14] **Conclusion:** Fidy must set every field explicitly and must pin/test the exact SDK version. For v10, also set `sendDefaultPii: false` as a compatibility belt; omit that property when using a version that removed it.
3. **Integration options override the global setting.** The Sentry specification requires integration-level data options to take precedence. [S14] AI source resolves `explicit integration option > dataCollection.genAI > `true``. [`server-utils/src/ai/core/utils.ts:49-57`](https://github.com/getsentry/sentry-javascript/blob/5e76abe234ff0117cccb042ad1140c5a4e11dde6/packages/server-utils/src/ai/core/utils.ts#L49-L57) Therefore every installed AI integration must explicitly disable inputs and outputs, and the final span scrubber remains necessary.
4. **Deprecated RequestData `include` options can override global behavior.** The integration source derives `include` from its explicit options first, then `dataCollection`. It also documents the `include` option as deprecated. [`requestdata.ts:25-88`](https://github.com/getsentry/sentry-javascript/blob/5e76abe234ff0117cccb042ad1140c5a4e11dde6/packages/core/src/integrations/requestdata.ts#L25-L88) Do not add a permissive `include` override accidentally.
5. **`dataCollection` gates automatic writes, not explicit reads.** The Sentry specification says data already set on a scope, span, log, metric, or event is not gated and is attached; `Sentry.setUser()` remains attached even with `userInfo: false`. [S14] The RequestData source explicitly notes that body data already on the scope is still attached; `httpBodies` controls capture/write time, not read/attach time. [`requestdata.ts:45-59`](https://github.com/getsentry/sentry-javascript/blob/5e76abe234ff0117cccb042ad1140c5a4e11dde6/packages/core/src/integrations/requestdata.ts#L45-L59)
6. **An explicit HTTP body size wins over `httpBodies`.** Node's server subscription uses a configured `maxRequestBodySize` if present; it only falls back to `dataCollection.httpBodies` otherwise. [`server-subscription.ts:112-123`](https://github.com/getsentry/sentry-javascript/blob/5e76abe234ff0117cc042ad1140c5a4e11dde6/packages/core/src/integrations/http/server-subscription.ts#L112-L123) Set both `httpBodies: []` and `maxIncomingRequestBodySize: "none"`.
7. **SDK hooks are event-type-specific.** `beforeSend` covers error/message events; `beforeSendSpan` covers serialized spans; `beforeSendTransaction` is only effective for static transaction mode; `beforeSendLog` and `beforeSendMetric` cover their respective streams; `beforeBreadcrumb` runs before a breadcrumb is stored. [S2] The client source processes `beforeSend` after event preparation, while streamed spans call `beforeSendSpan` during serialization. [`client.ts:1472-1519`](https://github.com/getsentry/sentry-javascript/blob/5e76abe234ff0117cccb042ad1140c5a4e11dde6/packages/core/src/client.ts#L1472-L1519), [`captureSpan.ts:48-91`](https://github.com/getsentry/sentry-javascript/blob/5e76abe234ff0117cccb042ad1140c5a4e11dde6/packages/core/src/tracing/spans/captureSpan.ts#L48-L91)
8. **Event processors are not the final hook.** Sentry documents that `beforeSend*` callbacks run after other event processors; event processors have undetermined order. [S2] Put the Fidy scrubber in the final hooks, not only in `addEventProcessor` or an integration processor.
9. **Organization server settings override project settings.** Organization-level data-scrubbing settings override project settings. [S10]

### Key-value filtering is not an allowlist by itself

The SDK's built-in key filtering is a partial, case-insensitive substring match. It replaces sensitive **values** with `[Filtered]` while retaining key names. The source's built-in terms include `auth`, `token`, `secret`, `password`, `key`, `jwt`, `bearer`, `session`, `sid`, and related terms. [`filtering-snippets.ts:3-24`](https://github.com/getsentry/sentry-javascript/blob/5e76abe234ff0117cccb042ad1140c5a4e11dde6/packages/core/src/utils/data-collection/filtering-snippets.ts#L3-L24), [`filterKeyValueData.ts:3-45`](https://github.com/getsentry/sentry-javascript/blob/5e76abe234ff0117cccb042ad1140c5a4e11dde6/packages/core/src/utils/data-collection/filterKeyValueData.ts#L3-L45)

The candidate specification likewise says headers, cookies, and query parameter **names are always included** in denylist/allowlist modes; an allowlist controls real values, while sensitive-denylist matching still wins. Off mode removes the category. [S14] Fidy should use off mode for all three categories. If a future decision permits one generated header such as `x-request-id`, use an explicit allowlist for each request/response direction and still remove the whole request object in the final event scrubber unless the value is proven safe.

For cookies/query strings, Sentry can preserve harmless values and replace sensitive values; malformed/opaque cookie strings must be treated as wholly sensitive by the candidate specification. [S14] This behavior is useful for ordinary debugging but is not the Fidy boundary because non-sensitive-looking values can still be financial or conversational content and names themselves can identify a User.

### Request bodies, URLs, headers, cookies, and user context

The documented data categories provide the required switches:

- `httpBodies: []` disables incoming/outgoing request and response bodies. [S1] [S14]
- `httpHeaders` can control request and response directions separately. [S2] [S14]
- `cookies: false` disables cookies. [S1] [S14]
- `urlQueryParams: false` disables query parameter collection according to the candidate specification, including URL query attributes and `request.query_string`. [S14]
- `userInfo: false` stops automatic population of `user.id`, `user.email`, `user.username`, and `user.ip_address`; it does not remove an explicitly set user. [S1] [S14]

The Node `requestDataIntegration` is enabled by default in the Node SDK and normally adds incoming URL, method, headers, cookies, query string, data, and optional IP/user data to events. Its documented `include` fields default to cookies/data/headers/query/url on and IP off. [S5] The first-party Node default integration list includes `requestDataIntegration`, `consoleIntegration`, `httpIntegration`, native fetch, context, local variables, and global handlers. [`node/sdk/index.ts:48-94`](https://github.com/getsentry/sentry-javascript/blob/5e76abe234ff0117cccb042ad1140c5a4e11dde6/packages/node/src/sdk/index.ts#L48-L94)

The browser default integrations include `breadcrumbsIntegration`, global handlers, HTTP context, culture, and browser sessions. [`browser/sdk.ts:32-49`](https://github.com/getsentry/sentry-javascript/blob/5e76abe234ff0117cccb042ad1140c5a4e11dde6/packages/browser/src/sdk.ts#L32-L49) Browser HTTP context adds the current page URL, referrer, and User-Agent to the event request context. [`httpcontext.ts:9-48`](https://github.com/getsentry/sentry-javascript/blob/5e76abe234ff0117cccb042ad1140c5a4e11dde6/packages/browser/src/integrations/httpcontext.ts#L9-L48), [`helpers.ts:191-208`](https://github.com/getsentry/sentry-javascript/blob/5e76abe234ff0117cccb042ad1140c5a4e11dde6/packages/browser/src/helpers.ts#L191-L208)

**Conflicting evidence requiring an experiment:** the general data-collection page says the full request URL is always sent and the current URL may contain PII. [S1] The candidate specification says `urlQueryParams: false` removes the query from `url.full`. [S14] The reviewed JavaScript source currently writes `URL_FULL` directly for Node incoming spans and Node fetch spans, and the browser HTTP context writes the page URL directly. [`httpServerSpansIntegration.ts:157-203`](https://github.com/getsentry/sentry-javascript/blob/5e76abe234ff0117cccb042ad1140c5a4e11dde6/packages/node/src/integrations/http/httpServerSpansIntegration.ts#L157-L203), [`undici-instrumentation.ts:207-230`](https://github.com/getsentry/sentry-javascript/blob/5e76abe234ff0117cccb042ad1140c5a4e11dde6/packages/node/src/integrations/node-fetch/undici-instrumentation.ts#L207-L230). Until the exact Fidy SDK/runtime matrix proves otherwise, treat every URL as potentially containing query values and remove or replace URL attributes in `beforeSend` and `beforeSendSpan`.

### Breadcrumbs and arbitrary data

The JavaScript SDK retains up to 100 breadcrumbs by default; `beforeBreadcrumb` can modify or drop them by returning `null`. [`breadcrumbs.ts:10-39`](https://github.com/getsentry/sentry-javascript/blob/5e76abe234ff0117cccb042ad1140c5a4e11dde6/packages/core/src/breadcrumbs.ts#L10-L39), [S6]

Browser breadcrumbs are enabled by default for console, DOM click/keypress, fetch, history, XHR, and Sentry events. [`browser/integrations/breadcrumbs.ts:62-119`](https://github.com/getsentry/sentry-javascript/blob/5e76abe234ff0117cccb042ad1140c5a4e11dde6/packages/browser/src/integrations/breadcrumbs.ts#L62-L119), [S7] Node's console integration turns console calls into breadcrumbs by default, including the original arguments in breadcrumb data. [`console.ts:20-78`](https://github.com/getsentry/sentry-javascript/blob/5e76abe234ff0117cccb042ad1140c5a4e11dde6/packages/core/src/integrations/console.ts#L20-L78)

**[Design conclusion]** Set `maxBreadcrumbs: 0`, `beforeBreadcrumb: () => null`, and disable all breadcrumb sources. This is safer than attempting to sanitize arbitrary console arguments, DOM attributes, URL fragments, or application-created breadcrumb data. If Fidy later wants breadcrumbs, expose a tiny constructor accepting only fixed enum values and numbers, then test it as a separate allowlist.

### Prompts, tool arguments, AI outputs, and conversation identifiers

Sentry's JavaScript AI integrations automatically instrument supported OpenAI, Anthropic, Google Gen AI, LangChain, and Vercel AI calls when tracing/integration support is enabled. The official integration pages state that inputs include prompts/messages and outputs include generated text/responses. [S9]

The JavaScript source shows the payload paths and precedence:

- OpenAI request instrumentation serializes `input`/`messages`, system instructions, and available tools; response instrumentation records response data when outputs are enabled. [`openai/index.ts:39-113`](https://github.com/getsentry/sentry-javascript/blob/5e76abe234ff0117cccb042ad1140c5a4e11dde6/packages/server-utils/src/ai/openai/index.ts#L39-L113)
- Anthropic input instrumentation records messages/prompts, and output instrumentation records response text and tool calls when `recordOutputs` is true. [`anthropic-ai/index.ts:86-176`](https://github.com/getsentry/sentry-javascript/blob/5e76abe234ff0117cccb042ad1140c5a4e11dde6/packages/server-utils/src/ai/anthropic-ai/index.ts#L86-L176)
- LangChain output instrumentation explicitly captures tool calls regardless of `recordOutputs` because it treats tool names/IDs as metadata; textual output is separately gated. [`langchain/utils.ts:348-465`](https://github.com/getsentry/sentry-javascript/blob/5e76abe234ff0117cccb042ad1140c5a4e11dde6/packages/server-utils/src/ai/langchain/utils.ts#L348-L465)
- Sentry's candidate specification says `genAI.inputs` gates system instructions, prompt messages, tool definitions, and tool-call arguments; `genAI.outputs` gates completion text and tool-call results; model/token metadata remains collected. [S14]
- MCP instrumentation has independent `recordInputs`/`recordOutputs` options. It puts request arguments into `mcp.request.argument.*`, and its documented examples include tool result content and prompt result message content. [S9] The implementation resolves MCP input/output recording from explicit options, then global `dataCollection.genAI`, then `true`. [`mcp-server/index.ts:53-74`](https://github.com/getsentry/sentry-javascript/blob/5e76abe234ff0117cccb042ad1140c5a4e11dde6/packages/core/src/integrations/mcp-server/index.ts#L53-L74), [`attributeExtraction.ts:109-129`](https://github.com/getsentry/sentry-javascript/blob/5e76abe234ff0117cccb042ad1140c5a4e11dde6/packages/core/src/integrations/mcp-server/attributeExtraction.ts#L109-L129)
- `userInfo: false` only removes a small set of MCP network-PII attributes; it does not remove prompt/tool content. [`mcp-server/piiFiltering.ts:39-58`](https://github.com/getsentry/sentry-javascript/blob/5e76abe234ff0117cccb042ad1140c5a4e11dde6/packages/core/src/integrations/mcp-server/piiFiltering.ts#L39-L58), [`mcp-server/spans.ts:85-116`](https://github.com/getsentry/sentry-javascript/blob/5e76abe234ff0117cccb042ad1140c5a4e11dde6/packages/core/src/integrations/mcp-server/spans.ts#L85-L116)

**[Design conclusion]** Set `genAI.inputs` and `genAI.outputs` to `false`; set `recordInputs: false, recordOutputs: false` on every installed AI/MCP integration; forbid call-site telemetry options that turn them back on; and strip all `gen_ai.*`, `mcp.request.argument.*`, `mcp.*.content`, and tool-call-content attributes in the final span scrubber. Do not call `setConversationId` with a Fidy conversation identifier: Sentry documents that it adds `gen_ai.conversation.id` to AI spans. [S9]

### Financial, database, GraphQL, and queue payloads

The candidate SDK specification treats GraphQL documents/variables, database bound parameters/write bodies/results, and queue task arguments as data-collection categories. It says parameterized/sanitized database statements and structural metadata such as database system, query summary, operation name, or table are still collected when `databaseQueryData` is false. [S14]

**[Design conclusion]** Set `graphQL.document/variables` and `databaseQueryData` to false. Also remove `db.query`, `db.body`, `db.result`, `graphql.*`, and any `db.query.text`/table metadata that reveals Fidy's financial domain if the final approved allowlist does not explicitly permit it. Because the current JavaScript source does not expose `queues`, do not assume a global queue switch exists; keep queue instrumentation metadata-only and redact all message/task arguments at the producer/consumer seam and in `beforeSendSpan`.

## Recommended SDK configuration shape

This is a planning shape, not copy-paste production code. The exact option names must be compiled against the pinned SDK version:

```ts
const metadataOnlyDataCollection = {
  userInfo: false,
  cookies: false,
  httpHeaders: { request: false, response: false },
  httpBodies: [],
  urlQueryParams: false,
  graphQL: { document: false, variables: false },
  genAI: { inputs: false, outputs: false },
  databaseQueryData: false,
  stackFrameVariables: false,
  frameContextLines: 0,
  // queues: false, // candidate-spec option; verify SDK support first
};

Sentry.init({
  dsn,
  dataCollection: metadataOnlyDataCollection,

  // v10 compatibility only; omit when using a version where it was removed.
  // sendDefaultPii: false,

  maxBreadcrumbs: 0,
  beforeBreadcrumb: () => null,
  enableLogs: false,
  enableMetrics: false,
  replaysSessionSampleRate: 0,
  replaysOnErrorSampleRate: 0,
  profileSessionSampleRate: 0,

  // Add the event/span scrubbers described below.
  beforeSend: scrubErrorOrMessage,
  beforeSendSpan: scrubStreamedSpan,
});
```

Additional integration rules:

- **Node request data:** either replace the default RequestData integration with a fully-off compatibility configuration (`cookies`, `data`, `headers`, `ip`, `query_string`, and `url` all false), or ensure the selected SDK's default integration uses the explicit `dataCollection` settings. The former is redundant defense against version drift; it must be tested because the `include` API is deprecated. [S5] [J1]
- **Node HTTP:** configure `httpIntegration({ breadcrumbs: false, maxIncomingRequestBodySize: "none" })`. Do not set a permissive body size elsewhere. Node HTTP captures incoming spans and outgoing HTTP breadcrumbs/spans by default. [S8] [`http/index.ts:165-224`](https://github.com/getsentry/sentry-javascript/blob/5e76abe234ff0117cccb042ad1140c5a4e11dde6/packages/node/src/integrations/http/index.ts#L165-L224)
- **Browser breadcrumbs:** if the integration remains installed, set `console`, `dom`, `fetch`, `history`, `sentry`, and `xhr` to `false`; `maxBreadcrumbs: 0` and `beforeBreadcrumb` remain the final guard. [S6] [J1]
- **Node console:** remove the default console integration or configure an empty level list. Never use console capture as a substitute for a structured, pre-allowlisted metadata event. [J1]
- **AI:** do not install provider integrations unless their metadata spans are needed. If installed, set `recordInputs: false` and `recordOutputs: false` for OpenAI, Anthropic, Google Gen AI, LangChain, Vercel AI, and MCP. Vercel AI call-site `experimental_telemetry` options need a separate code-review rule because call-site settings can override integration defaults. [S9]
- **Replay/profiling:** do not install Replay or profiling. `dataCollection` does not control Replay; Replay has its own privacy model and network capture settings. [S14] If a dependency enables either, force all replay sample rates and profiling rates to zero and test that no replay/profile envelope item is produced. [S16]
- **Attachments/feedback:** do not call attachment or feedback APIs. In `beforeSend`, clear `hint.attachments` as a defensive measure; attachments are separate event payloads and are not made safe by event-field scrubbing. [S10] [S16]
- **Logs/metrics:** leave them disabled for this map. If a later decision enables them, provide `beforeSendLog`/`beforeSendMetric` allowlists and test that scope attributes and message parameters cannot contain Fidy payloads. Sentry's current JavaScript source defaults both facilities to enabled, while the public options page has version-sensitive defaults; explicit `false` removes that ambiguity. [`options.ts:527-580`](https://github.com/getsentry/sentry-javascript/blob/5e76abe234ff0117cccb042ad1140c5a4e11dde6/packages/core/src/types/options.ts#L527-L580), [S2]
- **Source maps:** source-map upload is build-time data separate from runtime events. It can expose proprietary source, embedded strings, fixtures, or accidentally bundled secrets, so the release pipeline must scan generated artifacts and must not include financial/conversational fixtures or secrets. [S16]

## Final SDK scrubber design

### Error/message events: `beforeSend`

`beforeSend` is the final SDK hook for error and message events and can modify or drop the event. [S2] It should be an allowlist projection, not a recursive “redact suspicious words” pass:

1. Delete `request` entirely. This removes body/data, query string, cookies, headers, URL, environment, and fragment in one fail-closed operation. If a future allowlist needs method/status, reconstruct only those scalar fields from a known enum/number source.
2. Delete `user` entirely. Do not depend on `userInfo: false`, because explicit `setUser` data is not gated.
3. Delete `breadcrumbs`, `extra`, arbitrary `contexts`, feature flags, feedback, and any custom event interfaces. Re-add only fixed metadata fields that have an explicit schema.
4. Replace the top-level message and every exception value with a stable error code or static class. Do not preserve raw `Error.message`; an error raised while parsing a User message can contain the User message.
5. Retain only stack frame metadata that is demonstrably safe: normalized in-app filename/function/line/column and static release information. Remove frame local variables and source context; disable local-variable/context-line integrations as well.
6. Replace dynamic transaction names, URLs, route parameters, and fragments with a static operation code. Never rely only on parameterization: Sentry documents that a pageload or route name can contain a user identifier, and the reviewed integrations write raw URL attributes.
7. Retain only fixed enum tags and bounded numeric metadata. Drop arbitrary tag keys/values.
8. Clear attachments from the `hint`; do not copy `hint.originalException`, request objects, provider responses, or any other hint data into the event.
9. If the event shape is unknown or the projection fails, return `null` (drop it) rather than returning the unprojected event.

The scrubber must catch its own failures and return `null` or a preconstructed minimal safe event. The SDK source treats a thrown/rejected `beforeSend` as an internal processing failure; the original event is not sent, but the SDK can capture an internal exception. [`client.ts:1664-1689`](https://github.com/getsentry/sentry-javascript/blob/5e76abe234ff0117cccb042ad1140c5a4e11dde6/packages/core/src/client.ts#L1664-L1689) A scrubber that throws while handling a sensitive exception must not create a second event containing the scrubber failure or original payload. This must be a test case.

### Spans/transactions: `beforeSendSpan` and `ignoreSpans`

The current source defaults to streamed spans. `beforeSendTransaction` is ignored for stream lifecycle unless static mode is explicitly selected; Sentry warns to use `beforeSendSpan` and `ignoreSpans` instead. [`options.ts:621-680`](https://github.com/getsentry/sentry-javascript/blob/5e76abe234ff0117cccb042ad1140c5a4e11dde6/packages/core/src/types/options.ts#L621-L680), [`warnAboutIgnoredTransactionOptions.ts:5-25`](https://github.com/getsentry/sentry-javascript/blob/5e76abe234ff0117cccb042ad1140c5a4e11dde6/packages/core/src/utils/warnAboutIgnoredTransactionOptions.ts#L5-L25)

The span scrubber must handle both the current streamed shape (`name`, `attributes`) and any pinned static shape (`description`, `data`). It should:

- remove `url.full`, `url.query`, `url.fragment`, `http.target`, raw route/path values, and any provider URL with dynamic components;
- remove all request/response header and cookie attributes, including `http.*.header.*`;
- remove `http.*.body.*`, GraphQL documents/variables, database parameters/results/query text if not explicitly approved, messaging correlation/message IDs, queue arguments, and all dynamic custom attributes;
- remove `gen_ai.input.*`, `gen_ai.prompt`, `gen_ai.system.instructions`, `gen_ai.response.text`, `gen_ai.response.tool_calls`, `mcp.request.argument.*`, `mcp.tool.result.content`, and `mcp.prompt.result.message_content`;
- retain only static operation/provider/database/queue names, status codes, timing, and approved token-count/model metadata;
- return a safe span object even if a span is malformed. `beforeSendSpan` cannot be used as a drop hook in the streamed path; use `ignoreSpans`/integration-level filtering to drop a whole dynamic span. [S2]

The candidate specification says streamed `gen_ai` spans may be separate envelope items and that AI metadata remains collected when content is disabled. [S14] [S9] Therefore tests must inspect standalone span envelope items, not only transaction events.

### Breadcrumbs, logs, and metrics

`beforeBreadcrumb` should return `null` for every breadcrumb. It is called before the SDK stores the breadcrumb, but it cannot remove a breadcrumb already manually copied into another event field. [S6] `maxBreadcrumbs: 0` prevents storage in the reviewed source. [J1]

Logs and metrics are disabled. If they are ever enabled, their final callbacks must drop by default and retain only an allowlisted metric name/number/unit or static log code. Sentry documents that log message parameters and scope attributes become telemetry attributes, and that user attributes can be automatically attached. [S16]

## Server-side scrubbing backstop

Keep Sentry server-side data scrubbing enabled at organization and project level. Sentry says default scrubbing is enabled, scrubs credit-card-like values and sensitive key/value patterns, and can use Additional Sensitive Fields. Organization rules override project rules. [S10]

Configure Advanced Data Scrubbing rules as an explicit second line. The UI supports Remove, Mask, Hash, and Replace; selectors can target request/user/message/breadcrumb/span/extra paths. [S11] A proposed rule inventory is:

- Remove Anything from `request.data`, `request.query_string`, `request.cookies`, `request.headers.**`, `request.env`, `request.fragment`, and `user.**`.
- Remove Anything from `extra.**`, `breadcrumbs.**`, `logentry.formatted`, and `exception.values.*.value`.
- Remove local variables from all stack-frame paths and remove source-context fields if any are attached.
- Remove dynamic URL/HTTP attributes and raw span content, including `spans.data.gen_ai.*`, `spans.data.mcp.*`, `spans.data.db.*`, `spans.data.graphql.*`, `spans.data.http.*`, and exact dynamic span description/name fields as revealed by the event JSON.
- Remove `$user.geo.**`. Sentry says geo information is extracted from the user's IP even when IP storage is disabled; an explicit advanced rule is required to scrub geo data. [S10]
- Add Fidy-specific sensitive terms for Spanish financial/conversational markers and provider fields only as a supplement, never as the primary control. Regex rules can mask or replace strings but cannot prove that an arbitrary new field is safe.

These rules must be checked against Sentry's **raw event JSON**. Sentry warns that `**` selectors apply only to default event PII fields; arbitrary fields such as span descriptions require specific selectors. [S11] The default Event PII list includes request data/query/cookies/headers, breadcrumbs data/message, extra, user fields, exception values, stack variables, and span data, but the list is not an application-specific allowlist. [S12]

Server-side scrubbing is not a no-egress guarantee: the SDK sends the event before Sentry scrubs it immediately before storage. [S3] If Fidy requires the data to leave neither the process nor Sentry's public ingestion endpoint, evaluate a local Relay and test its rule configuration; Sentry documents Relay as an intermediary that can prevent data from reaching Sentry while allowing configuration changes without redeploying the application. [S3]

Do not use broad Safe Fields to preserve an object containing both safe and unsafe values. Sentry documents that Safe Fields can exempt fields from scrubbing and that a default rule can remove an entire object; use exact safe paths only after the SDK test proves the field is metadata-only. [S10]

## What Sentry can still collect automatically

Even with the proposed payload opt-outs, the following are not automatically eliminated and must be accepted as safe metadata, explicitly removed, or tested:

| Residual category           | Sourced behavior and Fidy action                                                                                                                                                                                                                                                                                                                                                                           |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Protocol/event identity     | Sentry events have required `event_id`, timestamp, and platform, and commonly include release, environment, SDK, level, transaction, tags, and other event interfaces. [S15] Keep only generated/provenance metadata; do not put User/domain IDs in tags or transaction names.                                                                                                                             |
| Exception type/stack        | Error events inherently contain exception type/stack metadata; source context and local variables can also be integrated. [S15] [S16] Disable locals/context lines and normalize/remove dynamic messages/paths in `beforeSend`.                                                                                                                                                                            |
| Device/runtime              | Sentry documents browser User-Agent and server OS/runtime/device context as automatically collected. [S1] Node context integration is enabled by default and captures app, OS, device, culture, and cloud-resource context unless configured otherwise. [S7] Decide whether these are acceptable metadata; remove device identifiers, hostnames, cloud IDs, culture details, and user-agent if not needed. |
| Current page/referrer/URL   | Browser HTTP context adds the current URL, referrer, and User-Agent; Node HTTP/fetch spans write URL attributes. [J5] [J6] Remove `event.request` and URL/span attributes rather than trusting `urlQueryParams:false` until the runtime test passes.                                                                                                                                                       |
| Route/span metadata         | Incoming/outgoing HTTP, DB, GraphQL, fetch, provider, and messaging integrations create spans when tracing is enabled. [S8] The name, operation, status, timing, and structural attributes may remain even when bodies are off. Allow only static names and codes.                                                                                                                                         |
| AI metadata                 | Model IDs, token counts, tool names, operation names, and possibly conversation IDs remain when AI content is disabled. [S9] [S14] Do not set a Fidy conversation ID; decide explicitly whether model/token metadata is acceptable.                                                                                                                                                                        |
| Database structure          | Parameterized/sanitized query text and database system/query summary/operation/table metadata are not controlled by `databaseQueryData:false` in the candidate spec. [S14] Remove them if table/operation names reveal sensitive domain structure.                                                                                                                                                         |
| Queue/messaging metadata    | Queue names, exchanges, routing keys, message/correlation IDs, and structural messaging metadata may be captured by messaging integrations; candidate queue controls concern task arguments, not necessarily every messaging attribute. [S14] Remove IDs and dynamic names unless generated and approved.                                                                                                  |
| Sessions and client reports | Browser/Node release-health sessions and SDK client reports may be emitted by default integrations. These should contain operational aggregates, not User/domain payload, but must be present in the envelope test. [J1]                                                                                                                                                                                   |
| Logs/metrics                | Current source defaults logs and metrics to enabled, while public docs are version-sensitive. [J1] [S2] Explicitly disable both; if enabled later, their message parameters and attributes are payload channels. [S16]                                                                                                                                                                                     |
| Replay/profiles             | `dataCollection` does not govern Replay, and profiling/replay have separate envelope/configuration paths. [S14] [S16] Do not install them; force zero sampling and assert no replay/profile items.                                                                                                                                                                                                         |
| Source maps/build artifacts | Source maps are uploaded at build time for readable stack traces. [S16] They are not runtime event fields and are not protected by event scrubbing; scan artifacts for secrets and Fidy fixtures.                                                                                                                                                                                                          |
| Server-side geo             | Sentry can derive geo from an IP even when IP storage is disabled. [S10] Add an explicit geo removal rule.                                                                                                                                                                                                                                                                                                 |

Sentry's own event payload specification also lists arbitrary `extra`, contexts, breadcrumbs, request, user, and span interfaces; those interfaces can carry application data when the application or an integration supplies it. [S15] The allowlist scrubber must therefore remove unknown interfaces instead of assuming Sentry's default scrubbing makes them safe.

## Failure modes and safeguards

| Failure mode                                                                        | Why it matters                                                                                                                 | Safeguard                                                                                                               |
| ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------- |
| Relying on omitted defaults or `dataCollection: {}`                                 | Defaults differ between legacy v10 behavior, current JavaScript source, and the candidate v11 specification. [S14] [J2]        | Set every category explicitly and pin SDK versions; run an omitted/empty/explicit config matrix.                        |
| Relying on the sensitive denylist                                                   | It filters values by key substring but preserves names and allows ordinary-looking values; it is not domain-aware. [S14] [J1]  | Use off mode and final allowlist projection.                                                                            |
| Explicit `setUser`, `setContext`, `setExtra`, span attributes, logs, or breadcrumbs | Explicit data bypasses `dataCollection` and is attached. [S14]                                                                 | Code-review/API lint rule against payload-bearing calls; final hooks delete them anyway.                                |
| A body was already attached to the scope                                            | `httpBodies: []` gates automatic capture but not later attachment. [J1]                                                        | Set Node `maxIncomingRequestBodySize: "none"`, disable RequestData data, and delete request/body fields in final hooks. |
| Explicit body size overrides opt-out                                                | Configured `maxIncomingRequestBodySize` takes precedence over `httpBodies`. [J4]                                               | Set both to off and test Express/Fastify/other adapters.                                                                |
| Query option misses a URL/span path                                                 | Docs and current source disagree about full URL behavior; browser/Node integrations write raw URLs directly. [S1] [S14] [J5]   | Remove all request URL and span URL/query/fragment attributes in hooks; use static route codes only.                    |
| `beforeSendTransaction` silently does nothing                                       | Streamed spans are the default in the reviewed source; transaction hook is static-only. [J7]                                   | Use `beforeSendSpan` for stream mode or deliberately select/test static mode and wrap the callback correctly.           |
| `beforeSendSpan` returns `null` to drop                                             | The streamed span hook is a modifier; dropping is not supported there. [S2]                                                    | Return a safe span; use `ignoreSpans` or integration-level filtering to drop.                                           |
| AI integration/call-site re-enables content                                         | Integration settings take precedence over global settings; Vercel AI call sites can request input/output recording. [S9] [S14] | Set all integration options false, ban call-site opt-ins, and remove AI attributes in `beforeSendSpan`.                 |
| Server scrubbing is treated as prevention                                           | Server scrubbing occurs after network ingress, immediately before storage. [S3]                                                | SDK prevention first; local Relay only if the egress guarantee is required.                                             |
| Advanced `**` selector appears to work but misses custom data                       | `**` only covers default Event PII fields; custom span descriptions/attributes need exact selectors. [S11]                     | Inspect raw JSON and add exact paths; test after every SDK upgrade.                                                     |
| Scrubber throws or returns an invalid shape                                         | The SDK rejects the event and may capture a separate internal failure. [J6]                                                    | Make scrubber total/synchronous, catch all errors, return `null` or a fixed safe event, and test malformed events.      |
| An event exceeds Sentry limits                                                      | Sentry can reject oversized events/envelopes; payload trimming is not a privacy control. [S15]                                 | Keep payloads small by construction and assert no sentinel survives truncation/normalization.                           |
| Sentry transport is unavailable                                                     | JavaScript transports can drop events on connection failure. [S13]                                                             | Treat telemetry as best-effort; never await or branch Fidy business behavior on Sentry success.                         |

## Representative event tests and experiments

### Test harness

Use a custom transport in unit/integration tests so assertions inspect the serialized envelope before it leaves the process. Sentry documents that a transport implements `send(request: Envelope)` and `flush()`. [S13] A community `sentry-testkit` can intercept reports, transactions, logs, and check-ins, but it is explicitly community-maintained; a small Fidy transport/parser gives stronger control over every envelope item and avoids making the privacy test depend on a third-party test helper. [S13]

Use synthetic, unmistakable sentinels only, for example:

- `F####_FINANCE_SENTINEL_9c2e` in amount/merchant/category/database values;
- `F####_CHAT_SENTINEL_9c2e` in User/assistant/prompt/tool text;
- `F####_SECRET_SENTINEL_9c2e` in headers/cookies/query values;
- `F####_QUEUE_SENTINEL_9c2e` in task/message arguments.

The assertion must recursively inspect every decoded event, transaction, streamed span, log, metric, session, attachment, and replay item. A test passes only if no forbidden sentinel or forbidden field path survives; it must not assert merely that a value was replaced by `[Filtered]` because the key/name may still be sensitive.

### Matrix

1. **Error/message event:** capture an exception whose message, nested cause, request body, tags, context, extra, user, and breadcrumb all contain sentinels. Assert the event is retained only with a static error code and approved stack/protocol metadata; no `user`, `request`, `breadcrumbs`, `extra`, raw exception values, or attachments remain.
2. **Node incoming request:** exercise an actual HTTP adapter with a POST JSON body, query values, cookies, authorization and forwarded-IP headers, then throw/capture. Test both a body available before Sentry and a body read by Sentry. Assert no body/query/cookie/header/URL/IP survives and `maxIncomingRequestBodySize: "none"` prevents body capture.
3. **Browser page and interaction:** set a page URL with query/fragment sentinels, a referrer with a sentinel, console arguments, DOM attributes, history navigation, fetch/XHR URL, and an error. Assert no `event.request` URL/referrer/header and no breadcrumbs survive.
4. **Outgoing provider request:** issue a fetch/HTTP request whose URL, request/response headers, cookies, and synthetic body contain sentinels. Assert outgoing spans/breadcrumbs contain only static provider/method/status/timing metadata. This specifically tests the current source paths that write `URL_FULL` directly.
5. **AI provider:** run OpenAI/Anthropic/Google/Vercel AI calls with synthetic prompt, system instruction, tool definition, tool argument, tool result, and completion sentinels. Test streaming and non-streaming calls, integration-level false settings, and call-site settings. Assert standalone `gen_ai` span envelope items contain no content attributes; check whether model/token metadata remains.
6. **MCP:** run `tools/call`, `prompts/get`, and resource access with argument/result/message-content sentinels. Assert `mcp.request.argument.*`, result content, prompt message content, resource URI, and session/correlation identifiers are absent or approved; test `recordInputs:false`/`recordOutputs:false` and global `genAI:false` independently.
7. **GraphQL/database:** execute a GraphQL document/variables and a parameterized database query/write/result containing finance sentinels. Assert no GraphQL payload, bound values, write body, or result remains; decide from raw JSON whether sanitized query/table metadata also needs removal.
8. **Queue/provider/channel:** exercise the durable queue, Kapso webhook/provider adapter, and any messaging integration with a body/task argument containing sentinels. Assert only fixed operation/provider/status metadata is emitted. Verify no queue option is silently ignored by the selected SDK.
9. **Explicit-data bypass:** call `setUser`, `setContext`, `setExtra`, `addBreadcrumb`, `span.setAttribute`, logger, and metric APIs with sentinels even though all `dataCollection` options are false. Assert final hooks remove/drop every sentinel. This proves the documented write/read precedence rather than assuming the configuration works.
10. **Hook lifecycle:** run both `traceLifecycle: "stream"` and `"static"` (if static is retained), verify `beforeSendSpan` is called for root/child/standalone spans, verify `beforeSendTransaction` is not silently relied upon in stream mode, and verify malformed span shapes are fail-closed.
11. **Scrubber failure:** make the scrubber throw, return an invalid value, and receive an event with an unexpected interface. Assert the raw sentinel is never sent, no internal-error event contains it, and Fidy operation completion is unaffected.
12. **Server-side project:** send a safe synthetic event through a non-production Sentry project with all proposed rules. Open raw JSON and confirm request/user/breadcrumb/message/span/geo fields are removed. Test organization-level rules versus project-level rules, Safe Fields, advanced selectors, logs/metrics, attachments, and a new custom span field.
13. **Upgrade regression:** run the complete matrix against every pinned SDK/runtime combination and compare raw envelopes. Treat any new field or envelope item as a failing privacy regression until classified and allowlisted.

### Observability of the test itself

The test harness should record only field paths and pass/fail outcomes, never print the sentinel-bearing event. If an assertion fails, store the failing field path and a hash/length, not the payload. CI must use synthetic fixtures and no production DSN; Fidy's map already calls for local opt-in capture and future CI E2E support. [F1]

## Unresolved questions

1. **SDK/runtime pin:** Which exact `@sentry/*` versions and integrations will Fidy use for Vite/React, Node/Bun, Effect workers, queues, PostgreSQL, Kapso, and provider calls? The candidate `dataCollection` spec and the reviewed JavaScript implementation are not identical (notably queues, defaults, URLs, logs/metrics, and the legacy option).
2. **URL behavior:** Does the selected stable SDK remove query material from every browser request, incoming span, outgoing fetch span, provider span, transaction name, and breadcrumb when `urlQueryParams:false`, or must Fidy's final scrubber remove all URL attributes? The current source requires the latter until proven otherwise.
3. **Body paths:** Which server/framework adapters can pre-populate request data before `dataCollection.httpBodies` is consulted, and which explicit body-size options override the category? This needs adapter-level tests.
4. **Final metadata allowlist:** Are model IDs/token counts, database system/table summaries, queue/provider names, User-Agent, culture, cloud-resource IDs, and generated message/correlation IDs acceptable metadata? The answer should be recorded as a Fidy decision, not inferred from Sentry's PII denylist.
5. **AI and MCP coverage:** Which integrations are actually installed by tracing defaults, and can any provider/call-site option re-enable content after global/integration opt-out? Test all shipped provider versions before launch.
6. **Server-side account controls:** Which Sentry plan/project supports organization-level advanced scrubbing, raw JSON verification, attachment rules, data region, and retention? This is coordinated with [#93](https://github.com/B4rz99/fidy-ai/issues/93), not resolved here.
7. **Relay requirement:** Is SDK-side prevention plus Sentry server scrubbing sufficient, or does Fidy require a local Relay/egress gateway so forbidden payloads cannot reach Sentry's hosted ingress at all?
8. **Artifacts:** What source-map upload policy prevents embedded financial/conversational fixtures and secrets while preserving readable stack traces?

## Primary sources

### Sentry documentation/specification

- [S1 — JavaScript data collected](https://docs.sentry.io/platforms/javascript/data-management/data-collected/)
- [S2 — JavaScript configuration options](https://docs.sentry.io/platforms/javascript/configuration/options/)
- [S3 — SDK sensitive-data guidance](https://docs.sentry.io/platforms/javascript/data-management/sensitive-data/)
- [S4 — JavaScript filtering](https://docs.sentry.io/platforms/javascript/configuration/filtering/)
- [S5 — Node RequestData integration](https://docs.sentry.io/platforms/javascript/guides/node/configuration/integrations/requestdata/)
- [S6 — JavaScript breadcrumbs](https://docs.sentry.io/platforms/javascript/guides/node/enriching-events/breadcrumbs/)
- [S7 — Node integrations/defaults](https://docs.sentry.io/platforms/javascript/guides/node/configuration/integrations/)
- [S8 — Node HTTP integration](https://docs.sentry.io/platforms/javascript/guides/node/configuration/integrations/http/)
- [S9 — Agent tracing, AI integrations, and MCP](https://docs.sentry.io/platforms/javascript/guides/node/agent-tracing/), [OpenAI](https://docs.sentry.io/platforms/javascript/guides/node/configuration/integrations/openai/), [Anthropic](https://docs.sentry.io/platforms/javascript/guides/node/configuration/integrations/anthropic/), [Vercel AI](https://docs.sentry.io/platforms/javascript/guides/node/configuration/integrations/vercelai/), [MCP](https://docs.sentry.io/platforms/javascript/guides/node/tracing/instrumentation/mcp-module/)
- [S10 — server-side scrubbing](https://docs.sentry.io/security-legal-pii/scrubbing/server-side-scrubbing/)
- [S11 — Advanced Data Scrubbing](https://docs.sentry.io/security-legal-pii/scrubbing/advanced-datascrubbing/)
- [S12 — default Event PII fields](https://docs.sentry.io/security-legal-pii/scrubbing/server-side-scrubbing/event-pii-fields/)
- [S13 — JavaScript transports and test interception](https://docs.sentry.io/platforms/javascript/configuration/transports/), [Sentry Testkit documentation](https://docs.sentry.io/platforms/javascript/guides/node/best-practices/sentry-testkit/)
- [S14 — candidate SDK Data Collection specification, v0.11.0](https://develop.sentry.dev/sdk/foundations/client/data-collection/)
- [S15 — event payload specification](https://develop.sentry.dev/sdk/foundations/transport/event-payloads/)
- [S16 — source maps, Replay, profiling, logs, and metrics](https://docs.sentry.io/platforms/javascript/sourcemaps/), [Replay](https://docs.sentry.io/platforms/javascript/session-replay/), [profiling](https://docs.sentry.io/platforms/javascript/profiling/), [logs](https://docs.sentry.io/platforms/javascript/logs/), [metrics](https://docs.sentry.io/platforms/javascript/metrics/)

### First-party SDK/source citations

All source links below are pinned to `5e76abe234ff0117cccb042ad1140c5a4e11dde6`:

- [J1 — default integrations, data collection, breadcrumbs, request/body filtering](https://github.com/getsentry/sentry-javascript/tree/5e76abe234ff0117cccb042ad1140c5a4e11dde6/packages/core/src)
- [J2 — data-collection resolver](https://github.com/getsentry/sentry-javascript/blob/5e76abe234ff0117cccb042ad1140c5a4e11dde6/packages/core/src/utils/data-collection/resolveDataCollectionOptions.ts#L3-L45)
- [J3 — v10.57 legacy/`sendDefaultPii` migration changelog](https://github.com/getsentry/sentry-javascript/blob/5e76abe234ff0117cccb042ad1140c5a4e11dde6/CHANGELOG.md#L703-L739)
- [J4 — Node incoming-body precedence](https://github.com/getsentry/sentry-javascript/blob/5e76abe234ff0117cccb042ad1140c5a4e11dde6/packages/core/src/integrations/http/server-subscription.ts#L112-L123)
- [J5 — browser/Node URL and request context paths](https://github.com/getsentry/sentry-javascript/blob/5e76abe234ff0117cccb042ad1140c5a4e11dde6/packages/browser/src/integrations/httpcontext.ts#L9-L48)
- [J6 — event pipeline and failure handling](https://github.com/getsentry/sentry-javascript/blob/5e76abe234ff0117cccb042ad1140c5a4e11dde6/packages/core/src/client.ts#L1472-L1519)
- [J7 — streamed/static span hook behavior](https://github.com/getsentry/sentry-javascript/blob/5e76abe234ff0117cccb042ad1140c5a4e11dde6/packages/core/src/tracing/spans/captureSpan.ts#L48-L91)
- [J8 — AI/MCP integration source](https://github.com/getsentry/sentry-javascript/tree/5e76abe234ff0117cccb042ad1140c5a4e11dde6/packages/server-utils/src/ai), [MCP](https://github.com/getsentry/sentry-javascript/tree/5e76abe234ff0117cccb042ad1140c5a4e11dde6/packages/core/src/integrations/mcp-server)

### Fidy sources

- [F1 — map #91](https://github.com/B4rz99/fidy-ai/issues/91)
- [`CONTEXT.md`](../CONTEXT.md), especially [Transaction](../CONTEXT.md#L38-L42), [IngestSample](../CONTEXT.md#L93-L98), [Transcript/UserNote](../CONTEXT.md#L129-L139), and [AuditLogEntry](../CONTEXT.md#L167-L170)
- [`ARCHITECTURE.md`](../ARCHITECTURE.md), especially [user isolation/audit boundary](../ARCHITECTURE.md#L88-L118), [external effects](../ARCHITECTURE.md#L127-L137), and [testing seams](../ARCHITECTURE.md#L153-L168)
