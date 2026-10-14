# Effect v4 HttpApi and Cloudflare adapter boundaries

Import HttpApi modules from `effect/http-api`. Selected Effect 4.0.2 source:
`node_modules/effect/src/http-api/{HttpApi,HttpApiBuilder,HttpApiClient,HttpApiMiddleware,HttpApiSchema,OpenApi}.ts`.

Use HttpApi as the define-once public contract. The canonical operation declaration derives typed
server/client artifacts, OpenAPI, reflected access metadata, and browser/tool policy. Cloudflare
Workers consume the declaration; they do not create a second route or operation registry.

## Operation definitions

Keep input and output schemas closed, bounded, and provider-neutral. Declare query versus mutation,
access requirement, confirmation policy, and safe error types in operation annotations. Use explicit
User context at the adapter boundary. A public route may be unauthenticated only when its own proof
and purpose are explicit.

Request decoding and response encoding happen at the HttpApi seam. Do not treat TypeScript types,
provider SDK responses, queue payloads, or model output as decoded domain values. Map failures to the
operation's schema-serializable error union and do not include raw statements, provider bodies,
secrets, or personal content.

## Middleware and routes

Worker middleware owns origin, authentication, rate limits, request-size bounds, security headers,
correlation metadata, and safe error projection. Keep private service bindings and D1 inaccessible to
public ingress. A private Core Worker may expose an internal data boundary, but it must still receive
an explicit subject and operation policy.

Custom routes, raw bodies, multipart, static files, and response headers need explicit annotations and
reflection evidence. Provider callbacks verify authenticity before parsing or changing state. Email
Worker admission is outside the public API and hands off only the bounded provider-neutral contract.

## Middleware recipe

1. Declare `HttpApiMiddleware.Service` at the contract seam, including its serializable error schemas.
   `provides` describes services installed for downstream handlers; `requires` describes middleware
   dependencies supplied by assembly. Follow `TokenAuthorization` and `ResolvedCaller` in the
   [authorization contract](../apps/server/src/shell/authorization/contract.ts).
2. Supply the server implementation as a Layer at request assembly. Keep caller services request-scoped;
   declaration of a security scheme alone does not authenticate a caller.
3. With `requiredForClient: true`, typed clients require the corresponding
   `HttpApiMiddleware.ForClient` service. Use `HttpApiMiddleware.layerClient` as in the
   [authorization runtime](../apps/server/src/shell/authorization/runtime.ts). Its anonymous pass-through
   implementation deliberately receives declared authentication failures; it does not grant access.
4. When adding schema-error middleware, use `HttpApiMiddleware.layerSchemaErrorTransform` with a
   declared safe error schema and return `Effect.fail(safeError)` (or an intentional safe response).
   Project the wrapper's decoding category into a closed failure; never serialize its full issue tree
   or input values. Install it where endpoint decoding errors can reach it and test malformed input
   through the real router. This API is marked unstable in the selected release.

## Client and generated artifacts

The browser imports only the generated/client declaration seam. It must not import shell
implementations, platform bindings, provider SDKs, database code, or server-only Effect modules. Build
checks validate the browser graph and static artifact separately from API contract generation.

OpenAPI and operation-policy files are generated review artifacts. Run freshness and compatibility
checks after every operation/schema/annotation change. A generated artifact never becomes a second
source of truth.

For a policy-bearing derived client, follow `makePairingClient` in the
[CLI transport](../apps/cli/src/direct-client/runtime.ts): pass the protected `HttpClient` to
`HttpApiClient.makeWith(Api, { httpClient, baseUrl })`. The generated client supplies codecs and
endpoint shapes; the protected transport supplies origin, redirect, size, deadline and telemetry
policy. Keep the transport lifetime open through response consumption.

`OpenApi.fromApi` derives the document from the declaration. Follow the
[contract generator](../apps/server/tools/contracts/generate.ts) for reference policy and persisted
artifacts; do not manually maintain a second endpoint schema. Test both the middleware's projected
failure and the declared OpenAPI response, since a successful document build does not exercise
runtime authentication or safe decoding errors.

## Testing

Portable tests cover schema decoding, authorization projection, errors, reflection, and operation
policy. Provider-boundary tests use deterministic bounded transports. Cloudflare adapter tests cover
Worker routing, D1 subject isolation/atomicity, Durable Object coordination, Queue/Workflow behavior,
R2 bounds, Email Worker handoff, and safe response headers. A fixture transport does not claim that a
production adapter exists.
