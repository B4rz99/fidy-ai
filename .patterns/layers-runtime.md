# Services, Layers, Config & Runtime

How Effect v4 services, Layer composition, Config, and single-process runtime assembly
actually work, read from the source. Citations are `<path>:<line>` relative to the checkout
root (`.repos/effect/`); bare `Foo.ts` means `packages/effect/src/Foo.ts`. Canonical
walkthroughs: `ai-docs/src/01_effect/03_services/`, `05_resources/`, `06_running/`,
`08_observability/10_logging.ts`, `09_testing/`. The `migration/*.md` docs are the
authoritative v3→v4 diff — read `services.md`, `layer-memoization.md`, `forking.md` first.

## Defining services (v4 = `Context.Service`, everything else is gone)

`Context.Tag`, `Context.GenericTag`, `Effect.Tag`, and `Effect.Service` are all replaced by
`Context.Service` (`migration/services.md:1-9`). A `Context` is a typed map from string keys
to implementations (`Context.ts:1-11`). Class form — the class **is** the key:

```ts
class Database extends Context.Service<Database, {
  query(sql: string): Effect.Effect<Array<unknown>, DatabaseError>
}>()("myapp/db/Database") {
  static readonly layer = Layer.effect(Database, Effect.gen(function*() {
    const query = Effect.fn("Database.query")(function*(sql) { ... })
    return Database.of({ query })
  }))
}
```

(`ai-docs/.../03_services/01_service.ts:13-38`). Conventions baked into the repo's own code:

- Key string = package + path (`01_service.ts:16-18`). It is the **runtime identity** — two
  services with the same key occupy the same slot (`Context.ts:169-171`).
- Methods wrapped in `Effect.fn("Service.method")` for spans (`01_service.ts:26`).
- Layer naming: `layer` (primary), `layerNoDeps` (requirements exposed), `layerTest`,
  `layerConfig` — not v3's `Default`/`Live` (`migration/services.md:193-197`).
- Service type when needed: `Database["Service"]` (`01_service.ts:44-45`).
- v3 static accessors are **removed**; nearest replacement is `Tag.use((s) => s.method(x))`
  / `useSync`, but the migration doc says prefer `yield*` — `use` hides dependencies at the
  call site (`migration/services.md:125-139`; `use`/`useSync`/`of`/`context` on every key,
  `Context.ts:99-104`).
- Optional `make` on the class stores a constructor effect but does **not** auto-generate a
  layer (no v3 `dependencies:`); build it yourself: `static layer =
Layer.effect(this, this.make).pipe(Layer.provide(Dep.layer))` (`migration/services.md:142-192`).
- `Context.Reference<Shape>(key, { defaultValue })` = service with a default, usable without
  provision (`Context.ts:1335-1338`; `ai-docs/.../10_reference.ts`). This is also v4's
  replacement for `FiberRef` (`migration/MIGRATION.md:76`). Clock, ConfigProvider,
  CurrentLoggers, MinimumLogLevel are all References — override by layer, never mandatory.

## Layer constructors and scoped resources

There is **no `Layer.scoped` in v4** — `Layer.effect` already runs the construction effect
inside the layer's own scope and strips `Scope` from `R` (`Layer.ts:974-981`, via
`effectContext` = `Scope.provide(effect, scope)`, `Layer.ts:1031-1033`). So
`Effect.acquireRelease` inside `Layer.effect` just works: acquired at build, released when
the layer scope closes (`ai-docs/.../05_resources/10_acquire-release.ts:28-44`).

| Constructor                         | Use                                                                                                          |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `Layer.succeed(Tag, impl)` / `sync` | pure values (`Layer.ts:775`, `:890`)                                                                         |
| `Layer.effect(Tag, eff)`            | effectful/scoped construction (`Layer.ts:974`)                                                               |
| `Layer.effectDiscard(eff)`          | side effects, provides nothing — the background-worker idiom (`Layer.ts:1061`)                               |
| `Layer.unwrap(eff)`                 | choose a layer from an Effect/Config at build time (`Layer.ts:1126`; `ai-docs/.../20_layer-unwrap.ts:51-65`) |
| `Layer.suspend(f)`                  | lazy layer, normal memoization (`Layer.ts:1091`)                                                             |
| `Layer.mock(Tag, partial)`          | partial test impl; unimplemented members **die** with `UnimplementedError` (`Layer.ts:2262-2288`)            |

**Background loops owned by a layer**: `Layer.effectDiscard(Effect.gen(function*() { yield*
loop.pipe(Effect.forkScoped) }))` — the fiber is interrupted when the layer scope closes
(`ai-docs/.../05_resources/20_layer-side-effects.ts:11-30`). Fork renames
(`migration/forking.md`): `fork`→`forkChild` (dies with parent), `forkDaemon`→`forkDetach`
(global scope, survives parent — avoid in a layer-owned worker or shutdown won't stop it),
`forkScoped`/`forkIn` unchanged (`Effect.ts:8546`, `:8591`, `:8642`, `:8692`). All accept
`{ startImmediately, uninterruptible }`.

Finalizers run in **reverse registration order**, sequentially by default
(`Scope.ts:242-251`); `Layer.provide` builds the dependency first (`Layer.ts:1306-1310`), so
dependencies are torn down **after** their dependents. `Layer.mergeAll` builds siblings
concurrently in a `"parallel"`-forked scope — sibling finalizers also run in parallel
(`Layer.ts:1142-1148`).

Layer construction errors stay in the layer's `E` channel; combinators: `Layer.orDie`,
`catchTag`, `catchCause`, `tapError` (`Layer.ts:1782`, `:1854`, `:1962`, `:1676`). An `E`
that reaches `Layer.launch`/`runMain` is logged and the process exits 1 — config/resource
failures are boot failures, which is what fidy wants.

## Composition and memoization (the trap section)

`Layer.provide(dep)` feeds `dep` into requirements and **hides** it; `Layer.provideMerge`
feeds and re-exposes (`Layer.ts:1375`, `:1490`; the canonical `layerNoDeps` + `layer =
layerNoDeps.pipe(Layer.provide(Dep.layer))` shape is `ai-docs/.../20_layer-composition.ts:24-69`).
Both accept arrays: `Layer.provide([A, B])`. `Effect.provide` also takes a layer, an array
of layers, or a raw `Context` (`Effect.ts:5862-5908`).

Memoization facts (`Layer.ts:380-446`, `migration/layer-memoization.md`):

- The memo map is keyed by **layer object identity** (`Map<Layer, entry>`,
  `memoMap.map.set(layer, entry)` — `Layer.ts:401`, `:422`). One module-level
  `static readonly layer` referenced from ten places = built once. A factory like
  `layerRemote(url)` returns a **new instance per call** = built per call. Lift layer
  factories to constants.
- Entries are **refcounted**: each consuming scope registers a finalizer that decrements
  `observers`; the layer's scope closes when the count hits zero (`Layer.ts:386-399`). A
  memoized layer outlives any single consumer but not all of them.
- **New in v4**: the memo map is shared _across_ separate `Effect.provide` calls in the same
  fiber tree — overlapping layers no longer double-build (`migration/layer-memoization.md:8-12`).
  Opt out per call with `Effect.provide(layer, { local: true })` or per layer with
  `Layer.fresh` (fresh memo map — `Layer.ts:2100-2101`). Use these for test isolation /
  independent pools; composing layers once and providing once is still the recommended shape.
- `ManagedRuntime`s do **not** share memoization unless you pass the same
  `memoMap: Layer.makeMemoMapUnsafe()` to each (`ai-docs/.../04_integration/10_managed-runtime.ts:60-69`).

## Refreshable layer resources (`LayerRef`)

RC.112 adds stable `LayerRef`: a reference-counted, refreshable cache for one layer-built service
context (`LayerRef.ts:1-65`). `LayerRef.make(layer, { idleTimeToLive?, preload?,
invalidationSchedule? })` lazily builds once, shares while borrowed, optionally retains the context
while idle, and exposes:

- `get` — a Layer providing the current context;
- `contextEffect` — scoped direct access;
- `invalidate` — mark the current context stale; the next borrower rebuilds;
- `refresh` — invalidate and immediately reacquire (`LayerRef.ts:74-191`).

`LayerRef.Service<Self>()("id", { layer, ... })` packages that mechanism as a service with static
`layer`, `layerNoDeps`, `get`, `contextEffect`, `invalidate`, and `refresh`
(`LayerRef.ts:196-326`). This is v4's replacement direction for the removed `Reloadable`
(`migration/v3-to-v4.md:12722-12742`).

Use it only for a genuinely refreshable scoped resource such as rotated provider configuration or a
rebuildable client. It is not application state, a request cache, or a way to hot-swap domain rules.
Invalidation does **not** revoke a context already borrowed by an active Scope; that borrower keeps
using it until its Scope closes (`LayerRef.ts:74-131`). If immediate credential revocation is a
security requirement, enforce revocation at use time rather than relying on LayerRef invalidation.

## Runtime assembly on Bun — the canonical main

`BunRuntime.runMain` is literally `NodeRuntime.runMain` from `platform-node-shared`
(`platform-bun/src/BunRuntime.ts:52`). What it does (`platform-node-shared/src/NodeRuntime.ts:36-58`,
`Runtime.ts:201-244`):

1. `Effect.runFork`s the program with a `tapCause` that `Effect.logError`s any non-interrupt
   cause (suppress per error with `[Runtime.errorReported] = false`, or globally with
   `disableErrorReporting`) (`Runtime.ts:227-234`, `:399`).
2. Installs `SIGINT`/`SIGTERM` handlers that **interrupt the root fiber** — interruption
   closes the layer scope, running every finalizer: this _is_ graceful shutdown.
3. On exit runs the teardown: code 0 on success, **130** on interrupt-only causes, an
   `[Runtime.errorExitCode]` marker if present, else 1 (`Runtime.ts:117-125`).
   `process.exit` is called only after a signal or on non-zero code
   (`NodeRuntime.ts:45-49`).
4. Keep-alive is built into the v4 core runtime (`migration/fiber-keep-alive.md:44-63`);
   runMain adds its own interval too (`Runtime.ts:236-241`). runMain remains the recommended
   entrypoint for signals + exit codes.

The whole app as one layer, launched (`ai-docs/.../06_running/20_layer-launch.ts`,
`10_run-main.ts:20-30`):

```ts
const AppLive = Layer.mergeAll(HttpServerLive, WebhookWorkerLive, AgentLoopLive, SchedulerLive);
BunRuntime.runMain(Layer.launch(AppLive));
```

`Layer.launch` = build the layer in a scope, then `Effect.never` (`Layer.ts:2167-2168`);
interruption (the signal) closes the scope. Every long-running concern is a layer
(workers as `Layer<never>` via `effectDiscard` + `forkScoped`), merged; `mergeAll` builds
its members concurrently (`Layer.ts:1194-1200`).

**Trap**: `BunRuntime.runMain`'s JSDoc mentions a `disablePrettyLogger` option
(`BunRuntime.ts:33`) but the options type has only `disableErrorReporting` and `teardown`
(`BunRuntime.ts:38-51`) — v4 runMain installs **no** pretty logger; logging comes from the
default logger set (below).

### BunHttpServer

`BunHttpServer.make` wraps `Bun.serve` and registers `server.stop()` (waits for in-flight
requests) as a scope finalizer, bounded by `gracefulShutdownTimeout` (default **20s**;
`disablePreemptiveShutdown` skips the wait) (`platform-bun/src/BunHttpServer.ts:75-125`,
`:152-158`). Layers (`:227-311`): `layer(opts)` = `HttpServer` + `HttpPlatform` + `Etag` +
`BunServices` (fs/path/crypto/stdio/terminal/spawner — `platform-bun/src/BunServices.ts:32-49`);
`layerServer` (server only); `layerConfig(Config.Wrap<opts>)` for config-driven port;
`layerTest` (ephemeral port + pre-pointed `HttpClient`). So the http-api.md assembly on Bun is
`HttpRouter.serve(AllRoutes).pipe(Layer.provide(BunHttpServer.layer({ port })))` — no
`createServer` argument, unlike `NodeHttpServer.layer`. `BunHttpClient` is just a re-export
of `FetchHttpClient` (`platform-bun/src/BunHttpClient.ts:9`).

## Config

A `Config<T>` **is an Effect** — yielding it resolves the current `ConfigProvider` from the
fiber (`Config.ts:110-124`), so `yield* Config.string("SMTP_USER")` works inside any
`Layer.effect` with zero setup: the provider is a `Context.Reference` defaulting to
`fromEnv()` (`ConfigProvider.ts:296-299`). Failures are `ConfigError` wrapping either a
`SourceError` (I/O) or a `SchemaError` (validation) (`Config.ts:70-84`) — they ride the
layer's `E` channel and abort boot.

- Config is schema-based in v4: `Config.schema(codec, path?)` is the primitive
  (`Config.ts:642-661`); `string/nonEmptyString/int/finite/boolean/duration/port/logLevel/
url/date/literals/redacted` are shortcuts (`Config.ts:904-1362`). Locked structures =
  `Config.schema(Schema.Struct({...}), "prefix")` — whole-struct decode, one error site.
- `Config.redacted(name)` → `Redacted<string>` via `Schema.Redacted` (`Config.ts:1268-1270`);
  unwrap with `Redacted.value` at the use site (`ai-docs/.../10_acquire-release.ts:26-40`).
- **`withDefault`/`option` only swallow missing-data** — a _malformed_ value still fails
  (`Config.ts:357-370`, gotcha at `:583-585`). This matches no-silent-fallbacks: defaults
  never paper over invalid input.
- `Config.nested(cfg, "delivery")` prefixes the lookup path (`Config.ts:1418-1425`). The env
  provider joins path segments with `_` **case-sensitively** (`ConfigProvider.ts:893`) and
  splits env names on `_` to build nesting (`:867-874`) — `["delivery","window"]` reads env
  `delivery_window`, not `DELIVERY_WINDOW`. Use uppercase segment names, or pipe the provider
  through `ConfigProvider.constantCase` to map camelCase keys → `SCREAMING_SNAKE_CASE`
  (`ConfigProvider.ts:535-537`). Empty-string env values count as **missing** unless
  `preserveEmptyStrings: true` (`ConfigProvider.ts:848-860`).
- Providers: `fromEnv` (default), `fromUnknown(json)` (tests), `fromDotEnv` (needs
  `FileSystem`, returns `Effect<ConfigProvider>` — `ConfigProvider.ts:1110-1121`), `fromDir`
  (K8s-style file-per-key, `:1166`). Install with `ConfigProvider.layer(providerOrEffect)`
  (replace) or `layerAdd(provider, { asPrimary? })` (fallback/override chain)
  (`ConfigProvider.ts:631-707`).
- `Config.Wrap<Options>` / `Config.unwrap` let a layer factory accept per-field configs —
  the pattern `BunHttpServer.layerConfig` and `PgClient.layerConfig({ url:
Config.redacted("DATABASE_URL") })` use (`Config.ts:438-489`;
  `ai-docs/.../20_layer-composition.ts:13-18`).

## Time as a seam

`Clock` is a `Context.Reference` whose default is the live clock (`Clock.ts:111`,
`internal/effect.ts:5834-5836`) — production code needs no wiring, tests override the same
key. Read time via `yield* DateTime.now` (goes through Clock — `DateTime.ts:822-838`) or
`Clock.currentTimeMillis` (`Clock.ts:169`); `Effect.sleep`, timeouts, and `Schedule` all go
through Clock. **`DateTime.nowUnsafe` / `Date.now()` bypass the Clock service**
(`DateTime.ts:865-884`) and are invisible to TestClock — never call them in the core.
`TestClock.layer()` substitutes `Clock.Clock` (`testing/TestClock.ts:379-382`);
`TestClock.adjust`/`setTime` run everything scheduled up to the new time (`:445`, `:479`).
Gotcha: sleepers block until time moves — fork the effect under test, then adjust
(`TestClock.ts:36-41`). `@effect/vitest`'s `it.effect` provides TestClock + TestConsole
automatically (`packages/vitest/src/internal/internal.ts:40-42`); `it.live` uses real
services; `layer(SharedLive)("name", (it) => ...)` builds one shared context per block torn
down in `afterAll` (`ai-docs/.../09_testing/20_layer-tests.ts:92-120`).

## Logging (Railway = stdout JSON)

Default logger set = `defaultLogger` (human-formatted `console.log` lines) + `tracerLogger`
(span events) (`internal/effect.ts:6043`, `:6389-6408`). For structured stdout, replace the
set: `Logger.layer([Logger.consoleJson])` — one JSON object per line (`Logger.ts:1028`,
`ai-docs/.../08_observability/10_logging.ts:10`); `consoleLogFmt` / `consoleStructured` are
the alternatives (`Logger.ts:913`, `:969`). `Logger.layer` **replaces** unless
`mergeWithExisting: true` (`Logger.ts:1130-1152`). Level filtering:
`Layer.succeed(References.MinimumLogLevel, "Warn")` (`References.ts:433`;
`10_logging.ts:13`). Env-switched logger via `Layer.unwrap` (`10_logging.ts:43-49`).
`Effect.annotateLogs`/`withLogSpan` attach structured metadata (`10_logging.ts:58-65`).

## ManagedRuntime (non-Effect edges only)

For embedding Effect under a foreign framework: `ManagedRuntime.make(layer, { memoMap? })`
builds the layer lazily, exposes `runPromise/runSync/runFork/runPromiseExit`, and
`dispose()` runs the finalizers (`ManagedRuntime.ts:112-217`, `:273-279`). The Hono
walkthrough wires `dispose` to `SIGINT`/`SIGTERM` manually
(`ai-docs/.../10_managed-runtime.ts:124-129`) — everything runMain gives you for free. For
fidy's single-process monolith, `Layer.launch` + `BunRuntime.runMain` covers all edges;
reach for ManagedRuntime only if a non-Effect entrypoint (e.g. a vendor SDK callback) must
run effects. v3's `Runtime<R>` type is gone; capture services with `Effect.context<R>()` and
run with `Effect.runForkWith(services)` (`migration/runtime.md:1-17`, `:53-58`).
