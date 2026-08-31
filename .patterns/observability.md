# Observability (v4)

Effect v4 tracing, logging, and metrics, read from the RC.112 source. Citations are relative to
`.repos/effect/packages/effect/src/`; unstable exporter citations are under
`unstable/observability/`. This document describes the Effect substrate; Fidy's closed telemetry
protocol and Projectors remain the product/security boundary.

## Instrument Work, not implementation depth

`Effect.withSpan("name")` wraps the exact Effect and ends the child span with the workflow's real
`Exit`; `useSpan` exposes the span while preserving the same lifetime, and `withSpanScoped` ends only
when the surrounding Scope closes (`Effect.ts:8250-8375`). This directly matches Fidy's Work rule:
wrap the bounded shell orchestration Effect without changing its success, failure, defect, or
interruption.

A named `Effect.fn("name")` also creates a span every time its returned Effect runs. Unnamed
`Effect.fn` gives the reusable generator/stack-frame boundary without that span, and
`Effect.fnUntraced` removes instrumentation (`Effect.ts:13481-13608`). Do not mechanically name
row decoders, tiny repository helpers, or every nested function: that turns implementation depth
into telemetry volume and obscures the Work boundary.

Span names must be low-cardinality constants. Put bounded coordinates in attributes, never in the
name.

## Attributes are not sanitized

`Effect.annotateCurrentSpan` adds fields to the current span; `annotateSpans` supplies annotations to
all spans created within an Effect (`Effect.ts:7979-8050`). Values are `unknown`: Effect performs no
allowlist, privacy projection, or secret detection. Only pass outputs of the owning Projector.

Safe defaults:

- operation id, closed outcome/reason, retry/attempt, validated status, bounded latency class;
- no UserId, raw provider id, URL, body, free text, Money, credential, or broad domain object;
- bounded low-cardinality dimensions for metrics; high-cardinality values create an unbounded
  series set.

The HTTP client automatically records full URL and query plus filtered headers on outbound spans
(`unstable/http/HttpClient.ts:643-713`). Its default header redaction recognizes only a fixed set
including authorization/cookies/x-api-key (`unstable/http/Headers.ts:453-470`). Configure the header
filter/redaction references and never place Secrets in URLs.

## Propagation controls

`Tracer.DisablePropagation` is a fiber-local `Context.Reference`; the HTTP client also exposes
`TracerDisabledWhen`, `TracerHeaderFilter`, and `TracerPropagationEnabled`
(`Tracer.ts:527-545`; `unstable/http/HttpClient.ts:1591-1618`). Use these at an external trust
boundary when propagating Fidy trace context is not intended. Disabling propagation does not remove
unsafe span attributes already recorded.

`withSpan` builds ordinary parent/child traces. Use links (`Effect.linkSpans`) for causally related
work that is not a child lifetime—for example, durable work consumed later—rather than retaining a
live parent span across persistence (`Effect.ts:8110-8172`). Persist stable safe correlation
coordinates, not Span objects.

## Logging and failure reporting

Structured logging configuration lives in `layers-runtime.md`. `Effect.log*` recognizes a `Cause`
argument and preserves the complete failure/defect/interruption structure for the logger; do not
pre-render it to a lossy string (`errors.md`). Report a failure at one ownership boundary. Lower
layers map or propagate it; the owning worker/request boundary records it once.

Logging a tagged error or broad object is not automatically safe: `Data` errors expose fields in
`toJSON`, and HTTP messages are inspectable. Log closed safe coordinates and the Cause only when its
error chain is known not to contain protected values. Fidy's telemetry adapter must apply its
Projectors before provider egress.

`ErrorReporter` is the runtime cause-reporting seam; errors can opt out with
`[ErrorReporter.ignore]`, while runMain separately reports an unhandled root cause unless disabled
(`ErrorReporter.ts:1-12`; `layers-runtime.md`). Do not install parallel reporters that count the
same failure twice.

## Metrics

Effect metrics are typed values backed by the current `MetricRegistry`: counters, gauges,
frequencies, histograms, summaries, and duration timers (`Metric.ts:1-90`, constructors around
`:2091-2564`). Update with `Metric.update`; read with `Metric.value`; `Metric.snapshot` returns the
current registry's complete state (`Metric.ts:2591-2720`, `:2938-2942`).

Metrics are process memory unless an exporter reads them. Defining a metric does not itself publish
anything. `Metric.enableRuntimeMetricsLayer` enables runtime/fiber measurements; opt in only when
the exporter and cardinality/cost are understood (`Metric.ts:3374-3444`).

Rules:

- create metric definitions once at module scope, not dynamically per request;
- ids and attribute keys are constants;
- attribute values come from closed bounded sets (operation, outcome, status class), never User or
  provider identifiers;
- use a timer/histogram for latency distributions, a counter for cumulative events, and a gauge for
  current level; do not emulate one with another;
- metrics observe the same bounded Work as spans rather than every helper call.

## Exporters and adapters

V4 includes first-party OTLP tracer, logger, metrics, resource, and serialization layers under
`effect/unstable/observability`; the canonical composition is
`.repos/effect/ai-docs/src/08_observability/20_otlp-tracing.ts:1-73`. They are useful when OTLP is
the approved egress. Their existence does **not** supersede Fidy's Sentry adapter, closed protocol,
or security projection rules.

A custom backend implements/provides `Tracer.Tracer`; `Tracer.make` is only the constructor for that
low-level interface (`Tracer.ts:437-455`, service at `:607-637`). Keep one app-wide backend Layer so
span ownership, sampling, flush, and shutdown remain coherent.

## Testing

Test Work instrumentation at the public orchestration seam:

- provide a recording `Tracer.make({ span })` or the project's recording Telemetry adapter;
- assert span name, safe projected coordinates, and the exact terminal outcome;
- test success, typed failure, defect, and interruption when the Work wrapper promises transparency;
- test that forbidden values are absent from the serialized exporter envelope, not merely absent
  from one API call;
- close the Layer Scope and assert exporter flush/finalization where shutdown delivery matters.

Do not snapshot broad telemetry objects. Assert the closed protocol fields and explicit absence of
Secrets/personal data.
