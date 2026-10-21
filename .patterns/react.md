# React

Use this page for component identity, synchronization adapters, async rendering, and React API
selection. Fidy pins React and React DOM **19.3.1**, with **19.3.0** types, in
[`apps/web/package.json`](../apps/web/package.json). Runtime tarball SHA-512 integrities were
checked against `bun.lock` on 2026-10-21; public exports/declarations confirm the APIs below.

`.repos/react` is a **historical 19.2.8 reference**, not the application's release source. Existing
source citations below are relative to that tree and describe its implementation; use the installed
19.3.0 public declarations, 19.3.1 runtime exports and [official React documentation](https://react.dev/reference/react)
for current contracts. Reverify internals against the application release before relying on them.

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
handlers. Fidy permits imperative synchronization only inside a narrow adapter with an explicit
file-scoped lint override; application components receive its behavioral interface. See
[React coding standards](../CODING_STANDARDS.md#react). An effect is not an indirect command dispatcher.

An effect that acquires a resource or starts ongoing work must release or stop it in cleanup.
Purely idempotent synchronization may need no cleanup. Strict Mode adds a development setup/cleanup
replay (`packages/react-reconciler/src/__tests__/StrictEffectsMode-test.js:53-111`); production can
also restart synchronization after changed dependencies, remounts, or visibility changes. Model each
setup/cleanup cycle independently instead of assuming a once-only mount. See the
[`useEffect` lifecycle](https://react.dev/reference/react/useEffect).

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

## Loading, failures, and rendering priority

Declare `lazy` at module scope and put `Suspense` around the region that should reveal together.
The loader resolves to `{ default: Component }`; for Fidy's named exports, adapt the import as in
[`DashboardRouteContent` / `DashboardRoute`](../apps/web/src/app/routes.ts).
`lazy` caches both its loader Promise and result. Rejections reach the nearest error boundary.
See [`lazy`](https://react.dev/reference/react/lazy).

Suspense displays loading for supported suspending reads and code loads; it does not discover
ordinary event-handler or effect fetches. Keep data acquisition in the existing Atom owner and
use its supported Suspense adapter when chosen. See [Atom results](effect-atom.md) and
[`Suspense`](https://react.dev/reference/react/Suspense). Choose loading and stale-data feedback
separately from failure feedback; an empty result must not stand in for a failed query.

Place a router/library error boundary around the smallest independently recoverable feature.
It handles descendant render failures, including rejected lazy imports and errors thrown by Atom's
Suspense adapter. Event-handler and ordinary asynchronous failures stay with their command owner.
Recovery must clear or refresh the failed resource as well as reset the boundary. A changed `key`
remounts a boundary but does not evict a cached rejected `lazy` import; a broken deployment chunk
may require a page reload. Use existing boundary support instead of introducing a class contrary
to repository conventions. See [error boundaries](https://react.dev/reference/react/Component#catching-rendering-errors-with-an-error-boundary).

| Need                                                           | API and limit                                                                                                                                                                                                                                                                              |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Mark a local update as non-urgent and display pending feedback | `useTransition` returns `[isPending, startTransition]`. Keep controlled text-input updates urgent; state updates after `await` currently need another `startTransition`. It does not serialize requests or cancel transport. [Reference](https://react.dev/reference/react/useTransition). |
| Let an expensive view lag a value received from elsewhere      | `useDeferredValue(value)` gives interruptible background rendering. Mark stale content visibly; it is neither debouncing nor a request limit. [Reference](https://react.dev/reference/react/useDeferredValue).                                                                             |
| Associate a label, description, or error with an input         | `useId()` gives an instance-stable accessibility ID. Derive list keys from domain identity, and request/idempotency IDs from the owning protocol. [Reference](https://react.dev/reference/react/useId).                                                                                    |

Navigation remains with TanStack Router; server-state lifecycle remains with Effect Atom. React
priority APIs do not transfer either responsibility to component state.

## Optional APIs and ownership

These APIs are public in the verified 19.3.0 runtime and types. Availability is a selection option,
not a reason to add them to existing features.

- **`Activity`** preserves a hidden subtree's state and DOM while cleaning up its effects, then
  restarts effects on reveal. Use for deliberate UI preservation; hiding is not disposal or erasure
  of credentials. Authentication revocation and secret lifetimes remain with their owners.
  [Reference](https://react.dev/reference/react/Activity).
- **`useEffectEvent`** reads current values in non-reactive logic triggered by an effect. It belongs
  inside the permitted synchronization adapter, is called only from effects/Effect Events, and is
  not passed to children or listed in dependencies. Keep values that must resynchronize the adapter
  as real dependencies. [Reference](https://react.dev/reference/react/useEffectEvent).
- **`useActionState`** owns action result/pending state and queues dispatched actions. Choose it only
  for a genuinely local form action; dispatch through a form action or a Transition. Do not copy
  an Atom command's result/pending state into another owner.
  [Reference](https://react.dev/reference/react/useActionState).
- **`useOptimistic`** projects a temporary result during an Action and requires a pure update
  function. It does not prove a server commit. Fidy's Dashboard already has a mounted edit owner
  for pending placement and canonical reread recovery; keep that projection there rather than
  adding a competing optimistic document. [Reference](https://react.dev/reference/react/useOptimistic).
- **Form actions / `useFormStatus`** can own a local form's submission feedback. The status reader
  must be a descendant of the form; a successful function action resets uncontrolled fields.
  Preserve validation, explicit submission, secret lifetime and uncertain-outcome behavior in the
  existing feature owner. A React action supplies no server authorization or CSRF protection.
  [Form reference](https://react.dev/reference/react-dom/components/form),
  [status reference](https://react.dev/reference/react-dom/hooks/useFormStatus).

## Test seam

Test public behavior through rendered output and user interactions rather than reconciler details.
React's `act` queues React work, flushes it at the outer scope, and warns when an asynchronous scope
or suspended work is not awaited (`packages/react/src/ReactAct.js:32-207`). Prefer a testing library
that wraps interactions in `act`; when calling async helpers directly, await them before asserting.
Keep Strict Mode enabled in representative tests so replay exposes non-reversible effects.

For async UI changes, cover loading, rejected code/data, retry/reset and navigation away. For a
synchronization adapter, cover dependency changes and disposal. If adopting Activity, additionally
check hide/reveal and authentication revocation; retained hidden state must not revive authority.
