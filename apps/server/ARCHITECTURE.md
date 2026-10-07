# Server architecture

Read the repository [`ARCHITECTURE.md`](../../ARCHITECTURE.md) first. This document owns the
high-level boundaries of `@fidy/server`. Domain meaning belongs in [`GLOSSARY.md`](../../GLOSSARY.md),
security invariants in [`SECURITY_STANDARDS.md`](../../SECURITY_STANDARDS.md), and implementation
contracts beside their owners.

## 1. Application shape

`apps/server` owns the canonical domain, operation contracts, and Cloudflare application adapters.
It has no production process listener.

| Area            | Responsibility                                                                      |
| --------------- | ----------------------------------------------------------------------------------- |
| `src/core/`     | Business decisions and schemas, without platform requirements                       |
| `src/shell/`    | Canonical declarations, policy, provider-neutral contracts, and portable adapters   |
| `cloudflare/`   | Worker entrypoints, native adapters, D1 migrations, and platform evidence           |
| `contracts/`    | Generated OpenAPI and operation-policy evidence, not independent declarations       |
| `src/client.ts` | The sole outward browser/CLI-safe declaration publication; no server implementation |

Cloudflare is the sole Production runtime. D1 owns application state, Durable Objects coordinate
per-User work, Queues redeliver bounded identities, Workflows execute durable steps, and R2 retains
private bytes. Workers AI is the only Fidy-controlled inference platform. An absent adapter fails
closed; neither a declaration nor a binding proves an executable path. See
[ADR 0026](../../docs/adr/0026-cloudflare-native-production-replatform.md).

### Composition roots

- The public ingress Worker owns edge HTTP policy and forwards through a service binding; it has
  no D1 binding.
- `cloudflare/core-worker.ts` composes private HTTP, Queue, and Maintenance runtimes and publishes
  the deployed Durable Object and Workflow identities.
- The existing per-User Durable Object owns serialization and alarms. It constructs Agent and
  inference services where needed; merely declaring an AI binding on Core does not construct them.
- The private Email Worker composes only its narrow Ingestion and Maintenance capabilities.
- `infra/cloudflare` owns deployment topology and resource wiring, not domain behavior.

Roots compose published owner interfaces and never become inward-facing implementation facades.
Portable code cannot import native implementations; the native dependency graph remains acyclic.

## 2. Ownership and publication

An owner exposes only the Published Trio interfaces it earns:

- `contract.ts`: schemas, meaning, and inert declarations;
- `operations.ts`: substantive behavior and deliberate public projections;
- `runtime.ts`: construction and fixed-policy runtime authority.

Other files are owner-private, including visible `internal/` modules. Cross-owner imports—including
types, tests, scripts, tools, and infrastructure—use published interfaces. Contracts do not depend on
operations or runtime; private implementation does not import its own outward operations/runtime.
A wrapper must own behavior rather than expose private functions, storage rows, or provider shapes.

Runtime construction belongs to explicit composition roots, runtime interfaces and their private
implementation, and approved tool/integration compositions. A test or harness filename grants no
additional access. The pure Shared Kernel is limited to `core/_shared/money.ts`, `context.ts`, and
`time.ts`; shell helpers have named owners rather than a generic shared bucket.

Dependency and publication checks enforce the resolved graph; browser bundle checks independently
bound the client graph. Semantic leakage through an otherwise legal interface still requires review.
See root architecture's public-surface review and
[ADR 0031](../../docs/adr/0031-published-owner-interfaces-and-visible-internals.md).

## 3. Canonical contracts and execution

`src/shell/api.ts` assembles the canonical API from owner declarations.
`shell/canonical-catalog/contract.ts` reflects that graph; batch schemas derive from it before the
batch group is assembled. HTTP clients, OpenAPI, operation policy, SuggestedOperations, MCP
projections, and hosted tools share the same operation identities and input/output codecs.
Generated artifacts are review evidence, not alternate registries.

Canonical Policy owns discovery and execution policy. Native Canonical Operations coordinates
catalog-bound execution through owner operations; its dispatch and adapter registries remain
private. HTTP and hosted callers share installed-query selection and invocation, including
Transaction-history selection and observational Budget reads. Alert reconciliation belongs to
coordinated Budget/Transaction mutation execution, never query invocation. HTTP retains transport
admission and the original request for owner input classification; hosted canonical arguments reconstruct only their
declared route. Both cross the same invocation seam, which binds the declared capability and preserves
owner refusals, live accounting and interruption. Removing Canonical Operations would redistribute
this invocation knowledge across callers rather than remove it.

Canonical Operations sends HTTP Dashboard document/view queries through the existing per-User
coordinator for every input form. A query admission contains only a catalog-bound path/query target
plus the caller's credential proof, never transport headers or bearer plaintext. The coordinator
rejects foreign subjects, mutation identities and substituted targets before invoking a query owner.
Hosted queries execute inside their already held Turn coordination. Agent retains Turn, confirmation
and Transcript behavior; domain owners retain their substantive implementation and authority.
Tokens' installed PAT-metadata query consumes the admitted caller proof instead of reauthenticating
from transport cookies. Its D1 snapshot rechecks the exact WebSession digest, User, lifetime and
Consent for both the safe metadata read and Audit; PAT callers cannot manage their own credentials.
Individual and batch mutations keep their existing execution. Discovery does not grant execution
authority, and unavailable operations never fall back to a different path.

The direct browser/proof transports described in root architecture remain separate: credential
bootstrap, statement-byte staging, hosted conversation/delivery, and payment enrollment. They are
not tools or atomic-batch children. `src/client.ts` publishes their intended declarations without
native implementation. Server implementations consume owners directly, not through this client facade.
Contract checks establish freshness; prelaunch compatibility with older revisions is not a gate.

### Hosted MCP and OAuth development authority

[ADR 0033](../../docs/adr/0033-hosted-mcp-and-oauth-agent-grants.md) defines the installed development
slice, not launch enablement. `oauth-agents` owns separately identifiable OAuthConnections, fresh
browser approval, atomic Consent/code publication, PKCE exchange and digest-only finite credentials.
The reviewed absolute 7/30/90/365-day grant lifetime cannot grow through use or refresh. Refresh
atomically rotates credentials under the original User coordinator; recognized replay revokes the
entire credential family, including a concurrent winner. Lost delivery requires new browser approval,
with no grace window or recoverable replacement cache.

`mcp` projects installed eligible canonical queries and mutations from the assembled declarations through Effect's
protocol runtime. Discovery is deterministic and authorization-private, including nested batch children and
SuggestedOperations. Calls use the shared canonical owner invocation under live OAuth credential,
grant, User, Consent and capability guards, with distinct Audit attribution and exact Money codecs.
Ordinary mutations and authorized atomic batches reuse the canonical one-User mutation unit, owner preparation,
collision policy, live authority, accounting and Audit. Sensitive operations require exact OAuth-native confirmation
from canonical confirmation metadata, including batch children. Account-security operations
remain unavailable; OAuth callers never inherit PAT, WebSession or Hosted Agent Session lifecycle authority.

The installed #988 implementation uses native MCP form confirmation in **Claude Code and Codex only**,
not a browser approval detour or a model-callable approval operation. MCP projects the server-owned
exact effect and standard continuation; the confirmation owner validates the authorized client's
assertion and lends single-use consumption to the canonical mutation unit. Review waits must not
hold User coordination throughout the native UI interaction. The same User/connection, immutable
inputs and revisions, expiry and all live authority/domain guards remain mandatory. This is client
approval, not independent human attestation; ADR 0033 records the explicitly accepted automation
risk. Missing capability, unsupported interaction or invalid acceptance refuses safely. Pinned-host
accept/cancel/headless evidence exercises the public ingress, coordinator, Core and native D1;
it does not authorize deployment or onboarding.

Fresh first-party browser settings list bounded connection metadata and at most three attributable
canonical activity entries, then revoke one or all owned connections atomically with append-only
Consent evidence. Safety controls remain reachable after processing Consent withdrawal. Revocation
stops later calls and refresh without undoing committed work or affecting PATs, browser logout or
Hosted Agent Sessions. Malformed or unavailable metadata fails closed, never as an empty list.

Public bounds, shared User request pressure, deadlines and cancellation fence queued canonical/refresh work. Already-started D1 batches
settle atomically even when delivery is lost; cancellation is not rollback or retry authority.
OAuth MCP canonical calls share Canonical Admission's stable-User commercial consumption and ordinary
retry receipts with PAT/API/CLI callers. One envelope accounts for one mutation attempt or whole
atomic batch; native confirmation continuation retains that admitted unit and its single-use owner
contract. Tool-result metadata projects the same allowance codec; discovery and OAuth lifecycle
transports remain separate security work.
Existing bounded public/Core/coordinator Work observations export metadata only, never arguments,
financial results, credentials, URLs or raw causes. Exact-host onboarding and operator
launch gates remain separate work.

## 4. Subject, proof, and provider boundaries

Every protected operation carries an explicit User. Authentication supplies subject-correlated
premises for live rechecking, not a reusable permission token. A provider id, Queue identity,
Durable Object key, or anonymous source digest cannot authorize a User. Credential, Consent, scope,
and owner-state guards participate in the authoritative action or atomic unit.

Browser Login alone initiates one-use WebSession establishment, requiring both approval and the
browser-private verifier. Email proof, WhatsApp approval, and Recovery cannot independently mint a
session or change the stable User association. Onboarding composes verified owner state atomically
but does not issue a WebSession. Tokens owns the distinct PAT/PATPairing lifecycle; bearer plaintext
is disclosed only at issuance/claim, while server persistence retains verification evidence.

Consent owns current standing and append-only evidence. A standing read is not cached authorization.
Ordinary protected work checks current Consent. An exact Pending hosted Turn retains its admitted
Consent basis for bounded completion; revocation prevents the next Turn. Model egress still passes
through the Consent-owned boundary, and PAT work retains its per-call guard.

`shell/outbound-http` is the raw outbound provider transport boundary for Kapso/Meta, Wompi, and
outbound Resend. It owns fixed destinations, credentials, redirects, byte bounds, and safe failures.
Provider adapters consume its published contract. HostedInference instead uses the direct Workers AI
binding behind a provider-neutral contract and approved-model/conformance gates, with no external
model fallback. Kapso voice transcripts are external channel material, not Fidy-controlled inference.

Telemetry is allowlisted metadata only. Audit is a separate owner of accountability evidence and
transaction-composable recording; peers supply subject/credential proofs, not Audit persistence
shapes. Secrets, personal content, provider bodies, and raw failures stay out of telemetry and public
error projections.

## 5. State and atomicity

The canonical mutation unit composes owner-prepared work into one User-scoped D1 commit, including
live authority, credential accounting, and Audit. Individual and batch execution share that unit.
Child operations do not independently commit or make provider calls; batch preparation cannot assume
it sees earlier children's writes. Unsupported children fail closed rather than partially executing.
See [ADR 0029](../../docs/adr/0029-atomic-batch-accountability-boundaries.md).

Coordination and storage are complementary: the User Durable Object serializes work, while D1 guards
recheck authority, revision, and eligibility at commit. A pending-Turn mutation fence prevents a
foreign, terminal, or already-consumed hosted call from committing. No process lock or post-commit
repair substitutes for these guards.

R2 bytes and D1 state cannot commit together. Statement staging is authenticated, bounded, opaque,
and non-authoritative. Canonical publication verifies ownership, size, and digest and commits the
submission, accounting, staging promotion, and extraction intent together. Unpublished material
expires; authoritative submissions cannot reference missing or mismatched bytes. See
[ADR 0028](../../docs/adr/0028-statement-bytes-are-staged-outside-atomic-batches.md).

A D1 commit and external submission are also separate effects. Durable outbox intent plus idempotent
handoff bridges that boundary. Provider uncertainty belongs to the owner's retained lifecycle and
reconciliation policy; timeout or lost acknowledgment is not proof of rejection.

### Domain authority and cross-owner relationships

| Owner                            | Architectural responsibility                                                                             |
| -------------------------------- | -------------------------------------------------------------------------------------------------------- |
| Identity                         | Stable User, WhatsAppIdentity, original TrialPeriod, and historical UserContext                          |
| Consent                          | Processing permission and append-only evidence; protected-action composition                             |
| WebSession / Browser Login       | Live browser credential authority / pairing and one-use establishment                                    |
| Email Authentication / Recovery  | Mailbox proof and replacement / same-User recovery approval, not session issuance                        |
| Tokens                           | PAT/PATPairing scope, proof, issuance, activity, revocation, and expiry                                  |
| Transactions / SourceAttestation | Effective financial facts and corrections / immutable captured-source declarations                       |
| Categories                       | Stable taxonomy and User keyword rules; rule changes affect future capture, not retained history         |
| Budgets                          | Exact spending and threshold decisions over Transactions' published effective contributions              |
| Dashboard                        | Validated documents and views composed from published Category, Budget, and Transaction facts            |
| Ingestion                        | Bounded material admission, interpretation, Transaction-or-review finalization, and retention            |
| Subscription                     | Prices, PaymentEnrollment, BillingAttempts, and settled paid periods                                     |
| AccessTier                       | Data-free decision from Identity's original TrialPeriod and Subscription's settled paid interval         |
| Quotas                           | Independent commercial consumption and live meter projections, separate from resource protection         |
| Recurring                        | Historical charge-pattern evidence and immutable confirmations, not billing or delivery                  |
| Insights                         | Scheduled occurrences, lifecycle, and delivery evidence over published historical facts                  |
| Memory                           | Current User-owned prose and aggregate capacity, without a revision history or embedding authority       |
| Agent                            | Hosted Session/Turn lifecycle, context, confirmation, inference orchestration, and Transcript settlement |
| WhatsApp                         | Authenticated channel evidence, send claims, delivery certainty, and channel recovery                    |
| Audit                            | Accountability evidence, recording budgets, and bounded retention                                        |

Peers receive decoded projections or deliberate commit-composition operations, never another owner's
rows, effective SQL relation, provider representation, or reusable credential authority.
Web Authentication and Onboarding coordinate these owners without acquiring independent state.

Financial projections preserve exact Money, Currency separation, effective Transaction semantics,
and historical context. Dashboard/Budget reads cannot turn incomplete or changed-revision facts into
partial totals. Write-maintained projection and repair requirements belong to
[ADR 0030](../../docs/adr/0030-dashboard-exact-write-maintained-projection.md).
Dashboard queries do not create or edit documents; explicit initialization and edits share canonical
mutation execution under
[ADR 0032](../../docs/adr/0032-explicit-dashboard-creation-and-canonical-queries.md).
Recurring consumes Transaction-owned facts and invalidation under its
[design ADR](../../docs/adr/0032-deterministic-recurring-charge-detection.md).

Weekly card renewal consumes Subscription's retained due intent through the same User coordinator,
then commits a pending attempt, its frozen adjacent calendar week and collection outbox. Verified
settlement alone adds a paid period. Trusted weekly Price publication retains immutable terms and
atomically creates billing-email notice intent; the shared billing Queue/Workflow dispatches these
identity-only notices through bounded Resend transport. Newly admitted renewals use the published
Price, while pending attempts retain their snapshot. See ADR 0034.

Nequi and DaviPlata automatic renewal share the same bounded discovery, User coordinator,
immutable attempt and D1 outbox, Queue/Workflow collection, and independently verified settlement
path as card. Retained wallet sources are charged without new authorization, account details,
OTPs or renewal reminders. Duplicate and delayed work cannot rearm collection or shift the calendar;
provider failures remain failed BillingAttempts without extending paid history. Weekly grace remains
card-only.

Monthly and yearly renewal shares that same durable path. Each admitted attempt retains the
first paid period's start as an immutable calendar anchor, advances from the preceding paid boundary
in the captured time zone, and freezes explicit UTC period boundaries before collection. Short months
clamp to their last day and February 29 clamps to February 28 in ordinary years; later periods return
to the original day. Scheduler delay and provider finalization cannot shift these dates. Pending or
failed collection never extends paid history. Weekly grace and weekly Price-change notification retain
their existing policy.

Subscription's portable declaration and fixed-policy runtime own dedicated PaymentEnrollment
transport recognition: declared methods, parameterized status paths and the cookie-only/origin
forwarding projection. Public ingress and private Core consume that same browser-only meaning;
the native Subscription owner dispatches the recognized declaration identity rather than maintaining
another route/method list. Each adapter still enforces its own origin, method, transport and proof
checks, and the owner still rechecks live authority and Consent at the protected action.
Removing this runtime would recreate path recognition in ingress and Core, method recognition in
ingress and Subscription, and the enrollment-only forwarding policy in ingress. It owns no generic
routing bucket, provider representation or credential authority.

Payment enrollment requires fresh browser authority and Consent and stays outside canonical/PAT
access. Transient payment authorization material goes directly from the browser to Wompi. Paid Pro
requires independently verified matching settlement, not authorization or PaymentSource availability.
AccessTier is derived at the decision instant, never persisted as a separate authority. Weekly card
renewal includes a fixed three-day grace after the paid boundary, excluding stopped renewals and
refunded periods; grace never alters paid history. See
[ADR 0021](../../docs/adr/0021-browser-only-payment-credential-enrollment.md).

## 6. Hosted execution and delivery

Agent constructs one deep service inside the existing User coordinator. It privately owns context,
Compaction, confirmation, bounded inference, canonical execution, delivery, and terminalization.
A soft HTTP deadline cannot release serialization before owner settlement or durable recovery.
Progress observation does not start a second Turn or bypass canonical tool policy.

An accepted User entry and Pending Turn are retained atomically. A generated reply is a delivery
proposal, not yet Transcript evidence. Agent commits exact assistant content and Completed status
only from authenticated visible-delivery evidence: a browser receipt or the channel's authoritative
signed evidence. Provider send acceptance alone does not complete a Turn. Ambiguous sends are not
blindly retried, and unconfirmed delivery remains truthfully unconfirmed.

WhatsApp publishes inert delivery/status evidence; it does not receive an Agent terminalization
callback or read Turn/Transcript persistence. Memory supplies only the current same-User projection.
Transcript storage, confirmation records, and Compaction replacement remain Agent-private.

Durable Object alarms recover abandoned work and enforce retention; an independent Core sweep
recovers missed alarms without waiting for another User request. Retention removes private content
under owner policy while preserving permitted lifecycle metadata, never extending expired authority.

### Statement upload conversation

Verified WhatsApp document attachments use Agent's per-User Turn admission. Ingestion applies
stable-User, global, attempt, spend and outstanding upload budgets before bounded Kapso retrieval,
digest verification and private R2 staging. Held canonical publication atomically records the
submission, direct-attachment/session origin, Free-backfill reservation, Audit, commit fence and
identity-only extraction outbox. Public browser/PAT submission routes and atomic-batch children
refuse statement publication; a staged reference supplies no attachment authority.

The original upload Turn remains Pending while the installed Queue/Workflow extracts the document.
Recovery reuses retained staging and publication identities without downloading or charging again,
then asks for clarification in that conversation. Canonical resolution, skipping and abandonment
settle capture, SourceAttestation, evidence erasure, entitlement and Audit atomically. The lifetime
Free grant is consumed by the first captured Transaction; zero-capture terminal extraction releases
the reservation. Partial capture preserves consumption.

Clarification requires live same-session, same-channel authority and exact confirmation. Expired or
abandoned origins cannot resume. Public review queries retain metadata only; purpose-bound row
evidence, known Money and field messages stay out of immutable tool results. Terminal extraction
failure abandons remaining review rows and erases their evidence. Confirmation recovery reconciles
retained outcomes or commit fences under the original call identity without repeating the mutation.

## 7. Background execution and availability

Queue and Workflow payloads carry bounded, versioned identities/facts rather than credentials,
financial content, prompts, or raw material. Consumers assume redelivery and recheck current owner
state. Queue acknowledgment proves handoff, not provider delivery or domain completion.

Post-commit request continuations accelerate publication but are not its durability mechanism.
Scheduled recovery reoffers eligible intent and reconciles uncertainty. Maintenance composes owner
runtimes for independent dispatch, reconciliation, and retention: one failure does not skip unrelated
activities, while interruption preserves cleanup. Maintenance owns no SQL, retention policy, domain
aggregate, provider execution, or authorization.

Operational Health observes bounded owner metadata and dead-letter signals separately from public
reachability health. Unreadable measurements are unavailable, not zero. Operational procedures and
limits belong in the [background-work runbook](../../docs/operations/cloudflare-background-work.md).

Budget crossing snapshots, category-separated Budget/reminder Consent evidence, and guarded reminder
instruction/revision/occurrence/outbox primitives are installed. Undecided expired offers have independent
bounded Maintenance retention. Canonical reminder reads/edits now share installed HTTP/hosted owner
selection, live credential/capability guards, optimistic revisions and Audit. Exact authenticated
category-qualified channel decisions bypass inference and replay against immutable Consent receipts;
privacy revocation remains reachable after processing withdrawal. Contextual offers, fair bounded
category discovery, Queue/Workflow delivery and independent reminder attention now use the existing
User coordinator and one executable category outbox. Authenticated verified channel evidence commits
atomically with disclosure, governor, grouped InsightEvent lifecycle and exact Agent Transcript
settlement. Questions and offers retain standalone message Transcript identities without invented
financial events or requested Turns; same-User replies recover retained message context. Pending or
uncertain questions do not suspend scheduled reminders; only definitive failure or expiry before any
channel send begins permits a fresh question identity. Channel-owned started identities guard expiry
and recovery even if an outbox checkpoint was lost. First-Budget and contextual requests remain
pending outside delivery hours without repeatedly charging generation admission. Their short-lived
choices are created in an open window; exact request/report links recover expired never-started
disclosures after Queue delay or window closing, without replacing started or ambiguous sends.
Maintenance repairs lost outbox started checkpoints from channel-owned metadata before discovery.
The shared content-free protocol and runtime are named Proactivity; Weekly identities retain only
weekly-specific meaning, and the existing Queue/Workflow resource bindings remain unchanged.
Retained report identities do not restrict ephemeral offer deletion. Retained Budget reconciliation
work participates in fair bounded Maintenance discovery and drains under the same User coordinator
before crossing publication. Budget opt-in first drains pre-opt-in work under its previous
eligibility and atomically fences the new grant against any remaining reconciliation, so a delayed
post-commit evaluation cannot turn earlier financial changes into retroactive delivery. Fresh reminder
offers under an existing grant expose authenticated continuation as well as revocation; continuation
reactivates stopped or paused schedules without replacing legal Consent. Cross-User standalone
message context is denied at both the contextual owner and actual hosted inference boundaries.
Installed implementation and test evidence do not constitute issue acceptance, template approval,
or production enablement.

Installed code does not by itself enable a channel or provider. In particular, forwarded-email
routing remains disabled until institution Connection admission and authenticated institutional
sender proof exist. Receipt/image acceptance atomically publishes commercial consumption,
accountability, visible review, and an identity-only outbox; provider retrieval/extraction is not
installed. Accepted images therefore remain visibly extraction-unavailable, with bounded
locator/caption retention. Rejected images retain no deferred bytes and admit no hosted Turn.
[Commercial allowances](../../docs/operations/commercial-allowances.md) document the separate
accounting boundaries. Deployment configuration and owner contracts remain the evidence for
executable capabilities, not this document's directory inventory.

## 8. Evidence and test boundaries

- Core tests prove schemas and business decisions without platform bindings.
- Contract tests prove canonical reflection, policy, codecs, and generated-artifact freshness.
- Provider tests replace the published transport below real request/response policy.
- Browser tests distinguish presentation fixtures from real public/Core Worker journeys.
- Cloudflare tests prove actual D1 atomicity, User isolation, Durable Object coordination, R2
  ownership, Queue redelivery, Workflow behavior, and restart/retention semantics at the relevant seam.
- Live provider gates establish behavior that local fixtures cannot prove, including Workers AI
  conformance. Activity tests alone do not prove platform suspension or production alert delivery.

Tests may inspect their own visible internals; foreign tests use published contracts and operations.
Owner fixtures stay private. Explicit broad native integration compositions may construct actual
runtime bindings but gain no foreign-private access. Fixtures isolate state, schema, objects, and
coordinators across cases; cached immutable setup data is not shared application state. Migration
and runtime-lifecycle evidence must exercise the actual boundaries rather than infer them from a
faster ordinary fixture.

Verification combines dependency/publication checks, generated contracts, browser graph checks, and
behavioral evidence. Passing a fake or portable test never establishes a production adapter's
existence, durable guarantees, or launch readiness.

Recurring publishes a complete, bounded confirmation source for the recurring-charge digest.
Its same-User checkpoint guards the effective Transaction revision, completed detector evaluation,
and immutable confirmation cutoff. The source includes invalidated and suppressed confirmations
and explicit legacy exclusions: snapshots without confirmation-time Counterparty remain retained
and permanently ineligible; current series labels never repair historical snapshots.

Insights stages the complete source before freezing a closed ConfirmationDay. Identity includes
its local date and both UTC midnight boundaries, so backward travel can produce distinct reports
with the same date. Atomic materialization consumes every confirmation in the bucket and commits
its exact instruction version/grant guards, InsightEvent, immutable itemized report and shared
Proactivity outbox. Acceptance captures the current local midnight cutoff; stable instruction
identity and permanent consumption survive disable/re-enable. Source identity and the next closing
day drive bounded Maintenance discovery through published metadata, without inspecting foreign
owner tables. No weekly ignore governor or inference participates.

An authenticated foreground WhatsApp interaction records the first-discovery offer opportunity
with its request in one D1 unit, including suppressed discoveries. Only an undisclosed definitively
rejected send, or expiry before sending, permits a later foreground replacement. Rejected offer
replacement requires channel-owner proof in Consent's insertion unit. An exact native category
choice appends legal evidence and changes standing atomically. Financial messages use the existing
User coordinator, Queue/Workflow, live claims, resource admission and verified transcript settlement.
When the complete list exceeds the approved parameter limit, one message carries its count and an
identifier-only authenticated report URL. `insights.getRecurringDigestReport` is a Free canonical
read with live read capability, same-User authority and atomic Audit; report retention is independent
of its send deadline. Browser publication includes Insights' declaration-only report schemas.
