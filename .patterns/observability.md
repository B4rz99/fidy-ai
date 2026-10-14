# Effect v4 observability at the Cloudflare boundary

Import from `effect`. Selected Effect 4.0.2 sources: `node_modules/effect/src/{Effect,Tracer,Logger,Metric,ErrorReporter}.ts`.

Telemetry is a closed, provider-neutral metadata contract. Cloudflare logs, traces, metrics, and
alerts are adapters; core and domain code do not import an observability SDK.

## Work boundaries

Name meaningful work with named `Effect.fn("operation")` or `Effect.withSpan` at the Worker, canonical operation,
Queue/Workflow activity, provider adapter, and parser boundaries. Use stable low-cardinality names.
Expected domain decisions are outcomes, not defects; classify provider failures, defects, interruption,
and resource exhaustion separately.

Propagation across Fidy-controlled Worker/service boundaries is explicit and bounded. Queue and
Workflow payloads may carry a schema-versioned trace correlation id only when the platform adapter
requires it. Public provider callbacks begin a new local trace unless a trusted Fidy boundary proves
continuation. Do not send Fidy trace headers to Kapso, Wompi, outbound Resend, or Workers AI unless an
approved provider contract requires it.

## Metadata-only policy

Allowed attributes are coarse operation/provider names, safe status classes, bounded latency, retry
count, resource-limit class, and model token counts when the Workers AI adapter exposes them. Never
attach UserId, email, phone, account/card values, transaction facts, raw errors, request/response
bodies, prompts, replies, tool inputs/results, credentials, URLs with query data, or provider payloads.

Errors are mapped to safe categories before telemetry. Redaction is not a substitute for an allowlist:
construct envelopes from approved fields rather than copying broad objects and deleting known secrets.
Metrics labels must remain low-cardinality and must not contain user or provider identifiers.

## Logger and metric recipe

`Logger.make` receives arbitrary messages, causes, annotations and span context. Decode/project
allowed fields before writing to the sink; formatting with `Logger.formatJson` alone is not
sanitization. `Logger.layer([safeLogger])` replaces current loggers. Setting
`mergeWithExisting: true` retains them and can preserve an unsafe console/export path, so replacement
is the default choice for Fidy assembly. Inspect `Logger.CurrentLoggers` in composition tests.

This minimal metric recipe accepts an already-measured latency and a closed outcome, never raw
request/error objects. The adapter's deadline determines the real maximum; the clamp bounds the
recorded value, not execution time.

```ts
import { Effect, Metric } from "effect";

const outcomes = Metric.counter("provider_requests");
const latency = Metric.histogram("provider_duration_ms", {
  boundaries: [10, 50, 100, 500, 1000, 5000, 15000],
});

const record = (outcome: "success" | "unavailable", elapsedMs: number) =>
  Effect.gen(function* () {
    yield* Metric.update(Metric.withAttributes(outcomes, { outcome }), 1);
    if (Number.isFinite(elapsedMs)) {
      yield* Metric.update(latency, Math.min(15000, Math.max(0, elapsedMs)));
    }
  });
```

Measure around owned work with `Effect.timed` when recording successful completion; recording all
outcomes also needs a failure/interruption path with its safe classification. Never invent a success
sample for interrupted work. `Metric.withAttributes` creates a series for each attribute combination;
closed enums and stable metric names keep the number of series bounded. Metrics live in a registry;
constructing them does not install a Cloudflare exporter.

`Logger.batched` starts scoped periodic flush work and flushes remaining entries at scope closure.
Its time window does not impose a queue-size cap. A production sink needs bounded buffering,
a bounded shutdown flush and an explicit drop/failure policy; keep it below the metadata contract.
Do not depend on work outliving a Worker request without the platform's owned lifetime mechanism.
For HTTP span versus header propagation controls, read [HTTP telemetry](http-client.md#redirects-and-telemetry).

## Adapter and tests

The telemetry adapter receives the closed contract and fails safely if the Cloudflare sink is absent.
It must not change domain outcomes or provide persistence, retry, or authorization. Portable tests prove
projection, redaction, cardinality, and expected-outcome classification. Cloudflare adapter tests prove
metadata bounds, propagation policy, flush/shutdown behavior, and absence of personal content.

Test the metric recipe with `Effect.provideService(Metric.MetricRegistry, new Map())` and inspect
`Metric.value` for counts and histogram observations. Substitute an in-memory `Logger.make` sink,
assert the complete emitted allowlist and logger replacement, then close the scope to test final
flush. Verify timeouts and sink failure do not change the canonical operation's result.
