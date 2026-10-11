# Effect Atom in Foldkit

Selected source: `node_modules/effect/src/reactivity/{Atom,AtomRegistry,AtomHttpApi,AsyncResult,Reactivity}.ts`.
Import from `effect/reactivity`; consult [foldkit.md](foldkit.md) for runtime ownership.

## Choose ownership first

| State                                                  | Owner                                   |
| ------------------------------------------------------ | --------------------------------------- |
| Local interaction and safe drafts                      | Mounted Foldkit Model                   |
| Private input, verifier, receipt and payment authority | Scoped closure or DOM input             |
| Authenticated server projections                       | Authentication lifetime's AtomRegistry  |
| Navigation and document metadata                       | Application Foldkit router              |
| Durable business state                                 | Canonical server; atoms are projections |
| Reload-surviving preferences                           | Explicit browser persistence            |

Stable reusable atoms belong at module scope. `Atom.family` keys include all semantic request
inputs using immutable values, never credentials. Do not copy successful canonical data into a
second writable atom without an explicit editing or snapshot owner.

## Authentication isolation and subscriptions

`apps/web/src/session/lifetime.ts` creates one registry and generated client set per authentication
lifetime. `app/native-lifetime.ts` synchronously closes retained mounted features and disposes their
registry before account replacement. It ignores expiration callbacks from an earlier epoch.
Never store bearer authority in an atom or use credentials as cache keys.

Query owners use `registry.get`, `subscribe` and `refresh`. Subscriptions return disposal functions;
retain them in the mounted feature's scope. A publication guard suppresses callbacks after disposal.
If an atom emits during another atom's initialization, schedule one coalesced publication after
that evaluation to avoid a reentrant second request. See `features/dashboard/query-owner.ts`.

## Transport, invalidation and completion

`AtomHttpApi.Service` derives HttpApi operations with the policy-bearing HTTP layer at composition.
The application supplies the actual client's runtime layer through its account registry. Foldkit
commands own asynchronous work; view functions do not bypass their runtime with `runPromise`.

Query identity includes endpoint, request, response mode, invalidation keys, TTL and serialization.
Choose TTL from freshness needs. Successful mutations invalidate matching bounded collection/entity
keys; an uncertain mutation is not automatic permission to replay. Reactivity is process-local.

`Atom.fn` begins at Initial or supplied success. Writing begins work; `Atom.Reset` and
`Atom.Interrupt` explicitly reset or interrupt. Default invocation replaces prior work; concurrency
does not imply idempotency or transaction isolation.

AsyncResult has Initial, Success and Failure plus an independent waiting flag. Preserve successful
content while refreshing where appropriate. Use `transport/canonical-query.ts` to distinguish
declared refusals from boundary defects without exposing raw causes, bodies or Schema details.
AtomHttpApi keeps endpoint errors but converts SchemaError and low-level HttpClientError into defects.
Timeouts, redirects, response bounds and authentication policy belong beneath AtomHttpApi.

## Tests

Mount the real Foldkit program with `testing/foldkit.ts` and a fresh registry. Exercise canonical
transport, retained data during refresh, uncertainty locks, authentication replacement and disposal.
Use Effect TestClock for timed behavior and browser tests for layout, focus and native controls.
