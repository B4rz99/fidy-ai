# HTTP client (v4)

How `effect/unstable/http` should be used for outbound calls. Citations are relative to
`.repos/effect/packages/effect/src/unstable/http/` unless stated otherwise. The canonical upstream
walkthrough is `.repos/effect/ai-docs/src/50_http-client/10_basics.ts`.

## Build one policy-bearing client

`HttpClient.HttpClient` is a value with request preprocessing and response postprocessing. Its
combinators return a transformed client, so construct one provider-specific client in the owning
service Layer rather than repeating base URL, headers, status, retry, and tracing policy at every
call (`HttpClient.ts:583-641`, `:738-825`).

Typical shape:

```ts
const client = (yield * HttpClient.HttpClient).pipe(
  HttpClient.mapRequest(flow(HttpClientRequest.prependUrl(origin), HttpClientRequest.acceptJson))
);
```

Keep credentials inside that private adapter. A generic app-wide client with an authorization
header is an ambient credential and can leak authority to the wrong host.

## Status and body are separate decisions

A transport success returns an `HttpClientResponse` for **any HTTP status**. Add
`HttpClient.filterStatusOk` only when every non-2xx status has the same meaning; it converts the
response into an `HttpClientError.StatusCodeError` (`HttpClient.ts:555-571`;
`HttpClientResponse.ts:196-227`). When status controls domain certainty—as with a provider mutation
whose 4xx proves rejection while a 5xx is ambiguous—match the status before mapping to the domain
error instead of flattening it through `filterStatusOk`.

Use `HttpClientResponse.matchStatus` for an explicit exact/class table
(`HttpClientResponse.ts:151-194`). Decode the selected body with
`HttpClientResponse.schemaBodyJson(Schema, { errors: "all" })`; it parses JSON and decodes the
**JSON codec** of the schema, so transformations such as DateTime are honored
(`HttpIncomingMessage.ts:74-94`). `schemaJson` can decode status + headers + body as one schema when
that whole envelope is the provider contract (`HttpClientResponse.ts:82-115`).

The Web response's `text`/`arrayBuffer` accessors cache the complete body in memory
(`HttpClientResponse.ts:305-356`). That is not a size limit. For hostile or provider-controlled
responses, enforce a declared length and a streamed byte cap before decoding, as the Kapso adapter
does; `Stream.runCollect` is unbounded by definition (`effect/src/Stream.ts:10396-10405`).

## Encode requests through schemas

Preference order:

1. `HttpClientRequest.schemaBodyJson(schema)(value)` — validates and applies the schema's JSON
   codec before constructing the body (`HttpClientRequest.ts:734-760`).
2. `HttpClientRequest.bodyJson(value)` — effectfully catches JSON encoding failure
   (`HttpClientRequest.ts:699-715`).
3. `bodyJsonUnsafe` only for a value already proven JSON-serializable; it may throw and defect
   (`HttpClientRequest.ts:717-731`).

Provider SDK types are not runtime evidence. Decode provider bodies with their owning Schema even
when TypeScript says the response is typed.

## Timeouts, retries, and mutation certainty

`HttpClient.retryTransient` retries transient transport errors **and transient responses** by
default. It can be restricted with `retryOn`, bounded with `times`, and shaped by a `Schedule`
(`HttpClient.ts:896-993`). This convenience is safe for idempotent reads. It is not automatically
safe for provider mutations: a timeout or 5xx may follow provider acceptance, so replay can duplicate
the side effect. For such calls, model `rejected | ambiguous` certainty and retry only evidence that
proves rejection or only when an idempotency key gives the provider-side guarantee.

Always bound retries with both attempts and a backoff/deadline appropriate to the caller. A timeout
interrupts the local request; it does not prove the remote side did nothing.

`HttpClient.withRateLimiter` is new in v4 and can adapt from common rate-limit headers and honor
`Retry-After`, but automatic 429 retries are **unlimited unless `times` is specified**; setting
`disableResponseInspection` does not disable those retries (`HttpClient.ts:994-1118`). It requires a
`RateLimiter` value and is useful for provider admission, not as a replacement for durable product
quotas.

## Redirects and credentials

Redirect following is opt-in through `HttpClient.followRedirects(max)`. It defaults to at most ten,
implements method rewriting for 301/302/303, and removes `authorization`, `proxy-authorization`, and
`cookie` when the origin changes (`HttpClient.ts:1532-1582`). Still validate destinations when a
provider supplies a redirect; automatic credential stripping does not make SSRF or personal-data
egress safe.

## Tracing and secret leakage

The base client creates a `client` span and records `url.full`, `url.path`, `url.query`, method,
origin, status, and permitted request/response headers (`HttpClient.ts:643-713`). Header redaction
defaults cover `authorization`, `cookie`, `set-cookie`, and `x-api-key`, but not arbitrary custom
secret headers (`Headers.ts:453-470`). Therefore:

- never put bearer, pairing, recovery, or other secret material in a URL/query;
- extend `Headers.CurrentRedactedNames` for provider-specific secret header names;
- narrow `HttpClient.TracerHeaderFilter` when even non-secret headers are personal or unnecessary;
- use `HttpClient.TracerDisabledWhen` / `Tracer.DisablePropagation` only as a deliberate boundary,
  not as a substitute for safe attributes (`HttpClient.ts:1591-1618`).

The response and request objects are inspectable and may include decoded bodies when synchronously
available (`HttpIncomingMessage.ts:127-170`). Never log broad HTTP objects; project closed safe
metadata instead.

## Resource and test seams

Interruption aborts ordinary requests; `HttpClient.withScope` instead ties a request controller to
an explicit Scope (`HttpClient.ts:1511-1530`). Consume streams inside the owning scope.

Test a provider adapter by supplying a stub `HttpClient` below the real adapter, returning
`HttpClientResponse.fromWeb(request, new Response(...))`. This preserves request construction,
status policy, body decoding, and error mapping while replacing only transport; see
`testing.md` for the upstream pattern.
