# Architecture

## System ownership

This private Bun workspace owns the lockfile, CI, and repository-wide checks. Its packages have
separate responsibilities:

- [`@fidy/server`](apps/server/ARCHITECTURE.md) owns the domain model, canonical operations and
  schemas, provider-neutral contracts, and Cloudflare Worker adapters.
- [`@fidy/web`](apps/web/ARCHITECTURE.md) owns the React/Vite browser application and static artifact.
- [`@fidy/cloudflare-infra`](infra/cloudflare/) owns the Alchemy stack, resource wiring, and edge
  policy, but no domain model or Worker implementation.

Cloudflare is the sole Production runtime authority. The public ingress Worker has no D1 binding;
the private Core Worker owns the User-scoped data API and primary D1 authority. The unrouted Email
Worker has a narrow D1 binding for forwarded-mail admission and retention. Durable Objects coordinate
per-User work, Queues redeliver bounded identities, Workflows execute durable steps, R2 retains
private bytes, Email Workers admit forwarded mail, and Workers AI handles Fidy-controlled inference.
An unimplemented seam returns a typed unavailable result rather than falling back to process-local
state or a different provider. Railway,
PostgreSQL, and the Bun process runtime were superseded by
[ADR 0026](docs/adr/0026-cloudflare-native-production-replatform.md).

## Owner publication

The server uses optional Published Trio interfaces: `contract.ts` declares schemas and meaning,
`operations.ts` owns substantive behavior, and `runtime.ts` owns construction and fixed-policy
runtime authority. Implementation remains visibly private under its owner. Cross-module dependencies
use earned publications; source, tests, scripts, tools and infrastructure obey the same resolved
boundary. Core purity and the explicit Cloudflare compositions remain separate requirements.
See [ADR 0031](docs/adr/0031-published-owner-interfaces-and-visible-internals.md).

### Public-surface review

A published interface must not forward private implementation identities or private storage/provider
shapes through aliases, object members, factories, inferred return values, or exported types. Review
what callers can actually obtain, including indirect exports: renaming a private function or returning
it from a factory does not make it a public operation. A substantive public wrapper that owns its
behavior and a deliberate public data projection are allowed; they may invoke private implementation
without exposing it. Automated dependency and export checks cover bounded syntactic patterns, not
all semantic leakage. During code review, agents must inspect the public surface and trace forwarded
values and types to their owners, even when every automated check passes.

For each changed published interface, reviewers check:

- **Forbidden forwarding:** `export { privateRead as read }`, `export const api = { privateRead }`,
  or `export const makeApi = () => privateRead` exposes the private function itself. The same rule
  applies through intermediate aliases, mutations, computed members, class members and type aliases.
- **Forbidden type exposure:** publishing an internal row/provider type, or an API signature that
  exposes that implementation shape, couples callers to private representation even without a value export.
- **Allowed boundary:** an owner operation invokes `privateRead`, applies its domain policy and
  returns a deliberate public result defined by its contract. Runtime construction may return its
  intended public service, keeping private adapters and implementation handles enclosed. Reusing
  another owner's published declaration is allowed without copying or exposing its private model.
- **Finding evidence:** name the exported symbol, trace the private value or type it exposes and
  explain which implementation detail the caller can now depend on. An unsupported hypothetical
  syntax form in the checker is not itself a violation; a concrete leak in the changed public surface is.

## Cross-application contract

The server declares canonical operations once for HTTP, typed clients, MCP, and the hosted agent.
The web derives its typed client from the browser-safe server declaration, without importing server
implementations or copying the contract. The server generates OpenAPI and operation-policy artifacts
as review evidence, not competing declarations. The project-reference build orders server before
web; the root gate checks generated artifact freshness, not compatibility with older revisions.
See [Server contract artifacts](docs/server-contract-artifacts.md).

Three transports sit outside the stable-User canonical operation surface: proof-bearing credential
bootstrap before a stable User exists, bounded User-authenticated statement-byte staging before a
canonical mutation publishes the bytes, and the browser-only hosted Turn conversation channel.
The bootstrap establishes authority only after proof exchange; staging returns no readable content,
grants no authority, and expires if unpublished. The bootstrap's direct-client contract is checked
separately; staging's limits and publication boundary are specified in
[ADR 0028](docs/adr/0028-statement-bytes-are-staged-outside-atomic-batches.md).

The hosted Turn channel (`/web/hosted-turns` and `/web/hosted-turns/delivery`) accepts one User message
and a separate visible-delivery receipt. Neither endpoint is a tool-callable operation or belongs in
an atomic batch. Its browser-safe typed API is server-declared in
`apps/server/src/shell/agent/contract.ts`; public and Core Worker adapters enforce cookie,
origin, CSRF, D1, and per-User Durable Object policy. Completion requires an exact authenticated
receipt after visible rendering. A Durable Object alarm interrupts abandoned proposals, with an
independent private Core cron sweep for missing alarms and bounded retention. This channel never
bypasses canonical operation policy for tools.

## Production boundary

[`infra/cloudflare/alchemy.run.ts`](infra/cloudflare/alchemy.run.ts) is the sole Production topology
authority. One stack deploys an assets-only web Worker at `app.fidyapp.com`, redirects `fidyapp.com`
there, and exposes an ingress Worker at `api.fidyapp.com`. The Core Worker is private behind the
ingress service binding and owns the primary D1 binding; the unrouted Email Worker has a narrow
D1 binding for forwarded-mail admission and retention. The ingress has no direct database access.
The static artifact contains no server implementation or Secrets. Local development uses the same
entrypoints, D1 migrations, and binding graph; other remote stages are rejected before resource
creation.

The application combines synchronous D1 commits with durable asynchronous execution. Onboarding,
browser-pairing and replacement email, and billing collection use transactional outboxes, Queues,
and versioned Workflows. Statement extraction also uses a durable outbox and a Queue/Workflow path
through the User coordinator. Prompt email/billing publication follows a commit; cron recovers missed offers and runs
independent reconciliation and retention activities. Shared dead letters and bounded operational
signals expose delivery and execution failures; see the
[background-work runbook](docs/operations/cloudflare-background-work.md). The server architecture
records incomplete execution paths separately from their declared contracts.

GitHub Actions rechecks trunk immediately before deploying an exact source revision. It applies
forward-only additive D1 migrations, smokes exact zero-traffic Worker versions, and promotes only
the verified pair. Rollback can restore compatible Worker code traffic, never D1 or other state.
Workstation and provider-controlled source deployments are not release paths. See the [Production runbook](docs/operations/production-releases.md).

## Identity and verification

Browser login retains a private verifier in the browser. WhatsApp approval, verified email, or
support recovery can approve a pairing for the same stable User, but cannot establish a session
without that verifier. One approved pairing bootstraps one web session. The server verifies proof
and owns session authority; the web keeps private material out of URLs, public references, and
unrelated application state.

The root gate combines generated contract freshness, portable behavior tests, built-browser tests,
and Cloudflare adapter tests. Browser acceptance runs a built production-mode static artifact and real
public/Core Workers on separate loopback HTTPS origins with isolated Miniflare D1. Loopback operator
fixtures simulate external proof/approval delivery and provider responses; focused browser HTTP
fixtures cover presentation and failure cases without substituting for the real-Core journeys.
Cloudflare integration tests exercise the relevant Worker and platform boundaries locally; live
Workers AI behavior has a separate release gate. Application-specific test seams belong in the
application architecture documents.
