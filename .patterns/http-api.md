# HttpApi

How `effect/unstable/httpapi` (v4) actually works, read from the source. Citations are
`<path>:<line>` relative to `packages/effect/`. The canonical walkthrough is
`ai-docs/src/51_http-server/` (`10_basics.ts` + fixtures) — read it before adding endpoints.

## The define-once derivation trio

One `HttpApi` definition derives three artifacts, all schema-enforced **at runtime**, not
just at the type level:

| Artifact | Derivation                                                                                                   | Where validation happens                                                                                                                                                         |
| -------- | ------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Server   | `HttpApiBuilder.layer(api)` + `HttpApiBuilder.group` handlers                                                | request decoded through the operation definition (400 on failure), handler return **encoded through the success schema** (`HttpApiBuilder.ts:756-775`, applied at `:819-827`)    |
| Client   | `HttpApiClient.make(api)`                                                                                    | payload encoded through the operation definition; response body run through `Schema.decodeEffect` against the success schema per status (`HttpApiClient.ts:365-382`, `:728-742`) |
| OpenAPI  | `OpenApi.fromApi(api)` — served by `HttpApiBuilder.layer(api, { openapiPath })` (`HttpApiBuilder.ts:63-108`) | n/a (spec generation; cached per api instance in a `WeakMap`, `OpenApi.ts:216-218`)                                                                                              |

## Defining endpoints

`HttpApiEndpoint.get/post/put/patch/delete/head/options(identifier, path, options)`
(`HttpApiEndpoint.ts:979-1096`, method exports at `:1397-1449`). Options:

- `params` — path params; must encode to strings (`HttpApiEndpoint.ts:105-107`). Bridge branded/numeric types with
  `Schema.FiniteFromString.pipe(Schema.decodeTo(UserId))` (ai-docs `api/Users.ts:42-45`).
- `query`, `headers` — string-encodable schemas or bare fields records.
- `payload` — body schema; **array of schemas** = content-type negotiation (`HttpApiEndpoint.ts:1111-1145`).
  On GET/HEAD, `payload` is modeled as query params (`HttpApiSchema.ts:948-959`).
- `success` — single schema or array (multiple statuses/content-types). Defaults to
  `HttpApiSchema.NoContent` → 204 (`HttpApiEndpoint.ts:986-990`; `HttpApiSchema.ts:149`).
- `error` — single or array; streams forbidden in errors (`HttpApiEndpoint.ts:1172-1181`).

Statuses via `HttpApiSchema.status(201)(schema)` or `schema.pipe(HttpApiSchema.status(201))`;
success defaults 200, error defaults **500** (`HttpApiSchema.ts:972-1003`). `status` is sugar
for the `httpApiStatus` schema annotation (`HttpApiSchema.ts:101-121`, resolved at `:933-935`), so an
error class can carry its status directly:
`Schema.TaggedErrorClass<E>()("Tag", fields, { httpApiStatus: 401 })` — the repo's own idiom
(ai-docs `api/Authorization.ts:7-14`).

JSON codecs are applied automatically: params/query/headers get `Schema.toCodecStringTree`,
payload/success/error get their response-aware JSON codecs (`HttpApiEndpoint.ts:1080-1092`,
`:1149-1186`). This is why
`Schema.DateTimeUtc` in an operation definition "just works" as an encoded ISO string.

`HttpApiSchema` inventory: `Empty(code)`, `NoContent`(204), `Created`(201), `Accepted`(202),
`asNoContent({decode})` (empty body ⇄ constructed value), `asJson/asText/asUint8Array/
asFormUrlEncoded`, `asMultipart(limits?)` (buffered) and `asMultipartStream(limits?)`
(streaming — see the Multipart section), `StreamSse`, `StreamUint8Array`. v3's
`withEncoding` is gone — use the `as*` combinators.

## Server pipeline semantics (the parts that surprise)

Per-request flow is `handlerToHttpEffect` (`HttpApiBuilder.ts:756-838`):

1. **Request decode failure → empty 400.** Each component decode is wrapped in
   `HttpApiSchemaError.wrap("Params"|"Headers"|"Query"|"Payload", ...)` (`:792-807`), then
   re-thrown as a **defect** (`:831-835`) and rendered by `HttpServerRespondable` as an
   **empty `400 Bad Request`** — no body, by design (`HttpApiError.ts:447-468`). There is
   **no v3-style `HttpApiDecodeError` with an `issues` JSON body in v4**; field-level
   validation detail in responses must be built explicitly.
   The cause is still reported to logs (`HttpEffect.ts:45-47`).
   Payload decoding has two extra traps. `buildPayloadDecoders` always constructs
   `Schema.Union(schemas)`, even when there is exactly one payload schema, and invokes the decoder
   without parse options (`HttpApiBuilder.ts:682`), so parsing uses `errors: "first"`, the default
   (`SchemaAST.ts:470`). The union parser first narrows candidates by literal sentinels; when no
   candidate matches, it raises `AnyOf(ast, input, [])` with no member issue
   (`SchemaAST.ts:2965-2974`). Formatting that empty `AnyOf` reports one root issue containing the whole
   rejected value (`SchemaIssue.ts:1084-1092`), losing both the field path and the other offending
   fields. To produce complete field-level payload failures in middleware, recover the `AnyOf`
   input and decode it against the single unwrapped payload schema with `{ errors: "all" }`.
   The official interception seam for all of this is
   `HttpApiMiddleware.layerSchemaErrorTransform` — see the Middleware section.
2. **Unknown request content-type → 415** (`:707`).
3. **Success responses are runtime-validated.** The handler's return value is encoded
   through the union of success schemas (`makeSuccessSchema`, `:1123-1128`); an encode
   failure is also an `HttpApiSchemaError("Body")` → **empty 400, not 500**, in this build.
   A `WithHeaders` success validates its headers separately as `"ResponseHeaders"`
   (`:819-829`).
4. **Declared errors** encode through their schema with their annotated status; encoding an
   _undeclared_ error is `Effect.orDie`'d (`:835`).
5. **Defects → empty 500** (`HttpServerError.ts:283-326`); interrupts → 499/503. A defect
   (or handler return) that implements `HttpServerRespondable` chooses its own response.
6. **`Effect.orDie` on unexpected handler errors is the documented idiom** — the repo's own
   example does exactly `users.list(...).pipe(Effect.orDie)` "convert any potential errors
   into a 500" (ai-docs `server/Users/http.ts:15-48`). Use `Effect.catchReason(..., fail, die)`
   when some errors are declared and the rest should die.

Error modeling: `HttpApiError` ships `BadRequest`(400) … `ServiceUnavailable`(503) classes,
each with a `*NoContent` empty-body variant. **There is no `.addError` in v4** — errors are
declared per-endpoint via `error:`, and cross-cutting errors ride on middleware (a
middleware's `error` schema merges into every endpoint it covers,
`HttpApiEndpoint.ts:283-291`).

`handlers.handle(name, fn)` is fully type-enforced: `name` must be an unhandled endpoint of
the group; the request arg carries decoded `payload/params/query/headers`; an unhandled
endpoint turns the builder's return type into the string literal
`` `Endpoint not handled: ${name}` `` (`HttpApiBuilder.ts:241-247`).

## Client semantics

`HttpApiClient.make(api, { transformClient?, transformResponse?, baseUrl? })` requires the
`HttpClient` service (`HttpApiClient.ts:476-494`) and returns `client[group][endpoint](req)`.

- **Type safe AND runtime safe by default.** Payload/params/query/headers are encoded
  through the operation definition; the response body is decoded through the success schema selected by
  exact status (`HttpClientResponse.matchStatus`, `:330-337`) and content-type
  (`:788-801`). Opt out only via `responseMode: "response-only"`.
- Request keys in v4 are **`params` and `query`** (not v3's `path`/`urlParams`);
  `responseMode: "decoded-only" (default) | "decoded-and-response" | "response-only"`.
- Error channel of every call: declared error types (decoded by status) ∪
  `Schema.SchemaError` (encode/decode failures — a success body that doesn't match the
  contract **fails typed**, it does not die) ∪ `HttpClientError` (transport, undocumented
  status, unsupported content-type).
- An **undocumented status** (e.g. the framework's empty 400 on payload-decode failure) is
  an `HttpClientError` with reason `DecodeError` (`:1033-1042`) — not structured data.
- `baseUrl` prepends to the request URL (`:285-291`); needed for fetch-based clients hitting
  relative paths. `NodeHttpServer.layerTest`'s client is pre-pointed at the bound port, so
  no `baseUrl` there.
- Variants: `makeWith` (explicit `httpClient`), `group`, `endpoint`, `urlBuilder` (pure URL
  strings via `Schema.encodeSync`).

## OpenAPI derivation

- `OpenApi.fromApi(api)` emits **OpenAPI 3.1.0** (`OpenApi.ts:304-308`); defaults
  `info.title = "Api"`, `info.version = "0.0.1"`. Serving it is one option:
  `HttpApiBuilder.layer(api, { openapiPath: "/openapi.json" })` — that is the _only_ option
  `layer` takes, and the only spec-serving mechanism in v4 (replaces v3's
  `middlewareOpenApi`).
- **operationId** defaults to `` `${group.identifier}.${endpoint.identifier}` ``
  (`OpenApi.ts:383-386`); `topLevel: true` groups drop the prefix; override with
  `OpenApi.Identifier`. Duplicate ids or duplicate method+path **throw** at spec build.
- Annotations (`.annotate(OpenApi.X, ...)` on api/group/endpoint): `Title`, `Version`,
  `Description`, `Summary`, `License`, `ExternalDocs`, `Servers`, `Deprecated`,
  `Identifier`, `Exclude` (group-level cascades), `Override` (shallow merge), `Transform`
  (function on the generated object), plus `OpenApi.annotations({...})` and
  `HttpApi.AdditionalSchemas`.
- **Schema `identifier` annotations drive `$ref`/`components.schemas`.** RC.112 resolves identifiers on the encoded AST and uses them as the default reference policy
  (`internal/schema/toRepresentation.ts:8`, `:49-64`, `:112-139`). Anonymous non-recursive
  schemas inline; recursive schemas still receive a synthetic reference. Annotate shared
  operation schemas (`Schema.annotate({ identifier: "Transaction" })`) so agent/codegen
  consumers get stable named components.
- Check → JSON Schema mapping: `isUUID` → `pattern` + `format: "uuid"`; `isInt` → `integer`;
  `isGreaterThan` → `exclusiveMinimum`; `isMaxLength` → `maxLength`/`maxItems`; brands are
  **invisible**; objects get `additionalProperties: false`; unconstrained `Schema.Number`
  emits an `anyOf` including `"NaN"`/`"Infinity"` strings (use `isFinite`/`isInt`).
- Docs UI: `HttpApiScalar.layer(api, { path: "/docs" })` (self-contained, bundled) or
  `.layerCdn`, and `HttpApiSwagger.layer` — all in core `effect/unstable/httpapi`, all embed
  the spec into the HTML; keep `openapiPath` for the raw JSON.

## Dates in operation definitions

RC.112 made `Schema.Date` the valid-JavaScript-Date schema: it rejects instances whose timestamp
is `NaN`, and its JSON codec decodes strings through the validating `dateFromString`
transformation (`Schema.ts:12188-12241`; `SchemaTransformation.ts:879-897`). The old
`Schema.DateValid` workaround no longer exists.

Prefer `Schema.DateTimeUtc` when handlers should receive immutable `DateTime.Utc` values that
compose directly with `Clock`/`DateTime`; its JSON transport is a validated UTC ISO string
(`Schema.ts:13768-13804`, `:13887-13895`). Use `Schema.Date` when the domain genuinely requires a
JS `Date`, or `Schema.DateFromString` at an explicit string boundary (`Schema.ts:12270-12295`).
All three reject malformed date input rather than allowing an `Invalid Date` through the 400 gate.

## Schema patterns for operation definitions

- **Derive, don't duplicate**: `Base.mapFields(Struct.omit(["id", "createdAt"]))` is the v4
  idiom (`Schema.ts:3510-3551`; repo tests use it verbatim). Caveat: struct-level
  `.check(...)`s are dropped by `mapFields` unless `unsafePreserveChecks` — field-level
  checks survive.
- **Branded ids**: `Schema.String.check(Schema.isUUID()).pipe(Schema.brand("XxxId"))`
  composes the repo's own primitives; ai-docs use the same shape
  (`Schema.Int.pipe(Schema.brand("UserId"))`). No prebuilt branded-UUID schema exists.
- Keep API definitions in their own module, importable by clients without pulling in server
  code (ai-docs `10_basics.ts:12-16`).

## Layer assembly (canonical, ai-docs `10_basics.ts:23-63`)

```ts
const ApiRoutes = HttpApiBuilder.layer(Api, { openapiPath: "/openapi.json" }).pipe(
  Layer.provide([GroupHandlersLive]) // each group layer provides its own services
);
const AllRoutes = Layer.mergeAll(ApiRoutes, HttpApiScalar.layer(Api, { path: "/docs" }));
export const HttpServerLayer = HttpRouter.serve(AllRoutes).pipe(
  Layer.provide(NodeHttpServer.layer(createServer, { port: 3000 }))
);
Layer.launch(HttpServerLayer).pipe(NodeRuntime.runMain);
```

`HttpRouter.serve` auto-attaches a request logger (`disableLogger: true` to opt out) and
accepts `middleware:` (e.g. `HttpMiddleware.cors({...})`). Serverless:
`HttpRouter.toWebHandler`.

## Testing seams

- **In-memory**: `HttpApiTest.groups(api, ["group"], ...)` (`HttpApiTest.ts:41-113`) builds
  the full router and runs it as a direct `Effect` handler — no socket, no port; returns a
  real typed client, so the whole encode → route → handler → encode → decode pipeline runs,
  including middleware. Needs platform services (`FileSystem`, `Etag.Generator`,
  `HttpPlatform`, `Path`). This is what the effect repo's own HttpApiBuilder tests use.
- **Real socket**: `NodeHttpServer.layerTest` (`../platform/node/src/NodeHttpServer.ts:487-501`)
  binds an ephemeral port and configures an `HttpClient` pointed at it. Same schema pipeline,
  plus real transport. Bun equivalents: `BunHttpServer.layer`
  (`../platform/bun/src/BunHttpServer.ts:301-309`) and `BunHttpServer.layerTest` (`:320-325`).

## Middleware

Declaration (canonical fixtures: ai-docs `api/Authorization.ts` + `server/Authorization.ts`):

```ts
class Authorization extends HttpApiMiddleware.Service<
  Authorization,
  {
    provides: CurrentUser; // services injected downstream
    requires: never; // services the implementation needs per-request
  }
>()("app/Authorization", {
  security: { bearer: HttpApiSecurity.bearer },
  error: Unauthorized, // schema(s); merges into every covered endpoint
  requiredForClient: true,
}) {}
```

(`HttpApiMiddleware.Service`, `HttpApiMiddleware.ts:320`). Attach with `.middleware(Tag)` at
endpoint/group/api — group/api attachment just calls `endpoint.middleware` on every endpoint
**already present** (`HttpApiGroup.ts:324-328`, `HttpApi.ts:179-183`); endpoints added later
are not covered.

- **What a middleware is**: a function `(httpEffect, { endpoint, group }) => Effect<HttpServerResponse, ...>`
  (`HttpApiMiddleware.ts:64-72`); security middleware is a record keyed by scheme whose
  functions also receive the decoded `credential` (`:83-102`). It wraps the **whole**
  per-endpoint pipeline — request decode, handler, success encode — so it runs before
  decoding and sees the final encoded success `HttpServerResponse`.
- **Order**: `applyMiddleware` wraps in attachment order (`HttpApiBuilder.ts:856-871`) —
  first-attached is innermost. Since group/api attachment happens after endpoint
  construction, the practical nesting is endpoint-level closest to the handler, api-level
  outermost.
- **Providing services**: `Effect.provideService(httpEffect, CurrentUser, user)` inside the
  middleware makes `CurrentUser` available to the handler and to inner middleware (ai-docs
  `server/Authorization.ts:24-32`).
- **Security decode never fails.** `securityDecode` (`HttpApiBuilder.ts:476-495`) yields
  `Redacted("")` for a missing/malformed `Authorization` header (same for apiKey misses, and
  empty basic credentials). There is **no automatic 401** — the middleware must treat an
  empty credential as unauthorized itself. With multiple schemes, they are tried in
  declaration order; a middleware failure falls through to the next scheme, but errors from
  the wrapped handler short-circuit (`HandlerError` wrapping, `HttpApiBuilder.ts:876-899`).
- **Middleware never sees encoded error responses.** Declared-error encoding happens
  _outside_ `applyMiddleware` (`HttpApiBuilder.ts:831-835`): typed failures pass through the
  middleware's error channel and are turned into responses afterwards. To decorate error
  responses (e.g. `Retry-After`), see Response headers below.
- **Empty-400 interception**: `HttpApiMiddleware.layerSchemaErrorTransform(Tag, (error,
{ endpoint, group }) => ...)` (`HttpApiMiddleware.ts:466-495`) catches the
  `HttpApiSchemaError` before it becomes the empty 400. The error carries
  `kind: "Params" | "Headers" | "Query" | "Payload" | "Body"` and
  `cause: Schema.SchemaError` (`HttpApiError.ts:453-457`), so field-level `{ path, message }`
  detail is recoverable from `cause` (subject to the `AnyOf` payload trap above). Return a
  hand-built `HttpServerResponse` or fail with the middleware's declared error.
- **Client side**: `requiredForClient: true` adds a `ForClient<Id>` requirement to the
  derived client; satisfy it with `HttpApiMiddleware.layerClient(Tag, ({ request, next }) =>
next(HttpClientRequest.bearerToken(request, token)))` (`HttpApiMiddleware.ts:504-533`;
  `HttpClientRequest.bearerToken`, `HttpClientRequest.ts:362-368`). The layer captures its
  surrounding services at build time. Full wiring — `layerClient` + `HttpApiClient.make`
  with `transformClient` for baseUrl/retries — is ai-docs `10_basics.ts:68-106`.

Rate-limiting wiring follows directly: a middleware reads the endpoint's cost/scope
annotations from `options.endpoint` (next section), keys the limiter by the decoded
credential or `CurrentUser`, and on exhaustion either fails with a declared
`{ httpApiStatus: 429 }` error class (no custom headers) or succeeds with a hand-built 429
response carrying `Retry-After` (see Response headers). Limiter algorithms belong to
`concurrency-time.md`.

## Custom annotations and reflection

Endpoint/group/api annotations are a `Context.Context<never>` keyed by ordinary
`Context.Key`s — the same mechanism `OpenApi` uses for its own annotations.

- **Define a key**: `class CostClass extends Context.Service<CostClass, "cheap" |
"expensive">()("app/CostClass") {}` (exactly how `OpenApi.Description` is built,
  `OpenApi.ts:64`), or `Context.Reference("app/CostClass", { defaultValue: () => "cheap" })`
  when reads without an attachment should yield a default (the `OpenApi.Exclude` pattern,
  `OpenApi.ts:138`; `Context.Reference`, `Context.ts:1324-1331`).
- **Attach**: `endpoint.annotate(Key, value)` (`HttpApiEndpoint.ts:811-815`),
  `group.annotate` (group-level value, `HttpApiGroup.ts:336-340`), `group.annotateEndpoints`
  (copies onto every endpoint **already added**, `:348-352`), `api.annotate`
  (`HttpApi.ts:185-189`).
- **Read**: `Context.getOption(endpoint.annotations, Key)`, or `Context.get` for a
  `Reference` (default applies). TRAP: `endpoint.annotations` holds only the endpoint's own
  annotations — group/api levels are **not** merged in; merge yourself
  (`Context.merge(group.annotations, endpoint.annotations)`) or attach via
  `annotateEndpoints`.
- **At request time**: middleware receives `{ endpoint, group }` on every call
  (`HttpApiMiddleware.ts:64-72`), and handlers receive `request.endpoint` /
  `request.group` alongside the decoded parts (`HttpApiEndpoint.ts:97-110`, populated at
  `HttpApiBuilder.ts:783-790`) — annotation-driven authz/limits need no side tables.
- **Programmatic iteration**: `HttpApi.reflect(api, { predicate?, onGroup, onEndpoint })`
  (`HttpApi.ts:247`) walks every group/endpoint with `mergedAnnotations` (api ← group ←
  endpoint precedence), the endpoint's middleware set, and successes/errors grouped as
  `Map<status, schemas>`. This is the mechanism for deriving tool catalogs, affordance
  tables, and definition-lint tests from one metadata source.
- **Operation id**: `` `${group.identifier}.${endpoint.identifier}` `` — same default as
  OpenAPI's operationId (`OpenApi.ts:383-386`) — is computable at definition time (reflect),
  in middleware (`options.endpoint/group`), and in handlers (`request.endpoint/group`).

## Wrapping every success schema (envelopes)

There is **no api- or group-level success-schema transform**: `success` is a frozen
`ReadonlySet` fixed at construction and copied verbatim by every endpoint combinator
(`HttpApiEndpoint.ts:176-189`; `optionsFromEndpoint`, `:825-835`); nothing in `HttpApi`/`HttpApiGroup`
rewrites it. A universal envelope is therefore a discipline-plus-combinator pattern: a
single `Envelope(schema)` combinator applied in every `success:`, enforced mechanically by a
test that runs `HttpApi.reflect` over the api and asserts each entry in `successes` carries
the envelope's marker (e.g. an AST annotation the combinator sets).

## Response headers

RC.112 models typed response headers directly. Wrap a success body with
`HttpApiSchema.WithHeaders(bodySchema, headerFields)` and return
`HttpApiSchema.withHeaders({ body, headers })`; headers are converted through
`Schema.toCodecStringTree`, validated by the server, decoded by the typed client, and emitted in
OpenAPI (`HttpApiSchema.ts:455-478`, `:523-590`; `OpenApi.ts:396-422`, `:755-775`). An invalid success header
becomes `HttpApiSchemaError("ResponseHeaders")` (`HttpApiBuilder.ts:819-829`).

For domain errors whose handler should still fail with the original error value, pipe the error
schema through `HttpApiSchema.encodeToWithHeaders({ body, headers }, { decode, encode })`; the mapping
projects that value into a validated body/header pair (`HttpApiSchema.ts:628-729`). Structural
`WithHeaders` also works for errors when carrying `{ body, headers }` in the error channel is the
right model. A header-bearing response cannot share the same status and content type with another
member of its success/error union because the declaration would be ambiguous (`HttpApiSchema.ts:467-478`).

Use response mutation only outside that typed contract:

- **Cross-cutting success/raw headers**: httpapi middleware maps the encoded response with
  `HttpServerResponse.setHeader` / `setHeaders` (`HttpServerResponse.ts:525-579`). Declared errors
  are encoded outside endpoint middleware (`HttpApiBuilder.ts:831-835`), so model their headers in
  the error schema instead.
- **Literally every response** (api + webhooks + static): router-global middleware via
  `HttpRouter.middleware(fn, { global: true })` (`HttpRouter.ts:919-949`). This is the seam for
  blanket headers; it has no endpoint metadata.

## Multipart

- Mark the payload with `HttpApiSchema.asMultipart(limits?)` (buffered,
  `HttpApiSchema.ts:764-773`) or `asMultipartStream(limits?)` (streaming, `:808-814`).
  Per-endpoint limits: `{ maxParts, maxFieldSize, maxFileSize, maxTotalSize,
fieldMimeTypes }` (`Multipart.ts:759-780`); unset limits fall back to fiber references
  (`makeConfig`, `Multipart.ts:417-430`).
- **Buffered**: the request is parsed to `Multipart.Persisted` — text fields as strings,
  files written into a per-request scoped temp directory (`toPersisted`,
  `Multipart.ts:666-714`; paths valid for the request scope) — then decoded through your
  payload schema. Build that schema from `Multipart.FilesSchema` / `SingleFileSchema`
  (`Multipart.ts:332`, `:345`) plus string fields; `Multipart.schemaJson` (`:385`) decodes a
  JSON-string field through a schema.
- **TRAP — limit violations are empty 500s, not 413s.** Buffered parsing is
  `Effect.orDie`'d (`HttpApiBuilder.ts:711-717`), so `FileTooLarge` / `BodyTooLarge` /
  `TooManyParts` (`Multipart.ts:194-209`) become defects → empty 500. To respond 413, use
  stream mode and map `MultipartError` yourself, or intercept at router middleware level.
- **Streaming**: the handler's `payload` is `Stream<Multipart.Part, MultipartError>`
  regardless of the wrapped schema's Type (`HttpApiEndpoint.ts:97-105`) — the schema only
  documents the shape; validation is on you.
- **Client**: a multipart payload is typed as raw `FormData` (`HttpApiEndpoint.ts:489-507`)
  and sent verbatim (`HttpApiClient.ts:421-422`); schema-encoding it is Forbidden
  (`HttpApiClient.ts:1066-1082`). No client-side runtime validation for multipart.

## Plain routes, raw bodies, static files

`HttpApiBuilder.layer` is itself just `HttpRouter.use` registering the group routes
(`HttpApiBuilder.ts:64-107`), so anything else added to the same `HttpRouter` service
coexists — merge the layers before `HttpRouter.serve`:

- **Plain routes**: `HttpRouter.add(method, path, handler)` / `addAll` / `use` layers
  (`HttpRouter.ts:463-546`). Matching is find-my-way (`HttpRouter.ts:24`, `:119`):
  precedence is by path specificity (static > params > `/*` wildcard), **not** registration
  order, so an SPA fallback can't shadow api routes.
- **Webhook HMAC / raw bodies**: schema payload decoding consumes and reshapes the body, so
  signature checks need the raw bytes. Either (a) keep the endpoint in the api but implement
  it with `handlers.handleRaw(name, fn)` — payload decoding is skipped
  (`HttpApiBuilder.ts:311-328`, payload bypass at `:774-775`), params/query/headers still decode, and the handler
  reads `request.request.text` / `arrayBuffer` / `stream` (`HttpIncomingMessage.ts:51-65`)
  to verify before parsing; or (b) register a plain route outside the api. Request body cap
  via the `MaxBodySize` reference (`HttpIncomingMessage.ts:133-136`).
- **Static files / SPA**: `HttpStaticServer.layer({ root, index?, spa?, cacheControl?,
mimeTypes?, prefix? })` mounts a `GET /*` route (`HttpStaticServer.ts:227-250`) with
  conditional 304s (ETag / If-Modified-Since), byte ranges, and MIME mapping (`:111-175`); `spa: true`
  serves the index only for extension-less paths whose `Accept` includes `text/html`
  (`:180-190`). Requires `FileSystem`, `Path`, `HttpPlatform` (all in `BunServices.layer` /
  `NodeServices.layer`). Single files: `HttpServerResponse.file(path)`
  (`HttpServerResponse.ts:484-505`).
