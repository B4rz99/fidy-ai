# Effect Atom + React bindings

Selected sources: `node_modules/effect/src/reactivity/{Atom,AtomRegistry,AtomHttpApi,AsyncResult,Reactivity}.ts`
and `node_modules/@effect/atom-react/src/{Hooks,RegistryContext,ScopedAtom,ReactHydration}.ts`.
Import the former from `effect/reactivity` and React bindings from `@effect/atom-react`.

## Choose ownership first

| State                                   | Owner                                         |
| --------------------------------------- | --------------------------------------------- |
| Local hover, open state, draft input    | Component state/reducer                       |
| Shared state for a subtree              | Subtree provider / ScopedAtom                 |
| Authenticated server cache and commands | Authentication-lifetime registry              |
| Public server cache                     | Application registry                          |
| Navigation                              | Router/URL                                    |
| Durable business state                  | Server; query atoms are projections           |
| Reload-surviving preferences            | Explicit schema-versioned browser persistence |

Use atoms when state needs shared identity, Effect services, caching, or invalidation—not to replace
every `useState`. Stable reusable definitions belong at module scope. `Atom.family` keys must include
all semantic request inputs, using small immutable values rather than mutable objects or credentials.
`ScopedAtom.Provider` creates its atom once; changing `value` does not recreate it. Key/remount the
provider if replacement is intended.

## Registry lifetime is the isolation boundary

Every value, cache entry, fiber, and subscription belongs to an AtomRegistry. One definition may
have different values in different registries. Fidy replaces the registry at authentication-epoch
changes through `apps/web/src/session/session.tsx`; previous-principal state becomes unreachable.

Unmount removes the registry from React context immediately, but `RegistryProvider` delays disposal
500 ms and cancels that disposal on remount. Registry replacement is not immediate cancellation or
credential revocation. Server authorization remains authoritative; credential-bearing effects need
their own revocation/expiry behavior. Never store raw bearer secrets in atoms.

Create registries at ownership boundaries, not per render/query/route leaf. Provider creation options
are read once; remount deliberately when they change.

## Runtime, requests, and invalidation

Use `AtomHttpApi.Service` for generated HttpApi operations, providing the policy-bearing HTTP layer
at composition. Use AtomRuntime for other Effect services. Components read state and dispatch
commands rather than calling `Effect.runPromise` to bypass runtime ownership.

A query's identity includes endpoint, request, response mode, reactivity keys, TTL, and serialization
key. Choose TTL from freshness/resource needs. Keep authentication in the client layer and principal
isolation in the registry, not credential-bearing cache keys. Do not copy successful query data into
a second writable atom without an explicit editing/snapshot owner.

Reactivity is process-local key-based invalidation. Share key constructors across reads and writes;
successful mutations invalidate matching queries, failures do not automatically invalidate them.
Use bounded collection/entity keys rather than global refresh everywhere. Custom Reactivity service
implementations must include its branded TypeId; the value type is `Reactivity`, not a nested
`Reactivity.Service` type.

## Commands and completion

`Atom.fn` begins at Initial (or supplied initial success). Writing starts work and updates AsyncResult;
`Atom.Reset` and `Atom.Interrupt` are explicit controls. Default invocation replaces prior work;
`concurrent: true` allows overlap, but neither mode gives server idempotency or transaction isolation.

`useAtomSet(atom, { mode: "promiseExit" })` returns a complete Exit for command completion handling.
Default `value` mode returns void; `promise` throws a squashed failure on rejection. Prefer
`promiseExit` when an event handler must branch on failure or manage focus/toasts.

AsyncResult has Initial, Success, and Failure plus an independent `waiting` flag. Preserve previous
successful content during refresh where appropriate instead of replacing every waiting state with
a spinner. Use the module's matchers so typed failures, defects, and interruption stay distinct.

`useAtomSuspense` suspends on Initial and optionally on waiting. Without `includeFailure`, failure
throws and requires an Error Boundary. Explicit rendering is usually clearer for command state and
recoverable endpoint errors.

## HTTP errors and safe rendering

AtomHttpApi preserves declared endpoint/middleware errors but converts SchemaError and low-level
HttpClientError into defects. Render declared failures as product states and defects as safe generic
failure/retry UI. Do not expect `catchTag("HttpClientError")` in the atom's typed channel.
Timeouts, response bounds, auth, redirects, and telemetry policy belong below AtomHttpApi in its
HTTP client. Raw causes, bodies, and schema details are not user-facing messages.

## Subscription cost, hydration, and tests

`useAtomValue(atom, selector)` subscribes to a selection; keep selectors stable. `useAtomSet` writes
without subscribing, `useAtom` does both, and `useAtomRefresh` refreshes without reading. Choose the
narrowest subscription rather than rerendering large consumers for unrelated state.

Hydration uses stable serialization keys and schemas. HydrationBoundary initializes new nodes during
render but defers updates to existing nodes until commit. Dehydrate only data safe for the client;
never include credentials or cross-principal caches. `Atom.kvs` browser storage is suitable only for
approved non-sensitive preferences/drafts, never authoritative permissions or payment/bearer tokens.

Test with a fresh registry and stub layers below the runtime. Cover refresh-with-previous, declared
failure versus defect, interruption, success-only invalidation, query identity, authentication-epoch
replacement, delayed disposal, and safe hydration/persistence round trips.
