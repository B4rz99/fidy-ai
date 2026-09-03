# Effect v4 durable workflows

> Source: Effect checkout at `.repos/effect`, version RC.112. Citations below are relative to `.repos/effect/packages/`.

Use this reference before implementing a multi-step durable operation, replacing workflow state columns, scheduling durable waits, awaiting a callback, or dispatching workflow-owned external work.

## Mental model

`Workflow.make` defines a named protocol with payload, success, and error schemas plus an explicit idempotency-key function. The engine hashes the workflow tag and that key into the execution id; repeated execution with the same pair addresses the same durable execution (`effect/src/unstable/workflow/Workflow.ts:316-365`, `:429-466`). Use a stable domain operation id as the key. Do not derive it from mutable fields or secrets.

A workflow body is ordinary Effect code registered with `Workflow.toLayer`. On suspension or runtime loss the body may be entered again; durability comes from the engine's persisted workflow/activity requests and the durable primitives, **not** from a persisted instruction-by-instruction event history. Keep orchestration pure and cheap between durable boundaries. Never put an unwrapped provider mutation directly in the body.

`execute` validates the payload and either waits for the result or, with `{ discard: true }`, submits without waiting. `executionId`, `poll`, `resume`, and `interrupt` use the same derived identity (`effect/src/unstable/workflow/Workflow.ts:327-405`). Production must provide the cluster engine described in `.patterns/cluster.md`; `WorkflowEngine.layerMemory` is only a volatile testing/development engine.

## Activities are the durable side-effect boundary

Define external or otherwise retry-sensitive steps with `Activity.make({ name, success, error, execute })`. The activity executes through the current workflow engine; `Activity.idempotencyKey` derives a stable key from the current workflow execution and activity attempt (`effect/src/unstable/workflow/Activity.ts:123-178`, `:246-269`, `:300-324`). In the cluster engine, the persisted activity request primary key is `${activity.name}/${attempt}` (`effect/src/unstable/cluster/ClusterWorkflowEngine.ts:228-250`, `:661-680`, `:743-744`).

Activity names therefore form persisted identity. Keep them stable and unique for distinct logical steps in one execution. Reusing a name at the same attempt can alias the persisted result; renaming creates a new side effect on re-entry.

An activity retries interruption with a built-in schedule capped at ten recurrences before returning suspension (`effect/src/unstable/workflow/Activity.ts:181-210`). `Activity.retry` advances the durable attempt number according to the supplied schedule rather than pretending all attempts are one request (`effect/src/unstable/workflow/Activity.ts:212-244`). Model expected provider/domain failures in the activity error schema and choose retry schedules by error class.

### The unavoidable provider ambiguity

An activity can make a provider mutation and crash before its reply is durably stored. On recovery that activity request can run again. The workflow engine cannot infer whether the provider committed. This is at-least-once external execution, not exactly once.

For every mutating provider activity, use one of:

1. a provider idempotency key derived from workflow execution + stable activity name;
2. reconciliation by provider operation id before repeating;
3. an explicitly reviewed operation that is safe at least once.

Persist provider correlation facts needed for reconciliation. Do not “fix” ambiguity with a broad PostgreSQL lock or a transaction held across the network.

## Durable waiting and handoff

### `DurableClock`

`DurableClock.sleep` uses an in-memory sleep below a threshold and the workflow engine's durable scheduling at or above it. The default threshold is 60 seconds and can be overridden per call (`effect/src/unstable/workflow/DurableClock.ts:42-61`, `:70-117`). Use it for business waits that must survive restart; use ordinary `Effect.sleep` for short process-local pacing. Test the boundary explicitly if configuration changes it.

### `DurableDeferred`

A durable deferred is named and schema-backed. `await` suspends the workflow until the engine records completion; `done`, `succeed`, and `fail` complete it from another process (`effect/src/unstable/workflow/DurableDeferred.ts:84-161`, `:468-559`). `raceAll` can await multiple deferreds, but the result remains tied to their stable names (`effect/src/unstable/workflow/DurableDeferred.ts:260-315`).

A token serializes workflow name, execution id, and deferred name into base64url; parsing only decodes and validates that tuple (`effect/src/unstable/workflow/DurableDeferred.ts:317-398`). Treat a token as a routing capability, **not as authenticated authorization**. Callback routes must independently authenticate the caller, authorize the target User/workflow, enforce replay policy, and avoid logging tokens.

Names are persisted identity. Keep each deferred name stable and unique in the workflow execution. Store only bounded callback facts in its success/error schema.

### `DurableQueue`

`DurableQueue.process` composes three native primitives: a `PersistedQueue`, an activity-derived stable item id, and a `DurableDeferred`; it offers work and suspends until a worker completes the deferred (`effect/src/unstable/workflow/DurableQueue.ts:117-148`, `:178-242`). Use it when workflow orchestration and work execution belong in different worker pools.

`makeWorker` runs one worker by default, supports explicit concurrency, captures the handler `Exit`, completes the deferred, and only then lets the persisted queue item complete (`effect/src/unstable/workflow/DurableQueue.ts:255-333`). The same crash gap exists between the handler's provider effect and deferred/queue completion, so workers still require provider idempotency or reconciliation. Queue payload and retention rules from `.patterns/persisted-queue.md` apply.

Do not use `DurableQueue` merely to call a local function. Use it when independent scaling, isolation, or durable handoff is a real requirement.

## Failure, suspension, interruption, and compensation

A completed workflow result durably contains a schema-encoded `Exit`; suspension is a distinct result. `Workflow.intoResult` captures typed failure and, by default, defects, while suspension is represented only when the workflow intentionally marks itself suspended (`effect/src/unstable/workflow/Workflow.ts:468-590`, `:862-880`). Keep defects for violated invariants; model operational outcomes as typed errors.

Durable primitives suspend by marking the workflow instance and interrupting its current fiber (`effect/src/unstable/workflow/Workflow.ts:859-866`). Suspension is not failure and must not trigger domain failure handling. An explicit workflow interrupt is terminal intent; define who may request it and what compensation means.

`Workflow.withCompensation(step, compensate)` registers compensation only after `step` succeeds and runs it if the **overall** workflow later fails. The source explicitly warns that this is for top-level effects and does not work for nested activities (`effect/src/unstable/workflow/Workflow.ts:807-857`). Compensation is itself an external effect with retry/crash ambiguity. Make it idempotent. If reliable provider compensation needs its own durable attempts, model an explicit compensation phase and Activity in the top-level orchestration rather than assuming a finalizer is exactly once.

## Schema evolution

Payloads, activity results, workflow results, deferred completions, and durable-queue items are decoded later with the currently deployed schemas. There is no application payload migration registry in these APIs. Apply the compatibility discipline from `.patterns/schema.md`:

- prefer additive optional fields and tolerant decoding;
- retain decoders for every in-flight encoded form;
- version a workflow/activity/deferred name only when deliberately creating new persisted identity;
- drain or explicitly migrate incompatible in-flight executions before removing old decoders;
- never change an idempotency-key algorithm for an existing workflow name without treating old executions separately.

Because workflow names and execution ids are cluster entity/message keys, deployment skew matters. During rolling deploys, every runner that can own the shard must understand all in-flight request and result schemas.

## User and data boundaries

Every workflow payload must carry explicit `UserId` plus bounded domain identifiers. At every activity or repository boundary, activate the User database scope before reading/writing. The generic workflow engine does not establish Fidy's RLS context or infer ownership.

Do not persist access tokens, credentials, raw emails, unbounded provider responses, or browser/session objects in workflow payloads/results. Persist references and minimal reconciliation facts. Apply safe span attributes: execution ids and low-cardinality operation names are useful; User data, provider payloads, deferred tokens, and error bodies are not.

## Tests required before adoption

Use the memory engine for fast orchestration tests and the cluster SQL engine for durable integration tests. Cover:

1. duplicate execute calls with one idempotency key produce one logical execution;
2. suspension and later callback/sleep resume after runtime replacement;
3. crash after simulated provider commit but before activity reply does not duplicate the provider outcome;
4. typed activity retries and terminal failures preserve the expected workflow `Exit`;
5. interruption produces the intended compensation exactly in domain outcome terms;
6. old payload, activity-result, and deferred-result encodings decode under the new deployment;
7. callback authorization rejects a valid token belonging to another User;
8. no sensitive values enter durable rows, errors, logs, or spans.

The upstream suites exercise memory-engine retry/suspend/deferred behavior and cluster-engine replay, interruption, polling, and activities (`effect/test/unstable/workflow/WorkflowEngine.test.ts:1-285`, `effect/test/cluster/ClusterWorkflowEngine.test.ts:1-1482`). Mirror the relevant contract, but do not treat memory tests as proof of SQL/process-loss behavior.
