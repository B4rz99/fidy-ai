# Server architecture

Read the repository [architecture](../../ARCHITECTURE.md) first. This document describes the server's
layers, owners and execution boundaries. Domain language belongs in [GLOSSARY.md](../../GLOSSARY.md),
security invariants in [SECURITY_STANDARDS.md](../../SECURITY_STANDARDS.md), and feature details in
owner code, feature specifications and the references below.

## 1. Application shape

`apps/server` owns the domain and canonical API, with Cloudflare-native execution adapters.

| Area            | Responsibility                                                               |
| --------------- | ---------------------------------------------------------------------------- |
| `src/core/`     | Pure business decisions and domain schemas                                   |
| `src/shell/`    | Canonical declarations, orchestration policy and provider-neutral contracts  |
| `cloudflare/`   | Worker entrypoints, native persistence, coordination and background adapters |
| `contracts/`    | Generated public-contract evidence                                           |
| `src/client.ts` | Outward browser/CLI-safe declaration publication                             |

Public ingress owns edge HTTP policy and forwards through a service binding. Private Core composes
HTTP, Queue, Workflow and Durable Object execution. Per-User Durable Objects serialize User work;
maintenance coordinates scheduled work independently. The private Email Worker composes only its
narrow Ingestion and maintenance capabilities. Infrastructure owns bindings, not domain behavior.

## 2. Ownership and publication

An owner exposes declarations through `contract.ts`, behavior through `operations.ts`, and
construction through `runtime.ts` as needed. Other modules use these publications; private
implementation stays inside the owner. Composition roots assemble runtimes. Core remains pure,
portable code does not import native implementation, and the dependency graph remains acyclic.
See [ADR 0031](../../docs/adr/0031-published-owner-interfaces-and-visible-internals.md).

The [feature storage ownership rule](../../CODING_STANDARDS.md#feature-storage-ownership) governs
table design. A shared store has one explicit persistence owner; consumers retain their own domain
policy. Peers receive deliberate projections and commit preparations rather than foreign rows,
provider shapes or reusable credential authority.

| Owner                                             | Responsibility                                                                              |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| Identity                                          | Stable User, WhatsAppIdentity, original TrialPeriod and UserContext                         |
| Onboarding                                        | Atomic composition of identity, provider proof, Consent and recovery; no independent ledger |
| Browser Login / WebSession                        | Pairing and one-use session establishment / live browser authority                          |
| Provider Authentication                           | Provider credentials and verified signup/login proof                                        |
| Email Authentication / Recovery                   | Independent mailbox credentials / same-User recovery proof                                  |
| Tokens / OAuth Agents / OAuth Confirmation        | PAT grants / external-agent grants and credentials / exact sensitive-operation approval     |
| Consent                                           | Current permission, exact historical disclosures and protected-action composition           |
| Transactions / SourceAttestation                  | Effective financial facts, Corrections and Reconciliation / captured-source declarations    |
| Categories                                        | Stable taxonomy and User keyword rules                                                      |
| Budgets                                           | Monthly plans, caps and threshold decisions over published Transaction facts                |
| Dashboard                                         | Document interpretation and views composed from published owner facts                       |
| User Documents                                    | Shared encoded persistence and optimistic revision writes for feature-owned document kinds  |
| Ingestion                                         | Material admission, interpretation, Transaction-or-review finalization and retention        |
| Subscription / AccessTier                         | Billing and verified paid periods / derived capability-tier decision                        |
| Quotas / Resource Admission / Canonical Admission | Commercial consumption / resource protection / request pacing, leases and replay            |
| Recurring / Recurring Planning                    | Detected historical patterns / User-maintained expectations and tracking                    |
| Insights                                          | Scheduled occurrences, financial reports, message intent and attention lifecycle            |
| Agent                                             | Hosted Sessions, Turns, context, confirmation, Compaction and Transcript settlement         |
| Memory                                            | Current User-chosen durable prose                                                           |
| WhatsApp                                          | Authenticated channel evidence, routing, send claims and delivery certainty                 |
| Connections                                       | Institution authorization and Connection lifecycle                                          |
| Audit                                             | Metadata-only accountability and purpose-bound retention                                    |
| Erasure                                           | Cross-owner deletion, independent restore protection and external cleanup coordination      |

## 3. Canonical contracts and execution

`src/shell/api.ts` assembles owner declarations. Catalog, HTTP clients, MCP tools, hosted tools,
SuggestedOperations and generated contracts derive from that assembly. Canonical Policy selects
caller capabilities and confirmation requirements; Canonical Operations invokes the owning behavior.

Queries share an observational owner implementation. Individual and atomic-batch mutations share
the User-scoped mutation unit. Dedicated browser/proof transports retain separate declarations and
authority; using one does not confer canonical, agent or batch privileges.
See [ADR 0029](../../docs/adr/0029-atomic-batch-accountability-boundaries.md).

### Hosted MCP and OAuth development authority

MCP projects canonical capabilities under a separately identifiable OAuthConnection. It uses the
same owner behavior, User coordination, Consent, accounting and Audit boundaries as other clients.
OAuth approval, refresh, revocation and sensitive-operation confirmation remain distinct from PAT
and browser-session authority. Operation policy determines any required first-party approval.
See [ADR 0033](../../docs/adr/0033-hosted-mcp-and-oauth-agent-grants.md) and the
[release evidence](../../docs/operations/hosted-mcp-release.md) for protocol and enablement details.

## 4. Subject, proof, and provider boundaries

Every protected path carries a stable User and rechecks applicable authority at the action's atomic
boundary. Provider identifiers, queue messages, object references and coordination keys supply
context rather than reusable permission. Identity's caller association is distinct from channel
routing; provider contact email is distinct from an independently verified mailbox credential.

Provider Authentication owns ten-minute WhatsApp signup invitations separately from accepted-chat
Consent exchanges: the invitation carries only immutable source metadata and has its own expiry and
erasure lifecycle. A first signed message creates a link, not a User or Consent. Current browser
Consent, verified Google/Microsoft identity and exact originating-chat confirmation of the reviewed
provider account compose initial association and invitation consumption in the onboarding D1 unit. Public references
cannot approve anything. A prepared WhatsApp message removes manual code copying; only authenticated
native receipt can settle its per-provider-attempt review. Original accepted-chat handoffs retain their native confirmation proof.

Onboarding composes owner preparations in one D1 unit with exact originating proof consumption.
Returning authentication preserves established User identity and creation facts. Browser Login alone
establishes a WebSession with the browser's private verifier.
See [ADR 0009](../../docs/adr/0009-atomic-consent-bootstrap-across-owner-seams.md) and
[authentication integration](../../docs/operations/authentication-feature-map.md).

Consent owns current standing and retained disclosure evidence. Exact admitted work can retain its
original bounded Consent basis; transport payloads and recurring schedules cannot supply that basis.
Privacy controls remain independently reachable after processing withdrawal or commercial expiry.

Provider adapters use published bounded transport contracts. Hosted inference uses Workers AI
behind its own provider-neutral interface. Security policy owns validation, authenticity, Secret
handling and metadata-only telemetry requirements.

## 5. State and atomicity

D1 is authoritative for application state. The canonical mutation unit commits live authority,
owner changes, credential/accounting effects and Audit together. Child mutations prepare work for
that unit; they do not independently commit or make provider calls. Database guards recheck
ownership, revisions and eligibility even while a Durable Object serializes the User.

R2 and provider calls are separate effects. Statement staging supplies bounded, non-authoritative
bytes; publication establishes their owned submission and durable work atomically. Transactional
outbox intent bridges database commits to background execution. Ambiguous external outcomes require
owner reconciliation, not blind replay. See
[ADR 0028](../../docs/adr/0028-statement-bytes-are-staged-outside-atomic-batches.md).

Transactions owns effective financial facts and their derived projections. Budget, Dashboard,
Recurring and Planning consume published facts without reimplementing financial selection policy.
Exact Money and historical interpretation context remain intact across these boundaries.

Erasure composes each owner's bounded deletion and SQL authorization under User coordination.
An independent registry fences ordinary activity after database restoration until reconciliation.
Fresh authenticated account deletion fences new activity and waits for confirmed upload settlement
before removing owner records and User file prefixes. Minimal independent markers protect restoration;
external acknowledgments remain distinct from verified cleanup. Metadata outlives supported backups,
then expires after external completion. The [cutover contracts](../../docs/operations/database-cutover-1428.md)
own migration prerequisites, provider evidence and release gates.

## 6. Hosted execution and delivery

Agent owns one hosted runtime inside User coordination: context assembly, inference, canonical
tools, confirmation, Compaction and terminal settlement. The model uses public canonical capabilities;
independent execution policy supplies authority. Memory is explicit User-chosen prose, Transcript
records retained interactions, and CompactedConversation is lossy session continuity.

An accepted User entry and Pending Turn commit together. A generated reply is a proposal until
verified visible-delivery evidence permits completion. WhatsApp publishes channel evidence; Agent
owns the resulting Turn and Transcript transition. Alarms and independent maintenance recover
abandoned work without granting new execution authority.
See [ADR 0014](../../docs/adr/0014-deep-hosted-turn-modules.md) and
[hosted-agent scope](../../docs/operations/hosted-agent-scope.md).

## 7. Background execution and availability

Queues carry bounded versioned identities/facts; Cloudflare Workflows run durable execution with
Effect inside owned steps. Workers recheck retained owner state on redelivery. D1 records domain
intent, authorization and provider outcomes; workflow progress cannot substitute for them.

Maintenance composes owner discovery, reconciliation and retention without acquiring domain SQL or
policy. Post-commit publication accelerates durable handoff; scheduled recovery handles missed
publication. Independent activities retain bounded work, fair discovery and failure isolation.
Cadence, spend bounds, diagnostics and incident procedures belong in the
[background-work runbook](../../docs/operations/cloudflare-background-work.md).

Subscription privately owns billing observation from candidate discovery and cancellation handoff
through durable progression and recovery. Transaction lookup and PaymentSource cancellation retain
distinct evidence and budget rules behind that module; collection and observation share private
transaction verification. Queue publication remains upstream of observation admission.

## 8. Evidence and test boundaries

Core tests exercise pure decisions; contract tests check derived public declarations; provider tests
substitute external transport. Native Cloudflare integration proves persistence, atomicity,
coordination and recovery. Browser acceptance distinguishes presentation fixtures from real
public/Core journeys. Live provider or deployment behavior requires separate direct evidence.

Tests use the owning interface or an explicit native integration composition. Foreign private
implementation remains private; fixtures isolate mutable state. Test conventions belong in
[coding standards](../../CODING_STANDARDS.md#tests), and security evidence in
[security standards](../../SECURITY_STANDARDS.md#required-security-evidence).

## Feature references

Read the relevant reference when changing that feature; implementation status belongs with its
specification and operational evidence.

| Area                                | Reference                                                                                                                                                                                                             |
| ----------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Financial projections and Dashboard | [Projection ownership](../../docs/adr/0030-dashboard-exact-write-maintained-projection.md), [explicit Dashboard mutations](../../docs/adr/0032-explicit-dashboard-creation-and-canonical-queries.md)                  |
| Recurring                           | [Historical detection](../../docs/adr/0032-deterministic-recurring-charge-detection.md), [planning](../../docs/adr/0036-recurring-planning.md)                                                                        |
| Billing                             | [Enrollment](../../docs/adr/0021-browser-only-payment-credential-enrollment.md), [renewal](../../docs/adr/0034-weekly-card-renewal.md), [provider ambiguity](../../docs/runbooks/billing-ambiguity.md)                |
| Connections                         | [Authorization preparation](../../docs/operations/bancolombia-authorization-preparation-1267.md)                                                                                                                      |
| Privacy                             | [Withdrawal](../../docs/operations/processing-withdrawal-1273.md), [installed erasure procedure](../../docs/operations/titular-erasure-1274.md), [inventory](../../docs/operations/titular-erasure-inventory-1274.md) |
| Schema redesign                     | [Feature specs](https://github.com/B4rz99/fidy-ai/issues/1394), [ownership and cutover checklist](../../docs/operations/database-cutover-1428.md)                                                                     |
