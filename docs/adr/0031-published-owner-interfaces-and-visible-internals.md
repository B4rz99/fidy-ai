# Published owner interfaces and visible internals

- **Status:** Accepted
- **Date:** 2026-10-02
- **Refines:** ADR 0003's layer-major core/shell and slice ownership; ADR 0026's native Cloudflare boundaries
- **Supersedes:** ADR 0003's `reference.ts` publication detail

## Context

Layer boundaries preserve purity, but do not by themselves say which part of an owner another
module may know. A private repository, provider adapter, storage projection or runtime constructor
can otherwise become a dependency merely because it is exported from a file. A ticket-by-ticket
privacy list also leaves the next owner unprotected.

The server has one domain model and several explicit Cloudflare compositions. Publication must
cover the portable and native trees, tests, application tooling and repository infrastructure
consumers together. A test filename, type-only import, alias or package export does not make a
private dependency safe.

## Decision

Each owner or named module earns only the interfaces its callers need:

```text
owner/
  contract.ts       declarations, schemas and pure schema construction
  operations.ts     substantive behavior callers may invoke
  runtime.ts        construction and fixed-policy runtime authority
  internal/         visible, owner-private implementation
```

The trio is optional, not a requirement to create three empty files. A data-free coordinator owns
no repository or second ledger. Cross-module dependencies target contracts or operations; runtime
imports belong to runtime composition. Same-owner private implementation may construct another
published runtime only when it is reachable exclusively from its own runtime, rather than from its
contract or operations. Explicit application entrypoints, broad platform integration compositions
and owner tooling have named roles. An arbitrary `*-runtime.ts`, `*-harness.ts` or test filename
does not acquire that role.

Contracts know declarations, pure schema construction and the canonical API declaration assembly,
not operations, construction authority or private implementation. Internals may use their contract
and sibling internals, but cannot import their own outward operations or runtime. Portable core and
shell never import native implementations. Core remains pure and cannot import shell or platform I/O.
All dependency cycles are rejected, including native modules.

The exact Shared Kernel remains Money/Currency, product context and time. It owns no aggregate,
provider or platform behavior. Former shell-wide helpers have honest homes: bounded transport bytes
and immutable inference context are private to their owners; owner-write and partial-input schemas
are named declaration protocols; route matching belongs to Public HTTP. SourceAttestation is a
named declaration owner for captured source evidence, avoiding a circular Transactions/Ingestion
contract. Stable ids and schemas keep a single definition.

Published interfaces declare their surface instead of aliasing private values, storage rows,
provider shapes or types. Published Trio files contain direct declarations rather than TypeScript
namespace or module blocks; those wrappers cannot become a second publication surface. Resolved dependency checks and bounded export-provenance checks reject supported direct,
local, namespace and type re-export patterns. They do not prove absence of all semantic leakage;
code review applies the public-surface criteria below. Public declaration assembly may reuse another
published schema; it never makes that owner's implementation public. Browser publication and deployed Worker
export identities remain explicit outward compositions. There are no compatibility `reference.ts`
files, runtime barrels or generic shell helper paths.

Owner-local tests may reach their owner's private implementation. Foreign tests use publications;
explicit broad D1, Durable Object, Workflow and browser compositions may construct published
runtimes. Synthetic fixtures cannot become production or Published Trio dependencies. Private
fixtures remain beside their owner; platform binding and credential/cryptography harnesses have a
closed, named inventory.

The final graph gate applies these rules to every owner from resolved paths, including future
owners. Every application and repository source, test, script, tool and root configuration is a graph
root, whether tracked or untracked. Checked-in upstream reference checkouts, ignored generated
output and installed dependencies are not independent source roots. Missing source
coverage, unresolved imports and an empty graph cannot count as successful enforcement. Negative
probes must identify the precise rejected edge, while positive probes preserve legitimate owner
implementation and composition.

## Public-surface review

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

## Consequences

Callers state whether they need a declaration, behavior or runtime construction. Moving private
implementation does not require a foreign caller edit. General privacy and direction rules replace
the need to grandfather a newly encountered owner. Narrow browser publication, canonical contract
freshness, native integration evidence and the repository verification gate remain independent
checks.

Publication changes do not authorize production actions. D1 remains authoritative, per-User
Durable Objects serialize rather than own a ledger, and Workflows/Queues retain identity-only
execution boundaries. User isolation, atomicity, consent, provider authenticity, replay, retention
and bounded evidence remain unchanged. Completion of this architecture does not enable onboarding,
Email Routing, deployment, promotion or any live provider workflow.

## Rejected alternatives

- A broad barrel or compatibility re-export preserves the accidental dependency rather than the
  owner interface
- A fixed list of migrated owners leaves future owners and flat implementation filenames exposed
- Blanket test/tool/runtime suffix exemptions turn names into authority
- Copying schemas or moving native implementation into core weakens the canonical contract and
  purity boundaries rather than solving the dependency
