# Alchemy v2 resources and Cloudflare topology

Use when declaring Cloudflare resources, connecting Worker bindings, or changing deployment state
and release behavior. Public imports are `alchemy`, `alchemy/Cloudflare`, and `alchemy/Output`.

API authority is installed `alchemy@2.0.0-beta.80`, including Fidy's retained patch, not the older
`.repos/alchemy` snapshot. Selected sources under `node_modules/alchemy/src/` are `Phase.ts`,
`Stack.ts`, `Cloudflare/Website/StaticSite.ts`, and `Cloudflare/Workers/{Worker,WorkerProvider}.ts`.
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
Bootstrap the provider's remote state before the first plan, and pass explicit approval for
non-interactive deployment. Scope `AdoptPolicy.adopt(true)` to a known existing resource, not the stack.

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

Source symbols in beta.80: `Resource` / `ResourceLike.FQN` in `src/Resource.ts`, `PropsInput` in
`src/Input.ts`, and `ResourceExpr`, `PropExpr`, `map`, `evaluate` in `src/Output.ts`.

## Storage and private bindings

Follow the `database`, `statementStagingBucket`, `emailBucket`, and `core` declarations in
[the stack](../infra/cloudflare/alchemy.run.ts). Inside its `Effect.gen`, the D1 recipe is:

```ts
const database =
  yield *
  Cloudflare.D1.Database("Database", {
    migrations: "../../apps/server/cloudflare/migrations",
    readReplication: { mode: "disabled" },
  });
```

Pass `database` as the appropriate Core `env` binding, not its database ID. `DatabaseProps.migrations`
applies pending files during deployment and owns `__alchemy_migrations`; adopting an existing
Wrangler/Drizzle history is a one-way conversion. Fidy's release policy requires additive,
forward-only migrations and immutable applied files. Use the existing migration/release owners,
not a second migration tool. See [SQL atomicity](sql.md) for runtime operations.

`Cloudflare.R2.Bucket("StatementStagingBucket")` creates the resource used by Core's private byte
staging binding. Keep `publicAccess` disabled and omit public `domains` for these private buckets.
`BucketProps.lifecycleRules` can expire objects but does not implement Fidy's authorization,
publication, or retention reconciliation. `forceDestroy` defaults to false: deleting a nonempty
bucket fails instead of emptying it. Keep that protection for retained data.

Sources: `DatabaseProps`, `Database`, `ProviderLive` in `src/Cloudflare/D1/Database.ts`;
`BucketProps`, `BucketLifecycleRule`, `Bucket` in `src/Cloudflare/R2/Bucket.ts`.

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
`queueHandlerReadinessSchedule` in `src/Cloudflare/Queues/Consumer.ts`; `Queue` in
`src/Cloudflare/Queues/Queue.ts`.

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
`src/Cloudflare/Workers/DurableObject.ts`; `WorkflowRefProps`, reference-form `Workflow` in
`src/Cloudflare/Workflows/Workflow.ts`; `LiveWorkerProvider` environment serialization in
`src/Cloudflare/Workers/WorkerProvider.ts`.

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

Invoke beta.80 via `node_modules/alchemy/bin/alchemy.js` with the pinned Bun, as existing scripts do.
The package's `bin/cli.js` wrapper applies a package TS configuration that loses Fidy's aliases.
Use the existing entrypoint rather than adding another loader or runtime fallback.

The patch `patches/alchemy@2.0.0-beta.80.patch` preserves and verifies the uploaded Worker version
receipt using `getScriptVersion`. It also forwards placement into self-rollout version metadata,
verified with the [native placement controls](https://github.com/B4rz99/fidy-ai/blob/8ddab8fedb4f8e62837017f99f0484ca065bd80a/docs/research/core-placement-2026-10-30.md).
An upload receipt is not proof of active traffic assignment;
retain the deployment/version checks at their existing owners.

Production uses the public `Alchemist.Stack.plan` / `Apply.apply` seam in
`production-resources.ts`. The same retained patch adds `deletions: "defer"` (skip garbage
collection, preserve tracked generations, refuse delete-first replacements) and `"only"`
(refuse deployment changes and run native garbage collection without reconciliation). Ordinary
Apply behavior is unchanged. The protected workflow retires resources only after promotion and
normal-traffic checks; the runner rechecks the exact promoted pair immediately before deletion.

Local acceptance starts the declared stack and exercises ingress-to-Core service bindings. A fake
binding proves projection/failure behavior only, not platform parity. Bind validated immutable Git
revision and contract digest values, and expose only the closed health projection—never environment
objects, topology, Secrets, or raw exceptions.

## Verification seams

For a topology change, inspect the plan's resource identities and resolved binding graph using the
existing release tooling. Exercise local ingress-to-Core bindings through
[`local-emulation.test.ts`](../infra/cloudflare/local-emulation.test.ts); resource-specific behavior
needs the corresponding Cloudflare adapter tests. Release receipt and deferred-retirement behavior
have focused tests in [`production-resources.test.ts`](../infra/cloudflare/production-resources.test.ts)
and [`resource-retirement.test.ts`](../infra/cloudflare/resource-retirement.test.ts). A fake binding
or successful local emulation does not prove remote provider convergence.

Sources above were inspected in the beta.80 tarball verified against `bun.lock` on 2026-10-12;
the retained patch passed `git apply --check` against that package. This is source verification,
not a live-cloud deployment result.
