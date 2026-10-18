# Services, Layers, Config & Cloudflare adapters

Selected sources: `node_modules/effect/src/{Context,Layer,Config,ConfigProvider,ManagedRuntime}.ts`,
plus `src/internal/{layer,effect}.ts` for memoization and scope teardown.
Use this pattern when composing a Worker adapter, a deterministic test layer, or a provider boundary.

## Defining services (v4 = `Context.Service`)

`Context.Service` is the v4 service constructor. The class is the context key; use `yield* Service`
inside an Effect and provide a named `Layer` at the adapter edge. `Context.Tag`, `Effect.Tag`, and
v3 static accessors are not the v4 application pattern.

```ts
class DataStore extends Context.Service<
  DataStore,
  {
    readonly read: (id: string) => Effect.Effect<unknown, DataStoreError>;
  }
>()("fidy/DataStore") {}
```

Provide the real implementation separately through `Layer.effect` or `Layer.succeed`; a placeholder
success is not a D1 adapter. Use one stable key per service, name meaningful Work with `Effect.fn`,
and expose `layer`,
`layerNoDeps`, `layerTest`, or `layerConfig` deliberately. A `Context.Reference` is appropriate for
safe defaults such as Clock or ConfigProvider; it is not a substitute for a required authority.

## Layer constructors and scoped resources

Effect v4 uses `Layer.effect` for effectful and scoped construction; `Layer.scoped` is not the v4
constructor. `Effect.acquireRelease` inside `Layer.effect` is released when the layer scope closes.
`Layer.succeed`/`sync` are for pure values, `Layer.effectDiscard` for scoped side effects,
`Layer.unwrap` for configuration-selected layers, and `Layer.suspend` for lazy composition.

Background fibers need an explicit lifetime owner: use `forkScoped` for the construction scope,
`forkIn` for a designated owner scope, or `forkChild` when the parent fiber owns the whole task.
Choose the owner whose shutdown must interrupt the work; verify `forkIn` and `forkScoped` in
`internal/effect.ts`. Never use a detached fiber for correctness-critical queues, locks, retries,
or retention. The default
sequential scope awaits finalizers in reverse registration order. Parallel scope finalizers overlap;
use sequential teardown when a dependent must finish releasing before its dependency closes. Verify
`scopeCloseFinalizers` in `internal/effect.ts` when choosing a scope strategy.

Layer construction failures stay in the error channel. A missing or malformed Cloudflare binding must
make the adapter unavailable; it must not silently create a process-local replacement.

## Composition and memoization

`Layer.provide` hides supplied requirements; `Layer.provideMerge` retains them. Memoization reuses
Layer object identity within the same or inherited memo map, with reference-counted observing scopes.
Stable layer values permit sharing within that map; independent builds without an ambient map can
still acquire separately. A factory creates a new layer identity but may reuse stable dependencies.
Verify `MemoMapImpl`, `CurrentMemoMap.forkOrCreate`, and `buildWithScope` in `Layer.ts`.

Use `Layer.fresh` or `Effect.provide(..., { local: true })` to build a graph with a fresh memo map.
This isolates acquisition, not mutable objects already captured by `Layer.succeed` or services
supplied outside that graph. See `Layer.fresh` in `Layer.ts` and `provideLayer` in `internal/layer.ts`.

`ManagedRuntime` is for embedding Effect at a foreign edge only. A Worker request handler should
construct or reuse the adapter layer according to the Worker lifecycle and ensure all request-scoped
resources close on completion. No long-lived process runtime is part of the production authority.

## Config

A `Config<T>` is an Effect resolved from the current `ConfigProvider`. Use schema-backed config for
Worker environment and binding metadata; use `Config.Redacted` for secrets and unwrap only at the
narrow provider call. Missing and malformed configuration are distinct: defaults may handle absent
optional values, but invalid values must fail closed.

`ConfigProvider.fromUnknown` is the deterministic test seam. Cloudflare bindings and secret bindings
are supplied by the Worker adapter; they must not be copied into generated browser configuration,
logs, telemetry, URLs, or ordinary errors.

## Time and test layers

`Clock` is a `Context.Reference`; production uses the live clock and tests provide TestClock. Read
time through `DateTime.now` or `Clock.currentTimeMillis`, never through `Date.now()` in domain code.
`TestClock.adjust` and `setTime` advance scheduled effects. `@effect/vitest` effect tests provide
TestClock and TestConsole by default; live tests opt into real services explicitly.

## Logging and telemetry

Logger layers are explicit and can replace or merge the existing logger. Logs and telemetry are
allowlisted metadata only. Do not attach request bodies, provider payloads, prompts, replies, secrets,
User-owned financial facts, or raw error messages. Cloudflare observability adapters receive the
closed provider-neutral telemetry contract; they are not imported by core code.
