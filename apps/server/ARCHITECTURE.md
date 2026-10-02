# Server architecture

Read the repository [`ARCHITECTURE.md`](../../ARCHITECTURE.md) first. This document owns the stable
boundaries of `@fidy/server`; it does not describe a process deployment because this package has no
production listener.

## 1. Application shape

`apps/server` is the canonical contract and domain package for the Cloudflare application:

- `core/` contains pure business decisions and schemas. Core code has no platform requirements.
- `shell/` contains operation declarations, provider-boundary contracts, policy projection, and
  portable adapter code. It must not manufacture a local runtime authority.
- `contracts/` contains generated OpenAPI and operation-policy evidence owned by the canonical API.
- `cloudflare/` contains the Worker entrypoints, platform adapters, D1 migrations, and their tests;
  it implements the server-owned contracts without changing the portable core or shell.
- `src/client.ts` is the browser-safe declaration seam. It exports no server implementation.

The deleted process entrypoint, SQL persistence, in-process queue/lock/workflow machinery, and
provider-specific hosted inference implementations are not compatibility surfaces. Railway,
PostgreSQL, and a Bun process are superseded Production architecture under ADR 0026. The private
Core Worker in `apps/server/cloudflare` owns the D1-backed Categories adapter path, the direct
Workers AI binding boundary, the service-binding boundary, and the bounded health projection. It
declares that binding without building it: the User coordinator Durable Object builds the
hosted-inference layer only for Memory work and admitted hosted Turns that consume it. The server's
Cloudflare runtime owns resource admission, User-coordinated canonical mutations, statement staging,
and the Queue/Workflow adapters for onboarding email, browser-pairing email, email replacement, and
billing collection. Operations without an installed adapter fail closed; declaring an operation or
binding is not evidence that its full execution path is available.

## 2. Slices and ownership

A slice owns its domain decisions and published schemas. Cross-slice references use stable ids and
published interfaces; implementation files and `internal/` modules remain private. Core does not
import shell or platform code. Shell adapters load external values, pass plain values to core, and
map typed domain failures to the public contract.

The canonical operation definition is the source for reflected operation ids, access metadata,
suggested operations, OpenAPI, MCP definitions, and hosted-agent tool descriptions. The reflected
registries remain complete even when their execution implementation is unavailable; a registry entry
must never silently fall back to local state. The direct proof-bearing PATPairing API has no stable
User or canonical operation policy; its generated OpenAPI is checked for freshness independently of
the stable-User contract pair. No prelaunch compatibility gate compares either API with older revisions.

## 3. Security and subject boundaries

`UserId` is explicit wherever a decision needs a subject. No ambient process-local current-user
service, claim id, provider id, or opaque identifier grants authorization. Browser login keeps the
private verifier in the browser and treats the server/Worker as the proof-verification authority.

Cloudflare storage adapters must preserve the same subject boundary: D1 queries receive an explicit
subject, Durable Object keys are coordination identities rather than authorization, and Queue or
Workflow payloads contain only bounded, secret-free projections. The private, unrouted Email Worker admits and retains forwarded mail with a narrow D1/R2/Queue
binding; downstream processing uses the provider-neutral forwarding contract. Institution
Connection-state admission and authenticated sender proof are not installed, so no production Email
Routing rule enables inbound delivery.

Telemetry is metadata-only and provider-neutral. Secrets, request bodies, model content, provider
responses, and personal data do not cross the telemetry contract.

Audit publishes approved schemas through `core/audit/contract.ts`, transaction-composable recording
and budget operations through `shell/audit/operations.ts`, and D1 observation and separately built
retention authority through `shell/audit/runtime.ts`. Its projections and lifecycle evidence writers
are private under `shell/audit/internal/`. Peers supply held credential authority or a subject-scoped
owner commit proof, never Audit table names or body projections. Credential activity consumes an
Audit-owned proof instead of reading Audit persistence directly. The evidence observer distinguishes
attributable canonical calls from supporting statement publication/review rows whose baseline stores
no credential; it never invents missing attribution.

## 4. External providers

`shell/outbound-http` is the only raw outbound provider transport boundary. It publishes closed
requests for the retained specialist providers—Kapso/Meta, Wompi, and outbound Resend—and owns fixed
destinations, credential handling, redirects, byte limits, status projection, and safe failures.
Provider adapters cannot import raw transport or private implementation modules.

Hosted inference exposes a provider-neutral contract backed only by the direct Workers AI binding
the User coordinator Durable Object builds for Memory work and hosted Turns, which the Core Worker
only declares without building. A closed approved-model schema and live provider-conformance gate protect canonical tool,
continuation, structured-output, and `es-CO` behavior. Unsupported or absent configuration fails
with typed unavailability, and there is no gateway, direct OpenAI, or external-model fallback.
Kapso-generated voice transcripts arrive as external channel material through the authenticated
WhatsApp webhook; they are not a Fidy-controlled model invocation or hosted inference adapter.

## 5. Persistence and asynchronous execution

This package contains schemas and operation contracts, not a process-local database, SQL transaction,
queue, lock, workflow, or migration authority. The Cloudflare implementation makes D1 the
application state authority, Durable Objects the keyed coordination authority, Queues the redelivery
mechanism, Workflows the durable multi-step mechanism, and R2 the bounded content authority. Those
platform services must remain infrastructure, not alternate domain models.

The D1 baseline contains domain state, authentication and accountability evidence, durable outboxes,
statement staging/publication state, and resource-admission tables, alongside the stable Category
taxonomy and User-owned keyword rules. Subscription queries derive AccessTier from the original
TrialPeriod and settled paid period at the decision instant, return a bounded User-owned standing
projection and published Prices, and audit each protected read in its D1 unit. Verified Wompi
settlement creates immutable paid periods in the same atomic unit as BillingAttempt success; no
independent AccessTier owner is stored. Hosted Turns are serialized by the per-User coordinator;
D1 retains their User entry and Pending status atomically. A generated reply is an immutable
short-lived delivery proposal, not Transcript evidence. The authenticated browser receives the
proposal, renders it, and sends a one-use receipt through the same coordinator. Only that receipt
atomically writes the exact assistant entry and Completed status; delivery failure becomes Failed,
while an unacknowledged proposal becomes Interrupted after its delivery window via a per-User
Durable Object alarm, even without another request. The private Core scheduled sweep independently
recovers missing alarms, including admission-to-alarm failures, without a User request. Expired
receipts fail closed and recover the
pending Turn. The same per-User alarm removes exact terminal Transcript content after thirty days
while retaining metadata-only Turn status; D1 rejects premature or Pending-evidence deletion.
The browser conversation/receipt contract is server-owned and deliberately separate
from canonical tool-callable operations (see root architecture §2). The User's daily
hosted-Turn allowance is read before model preflight and guarded again at insertion. The canonical Categories implementation runs the bounded
ordered query, decodes every row through the published Category schema, and is shared by the
operation registry and the private Core Worker adapter. Keyword rules are scoped to one User and
reference stable CategoryIds; capture reads them for future Transactions and no rule change
rewrites retained history.
The infrastructure admission primitive atomically charges Stable-User, source, operation,
outstanding-work, and spend policies with caller-owned proof, replay, or outbox statements. Its
resource refusal and authority-unavailable failures are separate from commercial allowance results.
The shared canonical mutation unit in `cloudflare/mutations` composes the Reconciliation, Category
keyword-rule, Memory, Dashboard document, and statement-publication owners into one User-scoped D1 commit, derived from
the operation catalog so a new canonical mutation joins it without editing the unit. If an adapter is absent, canonical mutation execution returns the closed
unavailable failure. It must not use an in-memory map, local queue, process lock, or best-effort
continuation as a substitute.

Statement bytes enter private R2 through a bounded, User-authenticated browser-session transport,
not a canonical operation or PAT surface. Staging returns no readable content or authority. Only
`ingestion.submitForExtraction`, whose input is a retry key and an opaque staged reference rather
than bytes, can publish after checking ownership, size, and digest. R2 and D1 cannot commit together:
the Core Worker owns the R2 binding and expiry sweep, and no authoritative submission may refer to
missing or mismatched bytes. Unpublished material expires; published bytes follow the submission's
retention while their staging row records their eventual removal. See
[ADR 0028](../../docs/adr/0028-statement-bytes-are-staged-outside-atomic-batches.md) for the
staging and publication protocol.

Dashboard first-use document creation, edits, and view preparation use the same canonical mutation
unit for individual and atomic-batch calls. Batch preparation does not read earlier children's
writes; a batch refuses a second Dashboard document child rather than claiming an intermediate
view. Invalid first edits leave no document or accepted AuditLogEntry.

Dashboard Money views require a write-maintained projection of **effective** Transactions,
updated atomically with each effective transition and its Audit. The Transaction owner provides
old/new contributions; core defines exact Currency, Category, period, and time-zone bucketing;
the Cloudflare adapter stores the User-scoped read model. First-use backfill, zone changes,
versioned repair, and concurrent writes must prove completeness before a projection-backed
view is served. An incomplete projection is unavailable, never a partial total. Transaction-list
Widgets fetch only their bounded, filtered page, independently of aggregate totals. See
[ADR 0030](../../docs/adr/0030-dashboard-exact-write-maintained-projection.md) for the decision
and recovery rules. Until projection cutover, the adapter fails closed when its guarded fact
scan exceeds 8,192 effective Transactions; this interim cutoff is not the target behavior.

Individual and atomic-batch statement submissions share one User-scoped publication unit: the
submission, staging promotion, Free-backfill reservation, credential accountability, metadata-only
success AuditLogEntry, and bounded extraction outbox identity commit together or not at all. A batch
admits at most one statement child; its refusal follows the same canonical contract as individual
submission. See [ADR 0029](../../docs/adr/0029-atomic-batch-accountability-boundaries.md) for
accountability and abort attribution.

### Current background execution

Onboarding email, browser-pairing email, email replacement, and billing collection each have a D1
outbox, Queue, and versioned Workflow. Their acceptance boundary schedules an identity-targeted
publication through the Core Worker's execution context after the durable commit. The continuation
has a two-second budget and cannot change the accepted response. It grants no authority and is not
the durability mechanism: the every-minute schedule reoffers eligible outbox identities, including
when the request ended before publication. Both paths share the same atomic publication cooldown.

Audit retention removes only evidence strictly older than 365 days, in bounded subject-scoped D1
batches (64 rows per projection, eight subjects per sweep). A deletion permit is private to the
retention transaction and removed before commit; failed retention rolls back both deletion and permit.
Ordinary recording exposes no rewrite or deletion authority. The Core schedule observes retention
through the existing metadata-only scheduled Work span and closed failure projection.

Every scheduled dispatch, reconciliation, and retention activity is attempted independently. One
failure does not skip the remaining activities; the schedule reports a closed failure after all
activities finish. Provider ambiguity remains owned by the corresponding D1 lifecycle, never by a
blind resend. Queue acknowledgment confirms Workflow handoff, not successful provider delivery.

All five Core Queue consumers share a private dead-letter destination. A bounded operational inspection
observes the oldest eight pending records per owner, inspects stalled Workflow status, and reports
Queue dead-letter totals through metadata-only Cloudflare logs. A separate bounded sample of recent
rejected email work exposes delivery/proof rejection even when a Workflow completes successfully. Measurements that cannot be read
are explicitly unavailable. These signals are separate from the public reachability health response.
See the [background-work runbook](../../docs/operations/cloudflare-background-work.md).

Statement staging, atomic acceptance, extraction Queue/Workflow execution, public status and review
reads, and expiry are installed. The statement Workflow executes bounded chunks under the User
coordinator and settles supported material into Transactions or visible NeedsReviewItems. Its cron
reconciliation and dispatch run independently of the other activities, and its Workflow status and
dead letters are included in operational inspection. Financial content stays out of Queue payloads
and Workflow history. Forwarded-email ingress, private retention, and deterministic processing are installed.
Its identity-only Queue redelivers under the User coordinator; a bounded known format commits one
Transaction with its SourceAttestation, and uncertain, revoked, or interrupted work enters the
User-owned review read. Raw R2 bytes expire independently of the structural tag histogram,
which is retained only for successfully interpreted mail under a versioned allowlist approval policy.
Per-User and global rolling retention budgets supplement outstanding-work limits. Institution
Connection-state admission and authenticated institutional sender proof are not installed: this
codebase has no institution Connection authority, sender-to-institution mapping, or verified sender
result at the Email Worker. No Email Routing rule is provisioned; enable inbound delivery only
when both policies can be enforced before retention and automatic Transaction finalization. The full hosted-Turn path still requires its own adapter and platform evidence.

### Identity owner composition

Identity publishes stable User, WhatsAppIdentity, current UserContext and TrialPeriod declarations
through `core/identity/contract.ts`, and pure User creation through `operations.ts`. Its shell
contract contains browser-safe canonical declarations; shell operations own authoritative User and
TrialPeriod reads. Storage projections stay under `internal/`. WebSession publishes its own fresh
session and credential primitives; Identity composes current Consent with browser authority.

The Cloudflare Identity operations resolve only an established Business Portfolio/BSUID pair and
return a stable UserId as a coordination hint. Every protected action rechecks that same User and
association inside its D1 statement. User-context operations expose a subject-scoped semantic
projection for atomic snapshots and decoded reads, never a User persistence row. Recipient or
credential hints cannot release context without the caller's complete current guard. Historical
context remains captured at the original action, independent of later preferences.

Verified onboarding composes Identity's User, association and original TrialPeriod statements with
the existing mailbox, Consent, recovery and final proof assertion in one D1 batch. This extraction
creates no new session, reassociation, preference mutation or runtime authority. Existing per-User
Durable Objects and closed unavailable paths retain their behavior. No new external workflow or
telemetry purpose is introduced.

### Transactions owner composition

Transactions publishes exact normalized facts, captured SourceAttestation evidence and closed domain
failures through `core/transactions/contract.ts`; `operations.ts` owns pure occurrence, User-decision
and Reconciliation policy. Its shell contract is the browser-safe canonical declaration; portable
failure/continuation behavior and derived route composition have separate operations and runtime
interfaces. No peer imports a Transaction model, stored row, effective SQL relation or repository.

The native owner publishes User-scoped capture, correction, reversible Reconciliation, canonical
history/search, ingestion capture composition and bounded peer projections. Canonical mutations use
the existing one-User D1 unit; source capture supplies its source owner's eligibility query and
commits both normalized facts and append-only evidence with the caller's outcome assertion. Guards
re-evaluate ownership, current authority, revision and source eligibility at commit. Correction
retains identity, Reversal remains a separate completed movement, and linking retains both originals
and all SourceAttestations while recomputing effective facts on read.

Budget receives exact decoded contribution pages with an explicit continuation rather than reading
Transaction persistence. Dashboard reads normalized bounded lists, readiness and the caller's
Identity snapshot in one D1 batch; aggregate reads and repair stay Transaction-owned. Invalid or
incomplete projections fail closed. The shared `cloudflare/canonical-work` module owns existing
credential/refusal/accountability primitives so peer owners never depend on Transaction persistence
to authorize their own work. The original per-User coordinator is published from the Transaction
runtime; it introduces no second ledger or alternate lock. This is an ownership refactor, with no new
external workflow or telemetry purpose; existing canonical spans and metadata-only audits remain.

### Categories owner composition

Categories publishes its stable identities, public metadata, keyword inputs and closed failures through
`core/categories/contract.ts` and its pure capture/keyword decisions through `operations.ts`.
The launch taxonomy's seed attributes and keyword matching implementation remain private. Shell
Categories publishes canonical HTTP declarations in `contract.ts` and complete canonical reads and
failure projection in `operations.ts`; its portable SQL adapter is private.

The native Categories owner exposes required lookup, a complete ordered projection capped at 100
Categories, bounded categorization of up to 100 captures for one explicit User, and prepared canonical
keyword-rule operations. A malformed or oversized retained projection is unavailable, never a partial
answer. No caller reads keyword persistence or interprets the User's matching rules. Statement chunks
load one User's rule snapshot and retain input ordering; changes to rules still affect future capture
only. Required Category lookup distinguishes missing identity from unavailable or malformed storage.

Budgets compose the exact `category_reference(id)` projection into their existing atomic writes, so a
prepared write rechecks existence at commit. Dashboard reads public Category metadata and joins it with
bounded Transaction pages in memory; Transactions and ingestion ask Categories to categorize captures.
The native owner's persistence, canonical adapters and aborted-write classification live under its
private `internal/` boundary. Existing credential, Consent, audit and User-coordination checks retain
their authoritative D1 units. This ownership refactor introduces no new external workflow or telemetry;
the existing canonical spans and metadata-only evidence remain in force.

### Budgets owner composition

Budgets publishes positive exact-Money caps, monthly status, applied IANA periods, monotone latch
states and closed failures through `core/budgets/contract.ts`; `operations.ts` owns the pure
contribution, status and threshold decisions. Its shell contract contains browser-safe canonical
declarations, while shell operations project owner failures and caller-scoped recovery suggestions.
No portable Budget module constructs runtime authority.

The native Budget owner publishes guarded cap mutations, canonical reads, complete cap projections,
resumable exact monthly spending and bounded alert evaluation. Persistence rows, progress cursors,
audit composition and owner-only calculations stay under `cloudflare/budgets/internal/`. Callers
establish live authority and serialize one explicit User before composing these operations. Dashboard
receives public cap facts rather than Budget persistence; Category existence is rechecked through
Categories' published projection at commit. Spending consumes only Transactions' decoded effective
contribution pages, never its stored rows or SQL relations.

One User's fact revision guards retained progress across bounded reads. An incomplete, malformed or
changed-revision projection is unavailable, never a partial total. Calendar bounds remain half-open
UTC intervals derived from the explicit IANA zone; only matching Category/Currency outflows count.
Durable pending work retains backdated periods, and the existing coordinator drains it before later
corrections. Each monthly threshold remains monotone with a unique occurrence under concurrent work.
This ownership refactor adds no external workflow, telemetry purpose, migration or runtime; existing
canonical spans, metadata-only AuditLogEntries and atomic accountability remain in force.

### Consent owner composition

Consent publishes its declarations and decisions through `core/consent/contract.ts` and
`operations.ts`, and its protected actions and append-only evidence through
`shell/consent/contract.ts` and `operations.ts`. Private disclosure facts, ledger SQL, and row
schemas stay in the owner’s `internal/` modules. The Cloudflare Consent module publishes decoded
standing, native statement composition, and its ingress runtime; callers never import its storage
implementation.

Protected owner statements and credential authorities incorporate Consent inside the same D1
statement or caller-owned atomic batch as their action, evidence, and Audit. A standing read is
admission or refusal-classification evidence, never a reusable permission token. Existing per-User
Durable Objects still serialize hosted and multi-step work. Model egress invokes a Consent-owned
protected action at the actual provider boundary: ordinary work requires current Consent, while an
exact retained Pending Turn uses its admitted basis. Revocation prevents the next Turn without
interrupting the bounded admitted Turn, and PAT work keeps its per-call current-Consent guard.

## 6. Testing seams

Use the smallest seam that proves the behavior:

- core tests call pure decisions and schemas directly;
- contract tests validate canonical ids, reflected policy, OpenAPI, and compatibility artifacts;
- security tests cover proof handling, redaction, bounded input, provider authentication, and
  subject isolation;
- provider-boundary tests use the published outbound transport seam;
- browser tests exercise the built static shell with explicit HTTP fixtures;
- Cloudflare adapter tests exercise Categories through public ingress, the real service binding, and
  local D1; resource-admission tests exercise atomic D1 batches through independent adapters and
  persisted runtime restarts; statement staging and acceptance exercise local D1 and R2 directly to
  prove actual bytes, digests, ownership, interruption, replay, admission bounds, and bounded
  retention, including publication and retention through the private Core Worker; the release gate
  exercises Workers AI through its real binding; background-delivery tests cover identity-only Queue
  handoff, redelivery, provider ambiguity, prompt publication with cron recovery, and independent
  retention after dispatcher failure. Workflow activity tests do not by themselves prove live
  platform suspension or production alert delivery.

Ordinary D1 and D1/R2 adapter fixtures amortize Miniflare startup through
`cloudflare/d1-test-fixture.ts`. Each acquisition gets new database and bucket bindings; rows,
schema, triggers, objects, and coordinator instances are never shared between cases. Checked-in
migration SQL is cached as immutable text. Ordinary fixtures can install their entire ordered schema
in one D1 batch before seeding; this is not evidence for production migration boundaries. Migration
behavior tests and fixtures that seed between migrations retain file-by-file execution. Tests
of real Durable Object bindings, runtime restart, and platform lifecycle keep fresh runtimes.
Fixture isolation tests cover contaminated schemas, rows, R2 bytes, and allocation beyond one
process's binding pool. Files remain serial within each runner.

Tests whose only owner was a removed runtime or provider implementation are deleted. Portable
domain, schema, security, contract, browser, provider-boundary, and isolation evidence remains
authoritative.

### WebSession owner composition

WebSession publishes stable references and deadline decisions in `core/web-session`, and
commit-time credential, freshness and historical-ownership operations in `shell/web-session`.
The Cloudflare `web-session/operations.ts` boundary owns browser authentication, renewal, logout and
one-time session establishment; cookie parsing, bearer generation/digests and persisted rows remain
in its `internal/` implementation. BrowserLogin publishes bounded pairing and approval operations,
keeping private-verifier checks and polling state internal. Its authenticated redemption composes
pairing consumption with WebSession issuance in one D1 unit, never a process lock or reusable permit.

Authentication returns only the exact User/session proof required by the existing per-User Durable
Object and protected D1 work. Every protected mutation rechecks its credential owner in that same
commit; account-security and email delivery also recheck the owner-defined fresh deadline. Published
native SQL fragments are composable authority, not cached authorization. Other owners neither parse
browser credentials nor reproduce WebSession lifecycle predicates or import session storage.
The existing bounded Core/public-worker telemetry covers these workflows; the refactor creates no
additional provider call, persisted credential copy or telemetry payload.

### Subscription owner composition

Subscription publishes safe Price, enrollment, BillingAttempt and standing declarations in
`core/subscription/contract.ts`, and calendar-period and enrollment decisions in `operations.ts`.
Its shell contract owns both the canonical read group and the separate browser-only enrollment API;
the browser client consumes those declarations without provider or persistence implementation.
Enrollment remains unavailable to canonical agents and PAT callers.

The shell operations own paid-access predicates and bounded prepared standing reads. A prepared read
carries its row decoder with its statements, so native callers never know Subscription storage
shapes. They commit its live credential guard, credential use and Audit evidence in one D1 unit
before releasing safe JSON. AccessTier still derives from Identity's original TrialPeriod and the
settled paid interval at the decision instant; no independent tier authority is persisted.

`cloudflare/subscription/operations.ts` publishes protected observation and fresh-session enrollment.
Its `runtime.ts` composes the existing Queue, scheduled reconciliation and versioned Workflow.
Wompi models and clients, payment-source identity, webhook verification, settlement SQL and
ambiguity handling are private to its `internal/` implementation. Verified settlement retains the
same immutable Price snapshot, atomic paid-period write and monotonic terminal behavior. Private
operational health observes only bounded pending-work metadata through the owner. Existing bounded
Core, provider and Workflow telemetry is retained; this extraction introduces no new external
workflow, provider call or telemetry purpose.

### Email Authentication owner composition

Email Authentication publishes bounded mailbox and proof declarations in `core/email-authentication/contract.ts`
and pure lifetime and retry decisions in `operations.ts`. Its shell contract owns the browser-safe
verification and replacement declarations; canonical replacement behavior and native binding policy
live in shell operations. Resend request projection, response decoding and failure certainty remain
private, constructed only through the owner's runtime interface.

The native `email-authentication/operations.ts` owns verified onboarding, ordinary mailbox pairing
approval and credential replacement. Consent submits only its already-accepted exchange to the
bounded enrollment operation. Subscription composes the exact User's mailbox projection with its
fresh-session and Consent statement; recovery composes the live same-User pairing predicate. Neither
caller knows the credential or proof storage shape. BrowserLogin separately verifies the browser-held
secret and owns its pending projection and approval transition; email proof cannot create a WebSession.

Native runtime composition publishes the existing identity-only Queues and versioned Workflows.
Proof generation, provider execution, ambiguous outcomes, replay evidence and bounded retention remain
in visible private internals. A candidate mailbox replaces the prior credential only in its fresh,
subject-bound atomic proof-consumption unit. Workflow activities never persist mailbox or raw proof
material, and a lost provider response cannot trigger an automatic resend. Existing bounded telemetry
and operational samples retain their purposes; no new provider call or diagnostic content is added.

### Tokens owner composition

Tokens publishes PAT and PATPairing browser-safe declarations through `core/tokens/contract.ts`
and fixed-lifetime, scope-disclosure and proof-decision behavior through `operations.ts`. Its shell
contract declares both authenticated canonical management and the distinct pre-User, proof-bearing
PATPairing API. Portable operations publish current scope/Consent authority and transaction-composable
lifecycle work. Private metadata queries and decoded persistence remain in `internal/`; consumers
receive bounded safe metadata with its decoder, never bearer-verification or row implementation.

`cloudflare/tokens/operations.ts` owns pairing, manual issuance, authentication, safe listing,
revocation and expiry at the native boundary. Proof parsing, private-device verification, entropy,
bearer generation and lifecycle rows remain internal. Only the immediate issuance or claim response
contains a raw bearer. Approval still fixes the expiration; claim, polling and use cannot extend it.
Admission returns the exact User, PAT proof and required scope for live rechecking at protected D1
work, never a reusable permission.

Tokens selects its own grant references for Consent evidence and historical identities for Audit.
Consent owns only append-only evidence; Tokens asserts that both automatic-expiry transitions match
that evidence before commit. Canonical PAT activity consumes Audit's exact-call proof in the same
unit as the guarded action. Failed guards or evidence writes retain the existing whole-unit rollback
semantics, without a process lock or a post-commit repair. Platform statement binding, clock reads
and non-secret identity generation are independent of Tokens and confer no credential authority.
Existing bounded Core/public Worker telemetry covers these paths; this ownership refactor adds no
provider call, persistent credential, external workflow or telemetry payload.

### Browser Login and Recovery owner composition

Browser Login publishes its browser-safe declarations in `core/browser-login/contract.ts` and
`shell/browser-login/contract.ts`, with pure proof, expiry and polling decisions in core operations.
The direct WebAuth facade composes those declarations. Native operations own all pairing creation,
proof verification, approval and redemption; verifier digests and claim preparation remain private.
Browser Login alone initiates WebSession establishment, composing the exact one-use claim with the
session owner's issuance in one D1 unit. Public references and recovery approval never mint a session.

Recovery publishes only the intended one-time code response and browser operation declarations.
Native Recovery operations privately generate and digest the initial code, passing only its
insertion to Email Authentication's verified enrollment unit and disclosing the code after commit.
Fresh-session rotation rechecks the exact User's authority at its write. Support's origin-verified
Access identity, bounded attempts, credential consumption and metadata-only case evidence stay in
Recovery internals. The code can approve only its existing User and cannot change WhatsAppIdentity.

Support Recovery composes Browser Login's pending/approved projections and approval operation with
Email Authentication's same-User subject predicate. No foreign pairing row or mailbox proof is
read directly. That predicate is a portable published Email Authentication operation, avoiding a
cycle between verified enrollment and recovery. The guarded pairing transition, one-use credential
consumption and tracked case events commit or roll back together. All proof paths retain expiry,
replay, independent browser-verifier and cross-User safeguards. Existing Core request telemetry covers
the unchanged bounded workflows; no new provider call, runtime substrate or diagnostic data is added.

### Ingestion owner composition

Ingestion publishes statement, forwarding-address and visible NeedsReviewItem declarations through
its core and shell contracts. Pure allowance and statement-interpretation decisions remain in core
operations. Shell operations own the bounded byte parser and runtime-decoded email interpretation;
raw IngestSample schemas, mapping samples, format catalogs, parsers and owner fixtures stay private.
The catalog's tool runtime only rebuilds or checks its private generated artifact.

Native operations publish staging admission, canonical publication, bounded review reads and
Transaction-or-review finalization. The canonical mutation unit receives prepared guarded statements,
public committed-state reads and exact same-material replay evidence; it cannot inspect stored
submission rows, R2 locators or admission premises. The submission, staging promotion, Free-backfill
reservation, credential accountability, Audit and outbox identity retain their single D1 unit.
Transactions and Categories are requested through their published owner operations, preserving
source eligibility, historical interpretation context and explicit User/Consent checks.

The native runtime composes the unchanged Email Worker, identity-only Queues, versioned statement
Workflow and bounded retention activities. Private internals retain R2 reads, outbox and repository
queries, raw material, interpretation finalization and retries. Operational health observes only
bounded owner metadata. Existing two-User, hostile-input, atomic rollback, duplicate, interrupted
execution and retention evidence remains at the public or explicit platform-adapter seams. No new
provider call, workflow version, telemetry purpose, institution authority or inbound routing is added;
the existing unavailable institution Connection and sender-proof prerequisites remain closed.
