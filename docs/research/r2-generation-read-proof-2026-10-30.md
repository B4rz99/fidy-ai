# R2 generation read protocol comparison

**Reject this optimization candidate.** An isolated hosted comparison found a 52.5 ms median for
`get()` followed by `.text()`, versus 47 ms for `head()` and custom metadata: **1.12×**, a 5.5 ms
difference. This small synthetic result does not justify changing the recovery-generation protocol,
and does not establish a production Category latency improvement or the remaining 2× target.

## Protocol boundary

The current [generation reader](../../apps/server/cloudflare/erasure/internal/generation.ts) obtains
the authoritative object body afresh, checks its 64-byte bound, decodes `ErasureGeneration`, and
returns its generation with the object's ETag. The D1 unit independently asserts the published
generation. No cache or metadata substitute was introduced.

Cloudflare documents strongly consistent object and metadata reads/writes. Worker bindings access
the bucket directly rather than passing through custom-domain caches. This makes fresh metadata a
possible protocol ingredient, but does not make existing object metadata equivalent to the current
authoritative body. See the [R2 consistency model](https://developers.cloudflare.com/r2/reference/consistency/).

The [Workers API reference](https://developers.cloudflare.com/r2/api/workers/workers-api-reference/)
distinguishes metadata-only `head()` from `get()` with a body. `put()` accepts custom metadata and
conditional writes. A future metadata protocol would need coherent publication, validation and
failure handling across [initialization](../../apps/server/cloudflare/erasure/internal/registry-initialization.ts)
and every [checkpoint publication](../../apps/server/cloudflare/erasure/internal/checkpoint.ts),
including the `publishing:` marker, ETag conditions and interrupted outcomes. HEAD alone cannot
retrieve the current body's generation. That protocol redesign was neither implemented nor tested
by this fixture.

## Controlled hosted observation

The complete experiment ran on 30 October 2026, 06:55:06–06:55:52 UTC, in one private disposable
Worker/Workflow and one synthetic R2 bucket. Workers.dev and preview URLs were disabled; there were
no public routes, D1 bindings, production bucket bindings or application data. Both bucket creation
and Workflow invocation requested the `enam` location hint; actual execution/storage placement was
not independently established.

The fixture wrote one object whose body and `customMetadata.generation` were both `initial`. Every
read checked the object size and returned generation. One warmup per mode preceded 32 sequential
measured reads ordered GET, HEAD, HEAD, GET, repeated eight times. Workflow step retries were zero.
Elapsed times include the awaited API call and, for GET, body consumption. All checks passed.

| Method                   | Measured reads |  Median | Observed maximum |
| ------------------------ | -------------: | ------: | ---------------: |
| GET and body text        |             16 | 52.5 ms |            58 ms |
| HEAD and custom metadata |             16 |   47 ms |            56 ms |

All measured elapsed times, in milliseconds and in each method's observation order:

- GET: `56, 55, 53, 50, 48, 46, 57, 55, 55, 58, 55, 52, 49, 47, 49, 51`.
- HEAD: `43, 48, 56, 47, 45, 52, 47, 52, 47, 45, 51, 44, 48, 46, 48, 44`.

The separate post-GET body-consumption median was 0 ms at the available timer resolution. The same
fixture first passed locally in native Miniflare, with both measured medians 0 ms and observed
maxima 1 ms; those local timings cannot establish a speedup. One hosted instance with a tiny object,
integer-millisecond observations and location hints does not establish p95, performance under
contention, a causal production gain, CPU, memory, throughput or total billing improvements.

## Budget and resource audit

Fresh account-wide D1 observations, including deleted databases, passed the existing fail-closed
budget CLI before provisioning and before invocation. Both admitted estimates were **zero D1
reads and writes** because the fixture had no D1 binding. This was a separate R2-only protocol
experiment; it did not reopen the closed production Category request experiment.

The account-wide October R2 observation contained 880,255 operations across all classes. Adding the
complete experiment's conservative 1,000-operation ceiling remained below the deliberately tighter
900,000-operation threshold. The measurement itself completed **34 R2 reads and two object writes**
(one PUT and one DELETE). Provisioning, Workflow control and cleanup are outside those measurement
counters and were covered by the conservative ceiling.

The object's `finally` cleanup completed. A separate bounded cleanup Workflow found zero remaining
objects and made no empty delete call. The fixture was then redeployed without its R2 binding, and
the Workflow, Worker and bucket were deleted. Independent provider reads returned 404 for each of
the three resource identities. No credential was created and the account remained Free.

Sanitized raw observations, fixture source, budget decisions and cleanup outcomes are committed in
[the evidence record](r2-generation-read-proof-2026-10-30.json).

Operator evidence is retained as `r2-body-head-proof/hosted-proof.json`, `worker.mjs`, `hosted.py`
and `local-results.json` in the private performance artifact directory. The measured Worker source
SHA-256 is `c29090a75c8dda34f9d65b80bacc58ba73abc77dce46b5629dfa215b4e10f5d0`.
This note records the sanitized samples and audit outcome without publishing account identifiers
or credential material. Keep #1589 open; this rejected candidate adds no confirmed production gain.
