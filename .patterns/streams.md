# Streams & incremental encoding (v4)

Sources: `node_modules/effect/src/Stream.ts`, `Channel.ts`, and `encoding/Ndjson.ts` under the same
source directory. Import `Stream` from `effect` and `Ndjson` from `effect/encoding`.

## Incrementality must earn its complexity

Use `Effect<ReadonlyArray<A>>` for a small bounded collection already in memory. Use Stream when
production/consumption is incremental, backpressure or cancellation matters, or the source owns a
resource. A Stream does nothing until run.

`runForEach` processes incrementally; `runFold` / `runFoldEffect` retain an accumulator; `runDrain`
discards values; `runHead` stops after the first. `runCollect` materializes everything and therefore
requires a proven bound. `take(n)` limits elements, not bytes: arbitrary-size chunks still require
cumulative byte accounting before allocation. Content-Length is an early check, never proof.

## Ownership and concurrency

Runners manage a Scope. Resource-backed constructors must release readers/files/bodies on completion,
failure, and interruption. Use scoped acquisition and finalizers rather than hoping every consumer
remembers cleanup. `toPull` exposes a scoped pull whose normal end uses `Cause.Done`; reserve manual
pull control for boundaries that genuinely require it.

`fromReadableStream` and `toReadableStream*` bridge Web streams. Map foreign failures to the owning
closed error set and verify cancellation releases the reader/body.

`mapEffect` is sequential by default, supports finite `concurrency`, and preserves input order unless
`unordered: true`. It has no `bufferSize` option. Each queue, buffer, grouping, and concurrent mapper
needs its own capacity decision. `groupByKey` can organize process-local work but cannot provide
per-User durable serialization, transactions, or authorization.

## NDJSON

`Ndjson.decode` / `decodeString` frame and parse records; `decodeSchema` / `decodeSchemaString`
add schema decoding. Corresponding `encodeSchema*` APIs apply the schema's encoded representation.
Compose channels with `Stream.pipeThroughChannel`.

Typed records do not bound line length, record count, or total bytes. Apply those limits at the
transport/parser boundary. `ignoreEmptyLines` changes syntax acceptance, not validation or limits.
Msgpack is not an export of the selected encoding namespace; do not restore old examples.

Keep read failures, framing errors, and schema errors distinct until mapping to the owner's safe
failure. Preserve interruption. A Stream pipeline does not implement retention: discard provider
bodies after bounded validation and retain ingestion evidence only through its existing owner.
