# Server architecture

`apps/server` owns Fidy's domain model, canonical API and server-side execution. Read the repository
[architecture](../../ARCHITECTURE.md) for system topology and cross-application boundaries.

## 1. Application shape

| Area            | Responsibility                                                         |
| --------------- | ---------------------------------------------------------------------- |
| `src/core/`     | Pure business decisions and domain schemas                             |
| `src/shell/`    | Operation declarations, orchestration and provider-neutral contracts   |
| `cloudflare/`   | Native entrypoints, persistence, coordination and background execution |
| `contracts/`    | Generated public-contract artifacts                                    |
| `src/client.ts` | Browser/CLI-safe declaration publication                               |

Public ingress owns edge HTTP policy. Private Core composes server execution; per-User Durable
Objects serialize coordinated work, while shared reads and maintenance have separate execution
paths. Infrastructure supplies bindings and resources; domain policy stays with server owners.

## 2. Ownership and publication

A slice owns its data and invariants; a process coordinates slices through their published
interfaces. Pure core code is independent of shell effects and native adapters. Owners expose only
the declarations, operations and runtime construction their callers need. Private storage and
provider representations stay inside the owner.

| Domain area                  | Ownership                                                                     |
| ---------------------------- | ----------------------------------------------------------------------------- |
| Identity and access          | Stable User identity, authentication, browser sessions, PATs and OAuth grants |
| Consent and privacy          | Permission, disclosure evidence, accountability and cross-owner erasure       |
| Financial records            | Transactions, Corrections, Reconciliation, source evidence and Categories     |
| Financial views and planning | Budgets, Dashboard, Recurring detection, planning and Insights                |
| Ingestion and Connections    | Material interpretation and review; institution authorization and lifecycle   |
| Subscription and admission   | Billing, derived AccessTier, commercial allowances and resource protection    |
| Hosted interaction           | Agent Sessions, Turns and conversation; Memory; channel routing and delivery  |

Transactions owns effective financial facts. Financial views and planning consume those published
facts rather than duplicating their selection rules. Shared persistence has an explicit owner;
consumers retain their own domain policy. See [layer ownership](../../docs/adr/0003-layer-major-core-shell-and-slice-ownership.md)
and [published interfaces](../../docs/adr/0031-published-owner-interfaces-and-visible-internals.md).

## 3. Canonical contracts and execution

One API assembly supplies operation discovery, typed clients, HTTP, MCP and hosted tools. Canonical
policy determines caller capabilities and confirmation requirements; execution invokes the owning
behavior. Queries are observational. Individual and atomic-batch mutations share the same guarded
mutation boundary. Dedicated browser and proof transports retain separate authority.

### Hosted MCP and OAuth development authority

MCP exposes canonical capabilities through separately identifiable OAuthConnections. It shares
owner behavior, Consent, accounting and Audit with other clients. OAuth approval and sensitive-action
confirmation remain distinct from browser-session and PAT authority. Protocol details belong in
[the MCP feature](src/shell/mcp/FEATURE.md) and [ADR 0033](../../docs/adr/0033-hosted-mcp-and-oauth-agent-grants.md).

## 4. Subject, proof, and provider boundaries

Protected work carries a stable User and rechecks current authority at the action boundary. Provider
identifiers, transport messages and coordination keys supply context, not reusable permission.
Authentication, Consent and channel routing have separate owners. Privacy controls remain reachable
after Processing Consent withdrawal or commercial expiry.

Provider adapters implement bounded contracts for inference, messaging, authentication, payments
and institution access. Hosted inference uses OpenAI behind a provider-neutral interface. Forwarded
email admission remains disabled pending verifiable institution authority for the exact User;
retained-work processing and erasure remain separate capabilities.

## 5. State and atomicity

Browser Transaction history follows the mounted session digest through the shared Directory to its
UserStore. The UserStore checks its namespace identity, local credential, Consent and erasure fence,
then materializes the financial page, standing and Audit in one SQLite transaction. See
[per-User storage](../../docs/adr/0041-per-user-durable-object-storage-direction.md).

Browser and PAT Budget operations follow the credential through the Directory to the UserStore.
Budget changes commit their monthly plan, group Currency, accounting, Audit and eligible retry
receipt in the same local transaction. Budget status reads combine inherited caps and the
Transaction owner's Effective Transactions in one snapshot. Only outflows in the matching Category
and Currency count toward a cap.

Browser and PAT Dashboard operations use the same Directory routing. Each view reads the Dashboard
document, User calendar, Effective Transaction lists and Budget caps in the SQLite transaction
that commits its Audit. Capture, Correction, linked SourceAttestations and Reconciliation update
the effective leaves and their exact per-Currency minute and day contributions in the financial
write. A failed write or incomplete projection withholds the view.

Browser and PAT Recurring reads and edits use the same UserStore. Its planning ledger keeps
individual plan revisions, exceptions and fulfillments. The workspace selects effective financial
facts and plan history in one transaction. Historical series evaluation advances through bounded
User-local checkpoints under current Processing Consent. Financial changes invalidate the observed
revision and schedule discovery within an hour. The User alarm advances due evaluation.
Maintenance checks the retained revision and repairs the alarm when needed.

The Core minute Cron calls Maintenance to traverse the lifetime registry and check Directory,
Pricing and independent Erasure. A private check inspects retained owner work and repairs the
earliest required alarm. Owner alarms execute the continuation. Maintenance persists its cursor
before each batch and reports interrupted or unanswered checks as unknown. A repaired alarm and
a confirmed domain outcome have separate evidence. A probe whose cancellation cannot settle
stops the tick. Maintenance flushes its progress before resetting the object to release outstanding
I/O. A stalled shared owner runs after the User page budget on the next tick. A stalled User
restores shared-owner priority.

Unmigrated paths still use D1. Canonical mutation units commit live authority, owner
changes, accounting and Audit together. Database guards enforce ownership and revisions alongside
per-User coordination. Shared reads preserve the same authorization and accountability boundaries.

R2 writes and provider calls cannot join that transaction. Retained intent connects committed state
to external execution; ambiguous outcomes require owner reconciliation. Erasure coordinates owner
cleanup and uses an independent registry to prevent restored data from regaining authority.
See [atomic accountability](../../docs/adr/0029-atomic-batch-accountability-boundaries.md) and
[statement staging](../../docs/adr/0028-statement-bytes-are-staged-outside-atomic-batches.md).

## 6. Hosted execution and delivery

Agent owns hosted context, inference, canonical tool use, confirmation and Turn settlement. Memory
is explicit User-chosen prose; Transcript records retained interactions; CompactedConversation
provides lossy session continuity. Model output never supplies execution authority.

Channels own authenticated routing and delivery evidence. Agent uses that evidence to settle Turns;
provider acceptance alone does not prove visible delivery. Recovery resolves abandoned work using
retained outcomes without replaying uncertain mutations. See [hosted Turn ownership](../../docs/adr/0014-deep-hosted-turn-modules.md)
and [inference](../../docs/adr/0038-openai-hosted-inference.md).

## 7. Background execution and availability

Queues carry bounded identities and facts; Workflows execute durable steps. Owners recheck retained
state on redelivery and retain responsibility for intent, authorization and provider outcomes.
Maintenance composes owner discovery, reconciliation and retention. Post-commit publication speeds
handoff; scheduled recovery handles missed publication. Workflow progress cannot replace domain
state. See [background operations](../../docs/operations/cloudflare-background-work.md).

## Further reading

Feature specifications live beside their owners in `src/core/` and `src/shell/`.
[ADRs](../../docs/adr/) retain design rationale; [operations](../../docs/operations/) and
[runbooks](../../docs/runbooks/) retain procedures. Test boundaries and security evidence belong in
[coding standards](../../CODING_STANDARDS.md#tests) and
[security standards](../../SECURITY_STANDARDS.md#required-security-evidence).
