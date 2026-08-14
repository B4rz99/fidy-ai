# Effect Atom for the Fidy SPA

_Research snapshot: 2026-08-13. Primary sources: the exact Effect 4.0.0-beta.98 and React bindings in `.repos/effect`, including implementation, tests, and package manifests._

## Decision

Use Effect Atom for shared and server-backed SPA state. Keep TanStack Router for URL and navigation state, React for irreducible one-component interaction state, and the derived Effect client as the sole product transport.

Effect Atom fits because Fidy already models transport, errors, services, concurrency, streams, and cleanup with Effect. Effect programs can remain Effect programs up to a small React subscription hook instead of being adapted into another asynchronous state model.

The matching package is `@effect/atom-react@4.0.0-beta.98`. The atom core, `AsyncResult`, `AtomHttpApi`, registry, reactivity, and hydration modules are already part of `effect@4.0.0-beta.98` under `effect/unstable/reactivity`. The adapter's peers match the repository's Effect and React versions (`.repos/effect/packages/atom/react/package.json:1-65`).

## Why it fits

### Effect remains the execution model

Effect-backed atoms preserve typed failures and `Cause`, Layer services, interruption, Streams, scopes, and finalizers. `AtomRuntime` builds a Layer and supplies it to atoms and effectful functions (`.repos/effect/packages/effect/src/unstable/reactivity/Atom.ts:519-706`).

The React adapter uses `useSyncExternalStore` and exposes separate hooks for reading, writing, refreshing, and Suspense (`.repos/effect/packages/atom/react/src/Hooks.ts:21-55,113-247,331-378`). React does not become the owner of Effect execution.

### Resource lifetime follows the state graph

The registry tracks dependencies and disposes unused nodes (`.repos/effect/packages/effect/src/unstable/reactivity/AtomRegistry.ts:1-8`). Rebuilding or disposing an Effect-backed atom closes its Scope, runs finalizers, and interrupts owned work unless explicitly configured otherwise (`.repos/effect/packages/effect/src/unstable/reactivity/Atom.ts:534-594`).

This gives subscriptions, streams, timers, and in-flight requests the same ownership model as their reactive state.

### Derived state stays derived

Atoms can read other atoms, and the registry records that dependency graph. `Atom.map`, `Atom.transform`, and `Atom.family` cover pure projections and stable parameterized state (`.repos/effect/packages/effect/src/unstable/reactivity/Atom.ts:116-161,1329-1378,1628-1704`).

For the Transaction screen, current User context can feed pure calendar-boundary state, which feeds parameterized Category and Transaction reads without copying values into React state.

### Async state preserves useful information

`AsyncResult` distinguishes initial, waiting, success, and failure. Waiting and failure can retain the previous successful value (`.repos/effect/packages/effect/src/unstable/reactivity/AsyncResult.ts:168-190,261-331`). That supports explicit initial-loading, background-refresh, canonical-error, and authentication-expired presentation.

### Typed HttpApi integration preserves define-once derivation

`AtomHttpApi.Service` derives a client from the same `HttpApi` definition and provides endpoint-typed query and mutation atoms. It supports Layers, response decoding, reactivity-key invalidation, idle TTL, and optional schema-backed hydration (`.repos/effect/packages/effect/src/unstable/reactivity/AtomHttpApi.ts:35-129,169-306`).

Its upstream test verifies request encoding through the derived client and schema-backed dehydration (`.repos/effect/packages/effect/test/reactivity/AtomHttpApi.test.ts:1-82`). This matches Fidy's canonical-operation derivation boundary.

## Sealed frontend state policy

- **Registry lifetime:** mount one registry for the current anonymous or authenticated application lifetime. Dispose and replace it after login, logout, or authentication expiry so data cannot cross principals.
- **Secret handling:** the magic-link bearer remains a function-local memory value only. It never enters atom state, family inputs, serialization keys, reactivity keys, labels, hydration, persistence, or diagnostics.
- **Rendering:** render raw `AsyncResult` for authentication and Transaction flows because the product requires distinct loading, empty, canonical-error, and authentication-expired states. Introduce Suspense only for a later surface with an explicit boundary design.
- **Freshness:** begin with request atoms plus explicit refresh and successful-mutation invalidation. Add per-resource stale-while-revalidate only when a product freshness requirement exists; do not invent one global interval.
- **Cache lifetime:** use idle TTL only as a memory/resource policy. It is neither a freshness rule nor a security boundary.
- **Invalidation keys:** use safe hierarchical resource identities such as User, Categories-by-User, and Transactions-by-User-and-period. Keys contain no bearer, digest, financial values, response bodies, or other secret/sensitive data.
- **Optimistic updates:** use them only for a later mutation with an explicit rollback and concurrency model.
- **Hydration/persistence:** the initial Vite SPA uses neither. Any future adoption requires an explicit safe-value review.

## Package choice

Install exact `@effect/atom-react@4.0.0-beta.98` and direct peer `scheduler@0.27.0` through the normal seven-day dependency-admission policy. Do not install the older Effect 3 package line under the `@effect-atom/*` scope.

The React adapter exports hooks, registry context, hydration, and scoped-atom helpers, while application code imports atom modules from `effect/unstable/reactivity` (`.repos/effect/packages/atom/react/src/index.ts:1-24`; `.repos/effect/packages/atom/react/src/Hooks.ts:11-18`).

## Remaining implementation details

The architectural choices above are sealed. Issue implementation still needs to choose concrete, test-backed names for the reactivity-key constants and the exact registry-provider placement in the Vite component tree. Those are local implementation details rather than unresolved product behavior.
