# Streams & incremental encoding (v4)

How to use stable `Stream` and `effect/unstable/encoding` without accidentally buffering hostile or
unbounded input. Citations are relative to `.repos/effect/packages/effect/src/`.

## Reach for Stream only when incrementality matters

Use a plain `Effect<ReadonlyArray<A>>` for a small bounded collection already in memory. Use
`Stream<A, E, R>` when production/consumption is incremental, backpressure or cancellation matters,
the source owns a resource, or the total input should not be materialized.

A Stream is a description until run. Common terminal operations:

- `runDrain` executes effects and discards values (`Stream.ts:10776`);
- `runForEach` processes each element incrementally (`Stream.ts:10648-10676`);
- `runFold` / `runFoldEffect` retain only the accumulator (`Stream.ts:10474-10568`);
- `runHead` stops after the first element (`Stream.ts:10570-10593`);
- `runCollect` appends every element to one Array and is therefore safe only after a proven bound
  (`Stream.ts:10396-10405`).

`Stream.take(n)` bounds the **number of elements**, not bytes. For a stream of arbitrary-size byte
chunks, track cumulative byte length in the fold and fail before materializing beyond the contract.
A `Content-Length` check is an early rejection optimization, never proof: the body may omit or lie
about it.

## Resource lifetime and cancellation

Stream runners manage an internal Scope (`Stream.run` uses `Effect.scopedWith`,
`Stream.ts:10365-10392`). Constructors backed by files, HTTP bodies, sockets, readers, or custom
resources must release those resources on completion, failure, or interruption. Use the provided
scoped constructor or `Stream.ensuring`; do not acquire a reader outside the Stream and hope every
consumer remembers to cancel it.

`Stream.toPull` exposes a scoped pull and therefore adds `Scope` to requirements; the pull fails with
`Cause.Done` at normal end (`Stream.ts:10778-10810`). Use it only when a library boundary genuinely
requires manual pull control.

Web conversion is available through `fromReadableStream` and `toReadableStream*`
(`Stream.ts:1242`, `:10922-11072`). Map foreign reader failures into a closed adapter error and make
sure cancellation releases the reader/body.

## Effectful mapping and concurrency

`Stream.mapEffect` accepts `{ concurrency, bufferSize, unordered }` (`Stream.ts:1821` onward).
Sequential is the safe default for ordered or side-effectful work. Set finite concurrency from the
external capacity being protected. `"unbounded"` is only valid for an already-small proven-bounded
input; it is not a performance default.

Buffering decouples producer and consumer but moves the memory bound. Every `buffer`, queue, grouping,
or concurrent mapper needs a capacity decision derived from input limits and downstream latency.

For keyed work, `groupByKey` creates per-key streams and supports idle lifetime
(`Stream.ts:8143` onward). It is not automatically a per-key domain transaction or authorization
boundary. Keep stable User identity explicit and bound the number of live keys.

## NDJSON and Msgpack

V4's incremental codecs live in `effect/unstable/encoding`:

- `Ndjson.decodeString` / `decode` split text/bytes into parsed JSON values;
- `Ndjson.decodeSchemaString(schema)()` / `decodeSchema(schema)()` additionally decode every value
  through the Schema;
- matching `encodeSchemaString` / `encodeSchema` apply the schema's encoded representation before
  serialization (`unstable/encoding/Ndjson.ts:65-280`).

Compose them with `Stream.pipeThroughChannel`; the canonical examples are
`.repos/effect/ai-docs/src/03_stream/30_encoding.ts`.

A typed decoder proves each record's shape but does not bound line length, record count, or total
bytes. Apply transport/parser limits before or together with decoding. `ignoreEmptyLines` changes
syntax acceptance only; it is not validation.

## Error ownership

Keep transport/read errors, framing errors (`NdjsonError`), and schema errors distinct until the
adapter can map them into the owning domain failure. Catching every stream failure as one generic
error too early loses whether input was malformed, capacity was exceeded, or I/O was interrupted.
Never catch interruption as malformed input.

For provider responses, expose only a safe closed error and discard the raw body after bounded
validation. For ingestion, preserve the allowed evidence separately according to retention policy;
a Stream pipeline is not itself a retention control.
