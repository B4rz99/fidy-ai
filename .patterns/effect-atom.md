# Effect Atom

How Effect Atom works in Effect v4, rechecked against the matching checked-out
`effect@4.0.0-rc.112` and `@effect/atom-react@4.0.0-rc.112` sources. Citations are relative to
`.repos/effect/`.

## Responsibility and boundaries

Effect Atom owns reactive values, their dependency graph, Effect-backed work, and resource lifetime. An `AtomRegistry` evaluates atoms, caches values, tracks dependencies, applies writes and refreshes, manages subscriptions, and disposes unused nodes. Registries are isolated, so the same atom can have different values in different application instances (`packages/effect/src/unstable/reactivity/AtomRegistry.ts:1-8`).

An atom cache is not an authorization boundary. Keep credentials out of atom-family arguments, serialization keys, reactivity keys, labels, and persisted or hydrated values. When an authenticated principal changes, dispose the old registry and mount a fresh provider rather than relying on component unmounts to isolate cached state.

Use atoms for shared state, derived state, Effect-backed operations, and resources with meaningful lifetime. Keep one-component interaction state local to React and URL/navigation state in the router.

## Effect runtimes and resource lifetime

`Atom.runtime(layer)` creates an atom runtime that builds the Layer with a shared memo map and supplies its services to effectful atoms, functions, streams, pulls, and subscription refs (`packages/effect/src/unstable/reactivity/Atom.ts:613-706`). Add process-wide frontend infrastructure such as logging or configuration through a deliberate runtime Layer rather than constructing services in components.

Effect-backed atoms receive a `Scope`. Rebuild or disposal closes that scope, runs finalizers, and interrupts in-flight work unless the atom explicitly marks it uninterruptible (`packages/effect/src/unstable/reactivity/Atom.ts:519-594`). Put subscriptions, streams, timers, and other acquired resources in that scope instead of duplicating cleanup in React.

Atoms are disposed after inactivity according to their idle TTL unless kept alive. Treat TTL as a memory/resource policy, not freshness or security (`packages/effect/src/unstable/reactivity/Atom.ts:180-209`; `packages/effect/src/unstable/reactivity/AtomRegistry.ts:420-500`).

## Derived and parameterized state

Read dependencies through `AtomContext`; the registry records the graph and refreshes dependent atoms. Use `Atom.map` or `Atom.transform` for pure derivation rather than copying values into another writable atom (`packages/effect/src/unstable/reactivity/Atom.ts:116-161`, `packages/effect/src/unstable/reactivity/Atom.ts:1628-1704`).

Use `Atom.family` when an input identifies a stable set of parameterized atoms. Family inputs are cache identity, so use deterministic, non-secret coordinates (`packages/effect/src/unstable/reactivity/Atom.ts:1329-1378`).

## AsyncResult and refreshes

Effects and Streams produce `AsyncResult`. It distinguishes initial, waiting, success, and failure; waiting and failure states can retain the previous success (`packages/effect/src/unstable/reactivity/AsyncResult.ts:168-190`, `packages/effect/src/unstable/reactivity/AsyncResult.ts:261-331`). Render these states by meaning: an initial load can replace the surface, while a refresh can preserve rendered data and expose non-blocking progress.

Use raw `AsyncResult` when loading, stale, domain-error, or authentication-expired states need distinct presentation. Use `useAtomSuspense` only when a Suspense and error-boundary contract is intentionally simpler; by default it suspends initial results and throws failures (`packages/atom/react/src/Hooks.ts:331-378`).

`Atom.swr` adds stale-while-revalidate behavior with explicit stale time and mount/focus policy. Add it per resource from an actual freshness requirement rather than as a global default (`packages/effect/src/unstable/reactivity/Atom.ts:1750-1843`).

## Typed HttpApi state

`AtomHttpApi.Service` derives the client from one `HttpApi` definition and an HTTP-client Layer. Its query helper returns an endpoint-typed `AsyncResult` atom; its mutation helper returns an endpoint-typed effectful writable atom (`packages/effect/src/unstable/reactivity/AtomHttpApi.ts:35-129`, `packages/effect/src/unstable/reactivity/AtomHttpApi.ts:169-306`). Keep this as the sole product transport rather than wrapping it in another request cache.

Query atoms support idle TTL, optional schema-driven serialization, and reactivity keys. Mutation calls can invalidate matching reactivity keys after success. Design keys as a hierarchy of safe resource identity—not credentials or response data—and invalidate the narrowest complete set (`packages/effect/src/unstable/reactivity/AtomHttpApi.ts:220-306`).

Serialization is opt-in through `serializationKey` and endpoint schemas. Use it only for values safe to expose in an HTML or hydration payload. The upstream test demonstrates that request encoding still comes from the derived client and that a serializable query can be dehydrated (`packages/effect/test/reactivity/AtomHttpApi.test.ts:1-82`).

Use optimistic combinators only with a complete rollback and concurrency model. The existence of `Atom.optimistic` and `Atom.optimisticFn` does not make speculation correct for every mutation (`packages/effect/src/unstable/reactivity/Atom.ts:1845-2048`).

## React seam

Create one registry/provider at the application root. The React adapter subscribes through `useSyncExternalStore`; use `useAtomValue` to read, `useAtomSet` to write without subscribing, `useAtom` for both, and `useAtomRefresh` for explicit refresh (`packages/atom/react/src/Hooks.ts:21-55`, `packages/atom/react/src/Hooks.ts:113-247`).

Define stable atoms outside render or memoize parameterized atom creation through `Atom.family`. A new atom object is a new state identity.

## Test seam

Test pure atom derivation through a fresh `AtomRegistry`. Supply stub Layers or a stub `HttpClient` below `AtomHttpApi`, then assert `AsyncResult`, request encoding, invalidation, and finalization through public registry operations. Give each test its own registry and dispose it during teardown so cache state and scoped resources cannot cross tests.
