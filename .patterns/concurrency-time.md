# Concurrency, scheduling & time (v4)

Selected source root: `node_modules/effect/src/`. Inspect the named APIs in `Effect.ts`, `Fiber.ts`,
`Ref.ts`, `Queue.ts`, `Schedule.ts`, `Cron.ts`, `DateTime.ts`, and `persistence/RateLimiter.ts`.
These are library mechanics, not replacements for Fidy's durable Cloudflare authorities.

## Fiber lifetime and failures

| Primitive           | Owner                                                   |
| ------------------- | ------------------------------------------------------- |
| `Effect.forkChild`  | Parent fiber; interrupted even when the parent succeeds |
| `Effect.forkScoped` | Current Scope                                           |
| `Effect.forkIn`     | Explicit Scope                                          |
| `Effect.forkDetach` | Detached from parent lifetime                           |

Forks are scheduled lazily unless `startImmediately` is requested. Starting immediately still does
not prove asynchronous initialization completed: use `Deferred` or `Latch` for readiness.
`Effect.awaitAllChildren` makes parent completion wait for children. `Fiber.join` re-raises failure;
`Fiber.await` returns the Exit. Observe worker failure explicitly rather than assuming a detached
fiber reports itself. Scoped `FiberMap` / `FiberHandle` provide keyed/single-slot ownership;
replacement normally interrupts the prior fiber.

Use finite concurrency with `Effect.all` / `forEach` based on the capacity being protected.
`race` selects the first success; `raceFirst` selects the first completion, including failure.
Losers are interrupted. `timeout` adds a typed timeout and interrupts local work; it does not prove
an external mutation was rejected.

## Volatile state and bounded buffers

`Ref` is process-local atomic state. Use one `modify`/`update` operation for read-modify-write, not
separate `get` and `set`. Its callbacks are synchronous decisions, not places to launch effects.
An effectful critical section can use a Semaphore, which is also only process-local.

`Queue<A, E>` has typed completion. Choose bounded capacity and a deliberate overflow policy:
`suspend` backpressures, `dropping` refuses new items, and `sliding` discards old ones.
`end`, `fail`, and `interrupt` drain buffered items before the terminal outcome; `shutdown`
discards buffered items immediately. `flush` releases waiting takers without terminating the queue.
`takeAll` waits for at least one item, whereas `clear` takes the current buffer without waiting.
Use PubSub when every subscriber needs the event rather than competing consumers.

`Stream.debounce` retains only the latest element; it is unsuitable for accumulating every message
in a burst. `PartitionedSemaphore` shares one permit pool fairly across keys; it is not one mutex
per User. Ref, Queue, RcMap, and keyed streams cannot supply durable per-User serialization.

Fidy's per-User coordination belongs to its Durable Object boundary, with committed state in D1
and asynchronous delivery through Queues/Workflows. Extend those owners for turn batching, retry,
or admission. A process-local worker loop is appropriate only for explicitly volatile work.

## Rate limiting

Import `RateLimiter` from `effect/persistence`. It is store-backed, with `consume` configurations
for `fixed-window` or `token-bucket` and `onExceeded: "delay" | "fail"`. Check the store algorithm,
not its name, against the product requirement: the fixed-window implementation's expiry accounting
is not a sliding log or a promise of at most N requests in every rolling window.

`adaptiveConsume` / `adaptiveFeedback` support provider feedback; preserve the returned epoch so
stale responses cannot update newer state. `HttpClient.withRateLimiter` can use this policy but has
unlimited 429 retries unless `times` is supplied. See [HTTP clients](http-client.md).

`layerStoreMemory` resets on restart. It is not Fidy's admission/quota authority. Existing
Cloudflare admission owners and their platform tests establish joint-key accounting, rejection,
expiry, and replacement recovery; the library's memory store proves none of those guarantees.

## Schedules and clock

Use `Schedule.exponential`, `spaced`, or `recurs` as appropriate, with bounded attempts and elapsed
time. `Schedule.max` / `min` combine arrays of schedules; `upTo` bounds recurrence. Retry drives on
failure, repeat on success, with predicates on `Effect.retry` / `repeat`. A Schedule controls one
running Effect; it is not a durable scheduler.

`Cron.parse(expression, zone)` returns Result; `Cron.next` calculates the next instant using that
zone's wall-clock fields. Use that calculation within the existing scheduling owner rather than
implementing calendar arithmetic or introducing a polling runtime.

Read time through `Clock.currentTimeMillis` or `DateTime.now`. Applying a zone with `setZone` changes
the wall-clock view of the same instant. Constructing local wall-clock input with `makeZonedUnsafe`
requires `adjustForTimeZone: true` and a deliberate DST disambiguation policy.

`it.effect` supplies TestClock. Fork the sleeping work and synchronize readiness before advancing
with `TestClock.adjust` / `setTime`; sleeping and then adjusting in the same fiber deadlocks.
TestClock controls Effect's Clock, not `Date.now()` or arbitrary foreign timers. Use a live test only
for the platform behavior being measured.
