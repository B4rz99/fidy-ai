# Testing

How `@effect/vitest` (4.0.0-beta) and `effect/testing` actually work, read from the source.
Citations are `<path>:<line>` relative to `.repos/effect/`. The vitest package is one file pair —
`packages/vitest/src/index.ts` (types) + `packages/vitest/src/internal/internal.ts` (all logic) —
so every behavioral claim below is checkable in ~600 lines. Canonical walkthroughs:
`ai-docs/src/09_testing/10_effect-tests.ts` and `20_layer-tests.ts`.

## API surface

`import { assert, describe, expect, it, layer } from "@effect/vitest"` — the package re-exports
all of vitest (`packages/vitest/src/index.ts:16`) and overlays Effect-aware methods on `it` via a
Proxy (`internal.ts:55-70`), so plain `it(...)`, `describe`, `expect`, chai-style `assert` still work.

| Method                                     | Runs the Effect with                                            | Services provided                                                                      |
| ------------------------------------------ | --------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| `it.effect(name, () => Effect, timeout?)`  | `Effect.scoped` + `Effect.provide(TestEnv)` (`internal.ts:357`) | `Scope` + **fresh `TestClock` + `TestConsole` per test** (`TestEnv`, `internal.ts:42`) |
| `it.live(...)`                             | `Effect.scoped` only (`internal.ts:358`)                        | `Scope`; live Clock/Console                                                            |
| `it.layer(L, opts?)("suite", (it) => ...)` | per-block shared context, see below                             | `Scope` + L + TestEnv (unless `excludeTestServices`)                                   |
| `it.effect.prop(name, arbs, f, opts?)`     | property test, effectful body                                   | same as `it.effect`                                                                    |
| `it.prop(name, arbs, f)`                   | **sync** property test, plain function                          | none                                                                                   |

- **There is no `it.scoped` in v4** — `it.effect` and `it.live` already provide `Scope` and run
  `Effect.scoped` per test (`index.ts:101`, `internal.ts:357-358`), so `Effect.addFinalizer` /
  `acquireRelease` finalize at test end. v3 muscle memory (`it.scoped`, `it.scopedLive`) has no target.
- Variants on every tester: `skip`, `skipIf(cond)`, `runIf(cond)`, `only`, `each(cases)`, `fails`
  (`index.ts:55-63`, `internal.ts:104-124`). `timeout` is a number or full vitest `TestOptions`
  (`internal.ts:50`); vitest's default 5s applies — usually fine because TestClock sleeps consume no
  wall time.
- On failure, the runner pretty-prints every error in the Cause via `Cause.prettyErrors` +
  `Effect.logError` before rejecting with the Exit (`internal.ts:22-34`), so typed failures and
  defects both render with stack/spans.
- `flakyTest(effect, timeout?)` retries up to 10 times within a wall-clock budget (default 30s) and
  dies on exhaustion (`internal.ts:332-352`). Used in the repo for real-network tests only.

## it.layer — the seam-1 backbone

`layer(L, options?)(name?, (it) => ...)` builds `L` **once per block** and provides it to every
`it.effect` inside (`internal.ts:214-329`). Fine print:

- **TestEnv is merged into the layer itself**: `Layer.provideMerge(layer_, TestEnv)`
  (`internal.ts:239-241`) — layer construction _and_ all tests in the block see the same TestClock/
  TestConsole instance. `excludeTestServices: true` skips this, giving the block a live clock
  (`packages/vitest/test/index.test.ts:181-188`).
- **Build is lazy and cached**: `Layer.buildWithMemoMap(...).pipe(Effect.orDie, Effect.cached)`
  (`internal.ts:244-248`). Named blocks wrap in `describe` with `beforeAll` (build) / `afterAll`
  (close scope) (`internal.ts:318-328`). Unnamed blocks (`layer(L)((it) => ...)`) instead refcount
  the block's tests and close the scope **as soon as the last test in the block finishes**
  (`internal.ts:288-315`).
- **Memoization scope**: each `layer(...)` call makes its own `MemoMap` unless you pass one
  (`internal.ts:242`), so two _sibling_ `it.layer(SameLayer)` blocks build **two instances**
  (proven by `packages/vitest/test/isolation.test.ts` — three blocks, three State ids). Nested
  `it.layer` **forks** the parent MemoMap (`Layer.forkMemoMapUnsafe`, `internal.ts:271-279`):
  parent-built layers are reused, layers first built inside the fork are not shared back — sibling
  nested blocks each get a fresh child while sharing the parent
  (`packages/vitest/test/nested-isolation.test.ts:29-62`). MemoMap entries are refcounted
  (`Layer.ts:233,390-395`), released when the last observer scope closes.
- **To share one expensive layer across sibling blocks in a file**, pass a shared map:
  `const memoMap = Effect.runSync(Layer.makeMemoMap)` then `it.layer(L, { memoMap })`
  (`index.ts:147-151`). **Across files there is no sharing** — vitest isolates files; the repo pays
  one testcontainer per file (see Real infra).
- The `timeout` option is the **hook** timeout (layer build/teardown), converted via
  `Duration` (`internal.ts:52-53`); pg suites use `{ timeout: "30 seconds" }` for container startup
  (`packages/sql/pg/test/Client.test.ts:14`).
- Composition for a seam: build one layer graph (e.g. real-Postgres client + stubbed LLM
  `HttpClient`) with ordinary `Layer.provide`/`mergeAll` _before_ handing it to `it.layer` — the
  block sees the finished context. The repo's shape for "repo + test store": a `Context.Service`
  test layer over a `Ref` (`ai-docs/src/09_testing/20_layer-tests.ts:17-46`).

**Trap — one TestClock per block.** Because the context is cached per block, all tests in an
`it.layer` block share TestClock state: time adjusted in test 1 is where test 2 starts. The repo's
root config runs tests **concurrently within a file** (`vitest.shared.ts:36`), which makes
clock-adjusting tests in a shared block race each other (the effect package itself opts out with
`vitest --sequence.concurrent=false`, `packages/effect/package.json:101`). Keep clock-driving tests
in plain `it.effect` (fresh clock per test) or run the suite sequentially.

## TestClock

Module: `effect/testing/TestClock` (`packages/effect/src/testing/TestClock.ts`). It **is** the
`Clock` service — `TestClock.layer()` provides `Clock.Clock` (`TestClock.ts:379-382`), and `Clock`
is a `Context.Reference` with a live default (`Clock.ts:111`). Everything that goes through the
Clock service is controlled: `Effect.sleep`/`delay`, `Effect.timeout`, `Schedule` (incl.
`Schedule.cron` — `packages/effect/test/Schedule.test.ts:300-330`), and `DateTime.now`
(`DateTime.ts:822`). Raw Promises/`setTimeout` inside `Effect.promise` are NOT.

- `TestClock.adjust(durationInput)` — move time forward; every sleep scheduled at or before the new
  time runs **in order** before `adjust` returns (`TestClock.ts:317-333`). `adjust(Infinity)` is
  legal (`Schedule.test.ts:327`). `setTime(epochMillis)` is absolute (`TestClock.ts:335-337`).
- **Sleeps semantically block**: the canonical shape is fork → adjust → join
  (`TestClock.ts:36-41`; `ai-docs/src/09_testing/10_effect-tests.ts:28-39`). Sleeping without
  forking then adjusting deadlocks; after 1s of wall time a warning logs: "A test is using time,
  but is not advancing the test clock" (`TestClock.ts:184-190`).
- **Time starts at epoch 0** (`TestClock.ts:238`). `DateTime.now` under `it.effect` is 1970-01-01;
  any month/window logic (budget latches) must `TestClock.setTime(...)` to a real instant first.
- Live escape hatch: `TestClock.withLive(effect)` runs one effect against the real clock
  (`TestClock.ts:252-254`, `:513-514`); whole-test escape is `it.live` or
  `excludeTestServices: true` on a layer block.
- **Trap**: `TestClock.adjust` under `it.live` doesn't fail cleanly — `testClockWith` blindly casts
  the current clock (`fiber.getRef(Clock.Clock) as TestClock`, `TestClock.ts:410-412`), so you get
  `testClock.adjust is not a function` at runtime. TestClock helpers only work where TestEnv is
  provided.
- Root config disables vitest's own fake timers (`fakeTimers: { toFake: undefined }`,
  `vitest.shared.ts:32-34`) — TestClock is the only time mechanism; don't mix in `vi.useFakeTimers`.

## Other test services

- **TestConsole** (`effect/testing/TestConsole`) — provided by default under `it.effect`; captures
  `Console.*` calls in memory; assert via `yield* TestConsole.logLines` / `errorLines`
  (`TestConsole.ts:289,328,367`).
- **Deterministic randomness** — no TestRandom service in v4; instead
  `Random.withSeed(effect, "seed")` swaps the `Random` service for a seeded ISAAC CSPRNG
  (`packages/effect/src/Random.ts:309-315`). Same seed → same sequence.
- **TestSchema** (`effect/testing/TestSchema`) — `new TestSchema.Asserts(schema)` bundles
  decode/encode/make/round-trip assertions (`TestSchema.ts:52`); handy for vendor-payload schemas.
- **FastCheck** is re-exported at `effect/testing/FastCheck` (`testing/FastCheck.ts:1-10`); the
  real dependency is `fast-check` ^4 (`packages/effect/package.json:116`).

## Property tests

`it.effect.prop(name, arbs, f, { fastCheck: { numRuns: 200 } }?)` accepts an array **or** a record
whose values are FastCheck arbitraries **or Schemas** — Schemas are converted with
`Schema.toArbitrary` (`internal.ts:126-146`; `Schema.ts:13079`), so v4 core has schema-driven
arbitraries built in (`ai-docs/src/09_testing/10_effect-tests.ts:50-55` uses `[Schema.String]`).
Array form passes values as a tuple (`([a, b]) => ...`), record form as an object
(`packages/vitest/test/index.test.ts:194-215`). **Trap**: the non-effect `it.prop` throws
`"Schemas are not supported yet"` for Schema arbitraries (`internal.ts:182`) — Schema arbs only
work under `it.effect.prop`. Effectful property bodies run under the same TestEnv as `it.effect`.

## Assertion idioms (house style)

- The repo asserts with **`node:assert`-backed helpers**, not `expect`, for Effect data:
  `packages/effect/test/utils/assert.ts` — `deepStrictEqual` (`:17`), `assertEquals` via
  `Equal.equals` with a deep-diff on failure (`:44-49`), `assertNone/assertSome` (`:136-146`),
  `assertSuccess/assertFailure` for `Result` (`:152-166`), `assertExitSuccess/assertExitFailure`
  compared against `Exit.failCause(...)` (`:172-186`).
- Typed-failure idiom: `const error = yield* failing.pipe(Effect.flip)` then `deepStrictEqual`
  (`packages/effect/test/Effect.test.ts:72,182,212`); or `Effect.exit` and compare whole Exits —
  `assert.deepStrictEqual(exit, Exit.fail(...))` works because v4 Causes are plain data.
- **Trap — `addEqualityTesters` is a no-op in this beta**: it registers an empty array
  (`internal.ts:45-47`), despite `vitest.setup.ts:1-4` dutifully calling it. `expect(...).toEqual`
  is purely structural — fine for `Data`/`Schema` classes (plain fields), but do not rely on
  `Equal.equals` semantics through `expect` for hashed collections; use `assertEquals` or compare
  materialized arrays. `deepStrictEqual` also checks prototypes, so two structurally identical
  instances of _different_ tagged-error classes correctly fail.
- Snapshots are rare in the checkout; the norm is exact `deepStrictEqual` on decoded values.

## Stubbing at the edge (the LLM seam)

The house pattern: replace exactly one narrow external-effect service with `Layer.succeed`, keep
the entire vendor client + model stack real, and feed **recorded payloads** through it.

- Canonical: the Anthropic model tests build the real `AnthropicClient.layer({ apiKey })` and
  provide a fake transport underneath —
  `Layer.provide(Layer.succeed(HttpClient.HttpClient, makeHttpClient(handler)))`
  (`packages/ai/anthropic/test/AnthropicLanguageModel.test.ts:13-18`). `makeHttpClient` is 10 lines
  of `HttpClient.makeWith(handler, Effect.succeed as Preprocess)` (`:340-352`), with helpers that
  wrap fixture arrays as SSE / JSON `HttpClientResponse.fromWeb(request, new Response(...))`
  (`:353-380`). Same shape in `packages/ai/openai/test/OpenAiClient.test.ts:50-102`
  (`makeMockHttpClient`) and `OpenAiEmbeddingModel.test.ts:252`.
- Tool execution is stubbed one level up when needed: `toolkit.toLayer({ GlobTool: () =>
Effect.succeed("found.ts") })` (`AnthropicLanguageModel.test.ts:87-90`).
- For in-process services (repos, stores), the pattern is a `Context.Service` with a `layerTest`
  built over a `Ref` exposed as its own service so tests can seed/inspect state
  (`ai-docs/src/09_testing/20_layer-tests.ts:17-46`).
- This is also the vendor-adapter recipe: recorded webhook/API payloads as fixtures → stub
  `HttpClient` returns them → assert the canonical effects downstream.

## Real infra (Postgres)

- The repo uses **@testcontainers/postgresql**, not docker-compose, for sql tests: `PgContainer` is
  a `Context.Service` whose `make` is `Effect.acquireRelease(start container, stop container)`, and
  `PgContainer.layerClient` unwraps it into a real `PgClient.layer({ url })`
  (`packages/sql/pg/test/utils.ts:9-27`). Suites then run
  `it.layer(PgContainer.layerClient, { timeout: "30 seconds" })("PgClient", (it) => ...)`
  (`Client.test.ts:14,255,319`) — one container per block, stopped by the block's scope teardown.
  (Root `docker-compose.yaml` pg/redis exist for cluster examples, not the test suites.)
- **Isolation practice is per-block, not per-test**: tests inside a block share the database and
  are written to create their own uniquely-named tables inline (`CREATE TABLE test_multi ...`,
  `Client.test.ts:277`); there is no truncation/transaction-rollback harness in the checkout. For
  fidy's real-Postgres seam, that means isolation is ours to build (truncate between tests, or
  schema-per-block) — the framework only guarantees layer construction/finalization boundaries.
- CI pre-pulls container images to keep startup within hook timeouts (`.github/workflows/check.yml:126-133`).

## Bun

- `@effect/vitest` has no Bun-specific code — it is plain vitest (peer `vitest ^3 || ^4`,
  `packages/vitest/package.json`). It must run **under vitest**; Bun's native `bun test` runner is
  not vitest and will not execute `it.effect`.
- The repo's own accommodation when vitest runs on Bun: exclude `packages/platform-node` from the
  project list (`vitest.config.ts:4,24-27`) and keep `bun:sqlite` out of `optimizeDeps`
  (`vitest.shared.ts:9-11`). CI only exercises Node and Deno (`check.yml:121`), so Bun is
  supported-but-untested upstream — expect platform-node-adjacent packages to be the fragile edge,
  while core `effect`, TestClock, and `it.layer` are runtime-neutral.
