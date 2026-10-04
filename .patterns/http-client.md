# Outbound HTTP clients (v4)

Import from `effect/http`. Selected sources are
`node_modules/effect/src/http/{HttpClient,HttpClientRequest,HttpClientResponse,HttpIncomingMessage,Headers}.ts`.
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

`followRedirects(max)` follows at most ten redirects by default, rewrites methods where appropriate,
and strips authorization/proxy-authorization/cookie on origin changes. That protection is not an
SSRF policy. Validate allowed destinations and personal-data egress at the adapter.

The default client tracer records URL data and selected headers. Extend `Headers.CurrentRedactedNames`
for custom secret headers and narrow `HttpClient.TracerHeaderFilter`; even non-secret headers can
contain personal data. Keep secrets out of URLs entirely. Configure `TracerDisabledWhen` and
`Tracer.DisablePropagation` according to Fidy's metadata-only and provider-propagation policy,
not as a substitute for safe fields. Never log broad request/response objects.

## Test seam

Provide a stub `HttpClient` below the real provider adapter and return
`HttpClientResponse.fromWeb(request, new Response(...))`. This preserves request construction,
status handling, codecs, and error classification while replacing transport. Cover byte limits,
redirect policy, retry certainty, timeout/interruption, and safe failure projection explicitly.
