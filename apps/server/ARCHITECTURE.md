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
| `contracts/`    | Generated canonical-contract evidence                                        |
| `src/client.ts` | Outward browser/CLI-safe declaration publication                             |

Public ingress owns edge HTTP policy and forwards through a service binding. Private Core composes
HTTP, Queue, Workflow and Durable Object execution. Per-User Durable Objects serialize User work;
maintenance coordinates scheduled work independently. The private Email Worker composes only its
narrow Ingestion and maintenance capabilities. Infrastructure owns bindings, not domain behavior.

Production Core uses default execution near the incoming request. Staging requires the exact
Core version to omit placement metadata; live settings cannot establish a candidate's configuration.

Core consumes build-generated hosted tool parameters instead of converting every operation to a
provider schema at startup. Statement parsing loads its bundled CSV/XLSX implementation only after
bounded source admission; ordinary API reads do not initialize those engines. Runtime authority,
input validation and parser resource limits remain with their existing owners.

Canonical catalog reflection reads operation identity and policy eagerly, while input, response
and partial-suggestion codec derivation is suspended until use. Typed input helpers resolve the
bound catalog at codec use rather than module initialization. Shared suggestion helpers do not
import the API assembly. Telemetry uses build-generated canonical ids, methods and routes with
exact catalog freshness checks; those labels confer no request authority. The full Core composition
still imports its dispatcher and background implementations; these changes do not make Core load
only the requested feature.

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

Workspace read projections remain specific declared observations. Budget status includes bounded
editing metadata for the selected reporting month under the same authorization and accounting;
its effective caps, month-plan existence, Transaction readiness/revision and exact aggregate reads
share one native snapshot. For an unmetered mounted browser read, the exact WebSession/Consent
selection, request pressure, owner facts, required Audit and allowance standing compose in that
same batch under one fresh recovery fence. Presentation performs only bounded decoding and exact
Money assembly; it does no further storage or provider work. Other caller paths retain their
credential-specific admission and accounting. Future-month caps remain editing
metadata and do not contribute to active spending. Assembly uses request-local Category/Currency
indexes and exact per-Currency totals; no response or working index survives the request. Monthly cash flow and uncapped Category/Currency outflows derive from the same complete Transaction-owned aggregate snapshot as cap spending. The Review
workspace projects the first revision-bound item detail from its already-read rows, using the same
draft expiry and Category suggestion policy as an individual read, and never includes original
material. A separate WebSession-only `ingestion.getReviewPageContext` read shares its page selection
and order, materializes at most 50 owned identities before inspecting retained evidence, and clips
source excerpts to 180 characters inside D1. CSV records, up to sixteen XLSX cell displays and
retained image captions supply unconfirmed context without another stored index or R2 fan-out.
Email receipt timestamps provide source metadata without reading retained email objects.
The query commits live authority and metadata-only Audit with its read, suppresses expired evidence,
and returns no-store browser data; originals and excerpts stay out of agent queries and transcripts.
Browser User responses can carry the bounded Category display catalog through its
published projection seam, with live browser credential evidence checked after that read. These
projections do not add a generic batching transport or bypass admission, Consent or write guards.

Transactions declares `updateTransactions` for an explicit revision-bound selection sharing one
Correction. The owner reads only those same-User originals, prepares each record's correction
evidence, and commits set-based writes and one metadata-only operation Audit through the canonical
mutation unit. Exact affected-row assertions roll back incomplete writes. The 4096-record and
512KiB HTTP bounds protect one unit of work; the browser has no checkbox cap. OAuth group
approval observes and rechecks the selected originals, linked partners, effective facts,
Reconciliation membership and precedence inputs through the same snapshot owner as individual
correction, so changes to any financial premise invalidate pending approval. The generic atomic
batch remains limited to twelve canonical operations, independently of this selection size.

Queries share an observational owner implementation. Individual and atomic-batch mutations share
the User-scoped mutation unit. Dedicated browser/proof transports retain separate declarations and
authority; using one does not confer canonical, agent or batch privileges.
See [ADR 0029](../../docs/adr/0029-atomic-batch-accountability-boundaries.md).

### Hosted MCP and OAuth development authority

Browser OAuthConnection listing resolves the exact mounted cookie once and rechecks that live
session in a bounded native snapshot containing the connection page and its latest three outcomes
per connection. Audit selection requires the existing User/connection/time index rather than a
broad User-history scan. Identity-only listing remains available after Processing Consent withdrawal;
request pressure and fresh-session requirements for revocation remain independent.

PAT and OAuth activity indexes contain only credential calls with the corresponding credential
identifier. Other browser and hosted calls retain their complete Audit records without updating
unrelated activity indexes. Index replacement bounds the inspected history and destination entries
before any schema change; it never rebuilds the Audit table or changes its append-only guards.

MCP projects canonical capabilities under a separately identifiable OAuthConnection. It uses the
same owner behavior, User coordination, Consent, accounting and Audit boundaries as other clients.
PAT pairing keeps start, authenticated inspection, explicit live-session approval and private-proof
poll/claim separate. Inspection does not reserve authority or create a server approval receipt.
Approval fixes the PAT expiry while retaining the original pairing deadline. Claim's guarded D1
commit rechecks the exact initiating proof, bound User, both expiries, current Consent and issuance
capacity before consuming approval, storing a digest-only PAT and appending Audit atomically.
Repeated claims cannot disclose the bearer again, including after an uncertain response.

OAuth token exchange owns the original unconsumed Request through bounded form decoding,
code issuance or coordinated refresh, and no-store response delivery. Ingress returns that response
without inspecting bearer material or retrying issuance. Code consumption rechecks both code and
original grant expiry against commit-time D1 time; refresh descendants retain the original deadline
and any narrowed scope.

OAuth approval, refresh, revocation and sensitive-operation confirmation remain distinct from PAT
and browser-session authority. Sensitive OAuth operations require one client-native decision,
bound to the exact operation and consumed atomically; the client assertion is not human attestation.
Confirmation preparation captures the complete ordered native unit, including owner revision guards,
mutations and required Audit. Its guarded commit closure exposes no independently executable
confirmation statements. Live credential, scope, Consent and database-time expiry checks remain
inside that unit; a failed commit rolls back consumption and owner effects together.
See [ADR 0033](../../docs/adr/0033-hosted-mcp-and-oauth-agent-grants.md) and the
[release evidence](../../docs/operations/hosted-mcp-release.md) for protocol and enablement details.

### Browser document entry

The binding endpoint can opt into an application context, or the initial Transactions page. Core
composition resolves the live credential and Consent receipt together, applies the unchanged
canonical request-pressure guard, and delegates metadata and Transaction reads to their owners.
Metadata renewal, same-User credential/active-Consent checks, taxonomy and identity Audit form one
native batch. The Transaction reader retains its canonical projection, live authority and Audit. Both the ordinary
endpoint and document entry consume its validated page; entry encodes the combined domain values
once instead of serializing a Transaction response and decoding it into another response.
A final exact-credential receipt drops all private observations after withdrawal or revocation.
Missing/Revoked Consent returns no product data. An explicit mounted binding must match the cookie.

These responses use `no-store`; the ordinary binding-only path stays identity-only. The optional
Transaction page uses User-timezone month bounds and is omitted if the combined response would
exceed the existing 64KiB web-auth response limit. Omission falls back to the ordinary canonical
page read. This is one bounded document-entry request; burst, concurrency, lease duration, refusal
responses and later canonical authorization checks remain unchanged.

Payment enrollment availability composes its exact mounted cookie, session freshness, active
Consent and User context in one native read. Core delegates binding verification to that read;
availability does not fetch a mailbox credential. Other enrollment operations retain their existing
ingress and commit checks. The available-method response remains uncached.

OAuthConnection listing composes its User resource admission, bounded connection/activity selection
and outstanding-work completion in the final native batch. The ingress source grant and exact
mounted-cookie lookup share the preceding native unit. Cleanup remains idempotent when the final reply is lost;
no recovery generation, credential or page result is reused across transactions. Invalid listing
queries retain their User attempt charge. Mutations keep their separate admission and coordination.

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

Both protocols bind immutable reviews and native decisions to the exact current verified provider
attempt. Invitation approval compares the prepared text verbatim; accepted-chat approval also requires
a native reply to the retained review message in the accepted exchange. Retrying an unfinished
attempt atomically supersedes it and clears its review and decision while preserving the original
invitation or handoff deadline. Late send receipts cannot attach to a replacement review; an uncertain
send stays claimed for that attempt. Completion rechecks the same attempt and consumes its review
with pairing approval in one native batch. This grants no WebSession before separate private redemption.

Onboarding composes owner preparations in one D1 unit with exact originating proof consumption.
Returning authentication preserves established User identity and creation facts. Browser Login alone
establishes a WebSession with the browser's private verifier.
Browser Login owns pairing order through immutable native insertion rowids. Every approval owner
rechecks its candidate against the same User's live ready pairing in its guarded write; only a newer
candidate can replace it. Supersession invalidates the replaced ready pairing in that same native
unit, including rollback with the originating proof. Creation alone does not supersede approval.
Browser Login retains separate User attribution through pairing retirement for erasure of the pairing
and associated provider evidence. Its erasure-only publication grants no authentication authority;
the live pairing User binding and lifecycle continue to govern approval and redemption.
See [ADR 0009](../../docs/adr/0009-atomic-consent-bootstrap-across-owner-seams.md) and the
[browser authentication feature](../web/src/features/provider-authentication/FEATURE.md).

Consent owns current standing and retained disclosure evidence. Exact admitted work can retain its
original bounded Consent basis; transport payloads and recurring schedules cannot supply that basis.
Privacy controls remain independently reachable after processing withdrawal or commercial expiry.
Processing ingress opens its decision phase only after authenticated, correlated delivery evidence;
its explicit reply must be a distinct later message from the bound endpoint. Weekly and proactivity
choices preserve their existing exact offer, association and disclosure-message checks. Those category
checks do not establish the same authenticated-delivery or later-message proof as Processing ingress;
extending that proof to categories is a separate policy change. Processing renewal settles the exact
withdrawal against the retained historical disclosure and fresh browser authority. An uncertain commit
reconciles that same receipt without replacing legal evidence.
Cookie-only Consent handlers discover the subject and verify the expected browser binding in one
live session lookup. Core does not repeat that discovery before dispatch. Protected reads and
coordinated decisions still recheck credential authority in their existing atomic units; no
session or Consent result is cached across requests.

Provider adapters use published bounded transport contracts. Hosted inference uses OpenAI `gpt-6-luna`
behind its own provider-neutral interface, through bounded Outbound HTTP. Workers AI document
conversion remains a separate capability. Security policy owns validation, authenticity, Secret
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
Projection repair claims the supported target version while remaining unavailable. Each bounded
clear or rebuild batch fences the exact User, version, phase, cursor and repair revision; admitting
a page advances the repair revision even when its phase or cursor is unchanged. Ordinary financial
fact revisions remain trigger-maintained and do not restart repair. Rebuild validates effective
leaves and Reconciliation membership before the atomic ready cutover.
Budget threshold reconciliation validates the owned Budget and captured monthly boundaries/time zone
before atomically advancing monotone marks, frozen crossings and publication intent.
One bounded threshold pass reports Drained, Pending or Unavailable. Canonical financial preflight
requires Drained; post-commit evaluation remains best effort, and opt-in composes its fence only
after drained accounting. Exact sampled work versions are acknowledged after crossing commit.
Group Corrections use the existing credential-neutral Audit projection with the exact browser
session and accepted/rejected outcome. The original Audit history and table remain in place;
adding this operation requires no Audit rebuild.
The canonical Transaction detail query returns linked originals alongside the effective facts in
the same authorized, audited snapshot. Bounded SourceAttestation capture kinds explain
how each original was obtained without returning retained source material. Original selection remains same-User and bounded to the
exact pair even while the effective projection is being repaired; unlink uses the existing
canonical mutation and returns both restored originals. Ordinary history remains effective-only.

Dashboard deduplicates requested chart intervals before calling Transactions' bounded multi-interval
reader. Wider selections first count bounded projection rows at one fact revision. Compatible ranges
expand native batches beyond four intervals only within a raw-result budget; larger working sets
retain four-interval chunks. Every group retains current Consent, projection readiness and fresh
recovery fencing. HTTP document/view reads execute directly in Core, retaining the admission lease
and final live authority/Audit checks. Mounted browser views compose their bounded document,
calendar context and Category selection with exact-cookie/Consent admission in its native unit.
The dependent financial projection retains a second fresh fence, source/context revision assertions,
final Audit, allowance standing and lease release. This reuses the same view interpretation and
projection owners as other callers; no query, response cache or storage migration is introduced.
Every financial snapshot asserts the exact source document
and captured calendar context; later snapshots also assert the planned financial revision inside
the native transaction. A conflict aborts that unit and withholds the complete view without a retry
or accepted final accounting. A concurrent Correction can commit without waiting for the view.
Mutations and held hosted execution retain User coordination.

Erasure composes each owner's bounded deletion and SQL authorization under User coordination.
An independent registry fences ordinary activity after database restoration until reconciliation.
The reserved `erasure-registry-v1` object in the existing coordinator namespace owns this metadata
in its independent SQLite storage after the authenticated handoff; it never constructs User work.
With the shared-read binding enabled, existing query declarations and browser data GET transports execute canonical HTTP in that same
object; commands, User coordination and admission policies retain their existing owners. Each
protected D1 unit reads the current registry generation and asserts it inside its native transaction.
Other executors reach the same metadata through a bounded private binding. ForwardedEmail receives
only the named metadata transport entrypoint, without the coordinator namespace. No generation or response
cache grants authority. Private original bytes remain in R2.

The authenticated `MigrateRegistry` operator action performs an empty-only handoff from the original
R2 registry. It refuses retained cases and native restore state, claims the R2 generation with its
captured ETag, publishes the SQLite authority durably, then attempts one conditional D1 checkpoint.
The native journal grants that final attempt once; a retry only observes an already published result.
Uncertain or restored checkpoints require existing restore/release reconciliation. The retained R2
transfer witness prevents first-release initialization after complete independent metadata loss.
Erasure binds its execution configuration to the exact User inside the serialized coordinator.
Its private `admit`, `continue`, `receipt` and `custody` operations decode and authorize each
invocation independently; binding retains no credential, receipt or lifecycle observation.
Continuation reads and decodes the durable phase and offers one bounded opportunity.
Fresh authenticated account deletion fences new activity and waits for confirmed upload settlement
before removing owner records and User file prefixes. Minimal independent markers protect restoration;
external acknowledgments remain distinct from verified cleanup. Metadata outlives supported backups,
then expires after external completion. Migration and release checks follow the
[release procedure](../../docs/operations/production-releases.md).

A naked browser Category GET can compose mounted-cookie authentication, User pressure, the
bounded Category projection, its Audit record and quota standing into one
native D1 batch under one fresh recovery-generation fence. Cookie digest, expiry, revocation and
Consent remain predicates in that batch. Standing rechecks the same exact credential selection.
The native-only read counts existing live request leases against the unchanged two-request cap
inside the serialized D1 transaction, and preserves rate pacing and expired-lease cleanup. It
needs no transient lease to cover work outside the transaction. This capability is limited to the Category read. Authorization headers retain
credential precedence. A lost batch response never replays owner work; a refusal rechecks current authority. Presentation performs no provider or domain work.

## 6. Hosted execution and delivery

Agent owns one hosted runtime inside User coordination: context assembly, inference, canonical
tools, confirmation, Compaction and terminal settlement. The model uses public canonical capabilities;
independent execution policy supplies authority. Memory is explicit User-chosen prose, Transcript
records retained interactions, and CompactedConversation is lossy session continuity.

An accepted User entry and Pending Turn commit together. A generated reply is a proposal until
verified visible-delivery evidence permits completion. WhatsApp publishes channel evidence; Agent
owns the resulting Turn and Transcript transition. Alarms and independent maintenance recover
abandoned work without granting new execution authority. After durable admission, a failed recovery
wake fences the abandoned Turn through channel recovery before releasing its User queue owner; it
cannot turn the retained User entry into a no-admission refusal. Admission notification follows the
scheduling attempt for ordinary, confirmation and document Turns.
Recovery freezes begun, unresolved channel delivery and reads its certainty in one native unit.
Verified delivery that wins that unit completes with its exact text; unresolved delivery that
recovery freezes cannot later become a successful Turn. Every terminal unit reconciles retained
canonical commit fences into missing tool-result evidence before appending its one terminal entry.
Neither recovery nor repeated terminalization reexecutes canonical tools or renews proposal time.
Hosted reply submission reloads the retained
same-User route, stages exact text and correlation, schedules the original proposal deadline, and
claims once under a fresh clock, current association/business endpoint and verified service window
before calling the sender. Provider acceptance remains pending delivery. Hosted receipts must prove
the retained recipient BSUID or sandbox phone from raw provider status history before binding a
message identifier or settling; missing or mismatched recipient evidence grants no delivery.
Authenticated receipts cannot revive a rejected or unconfirmed hosted reply. Proactive templates and voice refusals retain
their separate admission, expiry and recovery protocols.

Verified WhatsApp Turns discover every installed canonical operation permitted by the catalog access
policy. Query and mutation adapters reuse their canonical owners under live held Turn authority,
including User isolation, audit, confirmation policy and atomic batch commit fences. Browser credentials
and PAT management authority are never synthesized for the channel. An invalid or unavailable WhatsApp query ends
the round with an unconfirmed-result reply; model prose cannot present that rejection as an empty result.
Canonical not-found evidence can still support an absence reply. Nullable optional query arguments
are omitted when reconstructing the canonical HTTP query. A capture receipt is rendered from the committed
canonical result, including its Transaction identifier and date in the User's configured time zone.
For recognized Spanish capture phrases and compact entries, a Turn without a committed result
receives an unconfirmed-registration reply instead of the model's proposed confirmation. Turn context supplies both the UTC start and the User-local date.
Executable WhatsApp confirmation commands are rendered only from the host-issued challenge. Model
prose containing a native confirmation command receives an unconfirmed-preparation reply, so a
copied or invented command cannot be presented as approval for a new operation.
Hosted confirmation tasks retain the reviewed input privately and reserve the exact decision for
one live pending Turn before protected execution. Reservation commits separately from the mutation
and proves no mutation outcome. Recovery rechecks the exact consumed binding and live authority,
consults retained commit and outcome evidence, and never lends that reservation to another Turn or
renews its original ten-minute deadline. OAuth's atomic consumption remains a separate protocol.
Hosted inference privately captures immutable prepared work behind a shared one-shot execution gate.
Claim and settlement handoff are interruption-safe while provider work remains interruptible. Only
pure typed retryable provider unavailability can restore execution within its two-attempt budget;
interruption, defects and mixed causes consume it. Text InvalidOutput retains a separate one-use
repair right, spent before feedback preparation. Continuation preparation reserves one descendant
before asynchronous work, restoring only when preparation fails.
WhatsApp may repair one invalid model output after successful queries, retaining their tool results
and remaining call budget. Repair is unavailable once a mutation has started; it cannot replay
owner effects or replace host confirmation.
Proactivity uses an exact reviewed Spanish body with enough fixed provider text. Frozen delivery
evidence includes that complete body; its length budget includes the wrapper. Native category
Consent choices use the compact `p:` prefix while retaining the category, exact offer identity,
decision, authenticated originating chat and verified disclosure checks.
Meta text parameters reject line breaks, tabs and five consecutive spaces. Disclosures and their
fixed choices use single paragraphs; disclosure presentation changes receive new revisions and
matching content hashes. Frozen evidence retains the exact transmitted text without transport rewriting.
When inference is refused by provider quota or availability, or its single invalid-output repair
is exhausted before any mutation attempt, WhatsApp
stages one fixed failure reply through its ordinary delivery evidence. It makes no result or commit
claim and waits for verified delivery before completing the Turn. Inference failures remain separately
classified in metadata-only telemetry; failure after a mutation attempt retains its existing recovery
path without substituting a generic reply for an uncertain outcome.

See [ADR 0014](../../docs/adr/0014-deep-hosted-turn-modules.md).

## 7. Background execution and availability

Queues carry bounded versioned identities/facts; Cloudflare Workflows run durable execution with
Effect inside owned steps. Workers recheck retained owner state on redelivery. D1 records domain
intent, authorization and provider outcomes; workflow progress cannot substitute for them.

Statement dispatch first offers a claimed, committed intent directly to its stable Workflow.
The same receiver checks current submission ownership, retention and state on either path.
An ambiguous creation requires an existing-instance lookup; unavailable creation and lookup fall
back to the Queue with the unchanged identity. The D1 intent and scheduled retry remain the
recovery path when both offers fail. Neither handoff means extraction has completed.

Committed queued statement readback can wake the owning User coordinator's durable alarm.
Its dispatcher selects only that User's published intents. One coalesced alarm preserves the
earliest statement or hosted recovery deadline; the alarm attempts both recovery owners and
hosted recovery restores any later deadline. Erasure retires the resident alarm scheduler before
joining pending native writes and clearing the alarm, so late callbacks cannot recreate custody.
Publication succeeds when a best-effort wake fails; D1 intent and independent cron discovery
remain authoritative recovery.

Maintenance composes owner discovery, reconciliation and retention without acquiring domain SQL or
policy. Post-commit publication accelerates durable handoff; scheduled recovery handles missed
publication. Independent activities retain bounded work, fair discovery and failure isolation.
Cadence, spend bounds, diagnostics and incident procedures belong in the
[background-work runbook](../../docs/operations/cloudflare-background-work.md).

Subscription privately owns billing observation from candidate discovery and cancellation handoff
through durable progression and recovery. Transaction lookup and PaymentSource cancellation retain
distinct evidence and budget rules behind that module; collection and observation share private
transaction verification. Queue publication remains upstream of observation admission.

Connections owns recovery progression, including hourly attempt retention and five-minute held-grant
cleanup eligibility. Generic maintenance schedules one recovery tick; the owner attempts due phases
independently, retains phase-specific operational evidence and reports aggregate failure after the
remaining phase has run. Interruption stops progression. Durable grant claims and cleanup checkpoints
remain separate from provider I/O, and unknown authorization outcomes do not authorize replay.
Active-token observations and cleanup completion require the exact retained grant envelope and a
live cleanup lease. Verified token inactivity clears encrypted custody while retaining cleanup-required
history; bank consent independently continues to suppress erasure. Missing cleanup configuration
makes no progress and cannot establish suppression completion.

Dashboard view timing headers carry request-local numeric metadata only. Direct HTTP reads report
source/context selection, financial projection and owner Audit/accounting inside Core's canonical
path and recovery R2/D1/SQL spans. Held coordinator reads additionally report hop, queue and execution;
their recovery measurements use a distinct Dashboard prefix. These spans overlap hierarchically.
When browser source selection shares admission, its I/O belongs to `canonical-admission`; there
is no separate `dashboard-source` duration to add or interpret as eliminated work.
Workers production clocks advance at I/O boundaries; CPU-only
decoding, aggregation and encoding require a separate native CPU profile, not zero-duration claims.

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

| Area                                | Reference                                                                                                                                                                                              |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Financial projections and Dashboard | [Projection ownership](../../docs/adr/0030-dashboard-exact-write-maintained-projection.md), [explicit Dashboard mutations](../../docs/adr/0032-explicit-dashboard-creation-and-canonical-queries.md)   |
| Recurring                           | [Historical detection](../../docs/adr/0032-deterministic-recurring-charge-detection.md), [planning](../../docs/adr/0036-recurring-planning.md)                                                         |
| Billing                             | [Enrollment](../../docs/adr/0021-browser-only-payment-credential-enrollment.md), [renewal](../../docs/adr/0034-weekly-card-renewal.md), [provider ambiguity](../../docs/runbooks/billing-ambiguity.md) |
| Connections                         | [Connection contracts](src/core/connections/contract.ts)                                                                                                                                               |
| Privacy                             | [Withdrawal](../../docs/operations/processing-withdrawal-1273.md), [Titular procedure](../../docs/operations/titular-requests-1273.md)                                                                 |

Connection authorization preparation privately owns its attempt-bound verifier, state digest
and bounded PAR handoff in `connection_authorizations`. Claim and Audit commit before external bank
I/O; the claim refuses superseded attempts before committing any effects. Prepared review is
bound to the exact WebSession that consumed the attempt. Settlement cannot replay a consumed
attempt or publish a handoff after the shorter of the thirty-second preparation budget and the
original attempt lifetime. The scheduled Connections retention sweep clears
expired private proofs independently of User Consent, and erasure removes them before attempts.
The Bancolombia adapter reuses private Core mTLS/signing custody for application authentication,
consent creation and PAR. It records the immutable consent intent at claim and the returned ConsentId
before PAR. A bounded, matching-User secret profile pins the support-collection version and approved
test identity; missing or invalid profiles install no adapter. The browser acceptance fixture
controls only external bank responses. Production institution registration stays empty. A Core-only, same-User admission window of at
most one hour permits sandbox testing with the accepted support collection.

The sandbox callback uses the original live WebSession and state digest, never bank identity as
Fidy identity. Its single-use grant claim commits before token exchange, outside provider I/O;
the User coordinator then settles validated Accounts, Active authority and Audit in one D1 batch.
`connection_grants` owns claimed/quarantined/active/cleanup-required authority; its recoverable
credentials use purpose-bound AES-GCM under a separate Core secret. Recoverable tokens are
quarantined before response status, token shape, bank identity and complete Account discovery can
accept or reject activation. A rejected response never authorizes another exchange.
`connection_accounts` retains stable Fidy identities across reauthorization and exposes only the currently active grant's exact
Account set. The [Connections adapter](cloudflare/connections/) owns credential custody and recovery.

## Manual Pro operations

The shell `pro-grants` owner retains ManualProGrant events and composes current grant standing into
AccessTier and Subscription status. The native `bun run pro` operator tool uses database-scoped
Cloudflare admin authority through Outbound HTTP; no Worker, PAT, browser or hosted-agent operation
can mint that authority. Its grant/revoke statement resolves exactly one existing User atomically.
See [operator procedure](../../docs/operations/manual-pro-grants.md).

## Forwarded institutional email admission

The native Email Worker uniformly refuses new deliveries before reading MIME, querying an owner,
or writing private material. Cloudflare delivery authenticates the native transport, not the
institution or the User's relationship to it. An owned forwarding address, active Consent, envelope
sender, MIME sender, and recognized financial format cannot supply that missing proof.

Routing must remain disabled until an operational capability supplies verifiable institution
admission bound to the exact forwarding-address User. Enablement requires concrete provider evidence
for forwarded-message authentication (including its trust boundary and failure behavior), retention
of that exact User/institution admission with the receipt, and Connections-owned eligibility at both
retention and atomic settlement. Connecting, Active, and Action required conflict; no Connection or
Ended qualifies. Tests must cover each state and races at both boundaries before routing is enabled.
No environment toggle or permissive verifier can substitute for these requirements.

The Ingestion receipt/storage and coordinated processing operations remain available for retained
work and native integration evidence. They do not establish institution verification or production
readiness. Previously queued work retains its original Processing basis, context and expiry after
withdrawal; maintenance and erasure remain active. Issuing or returning a forwarding address does
not enable native delivery.

An unknown receipt-publication response requires a same-User receipt readback before object
cleanup. A failed or malformed readback retains both private bytes and the original writer's
unresolved custody; only authoritative queued state can recover successful publication. Retries
reuse the original receipt and deadline rather than rewriting material or extending retention.
