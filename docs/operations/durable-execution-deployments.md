# Durable execution deployments

Persisted Workflow state lives in PostgreSQL: Effect's `cluster_messages`, `cluster_replies`, and
workflow-start `PersistedQueue` tables. Every server runner can acquire any shard, so a rolling release
runs old and new revisions concurrently and either revision may read what the other wrote. A crash or
restart can hand a suspended execution to the other revision at any point. Reader compatibility is
therefore a release precondition, not a post-deploy repair.

This runbook is the deployment check for the compatibility contract in
[ADR 0024](../adr/0024-effect-durable-execution.md). The executable fixtures and tests enforce it:

- fixtures: `apps/server/src/shell/testing/fixtures/durable-workflows/*.json`;
- harness: `apps/server/src/shell/testing/durable-compatibility.ts`;
- tests: `apps/server/src/shell/testing/durable-compatibility/*.compatibility.test.ts`;
- runner: `apps/server/vitest.durable-compatibility.config.ts`.

Run them with:

```sh
bun run typecheck
# The suite is fixture-only: it decodes checked-in bytes with production schemas and never opens a
# database, so it needs no database URLs and skips the main runner's schema-dropping global setup.
bun run --cwd apps/server test:durable-compatibility
```

## Contract scope

The contract is prospective. This project has not shipped, so no deployment wrote an earlier form and
no runner can encounter one; the fixtures pin the first shipped revision's forms plus every
reader-first additive form. A writer change that removes a pre-release-only form — for example the
short in-memory `DurableClock` Activity that the clamped clock form replaces — needs no fixture or
migration. Once a revision ships, its forms become the fixtures every later deployment must read.

## Boundaries that must stay readable

The fixtures cover every persisted boundary of every production Workflow:

- Workflow payloads, idempotency-key derivation, and execution ids;
- terminal Workflow results in success and error form, at both the application (`Workflow.Result`) and
  stored RPC reply (`Exit`) boundary;
- Activity requests, including the oldest form without `withTransaction`, engine primary keys
  (`` `${name}/${attempt}` ``), and persisted RPC replies: terminal success/error results,
  `Suspended` with and without a cause, and outer defect failures;
- DurableClock requests, `DurableClock/<name>` deferred names, and wake completion exits; every
  runtime-computed wait clamps to zero with `Math.max(0, ...)` and pins `inMemoryThreshold` to zero,
  so the engine either persists this covered clock form or skips a passed deadline — it never writes
  the uncovered in-memory short-sleep Activity form;
- awaited and `raceAll/<name>` DurableDeferred names and completion exits; production completes these
  deferreds through the success-only API, and a narrow repository guard rejects unfixtured `done`,
  `fail`, or `failCause` completion forms;
- the generic persisted resume message and its empty primary key;
- every queue handoff, including queues that do not start a Workflow: queue names, payload encodings,
  and primary-key derivation.

Identity strings are deployment contracts: Workflow tags, Activity names, clock and deferred names,
queue names, idempotency keys, execution ids, and primary keys. The typed compatibility spec for each
Workflow or standalone queue references its production schemas and identity functions directly. A
narrow per-file primitive-call inventory makes a new Activity, clock, deferred, or queue declaration
fail until its fixture manifest is updated. The tests reject changes to those contracts, to a
currently written encoded shape, or to fixture coverage.

Terminal result forms are pinned mechanically. The harness reads the production Schema AST, collects
every literal identity a Workflow or Activity result can decode to — union members, tagged structs,
top-level literal unions, and declaration-wrapped error classes — and every literal field of a
record-shaped Workflow or queue payload, then requires a fixture whose decoded value carries each one.
Adding a result variant or widening a payload's literal field fails the suite until a fixture pins the
new form, and a union member with no literal identity fails closed instead of being silently skipped.
Re-verify that scan against the checked-out Effect source when upgrading Effect, because it reads the
public `SchemaAST` node shapes rather than only the schemas' decoded types.

The harness mirrors the engine-private `ActivityRpc`, `DeferredRpc`, `ClockRpc`, and `ResumeRpc`
payload schemas and the engine-private Activity and resume primary-key compositions. Re-verify those
mirrors against the checked-out Effect source when upgrading Effect, because the engine does not
export them and the fixtures would otherwise decode against a stale shape.

## Additive revisions

An additive revision widens the reader with an explicit decoding default or union. It ships in two
trunk releases:

1. **Release N (reader).** The new revision decodes both the old and new encodings but still writes the
   old one. Add a `current: false` fixture for every old form that may remain in SQL — payloads,
   Workflow results, Activity requests/results, resume messages, queue payloads, and clock/deferred
   completion exits all carry `current`. Add `reencoded` only when the current reader intentionally
   writes different bytes; otherwise its absence asserts byte stability. Existing `current: true`
   fixtures must re-encode byte-for-byte.
2. **Release N+1 (writer).** After release N is running on every runner that can acquire any shard,
   switch the writer to the new encoding. Move the newly current form to `current: true` and keep the
   old form as `current: false` until no non-terminal execution can still emit it.
3. **Later removal.** Remove an old reader branch only when draining or migration (below) proves no
   reachable execution depends on it.

Never combine use and removal in one release. During the overlap, both revisions must share the same
definition and envelope version; a decoder that silently reinterprets old bytes is not compatible.

## Incompatible changes

A change is incompatible when old bytes cannot be read as the new form: renamed or removed Workflow
tags, Activity names, clock/deferred names, or queue names; changed idempotency-key or primary-key
functions; changed shard configuration; or a removed payload variant without a two-way decoder.

Incompatible changes require an explicit **drain or migration** decision recorded in the pull request:

- **Drain.** Stop admitting new executions for the affected tag, then wait until the owning retention
  queries in the [durable execution inventory](../architecture/durable-execution-inventory.md) report
  zero pending, suspended, callback-waiting, retrying, exhausted, ambiguous, and armed executions.
  Deploy the replacement only after that state is empty. Because any runner may acquire any shard,
  "empty" means the shared stores, not one runner's in-memory mailbox.
- **Migration.** Translate the stored envelopes with a reviewed, explicit SQL migration — payloads,
  primary keys, and entity ids together, in one transaction. Never repair persisted values by casting
  or reinterpreting decoded data.

The tests do not authorize removal by themselves. They prove the current revision still reads what may
exist; they cannot prove that old writers are gone from the fleet.

## Pre-deploy check

Before promoting a release that touches a durable boundary:

1. `bun run typecheck` and the compatibility suite pass, including the registry guard that every
   production `Workflow.make` tag has exactly one fixture and the variant guard that every literal
   result form and payload field has a fixture. A new result variant or payload literal is a reader
   change: add its fixture in the same release that teaches the reader to decode it.
2. The fixture diff adds only `current: false` forms, or this release is the writer release whose
   `current: true` changes were already readable in the previous release.
3. No identity string changed. If one did, the pull request links the drain or migration evidence:
   the bounded count queries used, their before/after values, and the migration if any.
4. Every runner that may acquire a shard runs a revision that decodes every reachable form before the
   writer revision reaches the fleet. Railway deploys one revision at a time; confirm the prior
   revision is still running the widened reader.
5. Do not regenerate fixtures to make a failing test pass. A fixture change is a contract decision:
   either the code or the rollout plan is wrong.
