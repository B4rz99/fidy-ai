# Architecture

## System ownership

This private Bun workspace owns the lockfile, CI, and repository-wide checks. Its packages have
separate responsibilities:

- [`@fidy/server`](apps/server/ARCHITECTURE.md) owns the domain model, canonical operations and
  schemas, provider-neutral contracts, and Cloudflare Worker adapters.
- [`@fidy/web`](apps/web/ARCHITECTURE.md) owns the React/Vite browser application and static artifact.
- [`@fidy/cloudflare-infra`](infra/cloudflare/) owns the Alchemy stack, resource wiring, and edge
  policy, but no domain model or Worker implementation.

Cloudflare is the sole Production runtime authority. D1, Durable Objects, Queues, Workflows, R2,
Workers AI, and Email Workers serve distinct adapter seams; an unimplemented seam returns a typed
unavailable result rather than falling back to process-local state or a different provider. Railway,
PostgreSQL, and the Bun process runtime were superseded by
[ADR 0026](docs/adr/0026-cloudflare-native-production-replatform.md).

## Cross-application contract

The server declares canonical operations once for HTTP, typed clients, MCP, and the hosted agent.
The web derives its typed client from the browser-safe server declaration, without importing server
implementations or copying the contract. The server generates OpenAPI and operation-policy artifacts
as review evidence, not competing declarations. The project-reference build orders server before
web; the root gate checks generated artifact freshness and compatibility with the pull-request base. See
[Contract compatibility](docs/contract-compatibility.md).

Two transports sit outside the stable-User canonical operation surface: proof-bearing credential
bootstrap before a stable User exists, and bounded, User-authenticated statement-byte staging before
a canonical mutation publishes the bytes. The bootstrap establishes authority only after proof
exchange; staging returns no readable content, grants no authority, and expires if unpublished. The
bootstrap's direct-client contract is checked separately;
staging's limits and publication boundary are specified in
[ADR 0028](docs/adr/0028-statement-bytes-are-staged-outside-atomic-batches.md).

## Production boundary

[`infra/cloudflare/alchemy.run.ts`](infra/cloudflare/alchemy.run.ts) is the sole Production topology
authority. One stack deploys an assets-only web Worker at `app.fidyapp.com`, redirects `fidyapp.com`
there, and exposes an ingress Worker at `api.fidyapp.com`. The Core Worker is private behind the
ingress service binding and alone owns the D1 binding; the ingress has no direct database access.
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

GitHub Actions rechecks trunk immediately before deploying an exact source revision, then verifies
the redirect, static artifact, and bound health response. Workstation and provider-controlled source deployments
are not release paths. See the [Production runbook](docs/operations/production-releases.md).

## Identity and verification

Browser login retains a private verifier in the browser. WhatsApp approval, verified email, or
support recovery can approve a pairing for the same stable User, but cannot establish a session
without that verifier. One approved pairing bootstraps one web session. The server verifies proof
and owns session authority; the web keeps private material out of URLs, public references, and
unrelated application state.

The root gate combines contract checks, portable behavior tests, built-browser tests, and Cloudflare
adapter tests. Browser API scenarios currently use explicit HTTP fixtures; they do not by themselves
prove a browser-to-real-Worker flow. Cloudflare integration tests exercise the relevant Worker and
platform boundaries locally; live Workers AI behavior has a separate release gate. Application-specific test seams belong in the application architecture documents.
