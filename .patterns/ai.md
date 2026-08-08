# AI (`effect/unstable/ai` + `@effect/ai-openai`)

How Effect v4's AI support actually works, read from the source. Citations: bare paths are
relative to `packages/effect/src/unstable/ai/`, `openai/...` to `packages/ai/openai/src/`,
`compat/...` to `packages/ai/openai-compat/src/`, `test/...` to
`packages/effect/test/unstable/ai/`. Canonical walkthroughs: `ai-docs/src/71_ai/`
(`10_language-model.ts`, `20_tools.ts`, `30_chat.ts`) — read them before wiring a model.

## Core shape

`LanguageModel` is a plain `Context.Service` with three methods: `generateText`,
`generateObject`, `streamText` (`LanguageModel.ts:71-73`, `:81-180`). Providers plug in as
layers: `OpenAiLanguageModel.model("gpt-5-nano", config?)` returns a
`Model<"openai", LanguageModel, OpenAiClient>` (`openai/OpenAiLanguageModel.ts:543-547`) —
a `Layer` that also provides `Model.ProviderName`/`Model.ModelName` string services
(`Model.ts:141-166`). Use `Effect.provide(model)` per call site, or
`model.captureRequirements` to lift the client requirement into a service layer, or
`ExecutionPlan.make({provide: model, attempts})` for multi-provider fallback (ai-docs
`10_language-model.ts:44-57`, `:73-79`).

Every failure is one error class: `AiError { module, method, reason }` with `isRetryable`
and `retryAfter` delegating to the reason (`AiError.ts:1461-1493`). `reason` is a schema
union (`AiErrorReason`, `:1380`) of `NetworkError | RateLimitError | QuotaExhaustedError |
AuthenticationError | ContentPolicyError | InvalidRequestError | InternalProviderError |
InvalidOutputError | StructuredOutputError | UnsupportedSchemaError | UnknownError |
ToolNotFoundError | ToolParameterValidationError | InvalidToolResultError |
ToolResultEncodingError | ToolConfigurationError | ToolkitRequiredError |
InvalidUserInputError`. `AiErrorReason` is itself a schema, embeddable in domain errors
(ai-docs `10_language-model.ts:30-39`).

## Prompt and response model

A `Prompt` is an immutable list of messages with roles `system | user | assistant | tool`;
`prompt:` accepts `RawInput = string | Iterable<MessageEncoded> | Prompt` — a bare string
becomes a single user text message (`Prompt.ts:1788-1791`, `:1854-1871`). User content is
`TextPart | FilePart` (`:1221`); **vision input is a `FilePart`**
`{ mediaType: "image/jpeg", data: string | Uint8Array | URL }` (`:389-422`). Builders:
`Prompt.make`, `fromMessages` (`:1893`), `fromResponseParts` (`:1934` — folds a response
into assistant + tool messages, tool results by their _encoded_ result), `concat`
(`:2075`), `setSystem`/`prependSystem` (`:2125`, `:2168`).

Responses are arrays of typed parts with accessors on `GenerateTextResponse`: `.text`,
`.reasoning`, `.toolCalls`, `.toolResults`, `.finishReason`, `.usage`
(`LanguageModel.ts:357-441`). `FinishReason` literals: `stop | length | content-filter |
tool-calls | error | pause | other | unknown` (`Response.ts:2317-2335`). `Usage` reports
`inputTokens: { uncached, total, cacheRead, cacheWrite }` and `outputTokens: { total, text,
reasoning }`, all possibly `undefined` (`Response.ts:2363-2400`).

## Tools and toolkits

`Tool.make(name, { description?, parameters?, success?, failure?, failureMode?,
dependencies?, needsApproval? })` (`Tool.ts:1195-1270`); defaults: parameters
`EmptyParams`, success `Schema.Void`, failure `Schema.Never`, `failureMode: "error"`
(`:1258-1266`). Parameter/`description` annotations feed the model (ai-docs
`20_tools.ts:31-56`). The wire JSON Schema derives from the parameters schema via
`Tool.getJsonSchema` → `Schema.toJsonSchemaDocument` (+ provider transformer)
(`Tool.ts:1647-1682`). `Tool.dynamic` takes a raw JSON Schema (runtime/MCP-discovered
tools, handler gets `unknown`, `:1315`); `Tool.providerDefined` models provider-executed
tools (web search etc.). Annotations: `Tool.Title`, `Readonly`, `Destructive`,
`Idempotent`, `OpenWorld`, `Meta` — read by the MCP server.

`Toolkit.make(...tools)` / `Toolkit.merge` group tools (`Toolkit.ts:474-476`, `:541-554`).
Handlers are Effects `(params, ctx) => Effect<Success, Failure | AiError | AiErrorReason,
Deps>` (`:162-171`), provided by `toolkit.toLayer(handlers | Effect<handlers>)` (`:93-98`);
`toolkit.of({...})` is the type-safety helper. Yielding the toolkit gives `WithHandler`
with `handle(name, params)` (`:194-210`).

Execution semantics of `handle` (`Toolkit.ts:260-374`): unknown tool →
`ToolNotFoundError`; params are **decoded through the parameters schema** — failure is
`ToolParameterValidationError` (`:283-296`); the result is encoded through the success
schema (encode failure `ToolResultEncodingError`). `failureMode` dispatch (`:362-367`):
`"error"` re-fails the calling effect; `"return"` converts the failure into a tool-result
part with `isFailure: true`, encoded through `Union([success, failure, AiError])`
(`:240-242`) — i.e. **the model sees the error and generation continues**.

## Tool rounds — there is NO built-in agent loop

`generateText` performs **exactly one provider call**: it sends the toolkit's tool
definitions, then resolves the tool calls the model returned (concurrently — default
`"unbounded"`, `LanguageModel.ts:2142-2144`; set `concurrency: 1` for sequential) and
returns the response content _merged with_ the tool results (`:1185-1212`,
`resolveToolCalls` `:2049-2150`). It never sends results back to the model; there is no
`maxSteps`/iteration option anywhere in the module. The agentic loop is yours:

```ts
let prompt = Prompt.concat(system, userTurn);
for (let i = 0; i < MAX_ITERATIONS; i++) {
  const response = yield * LanguageModel.generateText({ prompt, toolkit });
  prompt = Prompt.concat(prompt, Prompt.fromResponseParts(response.content));
  if (response.toolCalls.length === 0) return response; // or finishReason !== "tool-calls"
}
```

`Prompt.fromResponseParts` puts tool calls in an assistant message and non-preliminary
tool results in a tool message (`Prompt.ts:1895-1899`); the OpenAI provider maps tool
results to `function_call_output` items (`openai/OpenAiLanguageModel.ts:1155`). Options per
round: `toolChoice: "auto" | "none" | "required" | { tool } | { oneOf, mode? }`
(`LanguageModel.ts:320-330`); `disableToolCallResolution: true` returns raw tool calls
without running handlers — full manual control (`:265-273`, `:1173-1183`).
`Tool.needsApproval` inserts `tool-approval-request` parts instead of executing; resolved
approvals in the next round's prompt are executed pre-flight (`:1106-1135`).

**Tool-error feedback trap**: with the default `failureMode: "error"`, a handler failure
fails the _entire_ `generateText` effect — no tool result exists to feed back. For fidy's
"tool errors go back to the model" guard, declare a `failure` schema and
`failureMode: "return"` (or catch inside the handler and return a typed result).

`Chat` (`Chat.ts:67`) is the history holder: `Chat.fromPrompt`/`empty`, a public
`history: Ref<Prompt>` (`:109`), and `generateText` that concats prompt + response parts
into history per call (`:388-393`) — still one provider round per call, so the loop above
applies with `Prompt.empty` as the follow-up prompt. `Chat.makePersisted(:767)` /
`layerPersisted(:929)` add pluggable persistence; `export`/`exportJson` snapshot history.

## HttpApi → Toolkit derivation: does not exist — hand-build it

There is **no** `Toolkit.fromHttpApi`, no HttpApi reference anywhere in
`packages/effect/src/unstable/ai/` or `packages/ai/` (verified by grep across the
checkout), and `McpServer` has no HttpApi integration either. What IS provided: the target
types are small — a derived tool needs `name` (use the OpenAPI convention
`${group.identifier}.${endpoint.identifier}`), `description` (OpenAPI annotations),
`parameters` (one `Schema.Struct` combining the operation's `payload`/`params`/`query`
schemas), `success`/`failure` (the operation's schemas) — all of which live on
`HttpApiEndpoint` values reachable by iterating `api.groups[*].endpoints`. Handlers close
over `HttpApiClient.endpoint(api, {group, endpoint})` (or the full client), so request
encode / response decode reuse the operation definition. That mapper is the only
hand-built piece; `Tool.make` + `Toolkit.make` + `McpServer.toolkit` consume its output
unchanged — one derivation feeds both the agent loop and the MCP server.

## MCP server

`McpServer.layerStdio({ name, version })` runs the server over stdio (NDJSON-RPC via
`RpcServer.layerProtocolStdio`, `McpServer.ts:627-636`); it requires the `Stdio` service —
`NodeStdio.layer` — and **loggers must go to stderr** (`Layer.succeed(Logger.LogToStderr)(true)`,
example `:573-622`). `layerHttp({ path })` registers JSON-RPC on an existing `HttpRouter`
(`:656-666`).

`McpServer.toolkit(toolkit)` is a Layer registering every tool (`:749-760` →
`registerToolkit` `:673-741`): MCP tool = `{ name, description: Tool.getDescription,
inputSchema: Tool.getJsonSchema, annotations: {title, readOnlyHint, destructiveHint,
idempotentHint, openWorldHint} }` (`:688-703`). Handler failures become
`CallToolResult{ isError: true, content: [Cause.pretty(cause)] }` — never a protocol error
(`:717-724`); successes return `structuredContent` plus JSON text (`:726-733`). Also
available: `McpServer.resource` (URI templates with completions), `prompt`, `elicit`.

## Structured output (`generateObject`)

`generateObject({ prompt, schema, objectName? })` sets provider `responseFormat = { type:
"json", objectName, schema }` (`LanguageModel.ts:865-877`); `objectName` defaults to the
schema's `identifier` annotation, else `"generateObject"` (`:2164-2179`). The response
text is decoded through `Schema.fromJsonString(schema)` — failure is
`StructuredOutputError` carrying the raw text (`:2181-2211`). So the wire value round-trips
the canonical schema: encoded side out as JSON Schema, decoded side back as domain types.

OpenAI mapping (`openai/OpenAiLanguageModel.ts:2911-2928`): Responses-API
`text.format = { type: "json_schema", name, schema, strict: config.strictJsonSchema ?? true }`.
The JSON Schema comes from `toCodecOpenAI` (`OpenAiStructuredOutput.ts:53-70`), which
rewrites to OpenAI's strict subset **and returns a matching codec** so decoding still
lands on your type: tuples → objects with numeric-string keys, records → `[key, value]`
pair arrays, `Schema.optional` → required nullable (`optionalKey` is the JSDoc-recommended
fix), `oneOf` → `anyOf`, multiple regex filters merged (no `allOf`), `allOf` flattened
(`:39-48`, `:79-101`). Unsupported AST kinds **throw** → `UnsupportedSchemaError`:
`Declaration`, `Enum`, `TemplateLiteral`, `Undefined`, `Void`, bigint/symbol
(`:105-125`). Tool parameters go through the same transformer with the same
`strict: true` default (`openai/OpenAiLanguageModel.ts:2682-2693`).

## OpenAI provider

Two packages, same module names, different wire APIs: `@effect/ai-openai` targets the
**Responses API** (`POST /responses`, `openai/OpenAiLanguageModel.ts:1-9`,
`openai/OpenAiClient.ts:237`); `@effect/ai-openai-compat` targets **`/chat/completions`**
for OpenAI-compatible providers/gateways (`compat/OpenAiClient.ts:180`) with the same
`OpenAiLanguageModel.model(...)` surface (`compat/OpenAiLanguageModel.ts:531`). A gateway
move is a package + client-layer swap, not a rewrite.

- **Client**: `OpenAiClient.layerConfig({ apiKey: Config.redacted(...) })` +
  `FetchHttpClient.layer` (ai-docs `10_language-model.ts:22-27`); options `apiUrl`
  (default `https://api.openai.com/v1`, `openai/OpenAiClient.ts:191`), `organizationId`,
  `projectId`, `transformClient` (`:134-149`).
- **Config**: `OpenAiLanguageModel.Config` is a typed passthrough of
  `OpenAiSchema.CreateResponse` fields — `temperature`, `max_output_tokens`,
  `max_tool_calls`, `reasoning.effort`, `service_tier`, `store`, `instructions`,
  `truncation`, `seed`, plus `strictJsonSchema` (default true) and `fileIdPrefixes`
  (`openai/OpenAiLanguageModel.ts:80-119`; field list `openai/OpenAiSchema.ts:655-697`).
  Precedence: `model` arg < config arg < context `Config` (`:589-590`). System messages
  are re-roled to `developer` for reasoning models (`getModelCapabilities`,
  `:2941-2970`).
- **Vision**: image `FilePart` maps to `input_image` — `URL` → `image_url`, `Uint8Array` →
  base64 data-URI, string → `file_id` _only if_ it matches `config.fileIdPrefixes`
  (`:836-852`, `isFileId :2857-2858`). **A plain/base64 string that isn't a configured
  file-id matches no branch and is silently dropped from the request** — always pass
  `Uint8Array` or `URL`. Non-image, non-PDF media types fail with `InvalidRequestError`
  (`:870-876`). Per-part `options: { openai: { imageDetail } }` (`:133-148`).
- **Prompt caching**: OpenAI Responses caching is implicit; hits surface as
  `usage.inputTokens.cacheRead` (from `input_tokens_details.cached_tokens`,
  `:3037-3063`). `prompt_cache_key`/`prompt_cache_retention` are **not** in the typed
  `CreateResponse` config of `@effect/ai-openai` (`openai/OpenAiSchema.ts:655-697`) — the
  body is posted with `HttpBody.jsonUnsafe` so nothing strips extra keys at runtime
  (`openai/OpenAiClient.ts:236-239`), but typing them requires a cast. In
  `@effect/ai-openai-compat` they're accepted (`compat/OpenAiClient.ts:650-653`) yet the
  chat-completions mapping never forwards them — known-but-unmapped keys are silently
  dropped (`compat/OpenAiLanguageModel.ts:1490-1539`).

## Streaming vs non-streaming

`streamText` yields `Response.StreamPart`s (`text-start/-delta/-end`, tool parts, finish);
tool handlers run as calls arrive, with finish parts deferred until handlers complete
(`LanguageModel.ts:1526-1574`). For a non-streaming turn loop (WhatsApp), use
`generateText` — one Effect per round, accessors on the result; streaming buys nothing
without incremental delivery.

## Testing seams

The stub seam is `LanguageModel.make({ generateText, streamText })` — the same constructor
providers use — provided as the `LanguageModel` service; hooks return **encoded** response
parts and receive full `ProviderOptions` (prompt, tools, responseFormat) for asserting
what would hit the wire (`LanguageModel.ts:748-768`). The repo's own tests wrap this as
`withLanguageModel({ generateText: parts | (options) => parts })`
(`test/utils.ts:6-69`; usage e.g. `test/LanguageModel.test.ts:294-330`). Scripted
multi-turn conversations = a hook closing over a call counter returning different part
arrays. Provider-level tests instead stub `HttpClient` with a request-capturing mock under
a real `OpenAiClient` (`packages/ai/openai/test/OpenAiLanguageModel.test.ts:1317`,
`:1395`), asserting the exact JSON request body.

## Traps recap

| Trap                                   | Consequence                                                                         | Fix                                                                |
| -------------------------------------- | ----------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| No built-in loop / iteration cap       | one round per `generateText`, silent stop after tool round                          | own loop + `MAX_ITERATIONS` + `finishReason` check                 |
| `failureMode: "error"` (default)       | handler failure kills the turn, model never sees it                                 | `failure` schema + `failureMode: "return"`                         |
| string image data, no `fileIdPrefixes` | image silently omitted from request                                                 | pass `Uint8Array` or `URL`                                         |
| tool concurrency default `"unbounded"` | parallel side-effectful API calls                                                   | `concurrency: 1`                                                   |
| `Schema.optional` in structured output | encoded as required-nullable; `Undefined` kind throws                               | `Schema.optionalKey`                                               |
| `prompt_cache_key` in config           | not typeable (openai) / silently dropped (compat)                                   | rely on implicit caching; verify via `usage.inputTokens.cacheRead` |
| empty toolkit vs no toolkit            | both skip tool wiring but still error on pending approvals (`ToolkitRequiredError`) | keep the toolkit attached across rounds                            |
