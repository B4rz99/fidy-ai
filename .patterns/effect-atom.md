# Effect Atom + `@effect/atom-react`

Project baseline: `effect@4.0.0-rc.112`; source checkout `.repos/effect` at `f239b5b6cc`.

Use Effect Atom for client-side reactive state and scoped effects. HttpApi remains the server-operation contract; atoms adapt it to UI ownership, caching, and invalidation.

## Choose the owner before the atom

| State                                           | Owner                        | Shape                                                              |
| ----------------------------------------------- | ---------------------------- | ------------------------------------------------------------------ |
| DOM-only interaction (open, hover, draft input) | nearest component            | React state/reducer                                                |
| Shared state for one component subtree          | subtree provider             | `ScopedAtom` or explicit atom passed by context                    |
| Authenticated server cache and commands         | authentication lifetime      | module-level atom definitions evaluated in the session registry    |
| Public server cache                             | application registry         | query atoms in the app registry                                    |
| URL/navigation state                            | router/URL                   | derive from router; do not mirror casually                         |
| Server-authoritative durable state              | server/database              | HttpApi query/mutation atoms are a projection, never the authority |
| Data that must survive reload                   | explicit browser persistence | schema-versioned persisted atom; never secrets                     |

Use React state until state must be shared, derived across components, connected to Effect services, cached, or invalidated. An atom is a state ownership decision, not a replacement for every `useState`.

## Registry lifetime is the isolation boundary

Every atom value, cached query, running fiber, mount, and subscription belongs to an `AtomRegistry`. The same atom definition can have different values in different registries.

Repository rule: maintain one active registry per authentication lifetime. `SessionRegistryProvider` keys `RegistryProvider` by a non-secret authentication epoch. Login, logout, expiry, and pairing restart replace that epoch so state from the previous principal becomes unreachable (`apps/web/src/session/session.tsx:17-52`).

Important lifecycle detail: replacing/unmounting `RegistryProvider` removes the old registry from React context immediately, but actual `registry.dispose()` is delayed 500 ms and canceled if that same provider remounts (`.repos/effect/packages/atom/react/src/RegistryContext.ts:63-113`). Therefore:

- registry replacement is the confidentiality/correctness boundary;
- do not rely on immediate disposal as revocation or cancellation;
- server authorization remains authoritative for every request;
- effects holding credentials must have their own revocation/expiry behavior;
- never store raw bearer secrets in atoms.

Create a registry at a real ownership boundary. Do not create one per render, route leaf, query, or command. Provider options are read only when its registry is first created, so key/remount intentionally when they must change.

## Definitions, families, and scoped instances

Define stable, reusable atoms at module scope. Creating an atom during render creates a new identity and cache entry unless the API explicitly memoizes it.

Use:

- `Atom.make`/derived atoms for shared reactive values;
- `Atom.family(key => atom)` for parameterized identities such as one query per account;
- `ScopedAtom.make(factory)` when each provider subtree needs its own atom instance;
- component state for instance-local ephemeral details.

Family keys are equality/hash identities and retain semantic meaning. Use small immutable branded IDs or records, not mutable objects, functions, secrets, or whole response payloads. Include every input that changes the result and exclude presentation-only inputs.

`ScopedAtom.Provider` creates its atom once. Changing its `value` prop does not recreate the atom (`.repos/effect/packages/atom/react/src/ScopedAtom.ts:78-144`); key the provider or model value changes as writes if replacement is intended.

## Runtime-backed atoms

Use an `AtomRuntime` when atoms need Effect services. Build its Layer at the application/session composition edge and let the registry own the resulting scoped resources. Do not call `Effect.runPromise` in components to bypass the runtime.

```ts
class ApiClient extends AtomHttpApi.Service<ApiClient>()("ApiClient", {
  api: PublicApi,
  httpClient: ApiHttpClientLayer,
}) {}
```

Keep layers deep: provide HTTP policy, authentication, telemetry, and configuration below the runtime once. Components should only read atoms or dispatch commands.

## Queries and cache identity

`AtomHttpApi.Service.query` creates a family keyed by group, endpoint, request fields, response mode, reactivity keys, TTL, and serialization key (`.repos/effect/packages/effect/src/unstable/reactivity/AtomHttpApi.ts:236-295`). Construct requests from stable schema values.

```ts
const profileAtom = ApiClient.query("accounts", "current", {
  reactivityKeys: ["current-account"],
  timeToLive: "30 seconds",
});
```

Rules:

- A query describes server state; do not copy successful data into another writable atom without a clear snapshot/editing owner.
- Choose `timeToLive` from freshness and resource costs. Infinite keep-alive is exceptional.
- Refresh explicitly for user retry or use shared reactivity keys after successful writes.
- Avoid keying cache identity with credentials. Authentication belongs in the runtime/client layer, while registry replacement separates principals.
- Give serializable queries a stable, unique `serializationKey`; changing it invalidates hydration compatibility.

### Reactivity

Reactivity is process-local key-based invalidation, not durable messaging. A query runs initially and on matching invalidation; a mutation invalidates only after successful completion (`.repos/effect/packages/effect/src/unstable/reactivity/Reactivity.ts:65-174`).

Design keys as a small vocabulary:

- collection key: `"accounts"`;
- entity key: `{ accounts: [accountId] }`;
- multiple affected resources: a record of collections and IDs.

Use the same key constructors for queries and mutations. Invalidate every projection changed by a successful mutation, but do not use broad global keys as a substitute for dependency design. Failed mutations do not invalidate automatically.

## Commands: `Atom.fn` and mutation atoms

`Atom.fn` creates a writable command atom. Before its first write it is `Initial` (or the supplied initial success); writing an argument starts the effect/stream and exposes an `AsyncResult`. It also accepts `Atom.Reset` and `Atom.Interrupt` (`.repos/effect/packages/effect/src/unstable/reactivity/Atom.ts:1090-1208`).

Default command semantics are latest-write-oriented: a new non-concurrent invocation replaces/interferes with the prior computation. Set `concurrent: true` only when overlapping commands are valid and the UI can represent their combined completion semantics. Neither mode creates server idempotency or transaction isolation.

Use a mutation atom for a user command, not as a passive query. Put validation that requires server authority on the server, and provide a stable idempotency key in the payload where duplicate delivery matters.

In React:

```ts
const submit = useAtomSet(saveAtom, { mode: "promiseExit" });
const exit = await submit(input);
```

- default `value` mode dispatches and returns `void`;
- `promise` waits for success and throws a squashed failure cause;
- `promiseExit` returns the complete `Exit`, making expected failure handling explicit (`.repos/effect/packages/atom/react/src/Hooks.ts:105-178`).

Prefer `promiseExit` in event handlers that need branching or focus/toast behavior. Do not both await a command and independently infer completion from stale component state.

## Render every `AsyncResult` state

`AsyncResult` has three variants plus an orthogonal `waiting` flag:

| State                   | UI meaning                                                                      |
| ----------------------- | ------------------------------------------------------------------------------- |
| `Initial(false)`        | not started; render idle/empty affordance                                       |
| `Initial(true)`         | first load; render initial skeleton/spinner                                     |
| `Success(value, false)` | current successful value                                                        |
| `Success(value, true)`  | stale value is retained while refreshing; keep content and show subtle progress |
| `Failure(cause, false)` | request failed; render declared errors or a safe generic defect state           |
| `Failure(cause, true)`  | a retry/refresh is in flight; preserve any `previous` success where appropriate |

Do not collapse `waiting` into “replace everything with a spinner.” The model intentionally preserves previous success on refresh/failure (`.repos/effect/packages/effect/src/unstable/reactivity/AsyncResult.ts:182-405`). Use the module's matcher/builder so typed errors, defects, and interruption are not accidentally conflated.

`useAtomSuspense` suspends for `Initial`, optionally for any waiting state. Unless `includeFailure` is true, it throws `Cause.squash` for failures and requires an Error Boundary (`.repos/effect/packages/atom/react/src/Hooks.ts:279-360`). Prefer explicit rendering for command state and recoverable endpoint errors; use Suspense where the route/subtree owns loading.

## `AtomHttpApi` failure semantics

`AtomHttpApi` preserves endpoint-declared errors and middleware errors as typed failures. It converts `SchemaError` and `HttpClientError` into defects with `Effect.die` (`.repos/effect/packages/effect/src/unstable/reactivity/AtomHttpApi.ts:184-190`). Consequently:

- render declared errors as product states;
- treat decode incompatibility and low-level HTTP client failure as boundary defects, observe them, and present a safe retry/generic failure UI;
- do not expect `catchTag("HttpClientError")` on the atom's typed error channel;
- ensure the policy-bearing HttpClient applies timeouts, bounded responses, redirect/SSRF policy, auth, and safe telemetry before AtomHttpApi;
- avoid exposing raw causes, response bodies, credentials, or internal schema details to users.

If offline/network failure must be a first-class typed product state, model that intentionally in a deeper adapter rather than weakening the generated boundary with casts.

## Hooks and render cost

- `useAtomValue(atom)`: subscribe and render the value.
- `useAtomValue(atom, selector)`: subscribe to a derived selection; keep the selector stable.
- `useAtomSet(atom)`: dispatch without subscribing to its value.
- `useAtom(atom)`: use only when the same component needs both.
- `useAtomRefresh(atom)`: explicit refresh without reading.
- `useAtomSubscribe`: side effects after subscription; stabilize the callback.

Select the narrowest atom/value needed by the component. Split high-churn state from large object state rather than forcing every consumer to rerender. Hooks mount atoms for component lifetime where documented; cleanup belongs to the registry/scope, not ad-hoc component promises.

## Hydration and persistence

Hydration requires `Atom.serializable` definitions with stable keys and schemas. `HydrationBoundary` hydrates new nodes during render so descendants see them immediately, but defers values for existing nodes until commit to avoid leaking transition data into the current UI (`.repos/effect/packages/atom/react/src/ReactHydration.ts:35-101`).

Rules:

- dehydrate only data safe to embed in HTML and expose to the client;
- never hydrate credentials, private verification material, or cross-principal caches;
- include principal/tenant isolation in registry ownership, not in an easy-to-forget query parameter;
- evolve serialized schemas and keys deliberately.

When `Atom.kvs` is backed by browser storage, reserve it for client preferences or non-sensitive resumable drafts and use an explicit Schema. Browser storage is attacker/user-readable, long-lived, and outside server revocation. Never persist bearer tokens, payment tokens, or authoritative permissions there.

## Testing

Test atoms through a fresh `AtomRegistry` per test unless testing shared lifetime explicitly. Provide stub Layers/HttpClients below the runtime and assert observable `AsyncResult`/`Exit` values rather than implementation fibers.

Cover:

- initial, waiting, success, refresh-with-previous, declared failure, defect, and interruption;
- exact query-family identity and reactivity key behavior;
- invalidation occurs after success and not after failure;
- registry replacement makes prior authenticated state unreachable;
- in-flight work does not authorize after logout/expiry despite delayed disposal;
- hydration/persistence round trips and reject incompatible data;
- no secrets appear in dehydrated state, persisted state, logs, or rendered errors.
