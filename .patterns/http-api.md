# HttpApi

How `effect/unstable/httpapi` (v4) actually works, read from the source. Citations are
`<path>:<line>` relative to `packages/effect/`. The canonical walkthrough is
`ai-docs/src/51_http-server/` (`10_basics.ts` + fixtures) — read it before adding endpoints.

## The contracts-once trio

One `HttpApi` definition derives three artifacts, all schema-enforced **at runtime**, not
just at the type level:

| Artifact | Derivation                                                                                                    | Where validation happens                                                                                                                                         |
| -------- | ------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Server   | `HttpApiBuilder.layer(api)` + `HttpApiBuilder.group` handlers                                                 | request decoded through contract (400 on failure), handler return **encoded through the success schema** (`HttpApiBuilder.ts:758`, applied at `:809`)            |
| Client   | `HttpApiClient.make(api)`                                                                                     | payload encoded through contract; response body run through `Schema.decodeEffect` against the success schema per status (`HttpApiClient.ts:362-379`, `:726-730`) |
| OpenAPI  | `OpenApi.fromApi(api)` — served by `HttpApiBuilder.layer(api, { openapiPath })` (`HttpApiBuilder.ts:103-106`) | n/a (spec generation; cached per api instance in a `WeakMap`, `OpenApi.ts:213`)                                                                                  |

## Defining endpoints

`HttpApiEndpoint.get/post/put/patch/delete/head/options(identifier, path, options)`
(`HttpApiEndpoint.ts:964-1080`). Options:

- `params` — path params; must encode to strings (`:875`). Bridge branded/numeric types with
  `Schema.FiniteFromString.pipe(Schema.decodeTo(UserId))` (ai-docs `api/Users.ts:42-45`).
- `query`, `headers` — string-encodable schemas or bare fields records.
- `payload` — body schema; **array of schemas** = content-type negotiation (`:1096-1130`).
  On GET/HEAD, `payload` is modeled as query params (`:912`).
- `success` — single schema or array (multiple statuses/content-types). Defaults to
  `HttpApiSchema.NoContent` → 204 (`:264-267`).
- `error` — single or array; streams forbidden in errors (`:1156-1158`).

Statuses via `HttpApiSchema.status(201)(schema)` or `schema.pipe(HttpApiSchema.status(201))`;
success defaults 200, error defaults **500** (`HttpApiSchema.ts:702-714`).

JSON codecs are applied automatically: params/query/headers get `Schema.toCodecStringTree`,
payload/success/error get `Schema.toCodecJson` (`HttpApiEndpoint.ts:1065-1076`). This is why
`Schema.DateTimeUtc` in a contract "just works" as an ISO string on the wire.

`HttpApiSchema` inventory: `Empty(code)`, `NoContent`(204), `Created`(201), `Accepted`(202),
`asNoContent({decode})` (empty body ⇄ constructed value), `asJson/asText/asUint8Array/
asFormUrlEncoded`, `asMultipart(Stream)`, `StreamSse`, `StreamUint8Array`. v3's
`withEncoding` is gone — use the `as*` combinators.

## Server pipeline semantics (the parts that surprise)

Per-request flow is `handlerToHttpEffect` (`HttpApiBuilder.ts:751-819`):

1. **Request decode failure → empty 400.** Each component decode is wrapped in
   `HttpApiSchemaError.wrap("Params"|"Headers"|"Query"|"Payload", ...)` (`:784-799`), then
   re-thrown as a **defect** (`:812-816`) and rendered by `HttpServerRespondable` as an
   **empty `400 Bad Request`** — no body, by design (`HttpApiError.ts:445-475`). There is
   **no v3-style `HttpApiDecodeError` with an `issues` JSON body in v4**; field-level
   validation detail in responses must be built explicitly.
   The cause is still reported to logs (`HttpEffect.ts:45-47`).
2. **Unknown request content-type → 415** (`:702`).
3. **Success responses are runtime-validated.** The handler's return value is encoded
   through the union of success schemas (`makeSuccessSchema`, `:1047-1093`); an encode
   failure is also an `HttpApiSchemaError("Body")` → **empty 400, not 500**, in this build.
4. **Declared errors** encode through their schema with their annotated status; encoding an
   _undeclared_ error is `Effect.orDie`'d (`:815`).
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
`HttpApiEndpoint.ts:270-279`).

`handlers.handle(name, fn)` is fully type-enforced: `name` must be an unhandled endpoint of
the group; the request arg carries decoded `payload/params/query/headers`; an unhandled
endpoint turns the builder's return type into the string literal
`` `Endpoint not handled: ${name}` `` (`HttpApiBuilder.ts:241-247`).

## Client semantics

`HttpApiClient.make(api, { transformClient?, transformResponse?, baseUrl? })` requires the
`HttpClient` service (`HttpApiClient.ts:476-494`) and returns `client[group][endpoint](req)`.

- **Type safe AND runtime safe by default.** Payload/params/query/headers are encoded
  through the contract; the response body is decoded through the success schema selected by
  exact status (`HttpClientResponse.matchStatus`, `:330-334`) and content-type
  (`:754-766`). Opt out only via `responseMode: "response-only"`.
- Request keys in v4 are **`params` and `query`** (not v3's `path`/`urlParams`);
  `responseMode: "decoded-only" (default) | "decoded-and-response" | "response-only"`.
- Error channel of every call: declared error types (decoded by status) ∪
  `Schema.SchemaError` (encode/decode failures — a success body that doesn't match the
  contract **fails typed**, it does not die) ∪ `HttpClientError` (transport, undocumented
  status, unsupported content-type).
- An **undocumented status** (e.g. the framework's empty 400 on payload-decode failure) is
  an `HttpClientError` with reason `DecodeError` (`:973-981`) — not structured data.
- `baseUrl` prepends to the request URL (`:285-291`); needed for fetch-based clients hitting
  relative paths. `NodeHttpServer.layerTest`'s client is pre-pointed at the bound port, so
  no `baseUrl` there.
- Variants: `makeWith` (explicit `httpClient`), `group`, `endpoint`, `urlBuilder` (pure URL
  strings via `Schema.encodeSync`).

## OpenAPI derivation

- `OpenApi.fromApi(api)` emits **OpenAPI 3.1.0** (`OpenApi.ts:259`); defaults
  `info.title = "Api"`, `info.version = "0.0.1"`. Serving it is one option:
  `HttpApiBuilder.layer(api, { openapiPath: "/openapi.json" })` — that is the _only_ option
  `layer` takes, and the only spec-serving mechanism in v4 (replaces v3's
  `middlewareOpenApi`).
- **operationId** defaults to `` `${group.identifier}.${endpoint.identifier}` ``
  (`OpenApi.ts:335-339`); `topLevel: true` groups drop the prefix; override with
  `OpenApi.Identifier`. Duplicate ids or duplicate method+path **throw** at spec build.
- Annotations (`.annotate(OpenApi.X, ...)` on api/group/endpoint): `Title`, `Version`,
  `Description`, `Summary`, `License`, `ExternalDocs`, `Servers`, `Deprecated`,
  `Identifier`, `Exclude` (group-level cascades), `Override` (shallow merge), `Transform`
  (function on the generated object), plus `OpenApi.annotations({...})` and
  `HttpApi.AdditionalSchemas`.
- **Schema `identifier` annotations drive `$ref`/`components.schemas`**
  (`internal/schema/representation.ts:62-73`). Without them, everything inlines and
  `components.schemas` stays empty. Annotate shared contract schemas
  (`Schema.annotate({ identifier: "Transaction" })`) so agent/codegen consumers get named
  components.
- Check → JSON Schema mapping: `isUUID` → `pattern` + `format: "uuid"`; `isInt` → `integer`;
  `isGreaterThan` → `exclusiveMinimum`; `isMaxLength` → `maxLength`/`maxItems`; brands are
  **invisible**; objects get `additionalProperties: false`; unconstrained `Schema.Number`
  emits an `anyOf` including `"NaN"`/`"Infinity"` strings (use `isFinite`/`isInt`).
- Docs UI: `HttpApiScalar.layer(api, { path: "/docs" })` (self-contained, bundled) or
  `.layerCdn`, and `HttpApiSwagger.layer` — all in core `effect/unstable/httpapi`, all embed
  the spec into the HTML; keep `openapiPath` for the raw JSON.

## Dates in contracts — a trap

`Schema.Date` accepts **invalid `Date` instances** (`Schema.ts:10449-10451`), and its JSON
codec (`DateString`, `Schema.ts:10437`) decodes _any_ string — `"not-a-date"` decodes
successfully to `Invalid Date`. In an HttpApi contract that means a garbage date passes the
400 gate and detonates later (typically as a 500 deep in the handler). It also emits a bare
`{ "type": "string" }` in OpenAPI.

Use instead, in preference order:

1. `Schema.DateTimeUtc` — validates `DateTime.Utc`, wire codec is a **validated** ISO string
   (`Schema.ts:12026`, `dateTimeUtcFromString` rejects garbage — `SchemaTransformation.ts:1811-1823`),
   handlers get immutable `DateTime.Utc` values that compose with `Clock`/`DateTime`. The
   `Date`-schema JSDoc itself points to `DateTimeUtcFromString` for date-time strings
   (`Schema.ts:10525`).
2. `Schema.DateValid` (`Schema.ts:10596`, = `Date.check(isDateValid())`) — keeps JS `Date`
   but rejects `Invalid Date` at decode and adds `format: "date-time"` to the JSON schema
   (`representation.ts:711-712`).

## Schema patterns for contracts

- **Derive, don't duplicate**: `Base.mapFields(Struct.omit(["id", "createdAt"]))` is the v4
  idiom (`Schema.ts:3395-3402`; repo tests use it verbatim). Caveat: struct-level
  `.check(...)`s are dropped by `mapFields` unless `unsafePreserveChecks` — field-level
  checks survive.
- **Branded ids**: `Schema.String.check(Schema.isUUID()).pipe(Schema.brand("XxxId"))`
  composes the repo's own primitives; ai-docs use the same shape
  (`Schema.Int.pipe(Schema.brand("UserId"))`). No prebuilt branded-UUID schema exists.
- Keep API definitions in their own module, importable by clients without pulling in server
  code (ai-docs `10_basics.ts:12-16`).

## Layer wiring (canonical, ai-docs `10_basics.ts:23-63`)

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
- **Real socket**: `NodeHttpServer.layerTest` (`platform-node/src/NodeHttpServer.ts:477-486`)
  binds an ephemeral port and wires an `HttpClient` pointed at it. Same schema pipeline,
  plus real transport.

## Middleware

`class Authorization extends HttpApiMiddleware.Service<...>()("id", { security: { bearer:
HttpApiSecurity.bearer }, error: Unauthorized, requiredForClient: true }) {}` — attach with
`.middleware(Tag)` at endpoint/group/api; implementation is a Layer providing a function
(or a per-security-scheme record receiving the decoded credential) that typically
`Effect.provideService`s e.g. `CurrentUser` downstream. Middleware error schemas merge into
every covered endpoint's contract, and the derived client gains the matching requirement
(`HttpApiMiddleware.layerClient` on the client side).
