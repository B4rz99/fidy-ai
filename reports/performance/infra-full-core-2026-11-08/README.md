# Disposable current-Core infrastructure comparisons

Question: how much ordinary-read latency comes from remote recovery/database boundaries, and
which topology changes remove it without bypassing the current read owners?

This is throwaway source for issue #1887. No production bindings or customer data are used.
Application code is built from the clean server tree; its Git revision is recorded. These are
backend response experiments, not a click-to-fresh-render acceptance suite or migration plan.

## Local reproduction

Run at the repository root with its frozen dependencies:

```sh
bun reports/performance/infra-full-core-2026-11-08/build.ts
bun reports/performance/infra-full-core-2026-11-08/native.ts
bun reports/performance/infra-full-core-2026-11-08/native-colocated.ts
python3 reports/performance/infra-full-core-2026-11-08/calibrate.py
BENCH_ENFORCED=1 bun reports/performance/infra-full-core-2026-11-08/native.ts
BENCH_ENFORCED=1 bun reports/performance/infra-full-core-2026-11-08/native-placement.ts
BENCH_ENFORCED=1 bun reports/performance/infra-full-core-2026-11-08/native-colocated.ts
bun reports/performance/infra-full-core-2026-11-08/workload.ts
bun reports/performance/infra-full-core-2026-11-08/envelope.ts
bun reports/performance/infra-full-core-2026-11-08/envelope-cases.ts
bun reports/performance/infra-full-core-2026-11-08/index-experiment.ts
```

`native.ts` compares complete response bodies across real D1, per-User SQLite Durable Objects,
SQLite with a separate recovery-authority Durable Object, and D1 Sessions. Only Dashboard's
request-time `calculatedAt` is normalized. It checks invalid routing/cookies/bindings, Audit and
pressure rollback, changed calendar context, revoked credentials before final projection, and
missing/mismatched independent recovery generation. `native-placement.ts` also exercises
`first-primary` Sessions and the placement wrapper. Synthetic provider fixture values are
explicitly named fixtures; no provider is contacted by these reads.

`workload.ts` repeats the ordinary reads with 100,000 Transactions in each store. `envelope.ts`
uses one native D1 store with 100,000 Transactions, 100 RecurringPlans × 100 revisions, 5,000
NeedsReviewItems, populated Budgets, uneven Categories, mixed Currencies and 100 Reconciliation
links. It asserts retained/projected counts. `envelope-cases.ts` adds the full recurring ledger,
combined History filters, a no-match Counterparty filter and no-match search. These local files
raise accounting ceilings only in their in-memory Miniflare module override; that override is
never a deployment input. Bulk fixture Reconciliation is installed before growing History:
linking 100 pairs after bulk population reset the native test connection, and was not counted
as a successful large-fixture result. Native measurements are not hosted workload acceptance.

The SQLite adapter executes the unchanged Core SQL in synchronous storage transactions and
retains live authority, Consent, Audit and recovery reads. The prototype routes an untrusted
User prefix to a store, then lets Core verify the real cookie digest and session binding. This
is not a production credential-routing design. Cross-User/global uniqueness, full ingress
policy, ingestion, erasure, point-in-time restoration, cancellation and migration parity are
not established. The separate recovery-authority DO is a latency prototype; its administrative
restore and tombstone guarantees need a separate design before adoption.

## Hosted disposable experiments

```sh
python3 reports/performance/infra-full-core-2026-11-08/remote.py
python3 reports/performance/infra-full-core-2026-11-08/remote-followup.py
python3 reports/performance/infra-full-core-2026-11-08/remote-placement.py
python3 reports/performance/infra-full-core-2026-11-08/remote-colocated.py
node reports/performance/infra-full-core-2026-11-08/wire-native.mjs
python3 reports/performance/infra-full-core-2026-11-08/remote-wire-colocated.py
python3 reports/performance/infra-full-core-2026-11-08/analyze.py
```

These commands provision temporary Workers, a D1 database and an R2 bucket under a random
`fidy-core-probe-*` prefix. They require existing Wrangler authorization and first admit a
finite estimate against fresh account-wide actual Free-tier allowance. Physical D1 usage is
accounted separately from DO SQLite usage. All native batches must return accounting metadata;
an uncertain request is never retried. The private fixture token expires after two hours and
its local secret file is deleted. Cleanup removes only inventoried resources with the owned
prefix, then independently verifies Worker/database/bucket/namespace absence. Inspect that
verdict before treating a hosted run as finished.

The initial hosted runner used a combined 32,000-write ceiling and stopped after 28 complete
rounds plus a partial round. Its failure ledger is retained. The corrected follow-up uses four
rounds and separate physical D1 accounting. Analyze cohorts separately; do not turn a partial
round or different database into a manufactured 30-sample acceptance pass.

`remote-colocated.py` uses a one-Transaction fixture to fit remaining actual daily allowance.
It observes the D1 primary colo before choosing a regional hint, then compares 11 paired
Dashboard reads. Its 10 post-first observations are diagnostic, not workload acceptance.
`index-experiment.ts` alternates a Counterparty/order index on the scratch projection,
checking complete response equality after the same full-ledger predecessor. No application
migration is modified.

The primary comparison alternates 17 existing reads across default D1, SQLite DO + R2,
SQLite DO + recovery DO, Sessions/read replication and Smart Placement. The placement control
compares default and explicit `aws:us-east-1` placement, verifies D1 serving metadata, and adds
an HTTP service-binding control with the complete same Core behind it. Read-only Session
controls compare ordinary binding, `first-primary`, and `first-unconstrained`; the last is a
routing diagnostic, not proof that asynchronously replicated authority can satisfy live
revocation guarantees. All writes remain real, including Audit and pressure records.

Fixtures are renewed outside measured calls when necessary, keeping the real ten-minute
session freshness constraint. No product responses are retained between requests. First
observations remain separate; setup already loads the isolate, so these are not verified cold
starts. HTTP/2 is fixed across comparisons. Samples reach BOG; this alone does not establish a
representative Colombian end-user connection. Latency includes the whole HTTP response, but
not browser code loading, rendering or interactive-control verification.

Generated ledgers, secrets, compiled bundles, schema snapshots and measurements stay ignored.
Keep prototype source on its throwaway branch and dated findings on issue #1887; do not merge
this directory into the application.

`wire-native.mjs` and `remote-wire-colocated.py` are a separate synthetic two-unit control.
They use 100 integer records, two fresh R2/SQL units and one Audit insert per read. The hosted
control compares default/IAD/ORD/ATL execution against the same primary, keeps 30 post-first
observations per mode, and spends under 500 D1 writes. It does not invoke Fidy Core. Its bounded
readiness polling retries only storage-free health checks and retains failures; uncertain
storage operations are never retried.
