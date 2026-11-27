# Alchemy v2 resources and Cloudflare topology

Use when declaring Cloudflare resources, connecting Worker bindings, or changing deployment state
and release behavior. Public imports are `alchemy`, `@alchemy.run/cloudflare`, and `alchemy/Output`.

API authority is installed `alchemy@2.0.0-beta.87`, including Fidy's Cloudflare provider patch, not the older
`.repos/alchemy` snapshot. The core package owns `Stack.ts`. Provider sources live under
`node_modules/@alchemy.run/cloudflare/src/`, including `Website/StaticSite.ts` and
`Workers/{Worker,WorkerProvider}.ts`.
Fidy's composition is `infra/cloudflare/alchemy.run.ts`; see [the source map](effect-4-stable.md)
for CLI and WorkerProvider patch behavior.

## One stack, explicit state authority

One `Alchemy.Stack` with `Cloudflare.providers()` owns the deployment. Fidy selects
`Cloudflare.state()` only for supported Production deployment, `Alchemy.localState()` for
`ALCHEMY_DEV`, and in-memory state during provider discovery or unsupported-stage rejection.
Invalid stages must be rejected before they contact remote state.

Alchemy's CLI sets `ALCHEMY_DEV`; a configured profile is still required for local emulation.
A placeholder profile is safe only with local state and local resource modes. CI uses an ephemeral
profile from environment credentials; credentials stay out of command arguments and repository files.
Run `alchemy state bootstrap --backend cloudflare` from the provider workspace before
the first remote plan. The command adopts or upgrades the existing store and preserves its
credentials and deployment state. Pass explicit approval for non-interactive deployment. Scope `AdoptPolicy.adopt(true)` to a known existing resource, not the stack.

## Stable identity and output-dependent inputs

The first resource argument is a logical ID. `Resource` qualifies it with its namespace and registers
it in the stack; state is selected by stack/stage. Keep IDs stable across deploys, independent of
array position, time, and release SHA. Renaming an ID or changing its namespace is a state-identity
change: inspect the plan for replacement/deletion before treating it as a refactor. An explicit
physical `name` and a Worker environment binding key are different identities.

`yield* Cloudflare.Queues.Queue("ForwardedEmailQueue")` registers a resource and returns its
output-bearing handle; it does not mean a remote API call has finished. Pass resource handles to
Worker `env` for native bindings, and pass attributes such as `queue.queueId` to resource inputs.
These references retain the dependency graph. Transform an attribute with `Output.map` from
`alchemy/Output` when necessary; keep that transform pure. Avoid stringifying an unresolved Output
or copying a provider ID from an earlier deployment. The existing
[`resolveAccessConfig`](../infra/cloudflare/alchemy.run.ts) demonstrates output-dependent inputs:
`identity.identityProviderId` and `operators.groupId` feed the Access Application declaration.

Source symbols in beta.87: `Resource` / `ResourceLike.FQN` in `src/Resource.ts`, `PropsInput` in
`src/Input.ts`, and `ResourceExpr`, `PropExpr`, `map`, `evaluate` in `src/Output.ts`.

## Storage and private bindings

Follow the `statementStagingBucket`, `emailBucket`, and `core` declarations in
[the stack](../infra/cloudflare/alchemy.run.ts). Per-User persistence is the SQLite storage owned
by each Durable Object; it is not provisioned as a shared Alchemy database resource. Schema and
release checks use the SQLite Durable Object owners and their first-install verifier. See
[SQL atomicity](sql.md) for runtime operations.

`Cloudflare.R2.Bucket("StatementStagingBucket")` creates the resource used by Core's private byte
staging binding. Keep `publicAccess` disabled and omit public `domains` for these private buckets.
`BucketProps.lifecycleRules` can expire objects but does not implement Fidy's authorization,
publication, or retention reconciliation. `forceDestroy` defaults to false: deleting a nonempty
bucket fails instead of emptying it. Keep that protection for retained data.

`BucketProps`, `BucketLifecycleRule`, `Bucket` in `src/R2/Bucket.ts`.

## Queue producers, consumers, and dead letters

An `env` Queue binding permits producing messages; a separate `Queues.Consumer` attaches the
Worker's `queue` handler. After declaring both queues and Core, the existing stack uses:

```ts
yield *
  Cloudflare.Queues.Consumer("BrowserPairingEmailConsumer", {
    queueId: browserPairingEmailQueue.queueId,
    scriptName: core.workerName,
    deadLetterQueue: asyncDeadLetters.queueName,
    settings: { batchSize: 10, maxRetries: 3 },
  });
```

`queueId` is an ID, `scriptName` is the Worker name, and `deadLetterQueue` is a queue **name**.
The resource accepts `maxConcurrency`, `maxWaitTimeMs` (milliseconds), and `retryDelay` (seconds)
in addition to the shown batch/retry controls. Choose bounds from the consumer's work budget;
these settings do not supply idempotency. Fidy publishes bounded identities from transactional
outboxes and reconciles missed publication; handlers must tolerate redelivery. Dead letters require
an operational reader and recovery path: use the existing
[background-work runbook](../docs/operations/cloudflare-background-work.md).

The provider supports one Worker consumer per queue and refuses a conflicting script. Its bounded
queue-handler-readiness retry handles propagation after upload; it is separate from message retries.
Source symbols: `ConsumerProps`, `ConsumerSettings`, `ConsumerProviderLive`,
`queueHandlerReadinessSchedule` in `src/Queues/Consumer.ts`; `Queue` in
`src/Queues/Queue.ts`.

## Durable Object, Workflow, and secret bindings

Fidy uses reference-form bindings for native classes exported from
[`core-worker.ts`](../apps/server/cloudflare/core-worker.ts). Inside Core's `env`:

```ts
USER_TRANSACTION_COORDINATOR: Cloudflare.DurableObject("UserTransactionCoordinator", {
  className: "UserTransactionCoordinator",
}),
STATEMENT_EXTRACTION_WORKFLOW: Cloudflare.Workflow("StatementExtractionWorkflowV1", {
  className: "StatementExtractionWorkflowV1",
}),
```

These reference forms are plain binding descriptors, without `yield*`. Match `className` to the
entrypoint's actual exported class. Omitting `scriptName` hosts the class on this Worker; a
cross-Worker reference sets `scriptName` to the owning Worker's `workerName` Output. Preserve
Durable Object identity and Workflow version semantics when changing bindings/classes. Alchemy
wires deployment metadata; the owner still implements coordination, replay-safe steps, failure
handling, and bounded payloads. See [native Workflows](workflows.md).

Read secrets with `Config.Redacted` from `effect/Config` and pass the resulting `Redacted<string>`
directly as a Worker `env` value, as `KAPSO_API_KEY` and `GOOGLE_CLIENT_SECRET` do in the stack.
WorkerProvider serializes this as `secret_text`; a plain string becomes `plain_text`. Redaction is
not authorization or a promise that deployment state never contains sensitive values. Keep secrets
out of stack outputs, logs, static-site build inputs, and client-visible configuration; use the
existing protected credentials/state owners.

Sources: `DurableObjectProps`, reference-form `DurableObject` in
`src/Workers/DurableObject.ts`; `WorkflowRefProps`, reference-form `Workflow` in
`src/Workflows/Workflow.ts`; `LiveWorkerProvider` environment serialization in
`src/Workers/WorkerProvider.ts`.

## Assets and Worker exposure

`Cloudflare.Website.StaticSite` builds and hashes assets. Without `main` or `script`, it deploys an
assets-only Worker. Use `cwd` for the owning workspace and explicit release inputs for its build.
Preserve `_headers`; the assets layer applies it independently of application code.

A Worker value in another Worker's `env` declares a native service binding. Fidy's public ingress
calls private Core through that binding; public ingress does not receive Core's storage bindings.
For private Core, use `workersDev: false` with no public domain/routes. This disables both stable
and preview `workers.dev` URLs, not just the primary URL.

`domain.name` declares the canonical hostname; `domain.redirects` creates permanent edge redirects
preserving path and query. Redirect hostnames do not appear in `worker.urls`. Under local development,
`worker.urls` contains local server addresses instead of production URLs.

## Runtime and deployment evidence

Invoke beta.87 via `node_modules/alchemy/bin/alchemy.js` with the pinned Bun, as existing scripts do.
The package's `bin/cli.js` wrapper applies a package TS configuration that loses Fidy's aliases.
Use the existing entrypoint rather than adding another loader or runtime fallback.

The provider verifies uploaded Worker version receipts with `getScriptVersion` and forwards
placement into rollout metadata. The retained Cloudflare provider patch lets queue consumer
retirement converge when the parent queue is already gone. Verify traffic assignment at the
existing deployment check.

Production deploys use the plain CLI `deploy` and `plan` commands from `infra/cloudflare/package.json`
and `infra/docs/package.json`; no script drives `Apply.apply` directly.

Local acceptance starts the declared stack and exercises ingress-to-Core service bindings. A fake
binding proves projection/failure behavior only, not platform parity. Bind validated immutable Git
revision and contract digest values, and expose only the closed health projection—never environment
objects, topology, Secrets, or raw exceptions.

## Verification seams

For a topology change, inspect the plan's resource identities and resolved binding graph in the
pull request's plan summary. Exercise local ingress-to-Core bindings through
[`local-emulation.test.ts`](../infra/cloudflare/local-emulation.test.ts); resource-specific behavior
needs the corresponding Cloudflare adapter tests. The declared production graph has a focused test in
[`native-application-plan.test.ts`](../infra/cloudflare/native-application-plan.test.ts). A fake binding
or successful local emulation does not prove remote provider convergence.

Sources above were inspected in the beta.87 tarball verified against `bun.lock` on 2026-11-26;
the retained patch passed `git apply --check` against that package. This is source verification,
not a live-cloud deployment result.
