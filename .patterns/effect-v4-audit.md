# Effect v4 pattern audit — RC.112

Source of truth: checked-in `.repos/effect` at the repository's installed `effect@4.0.0-rc.112`.
This report compares the existing `.patterns/` set, current application usage,
Effect's migration notes, ai-docs, implementation, and tests.

## Outcome

The existing patterns were unusually strong in the hardest areas: Schema, HttpApi, SQL, AI,
Layers/runtime, errors, concurrency/time, testing, and Effect Atom. I found no basis for replacing
those designs with Cluster, Workflow, RPC, EventLog, STM, or persistence abstractions merely because
v4 exports them. They do not fit the current single-process/Postgres/canonical-HttpApi architecture,
and adopting an unstable subsystem without a concrete ownership problem would add a second system
rather than deepen the existing one.

The material gaps were stable-core interop/resources, outbound HTTP policy, observability semantics,
and incremental Streams. They are now captured in:

- `.patterns/effect-core.md`
- `.patterns/http-client.md`
- `.patterns/observability.md`
- `.patterns/streams.md`

`layers-runtime.md` now includes the new stable `LayerRef`, and `effect-atom.md` no longer claims it
was checked only against beta.98.

## Important source conflict resolved

Effect's `migration/yieldable.md` says `Option` and `Result` can be yielded from `Effect.gen`. That is
not true in RC.112. Their iterator contracts are for `Option.gen` / `Result.gen`
(`packages/effect/src/Option.ts:75-105`; `Result.ts:95-128`), while `Effect.gen` expects Effect's
iterator (`Effect.ts:117-120`, `:245-249`). A runtime probe against the installed package fails with
“Not a valid effect: some(1)”.

Therefore the pre-existing guidance in `.patterns/errors.md`—lift with `Effect.fromOption` /
`Effect.fromResult`—was correct. The new core pattern records this explicitly. This is also evidence
that migration prose must be verified against the exact checked-out implementation.

## Concrete application review candidates

These are not changes made by this audit. They are bounded follow-up candidates where current code
can violate the newly documented rules.

### 1. `Effect.promise` wraps Promises that can reject

`Effect.promise` requires a Promise guaranteed not to reject; rejection becomes a defect
(`packages/effect/src/Effect.ts:858-900`). Clipboard reads/writes can reject for permission, document
focus, or browser-policy reasons, yet production web code wraps them with `Effect.promise`:

- `apps/web/src/features/pats/feature.tsx:105-116`
- `apps/web/src/features/recovery/feature.tsx:133`

Several paths then apply `Effect.ignore`, which handles the typed error channel but does not turn a
defect into an expected UI outcome. These should use `Effect.tryPromise({ try, catch })` with the
feature's deliberate failure behavior. The same review should be applied to any SDK Promise whose
contract can reject; known shutdown/flush calls may deliberately defect only if process failure is
the intended contract.

### 2. Named `Effect.fn` is pervasive and every call creates a span

There are roughly 599 named `Effect.fn("...")` definitions under `apps/server/src`. RC.112 states
that the named form creates a tracing span when run, while unnamed `Effect.fn` and
`Effect.fnUntraced` avoid that behavior (`packages/effect/src/Effect.ts:13481-13608`). Examples
include row decoders and private repository helpers, not only external Work boundaries.

This is not automatically wrong—upstream itself recommends named service methods—but it conflicts
with Fidy's review rule to instrument bounded external Work at the shell orchestration boundary if
applied mechanically. Review high-frequency private helpers and switch those that need only a
reusable generator/stack frame to unnamed `Effect.fn` or `fnUntraced`. Keep named spans where the
latency/failure unit is operationally meaningful.

### 3. Some production ingestion code bypasses the Effect `Crypto` seam

Four ingestion modules import `randomUUID`, `randomBytes`, and/or `createHash` directly from
`node:crypto`:

- `apps/server/src/shell/ingestion/worker.ts:1,88`
- `apps/server/src/shell/ingestion/mutations.ts:1,59,234`
- `apps/server/src/shell/ingestion/email-worker.ts:2,78,223,242`
- `apps/server/src/shell/ingestion/email-anonymization-approval.ts:1,58`

Effect v4's platform-independent `Crypto` service supplies secure bytes, SHA digests, UUIDv4, and
clock-aware UUIDv7 (`packages/effect/src/Crypto.ts:1-163`). Most of the rest of the server already
uses it. Moving these shell operations to `Crypto.Crypto` would make cancellation/error behavior and
test substitution consistent. This is a testability/consistency opportunity, not evidence that
Node's cryptography is insecure.

### 4. Outbound HTTP tracing needs explicit leakage review

The v4 base HttpClient automatically records `url.full`, `url.query`, and request/response headers
allowed by its filter (`packages/effect/src/unstable/http/HttpClient.ts:643-713`). Default header
redaction covers authorization/cookies/x-api-key, not arbitrary provider credential headers
(`Headers.ts:453-470`). Existing Fidy adapters carefully project telemetry, but every new raw
HttpClient integration must ensure no Secret enters URLs and must configure provider-specific
redaction/filter policy. This requirement was absent from `.patterns/` and is now explicit in
`http-client.md` and `observability.md`.

### 5. Full-body response helpers are not resource limits

`HttpClientResponse.text` and `arrayBuffer` cache the complete Web response body
(`packages/effect/src/unstable/http/HttpClientResponse.ts:305-356`), while `Stream.runCollect`
materializes all elements (`packages/effect/src/Stream.ts:10396-10405`). Existing Kapso code already
uses an incremental byte cap, which is the right pattern. New provider adapters should copy the
bounded principle rather than decode unbounded `.json`/`.text` merely because a Schema follows.

## Useful v4 additions, with adoption criteria

### `LayerRef`

`LayerRef` lazily builds and reference-counts a Layer context, supports idle retention, scheduled
invalidation, and explicit refresh (`packages/effect/src/LayerRef.ts:1-191`). Use it for a genuinely
refreshable scoped resource. Do not use it for domain state or immediate credential revocation;
active borrowers survive invalidation until their Scope closes (`LayerRef.ts:74-131`). Added to
`layers-runtime.md`.

### `HttpClient.withRateLimiter`

The transformed client can use Effect's persistence RateLimiter, inspect provider headers, honor
`Retry-After`, and adapt its local limit (`packages/effect/src/unstable/http/HttpClient.ts:994-1210`).
The trap is significant: 429 retries are unlimited unless `times` is set. Adopt only with an
explicit finite attempt/deadline policy and never as a substitute for durable product quota.

### `Effect.acquireDisposable`

This v4 constructor scopes JavaScript `Disposable` / `AsyncDisposable` values directly
(`packages/effect/src/Effect.ts:6586-6649`). It is preferable to hand-written finalizers when a
foreign library implements the standard protocol. Added to `effect-core.md`.

### First-party incremental codecs

`effect/unstable/encoding` supplies schema-aware NDJSON and Msgpack Channels, composed with
`Stream.pipeThroughChannel` (`packages/effect/src/unstable/encoding/Ndjson.ts:65-280`; canonical
examples in `ai-docs/src/03_stream/30_encoding.ts`). These are useful for future large ingestion or
export boundaries, but schema validation still does not bound line length, item count, or total
bytes. Added to `streams.md`.

### OTLP observability layers

V4 now contains OTLP tracer/logger/metrics/serialization Layers; see
`ai-docs/src/08_observability/20_otlp-tracing.ts:1-73`. They are a valid backend option but do not
replace Fidy's closed telemetry protocol, Projectors, or approved Sentry egress. Added to
`observability.md` as an option rather than a migration recommendation.

## Available by trigger, not architectural defaults

Effect provides these specialized primitives for concrete requirements; it does not require every
application to put them beneath ordinary Work. They remain available when their adoption trigger
appears:

| Primitive                       | Adoption trigger                                                                                | Current ownership decision                                                                                                                                                                                        |
| ------------------------------- | ----------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Workflow                        | Work must durably suspend and resume across process restarts                                    | PostgreSQL queues, leases, and state transitions currently own durable coordination; adopting Workflow requires an explicit replacement or boundary rather than two retry/state authorities                       |
| Cluster                         | execution ownership must route, shard, or fail over across processes                            | the deployment is single-process; distributed entity placement would add semantics without a current consumer                                                                                                     |
| EventLog                        | append/replay and projection rebuilding are part of the source-of-truth model                   | relational state is canonical; selected audit evidence does not by itself require event sourcing                                                                                                                  |
| RPC                             | a distinct Effect-to-Effect process boundary benefits from RPC transport or streaming semantics | HttpApi owns canonical public operation derivation; RPC is appropriate only for a separate boundary rather than a duplicate operation declaration                                                                 |
| RequestResolver                 | independent requests can be safely deduplicated, grouped, or batched by the backend             | SQL joins/bulk queries and `SqlResolver` own current SQL batching; use a generic resolver when a concrete external lookup exposes useful batch semantics (`packages/effect/src/RequestResolver.ts:1-52`)          |
| `Effect.tx` + `Tx*` collections | multiple process-local references must preserve one atomic invariant                            | PostgreSQL transactions own durable invariants and Ref/Queue/Semaphore cover current local coordination; v4 removed the distinct STM type in favor of transactional Effects (`migration/v3-to-v4.md:12958-13016`) |
| Cache                           | key isolation, freshness, failure caching, capacity, and invalidation are explicit              | no generic cache policy may infer User isolation or revocation; Effect supplies bounded TTL and shared in-flight lookup mechanics, not those product decisions (`packages/effect/src/Cache.ts:1-24`)              |
| ScopedCache                     | keyed cached values own scoped resources with explicit eviction behavior                        | adopt when a bounded keyed resource contract exists                                                                                                                                                               |
| Resource                        | one scoped value requires manual or scheduled refresh                                           | adopt when refresh, stale-value, failed-refresh, and replacement-cleanup semantics are explicit (`packages/effect/src/Resource.ts:1-28`)                                                                          |

Workflow, Cluster, and EventLog are not inherently incompatible with PostgreSQL or a single-process
starting point. Their semantics overlap current ownership decisions, so adopting one requires a
specific problem and a decision about which mechanism becomes authoritative.

## Verification performed

- Read every pre-existing Effect pattern file.
- Compared the installed package version and Effect checkout (`4.0.0-rc.112`).
- Read all focused migration notes and relevant ai-docs for HTTP client, batching, streams, and
  observability.
- Checked current source for Option/Result generator behavior, Effect function tracing,
  Promise interop, resource constructors, LayerRef, HTTP retry/rate-limit/tracing semantics,
  metrics, Crypto, and response buffering.
- Searched current application usage for Effect imports, Promise bridges, named `Effect.fn`,
  outbound HTTP policy, ambient time, and direct platform cryptography.

Unresolved: the four application review candidates above need focused code changes and tests if the
team wants them remediated; this audit intentionally changed only agent patterns.
