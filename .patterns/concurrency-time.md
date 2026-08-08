# Concurrency, scheduling & time

How Effect v4 fibers, queues, schedules, cron, clocks and rate limiting actually work, read
from the source. Citations are `<path>:<line>` relative to `packages/effect/` (citations into
sibling packages are prefixed, e.g. `vitest/src/...` relative to `packages/`).

## Fibers

| Combinator          | Lifetime                                                                 | Cite             |
| ------------------- | ------------------------------------------------------------------------ | ---------------- |
| `Effect.forkChild`  | child of current fiber; **interrupted when the parent exits** (any exit) | `Effect.ts:8546` |
| `Effect.forkScoped` | interrupted when the current `Scope` closes (adds `Scope` to `R`)        | `Effect.ts:8642` |
| `Effect.forkIn`     | interrupted when an explicit scope closes                                | `Effect.ts:8591` |
| `Effect.forkDetach` | daemon: global scope, outlives the parent (v3's `forkDaemon`)            | `Effect.ts:8692` |

v3's bare `Effect.fork` is gone. All variants take
`{ startImmediately?: boolean, uninterruptible?: boolean | "inherit" }`.

**Trap — forked fibers start lazily.** Unless `startImmediately: true`, the child is only
scheduled onto the dispatcher and has executed nothing when the fork returns
(`internal/effect.ts:5096-5101`). A "worker is now listening" assumption right after a fork
is a race; either pass `startImmediately: true` or synchronize with a `Latch`/`Deferred`.

**Trap — parent completion interrupts children.** Auto-supervision is implemented as an
`interruptChildren` middleware run when the parent's exit is set
(`internal/effect.ts:606-611`), so a `forkChild`ed fiber is killed even when the parent
_succeeds_. Use `Effect.awaitAllChildren` (`Effect.ts:8731`) to wait instead, or fork into a
long-lived scope (`forkScoped`/`forkIn` on the server's scope) for background workers.

Joining: `Fiber.join` re-raises the fiber's failure (`Fiber.ts:272`); `Fiber.await` yields
the `Exit` (`Fiber.ts:159`). **No default reporting exists for an unobserved fiber
failure** — a `forkDetach`ed fiber that dies is silent unless you join/await it or hold it in
a `FiberMap`/`FiberSet`/`FiberHandle`, whose `join`/`awaitEmpty` surface the first non-interrupt
failure via an internal deferred (`FiberMap.ts:370-390`, `:993`, `:1025`). `References.UnhandledLogLevel`
only covers pool-finalizer errors (`References.ts:659-683`). Route worker failures explicitly.

Keyed fiber containers: `FiberMap` — one fiber per key, **setting a key interrupts the
previous fiber** unless `onlyIfMissing` (`FiberMap.ts:327-390`); `run(map, key, effect)` forks
and tracks (`:738`). `FiberHandle` is the single-slot version (`FiberHandle.ts:556`).

## Structured concurrency

- `Effect.all(arg, { concurrency?, discard?, mode? })` — `mode: "result"` collects
  per-element `Result`s instead of failing fast (`Effect.ts:514`, options at `:112-114`).
  `Effect.forEach` takes the same `concurrency` (`Effect.ts:773`).
- Racing (losers are always interrupted): `race` = first **success** wins, fails only if both
  fail (`Effect.ts:4827`); `raceFirst` = first **completion** wins, including failure
  (`:4883`); `raceAll` (`:4748`) / `raceAllFirst` (`:4788`) generalize to n.
- `Effect.timeout(d)` fails typed with `Cause.TimeoutError` and interrupts the source
  (`Effect.ts:4494`); `timeoutOption` returns `Option.none` on timeout (`:4553`).
- `Deferred` — one-shot cell: `make/succeed/fail/await` (`Deferred.ts:183`, `:267`).
  `Latch` — reusable gate: `open/close/await/whenOpen/release` (releases current waiters
  without opening) (`Latch.ts:60-96`, `whenOpen` `:372`).

## Queue (v4: one type, typed completion — replaces v3 Queue _and_ Mailbox)

`Queue<A, E>` carries an error channel. Constructors: `Queue.make({ capacity?, strategy? })`
with strategies `"suspend"` (backpressure, default) | `"dropping"` | `"sliding"`
(`Queue.ts:441-448`); shorthands `bounded/dropping/sliding/unbounded` (`:491-599`).

| Termination                    | Buffered messages             | Takers after drain     | Cite                                               |
| ------------------------------ | ----------------------------- | ---------------------- | -------------------------------------------------- |
| `Queue.end` (needs `E ⊇ Done`) | drained first                 | fail with `Cause.Done` | `Queue.ts:982`                                     |
| `Queue.fail(q, e)`             | **drained first**, then error | fail with `e`          | `Queue.ts:854`, test `test/Queue.test.ts:243-258`  |
| `Queue.interrupt`              | drained first                 | interrupted            | `Queue.ts:1077`, test `test/Queue.test.ts:171-194` |
| `Queue.shutdown`               | **discarded immediately**     | resumed immediately    | `Queue.ts:1114-1131`                               |

After any termination, `offer` returns `false` rather than failing (`test/Queue.test.ts:181`).
Batch consumption (the burst-collapse primitives): `takeAll` waits for ≥1 then drains
everything buffered, returning a `NonEmptyArray` (`Queue.ts:1218`); `takeBetween(q, min, max)`
(`:1346`), `takeN` (`:1304`), non-blocking `poll` (`:1434`), `clear` (`:1171`), `collect`
drains until Done (`:1246`). `Stream.fromQueue` (`Stream.ts:1293`) bridges to streams;
`Queue.into` runs an effect's outcome into a queue (`Queue.ts:1769`).

`PubSub` exists separately for broadcast; `RcMap` for keyed ref-counted resources with
`idleTimeToLive` GC (`RcMap.ts:235`, `get` is scoped `:326`, `touch` resets the idle timer
`:594`).

## Per-user serialized turns with debounce (the fidy problem)

What v4 offers, surveyed:

1. **`Semaphore.make(1)` per user** (`Semaphore.ts:329`, `withPermits` `:378`): serializes
   but has no buffering/collapse — a 5-message burst = 5 queued turns. Not sufficient alone.
   **`PartitionedSemaphore` is not this**: it is one _shared_ permit pool with round-robin
   fairness across keys, not per-key mutual exclusion (`PartitionedSemaphore.ts:46-62`).
2. **`Stream.groupByKey` + per-key pipeline**: `groupByKey` demultiplexes into one inner
   stream per key, backed internally by an `RcMap` of `Queue`s (bufferSize 4096, optional
   `idleTimeToLive`) (`Stream.ts:8333`, impl `:8385-8420`). Inner streams process
   sequentially per key while `mapEffect(..., { concurrency: "unbounded" })` runs keys
   concurrently (doc example `:8306-8330`). But **`Stream.debounce` drops earlier elements
   and emits only the latest after the quiet window** (`Stream.ts:7815`, example output
   `[3, 5]` `:7826-7832`) — a burst would lose messages, so you'd need
   `aggregateWithin`-style accumulation instead of `debounce`.
3. **Per-key worker fiber over a per-key `Queue`** (recommended): an
   `RcMap<UserId, Queue<Msg>>` whose lookup acquires a queue _and_ forks a worker in the
   map's scope; the worker loops: `Queue.take` (first message) → `Effect.sleep(debounce)` →
   `Queue.clear` (grab everything else buffered, non-blocking, `Queue.ts:1171`) — repeat the
   sleep/clear while new messages keep landing — then run **one agent turn** with the batch.
   Serialization is structural (one fiber per user, no lock to leak); different users are
   different fibers; `idleTimeToLive` GCs idle users; closing the scope ends all workers.
   This is exactly the shape `groupByImpl` uses internally (`Stream.ts:8385-8420`), minus the
   stream plumbing, and it keeps the debounce-restart decision (new message during sleep
   restarts the window) explicit instead of fighting `debounce`'s latest-only semantics.

For a small per-user concurrency cap on _other_ work (not the serialized turn), a per-user
`Semaphore` or `Effect.forEach(..., { concurrency: n })` suffices; `PartitionedSemaphore`
fits when many users share one global pool fairly (`PartitionedSemaphore.ts:46-60`).

## Rate limiting

v4 ships `RateLimiter` in `effect/unstable/persistence` — a **store-backed service**, not the
v3 in-memory scoped constructor (`unstable/persistence/RateLimiter.ts:1-11`). One `consume`
call per (string) key with per-call config: `{ algorithm?: "fixed-window" | "token-bucket",
onExceeded?: "delay" | "fail", window, limit, key, tokens? }` (`:45-60`). Semantics:

- **fixed-window**: counter per key; refill rate = `window / limit` (`:126-170`).
- **token-bucket**: bucket of `limit` tokens refilled at `window / limit` per token — this is
  the burst-friendly one for "60 req/min with burst" (`:171-227`).
- `onExceeded: "fail"` fails typed with `RateLimiterError` wrapping `RateLimitExceeded
{ key, retryAfter, limit, remaining }` (`:106-118`) — `retryAfter` maps directly onto a 429
  `Retry-After` header. `"delay"` returns the wait instead; `makeWithRateLimiter` wraps an
  effect and sleeps the delay (`:261`), `makeSleep` just sleeps (`:330`).
- Stores: `layerStoreMemory` — **process-local, resets on restart** (`:656-663`) — and Redis
  (Lua-scripted, `:874`, `:1321`). **No SQL store for RateLimiter**; in a single-process
  monolith the memory store is fine for req/min limits, but tight _daily_ caps that must
  survive restarts need Redis or a hand-built Postgres counter.
- Stream-level shaping: `Stream.throttle({ cost, units, duration, burst?, strategy:
"shape" | "enforce" })` is a token bucket holding up to `units + burst`; `"shape"` delays,
  `"enforce"` drops (`Stream.ts:8073-8090`, `:8119`).

Related: `PersistedQueue` (same package) is a durable, schema-encoded work queue with
**in-memory, Redis, and SQL store layers**, id-based de-duplication and retry handling
(`unstable/persistence/PersistedQueue.ts:1-11`, `layerStoreSql` `:1187`) — the primitive to
reach for before hand-rolling a Postgres outbox/scheduler table.

## Schedule

v4's inventory is small (29 exports); v3 names are heavily reshaped:

- Constructors: `exponential(base, factor = 2)` (`Schedule.ts:1270`), `spaced` (`:1823`),
  `fixed` — fixed-_window_: delays to the nearest window boundary, skips missed windows when
  the action overruns (`:1436`, boundary tests `test/Schedule.test.ts:457`, `:484`) —
  `windowed` (`:2090`), `fibonacci` (`:1350`), `recurs(n)` (`:1763`), `forever` (`:2130`),
  `duration` — once, after d (`:1014`), `during` (`:1116`), `cron` (`:969`).
- Composition: **`union`/`intersect` are now `min`/`max`** over arrays of schedules — `max`
  waits for the _slowest_ (use `max([exponential(...), recurs(5)])` for capped backoff,
  `Schedule.ts:794`; `min` `:1174`); `andThen` (`:631`), `addDelay` (`:572`),
  `modifyDelay` (`:1595`), `jittered` — uniform 80%–120% via the `Random` service (`:1645`),
  `passthrough` — output = input (`:1683`), `upTo({ times?, duration? })` bounds recurrence
  (`:1968`), `tap` sees `{ input, output, attempt, elapsed }` metadata (`:1862`, `:121`).
- **`whileInput`/`whileOutput`/`untilX` are gone from Schedule** — predicates moved to the
  drivers: `Effect.retry` accepts `{ while?, until?, times?, schedule? }` (predicates may be
  effectful) or a bare `Schedule` (`Effect.ts:4040`, options `:3980-3987`); same for
  `Effect.repeat` (`:7605`). `retryOrElse`/`repeatOrElse` add a fallback (`:4119`, `:7675`).
  `Effect.schedule` drives a schedule ignoring inputs (`:7804`).
- Retry recurs on _failure_, repeat on _success_ (first run happens before the schedule is
  consulted); a schedule's own error channel (e.g. `CronParseError`) joins the effect's.

## Cron & time zones

`Cron.parse(expr, tz?)` accepts 5 or 6 fields (seconds optional, `test/Schedule.test.ts:269`)
and an optional zone as `DateTime.TimeZone` or IANA/offset string (`Cron.ts:572`,
`test/Cron.test.ts:182-191`); `Result`-typed, with `parseUnsafe` (`:638`) and structural
`Cron.make` (`:355`). `match` (`:678`), `next`/`prev` return JS `Date` instants computed by
interpreting the field values as **wall-clock time in the cron's zone** (`:759`, tz test
`test/Cron.test.ts:302-317`), `sequence` iterates (`:993`). Day-of-month + day-of-week
follow classic cron union/intersection rules, with careful no-overshoot behavior for
nonexistent days (tests `test/Cron.test.ts:319-341`).

`Schedule.cron(expr, tz?)` sleeps until `Cron.next(cron, now)` each step (`Schedule.ts:969-1010`)
— so "Monday 9:00 in America/Bogota" is `Schedule.cron("0 9 * * 1", "America/Bogota")`
driving `Effect.repeat`. Per-user cron rows in Postgres need a hand-built loop, but the
next-occurrence math is `Cron.next(Cron.parseUnsafe(expr, userZone))` — don't reimplement it.

## Clock & DateTime

`Clock` is a `Context.Reference` (fiber ref, `Clock.ts:111`); `Effect.sleep`/`Effect.delay`
(`Effect.ts:4682`, `:4649`) and every Schedule/timeout resolve it per fiber
(`internal/effect.ts:5890-5895`) — which is why `TestClock` works by replacing the reference.
Read time via `Clock.currentTimeMillis` or `DateTime.now` (→ `DateTime.Utc`, `DateTime.ts:838`),
never `Date.now()`. `Effect.sleep(≤0)` = `yieldNow`, `sleep(Infinity)` = `never`
(`internal/effect.ts:5854-5856`).

Zone math for delivery windows: build zones with `zoneMakeNamed(zoneId)` (Option) /
`zoneMakeNamedEffect` / `zoneMakeNamedUnsafe` (`DateTime.ts:1065`, `:1090`, `:1015`);
attach with `setZone`/`setZoneNamed` (`:940`, `:1180`) — this **re-labels the same instant**.
`DateTime.getPart(zoned, "hours")` is zone-adjusted (`:1792`), `getPartUtc` is not (`:1765`).
So the 9am–7pm gate is: `DateTime.now` → `setZoneNamed("America/Bogota")` →
`getPart("hours")` within `[9, 19)`. There is also an ambient `CurrentTimeZone` service with
`withCurrentZoneNamed` (`:2012`) and `setZoneCurrent` (`:1913`).

**Trap — constructing zoned values**: `makeZonedUnsafe(input, { timeZone })` treats the input
as **UTC** and attaches the zone; wall-clock-in-zone input needs `adjustForTimeZone: true`,
with `disambiguation` for DST gaps/repeats (`DateTime.ts:667-680`).

## TestClock

`@effect/vitest`'s `it.effect` provides `TestClock.layer()` + `TestConsole` automatically
(`vitest/src/internal/internal.ts:40-42`); `it.live` does not. Semantics:

- Time starts at epoch 0 and **only moves via `TestClock.adjust`/`setTime`**; sleeps suspend
  until the clock passes them, then run **in order** (`testing/TestClock.ts:445`, `:479`;
  `test/TestClock.test.ts:8`, `:31`). No wall time passes.
- `adjust("2 hours")` runs everything scheduled within the window as it advances — a
  `Schedule.cron`/`spaced` loop fires multiple times during one big adjust
  (`test/Schedule.test.ts:247-330` drive cron entirely by `TestClock.setTime` + adjust).
  `TestClock.adjust(Infinity)` is legal; `Schedule.cron` guards `now = +Infinity` by ending
  the schedule instead of computing `Cron.next(Infinity)` (`Schedule.ts:975-977`,
  `test/Schedule.test.ts:319-331`).
- **Trap**: the sleeping fiber must already be suspended on the clock when you `adjust` —
  fork the worker first (and remember forks are lazy; yield or `startImmediately` before
  adjusting). Sequential `sleep → assert` without a fork deadlocks (the TestClock logs a
  warning after `warningDelay` of live time when a test waits on time without adjusting,
  `testing/TestClock.ts:134-136`, `:239-288`).
- `TestClock.withLive(effect)` escapes to the real clock for wall-time needs (`:513`).
- The test clock only controls the `Clock` service: `Date.now()` in library code escapes it —
  another reason the codebase must go through `Clock`/`DateTime.now`.
