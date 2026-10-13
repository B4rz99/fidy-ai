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

In selected Effect 4.0.1, `HttpClientResponse.stream` delegates to `Stream.fromReadableStream`.
Its `Channel.readableStreamToPullUnsafe` finalizer awaits `reader.cancel().catch(...)` and does
not call `releaseLock()`. A native cancellation Promise that never settles can therefore stall
scope closure after overflow, timeout or interruption. `releaseLockOnEnd: true` chooses only
`releaseLock()` instead; it does not cancel underlying work. Neither setting alone proves both
transport termination and local ownership release. Verify these branches in
`node_modules/effect/src/Channel.ts` and `node_modules/effect/src/http/HttpClientResponse.ts`.

Fidy's native Fetch owners acquire the response reader eagerly, connect cleanup to the request
AbortSignal, and wrap the body with `highWaterMark: 0` to avoid prefetch. On abort, read failure or
consumer cancellation they start native cancellation, handle its rejection, and release the raw
reader lock without awaiting untrusted cancellation. Normal end also releases the lock. Decode
unknown chunks before accounting bytes; catch decoder failures as well as rejected reads. See the
[Cloudflare native transport](../apps/server/cloudflare/outbound-http/runtime.ts) and the linked CLI
transport. Test against the native Fetch adapter with pending and rejected cancellation, not only
a stub HttpClient.

`FetchHttpClient.layer` uses `HttpClient.layerMergedContext`: execution-time services take precedence
when its response effect merges contexts. A Fetch wrapper captured only during Layer construction
can be bypassed by a later `FetchHttpClient.Fetch` override. Resolve and wrap the native Fetch
inside the per-request response transform, as `OutboundHttpLive` does; test different build-time
and execution-time Fetch services against the real adapter. Verify
`node_modules/effect/src/http/HttpClient.ts` and `http/FetchHttpClient.ts`.

Preserve bodyless statuses when reconstructing Web responses: 204, 205 and 304 require a null body,
even when a browser exposes an empty native stream. Cancel/release that native reader first.
`HttpClientResponse.stream` fails with `EmptyBodyError` for a null native body in this release;
a collector must recognize the bodyless status instead of trying to consume that stream. This
does not change the owner's status/refusal policy.

Cancellation policy belongs to the resource owner. The
[MCP SDK reader owner](../apps/server/cloudflare/mcp/internal/native-reader.ts) deliberately joins
SDK cancellation before releasing its resident lease; releasing that lease early would admit new
work while the previous SDK disposal is still active. Do not apply the Fetch cleanup policy to that
settlement guarantee.

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
