# TanStack Query

How TanStack Query v5 works, read from the checked-out v5.101.4 source
(`.repos/query/packages/react-query/package.json:1-4`). Citations are relative to
`.repos/query/`.

## Responsibility and boundaries

TanStack Query coordinates asynchronous reads, caching, freshness, retries, cancellation,
and mutation state. It does not establish authorization, make cached data authoritative, or
replace the client that owns transport and decoding.

Keep credentials out of query keys. Keys are retained for cache lookup and exposed to Query
callbacks and developer tooling, so they should contain only non-secret cache coordinates.
When an authenticated principal changes, clear or replace the `QueryClient` rather than relying
on component unmounting to isolate cached data. `QueryClient.clear()` removes both query and
mutation caches (`packages/query-core/src/queryClient.ts:632-635`).

## One client at the application root

Create one `QueryClient` per mounted application, outside component render, and pass it through
`QueryClientProvider`. The provider mounts the client in an effect, unmounts it during cleanup,
and makes it available through React context
(`packages/react-query/src/QueryClientProvider.tsx:24-45`). Creating a client during render can
replace the cache when React creates a new instance.

Set defaults deliberately:

- Data is stale immediately by default (`staleTime: 0`)
  (`packages/query-core/src/types.ts:325-331`). Stale queries refetch on mount, window focus,
  and reconnect by default (`packages/query-core/src/types.ts:348-381`). Choose freshness per
  resource rather than applying one arbitrary value everywhere.
- Inactive entries remain until `gcTime` elapses; `Infinity` disables collection
  (`packages/query-core/src/types.ts:239-250`). Garbage collection is a memory policy, not a
  security boundary.
- Browser queries retry three times by default, with exponential delay capped at 30 seconds
  (`packages/query-core/src/retryer.ts:49-50`, `packages/query-core/src/retryer.ts:169-179`).
  Use a retry predicate when some failures are known to be permanent.

## Define options once

Keep a query's key and query function together in an options factory, then reuse that definition
across loaders, components, cache operations, and tests. `queryOptions` is runtime identity but
tags the key with its data and error types, preserving inference for `QueryClient` APIs
(`packages/react-query/src/queryOptions.ts:52-86`).

Query keys are arrays. Include every input that can change the response, and use deterministic,
serializable values. The default hash is stable for plain objects because object keys are sorted
before JSON serialization (`packages/query-core/src/utils.ts:220-243`). Structure related keys as
a hierarchy when they need to be addressed as a group: non-exact query filters recursively
prefix-match arrays and objects (`packages/query-core/src/utils.ts:143-164`,
`packages/query-core/src/utils.ts:245-274`).

Use `select` for observer-local projection rather than rewriting shared server data; it transforms
or selects part of query data (`packages/query-core/src/types.ts:408-412`).

For dependent queries, use `skipToken` when required coordinates do not exist. Query defaults
translate it to `enabled: false` (`packages/query-core/src/queryClient.ts:596-606`). This avoids
inventing placeholder coordinates that could collide with a real key.

## Request lifecycle and cancellation

A query function receives its key, client, metadata, and an `AbortSignal`
(`packages/query-core/src/types.ts:137-156`). Pass the signal to the transport when that transport
supports cancellation. TanStack detects that the signal was read and cancels or reverts an
unobserved in-flight query; otherwise it lets the request finish so the result can remain cached
(`packages/query-core/src/query.ts:362-377`, `packages/query-core/src/query.ts:444-455`).

Render states by meaning:

- `isPending`: no cached data and no completed attempt.
- `isLoading`: the first fetch is both pending and in flight.
- `isFetching`: any in-flight fetch, including background refresh.
- `isRefetching`: a background fetch rather than the initial fetch.

Those distinctions are encoded in the result contract
(`packages/query-core/src/types.ts:669-710`). A background refresh does not require replacing
already rendered data with an initial-loading state.

## Mutations and invalidation

Mutations do not retry by default (`packages/query-core/src/mutation.ts:184-203`). Preserve that
behavior for non-idempotent operations unless their contract explicitly makes retry safe.

`useMutation` exposes two intentionally different calls: `mutate` catches the returned promise,
while `mutateAsync` returns it (`packages/react-query/src/useMutation.ts:52-68`). Use `mutate` when
result state drives the UI, and `mutateAsync` when surrounding control flow must await or catch the
operation.

After a successful mutation, return the relevant invalidation promise from `onSuccess` when the
mutation should remain pending until affected reads reconcile. Mutation execution awaits
`onSuccess` and `onSettled` before dispatching success
(`packages/query-core/src/mutation.ts:235-272`). `invalidateQueries` marks matching queries
invalid, then refetches active matches by default
(`packages/query-core/src/queryClient.ts:291-309`).

Optimistic updates require a complete rollback model. The lifecycle carries the `onMutate` result
into later callbacks (`packages/query-core/src/mutation.ts:208-250`), but the mechanism alone does
not make speculation safe for every operation.

## Test seam

Give each component or hook test a fresh `QueryClient` and `QueryClientProvider`. Disable retries
when testing expected failures so the result is immediate; the browser default is three retries
(`packages/query-core/src/retryer.ts:169-179`). Clear the client during teardown to remove both
internal caches (`packages/query-core/src/queryClient.ts:632-635`).

Stub the request boundary below the query function rather than TanStack internals. Assert
observable states, keys, and invalidation behavior; test pure data transformations independently
from React and Query.
