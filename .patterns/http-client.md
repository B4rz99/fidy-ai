# Outbound HTTP clients (v4)

Use for provider and first-party outbound transports. Import from `effect/http`. Selected Effect 4.0.1 sources are
`node_modules/effect/src/http/{FetchHttpClient,HttpClient,HttpClientRequest,HttpClientResponse,HttpIncomingMessage,Headers}.ts`.
Search the named combinators when changing adapter policy.

## One policy-bearing client per provider boundary

Build base URL, credentials, headers, status policy, retries, timeouts, and tracing policy in the
owning service Layer. `HttpClient.mapRequest` composes request preprocessing; combinators return a
new client. Keep credentials inside that adapter, not an ambient app-wide client that can reach any
host. Provider responses are untrusted regardless of their SDK types.

A transport success can have any HTTP status. `filterStatusOk` turns non-2xx into a status error;
use it only when that classification fits the provider contract. Otherwise inspect status with
`HttpClientResponse.matchStatus` before mapping certainty—particularly when rejection and ambiguous
acceptance must remain distinct.

## Body codecs and bounds

- `HttpClientRequest.schemaBodyJson(S)(value)` validates and applies S's JSON codec.
- `bodyJson` catches serialization failure; `bodyJsonUnsafe` is only for already-proven JSON values.
- `HttpClientResponse.schemaBodyJson(S, options)` parses and decodes through the JSON codec.
- `schemaJson` decodes a status/header/body envelope; `schemaNoBody` decodes without body content.

Complete-body accessors such as `text` and `arrayBuffer` cache the response in memory; they impose
no size limit. For hostile/provider responses, reject excessive declared length and enforce a
streamed byte cap before decoding. Missing or false Content-Length does not evade the cap.
`Stream.runCollect` is safe only after a proven bound.

`HttpClient.query` and `HttpClientRequest.query` use the body-capable `QUERY` method. It does not
inherit GET safety just because of its name; choose retry/encoding policy from the actual contract.

## Retry, rate limiting, and cancellation

`retryTransient` defaults to retrying both transient transport errors and transient responses.
Bound attempts with `times`, backoff with Schedule, and total work with the caller's deadline.
Use `retryOn` to select errors/responses deliberately. A provider mutation may have been accepted
before a timeout or 5xx; only retry with rejection evidence or a provider-backed idempotency guarantee.

`withRateLimiter` consumes a `RateLimiter` and can inspect headers and `Retry-After`. Automatic 429
retries are unlimited unless `times` is set. `disableResponseInspection` does not disable retries;
`times: 0` does. This library admission policy does not replace durable product quotas.

Ordinary interruption aborts the request; `withScope` ties its controller to an explicit Scope.
Consume streamed bodies inside their owning lifetime. Local cancellation cannot retract a remote
side effect.

## Redirects and telemetry

Native fetch follows redirects by default, before Effect can inspect the response. Provide
`FetchHttpClient.RequestInit` with `redirect: "manual"` when the adapter handles redirects, or
`redirect: "error"` when any redirect must fail. `followRedirects(client, 0)` alone does not prevent
native fetch from following. Browser manual redirects can produce an opaque redirect response;
reject it rather than assuming the destination/status is inspectable.

With native redirect handling disabled, `HttpClient.followRedirects` follows at most ten redirects
by default, rewrites methods where appropriate, and strips authorization/proxy-authorization/cookie
on origin changes. This is not an SSRF policy: validate every allowed destination and personal-data
egress before sending a follow-up request.

The default client tracer records URLs and selected headers. Extend `Headers.CurrentRedactedNames`
for custom secret headers and narrow `HttpClient.TracerHeaderFilter`; non-secret headers can still
contain personal data. Select controls deliberately:

| Requirement                                                                     | Effect 4.0.1 control                                                                    |
| ------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| Suppress automatic HTTP spans and their URL/header metadata                     | Provide `HttpClient.TracerDisabledWhen` with the appropriate request predicate          |
| Keep approved automatic HTTP spans but suppress injected outgoing trace headers | Provide `HttpClient.TracerPropagationEnabled` with `false`                              |
| Disable propagation through the broader tracer context                          | `Tracer.DisablePropagation`; this also bypasses the HTTP tracing branch in this release |

These controls do not remove trace headers already present in a request. Construct the allowed
header set at the adapter. Never log broad request/response objects.

## Existing recipe

Follow `makeProtectedClient` and `makePairingClient` in the
[CLI transport](../apps/cli/src/direct-client/runtime.ts): validate the fixed destination and request
bytes, execute under manual-redirect/tracing settings, consume a byte-bounded response, map transport
failures, and place the deadline around body consumption as well as headers. Feed that client into
`HttpApiClient.makeWith`. For browser-specific credentials and opaque responses, use the
[browser policy](../apps/web/src/transport/browser-http-policy.ts).

## Test seam

Provide a stub `HttpClient` below the real provider adapter and return
`HttpClientResponse.fromWeb(request, new Response(...))`. This preserves request construction,
status handling, codecs, and error classification while replacing transport. Cover byte limits,
redirect policy, retry certainty, timeout/interruption, and safe failure projection explicitly.
