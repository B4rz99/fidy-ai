# Effect v4 HttpApi and Cloudflare adapter boundaries

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

## Client and generated artifacts

The browser imports only the generated/client declaration seam. It must not import shell
implementations, platform bindings, provider SDKs, database code, or server-only Effect modules. Build
checks validate the browser graph and static artifact separately from API contract generation.

OpenAPI and operation-policy files are generated review artifacts. Run freshness and compatibility
checks after every operation/schema/annotation change. A generated artifact never becomes a second
source of truth.

## Testing

Portable tests cover schema decoding, authorization projection, errors, reflection, and operation
policy. Provider-boundary tests use deterministic bounded transports. Cloudflare adapter tests cover
Worker routing, D1 subject isolation/atomicity, Durable Object coordination, Queue/Workflow behavior,
R2 bounds, Email Worker handoff, and safe response headers. A fixture transport does not claim that a
production adapter exists.
