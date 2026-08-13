# React

How React 19.2.8 behaves, read from the exact checked-out release
(`.repos/react/packages/react/package.json:1-4`). Citations are relative to `.repos/react/`.
Use the official React documentation for the application-facing explanation of an API; use this
checkout to verify runtime semantics, feature gates, and tests.

## Public API boundary

Compile against the installed package and its public TypeScript declarations. Do not import from
React's `src`, `shared`, reconciler, or renderer internals. The checkout is a research reference,
not an additional application dependency.

Do not infer availability from an internal symbol. The client source includes explicitly unstable,
feature-gated exports such as `unstable_ViewTransition` and `unstable_addTransitionType`
(`packages/react/src/ReactClient.js:68-132`). An internal implementation or test therefore does not
mean the installed stable package exposes a supported API. Confirm the runtime export, installed
declaration, and release-channel status together.

## Render purity and Strict Mode

Render functions, state initializers, reducers, and memo calculations must be repeatable and free
of externally visible effects. In development Strict Mode, React intentionally invokes component
work and user functions twice (`packages/react-reconciler/src/ReactFiberHooks.js:591-600`,
`packages/react-reconciler/src/ReactFiberHooks.js:1261-1271`,
`packages/react-reconciler/src/ReactFiberHooks.js:1896-1907`,
`packages/react-reconciler/src/ReactFiberHooks.js:2917-2931`). Put user-triggered work in event
handlers and synchronization with external systems in effects rather than using render as an
imperative lifecycle.

Every effect setup needs a complete cleanup. Strict Mode tests exercise mount, cleanup, and remount
in development before the ordinary mounted lifetime; production mounts once
(`packages/react-reconciler/src/__tests__/StrictEffectsMode-test.js:53-111`). This replay is a
design check, not duplicate business intent to suppress. Fix leaked subscriptions, timers, or
requests at their owning boundary.

Derive display values during render when they follow entirely from current props and state. Do not
copy one reactive value into another with an effect merely to keep them synchronized; that adds an
intermediate stale render and another state owner. See React's official
[You Might Not Need an Effect](https://react.dev/learn/you-might-not-need-an-effect) guidance.

## Identity, keys, and state

A component's position, element type, and key determine whether React reuses its existing fiber and
state. Single-element reconciliation first matches the key, then the element type; a mismatch
creates a replacement (`packages/react-reconciler/src/ReactChildFiber.js:1634-1724`). Use a changed
key deliberately when a subtree must reset.

For collections, provide a stable key from item identity. The reconciler indexes existing children
by explicit key, but falls back to array index for unkeyed children
(`packages/react-reconciler/src/ReactChildFiber.js:463-479`). Index keys are therefore safe only
when order and membership are genuinely fixed; inserting, deleting, or reordering can otherwise
attach state to the wrong item.

React compares state with `Object.is` and can skip scheduling when an eagerly computed next state is
the same value (`packages/react-reconciler/src/ReactFiberHooks.js:3629-3683`). Treat state as
immutable and return a new object when its meaning changes; mutating an object and passing the same
reference can leave the UI stale.

## Dependencies and memoization

Hook dependency arrays are compared positionally with `Object.is`
(`packages/react-reconciler/src/ReactFiberHooks.js:454-500`). Each dependency must represent a real
reactive input. Recreated objects and functions count as changed references; first try moving their
creation into the calculation or effect that needs them instead of adding memoization solely to
silence a dependency warning.

`useMemo` and `useCallback` are performance tools, not correctness boundaries. Memo values are
reused only while dependency comparison succeeds, and memo calculations are deliberately replayed
in development Strict Mode (`packages/react-reconciler/src/ReactFiberHooks.js:2917-2959`). Code must
remain correct if a memoized calculation runs again. See the official
[`useMemo` caveats](https://react.dev/reference/react/useMemo#caveats).

## External stores and async rendering

Use `useSyncExternalStore` when adapting a mutable store that exists outside React rather than
building an ad hoc subscribe-and-set-state effect. `getSnapshot` must return a cached, referentially
stable value until the store changes; React warns that an uncached snapshot can loop. `subscribe`
must return cleanup, and React re-renders when `Object.is` detects a changed snapshot
(`packages/react-reconciler/src/ReactFiberHooks.js:1634-1879`). Prefer a library's supported React
adapter when it already owns this seam.

A Transition marks rendering work as non-urgent; it is not a request cache, authorization boundary,
or transport cancellation mechanism. `startTransition` establishes transition context and observes
a returned thenable, but contains no transport policy (`packages/react/src/ReactStartTransition.js:39-104`).
Keep server-state lifecycle in the library or client that owns it.

## Test seam

Test public behavior through rendered output and user interactions rather than reconciler details.
React's `act` queues React work, flushes it at the outer scope, and warns when an asynchronous scope
or suspended work is not awaited (`packages/react/src/ReactAct.js:32-207`). Prefer a testing library
that wraps interactions in `act`; when calling async helpers directly, await them before asserting.
Keep Strict Mode enabled in representative tests so replay exposes non-reversible effects.
