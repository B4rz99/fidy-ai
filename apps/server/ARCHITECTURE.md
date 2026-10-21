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
- Core's one-minute cron delegates to a reserved maintenance object in the existing private SQLite
  `UserTransactionCoordinator` namespace. The composition root selects the maintenance runtime before
  constructing any User coordinator; ordinary User fetches and alarms retain their existing runtime.
  The maintenance instance coalesces
  overlapping ticks and runs the existing owner schedule within the Durable Object CPU budget;
  no maintenance work falls back to the cron Worker. Its fixed non-User key coordinates execution,
  confers no authorization, and retains no domain state or credential. Reusing the deployed class
  permits zero-traffic candidate uploads without an atomic class-lifecycle migration.
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

`bun run lint:deps` checks resolved import relationships. General ownership, publication targets,
layer direction and runtime roles are enforced once in `tools/depcruise/boundaries.mjs`; the server
cruiser configuration holds cycles, platform dependencies and narrow application seams. These
policies apply to future owners without adding owner-specific rule families.

`bun run check:publication` separately checks exported source bindings for private value/type
forwarding. Both commands share complete graph resolution and reject empty, incomplete or unresolved
graphs. `bun run test:architecture` covers policy combinations in memory and checks actual resolution
and command wiring in isolated temporary projects. Production rules do not recognize test filenames.
Browser bundle checks independently bound the client graph.
Semantic leakage through an otherwise legal interface still requires review.
See root architecture's public-surface review and
[ADR 0031](../../docs/adr/0031-published-owner-interfaces-and-visible-internals.md).

### CLI distribution metadata

`cloudflare/cli-distribution/runtime.ts` owns the anonymous GET `/cli/latest.txt` route at public
ingress. It reads only the fixed GitHub latest-release asset, validates a maximum 64-byte numeric
release version within 15 seconds and returns plain text under the existing API security policy.
Outbound HTTP bounds every provider response to 4 KiB, permits at most two explicit redirects to
reviewed GitHub release destinations and exports only closed provider telemetry. Failure returns 503; it never invents a default or accesses private Core. Request cancellation owns
the upstream read. The route shares the edge's source-IP request bound.

### Operator request register

The cookie-only privacy transport also serves explicit access to visible effective Transactions at
`POST /web/privacy/transactions`. Transactions owns the financial selection and decoding; Consent's
browser composition owns the shared exact Origin, body bound, request pressure and fresh-session
admission. Every page independently binds that exact credential and freshness in the native D1
snapshot with its metadata-only Audit. Identity supplies only same-User display preferences and
Categories supplies its bounded public taxonomy before that final proof recheck. It requires no renewed processing Consent or commercial
standing, offers no mutation or PAT/OAuth authority, and never treats a cursor as a credential.
The scope excludes deleted records, raw Ingestion bytes, suppressed original members and other
owners' data; a broader request cannot be closed as fulfilled by this projection.

`scripts/titular-requests` is a local manual operator ledger, separate from canonical User state.
It persists bounded UUID references and workflow observations in private SQLite outside Git, under
the owning POSIX OS User. It cannot authenticate a Titular, query Core, send a response, withdraw
Consent or erase product data. Commands compare revisions and atomically commit history and projection;
replay returns the original receipt. Live verification, evidence storage, calendar/classification,
retention, safe delivery and operator approval remain gates in the
[procedure](../../docs/operations/titular-requests-1273.md).

### Whole-Titular erasure

The following describes the installed selective-retention implementation. The accepted full-deletion
target in #1425 has separate [cutover contracts](../../docs/operations/database-cutover-1428.md),
including existing archive disposal, independent restore markers and file-write safety gates.
Do not remove installed safeguards based on target table counts or design acceptance alone.

`cloudflare/erasure` composes current owners' published native erasure stores under the existing
User coordinator. `POST /web/privacy/erasure` uses exact Origin, bounded confirmation and fresh
WebSession authority to record one intention. Dedicated issuer-verified operator Access binds the
verified #1273 case/handoff, exact User, current inventory, reviewed class dispositions and the
response route before approval. The local handoff preparation tool checks reference consistency;
it neither authenticates a Titular nor gains server authority.

Draining fences new protected admissions while owners prove their exact prior work has finished or
expired. Sealing retires MCP state/owners and confirms native alarm removal. Each owner retains its
own exact-User SQL, archive fields, dependency order and bounded deletion. Native append-only guards
admit only exact User/store permits inside the owner's erasure batch. Normal source-to-derived
projectors do not run for that exact authorized erasure; derived stores have their own dispositions.
A reviewed hold preserves a record before ordinary cleanup can delete it during draining.

D1, private original buckets, restricted retained copies and processor work have independent durable
checkpoints. Reviewed cases, original locators, held records and recovery generation live in the
private erasure bucket outside D1. Every normal native database unit asserts that external generation
with its D1 work, including Sessions. Missing registry/checkpoint configuration refuses normal reads
and writes. The assertion is a read-only SQL expression that raises a native error on mismatch;
it remains inside the same atomic batch, so guarded reads do not consume D1 writes and a failed
assertion rolls back the whole batch. First-release initialization is a separate operator action;
it cannot reset a registry after an approved case. A restored D1 remains fenced until independent
case replay has finished native dispositions and the operator release predicate succeeds. The maintenance escape path reads
only purpose-qualified erasure controls, never ordinary restored User content.

For first-release bootstrap, native POSTs to the dedicated erasure operator path may preserve
candidate version-routing metadata when carrying an Access assertion. This selects a staged Core;
it does not authenticate the caller. Core still verifies the dedicated operator authority before
every action, including Initialize. Browser-Origin requests remain refused, and ordinary paths or
requests without an assertion cannot borrow these overrides without the existing smoke proof.

The receipt is operator-accessible after User credentials disappear and names completed, retained
and pending scope. External acceptance, unresolved Kapso Free retention/capability, lawful holds and
backup windows remain visible until actually resolved. Completed case controls have separate reviewed
finite expiry and bounded D1/R2 cleanup. A metadata-only sweep reconciles expired orphan placeholders
and nonce objects without treating financial/held payloads as control garbage. An enabled Connection
with unresolved required suppression blocks sealing; #313 owns bank-specific implementation.
See [inventory](../../docs/operations/titular-erasure-inventory-1274.md) and
[operator/recovery procedure](../../docs/operations/titular-erasure-1274.md).

### Connection browser preparation

The portable Connections runtime derives browser transport identity and methods from its declared
browser operations and owns cookie-only header forwarding policy. Public ingress, Core and native
Connections consume that meaning while enforcing their own origin, method and authority checks.

`cloudflare/connections` owns browser review and single-use preparation independently of the
canonical initiation operation. The public Worker forwards only the browser cookie, Origin and
body metadata to private Core. Preparation enters the existing User coordinator and atomically
rechecks the exact fresh WebSession, unrevoked Consent, institution gate and original attempt
deadline before consumption, private execution metadata and Audit commit. Review needs a live
same-User session and returns only safe Connection facts and `ready` or `prepared` progress.
A newer attempt retires the older continuation's progress; execution metadata cascades with the
attempt's bounded retention. Independent Core maintenance removes at most 128 attempts per tick
once their original expiry is 24 hours old, cascading execution metadata even after Consent
withdrawal or inactivity. Stable Connections and their separate Audit evidence remain retained.
Preparation leaves the Connection `Connecting` and grants
no institution authority. Bancolombia authorization, callback validation, protected credentials,
Account discovery and activation remain pending the verified institution contract; the production
gate remains disabled.

`cloudflare/bancolombia-sandbox` owns the public registration prerequisite: a static public RSA
JWKS and an unavailable callback at fixed sandbox paths. Ingress serves these without a Core
call or private-key binding. The callback strips query parameters through a fixed 303 before
returning a static unavailable explanation; it performs no authorization or state change.
See the [sandbox registration guide](../../docs/operations/bancolombia-sandbox-registration.md).

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

Public MCP ingress accepts only the configured API origin and a matching Host header when present.
It rejects every present Origin before Core admission under the native-client-only policy; Origin-less
requests still require OAuth authentication. Production uses the fixed HTTPS API, while local and
acceptance modes allow only their exact loopback API origins.

[ADR 0033](../../docs/adr/0033-hosted-mcp-and-oauth-agent-grants.md) defines the installed development
slice, not launch enablement. `oauth-agents` owns separately identifiable OAuthConnections, fresh
browser approval, atomic Consent/code publication, PKCE exchange and digest-only finite credentials.
The reviewed absolute 7/30/90/365-day grant lifetime cannot grow through use or refresh. Refresh
atomically rotates credentials under the original User coordinator; recognized replay revokes the
entire credential family, including a concurrent winner. Lost delivery requires new browser approval,
with no grace window or recoverable replacement cache.

`mcp` projects installed eligible canonical queries and mutations from the assembled declarations through Effect's
protocol runtime. Discovery is deterministic and authorization-private, including nested batch children and
SuggestedOperations. Both supported MCP protocol adapters execute in the existing User Durable Object;
Core authenticates and forwards a bounded private admission. Sessionless protocol requests retire
their SDK owner after the leased response, while sessionful requests retain their bounded native
owner. Only immutable scope-projected catalog metadata is shared; current User authority is never
cached. Calls use the shared canonical owner invocation under live OAuth credential,
grant, User, Consent and capability guards, with distinct Audit attribution and exact Money codecs.
Ordinary mutations and authorized atomic batches reuse the canonical one-User mutation unit, owner preparation,
collision policy, live authority, accounting and Audit. Sensitive operations require exact OAuth-native confirmation
from canonical confirmation metadata, including batch children. Account-security operations
remain unavailable; OAuth callers never inherit PAT, WebSession or Hosted Agent Session lifecycle authority.

MCP projects the exact owner-observed effects and standard native continuation in **Claude Code
and Codex only**. Canonical `oauthApproval` metadata additionally requires a fresh same-User
first-party browser decision for Budget and Transaction update/deletion, Memory revision/forgetting,
and confirmed Ingestion operations, including any containing atomic batch. The browser reviews
immutable input/effects; its decision marks the existing bounded intent without executing it.
Client-native acceptance alone cannot approve selected work. Other sensitive operations retain
ADR 0033's accepted client-assertion boundary. Neither contract independently attests human presence.

The confirmation owner consumes the exact intent once with the live credential/grant, scope,
Consent, owner revision guards, mutation and Audit. Review waits never hold User coordination
throughout the native interaction. Missing capability, unsupported interaction, wrong subject,
changed input/revision, expiry, revocation or invalid acceptance refuses safely. Browser decisions
use the existing first-party Origin/session-binding and fresh WebSession boundary. Pending browser
approval records expire with their original five-minute intent and are erased before the referenced
WebSession. No approval operation enters the model's canonical tool catalog.
Live first-party browser sessions list bounded connection metadata and at most three attributable
canonical activity entries. Revoking one or all owned connections requires a fresh session and commits
atomically with append-only Consent evidence. Safety controls remain reachable after processing Consent withdrawal. Revocation
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

Onboarding composes a new User, original 168-hour TrialPeriod, accepted Consent and digest-only
BackupRecoveryCode with the provider owner's verified proof in one D1 batch. Google and Microsoft
OIDC authenticate issuer/subject; returning authentication approves the initiating BrowserLoginPairing
without creating owner records or renewing Consent/TrialPeriod. WhatsApp-led signup additionally
requires the exact originating chat's association confirmation. Provider contact email creates no
VerifiedEmailCredential. Refusal rolls back all owner state; success discloses recovery once in the
immediate no-store response. Browser Login alone creates the subsequent WebSession.

The mandatory mailbox-code signup adapter, enrollment/outbox storage, Queue/Workflow and deployment
bindings are deleted. Email Authentication retains optional existing-mailbox login and fresh-session
credential replacement, with Resend proof delivery. Neither grants provider signup authority.
Microsoft accepts personal and work/school accounts through the common v2 authority, validating
exact tenant/issuer and signing-key scope. The native Core root supplies bounded Outbound HTTP for
fixed token/JWKS destinations; Maintenance expires protocol state. See the
[authentication feature map](../../docs/operations/authentication-feature-map.md),
[Google evidence](../../docs/operations/google-authentication.md), and
[Microsoft evidence](../../docs/operations/microsoft-authentication.md).

Consent owns current standing and append-only evidence. A standing read is not cached authorization.
The Processing Consent browser declaration supplies cookie-only status and explicit withdrawal
at `/web/consent` and `/web/consent/withdraw`, outside canonical operations and agent tools.
Private Core authenticates without requiring Consent or a paid plan; withdrawal enters the
existing User coordinator and atomically rechecks live credential proof with Consent and Audit.
Repeated withdrawal returns the original receipt. These controls remain reachable after withdrawal.
Ordinary protected work checks current Consent. Exact durably queued work retains its historical
Consent only through the owner's same-User unfinished-item projection and original expiry. Consent
owns that composition; Ingestion and Insights own native receipt/outbox/intent proofs. Queue payloads
and recurring schedules grant no authority. New admissions and scheduled occurrences remain blocked;
category grants, association, security limits and one-shot egress remain independently live.
An exact Pending hosted Turn retains its admitted Consent basis for bounded completion; revocation
prevents the next Turn. Model egress still passes
through the Consent-owned boundary, and PAT work retains its per-call guard.

`shell/outbound-http` is the raw outbound provider transport boundary for Kapso/Meta, Wompi, and
outbound Resend. It owns fixed destinations, credentials, redirects, byte bounds, and safe failures.
Provider adapters consume its published contract. HostedInference instead uses the direct Workers AI
binding behind a provider-neutral contract and approved-model/conformance gates, with no external
model fallback. Kapso voice transcripts are external channel material, not Fidy-controlled inference.

Telemetry is allowlisted metadata only. Audit is a separate owner of accountability evidence and
transaction-composable recording; peers supply subject/credential proofs, not Audit persistence
shapes. Secrets, personal content, provider bodies, and raw failures stay out of telemetry and public
error projections. The Cloudflare adapter exports closed span, outcome and failure events to
structured logs, with bounded trace/span coordinates joining finite Work records. Canonical owner
execution, hosted Turns and model rounds create application spans; expected refusals remain declared
outcomes. Model failures distinguish invalid output, unavailable inference, timeout and resource
admission without exporting prompts, replies or tool arguments. Queue workflow handoffs observe each
native message attempt, preserving acknowledgment, retry and interruption semantics.

Public ingress starts a server-generated root and discards caller-provided internal correlation.
A validated diagnostic trace receipt may be returned to browser and CLI callers. Trusted private
Worker/coordinator boundaries and versioned durable envelopes carry only trace coordinates and an
age-bounded timestamp; missing, malformed or stale context starts fresh observation and never changes
domain admission. Provider requests receive no Fidy trace headers. Private Transcript and retained
domain state remain owner-held evidence for constructing synthetic reproductions, separate from
metadata-only diagnostic traces.
When investigating a failure from its trace, follow the
[trace reproduction guide](../../docs/agents/trace-reproduction.md): locate the deployed release,
separate observed facts from hypotheses, and reproduce the bounded boundary failure with synthetic
fixtures instead of requesting retained personal content.

Focused evidence lives in `cloudflare/runtime/application-observation/operations.test.ts`
(closed application outcomes and nested parentage), `cloudflare/runtime/telemetry.test.ts`
(adapter projection and trusted continuation), and Queue failure-isolation/hosted-Turn tests
(authoritative acknowledgment, cancellation and execution semantics). CLI canonical tests check
failed-call receipts and quiet successful output. These local checks do not establish live log
retention, collection, or production overhead.

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

`sql_assertions` shares fixed, metadata-only guard slots across owners. Each scope preserves the
old singleton's row presence and update behavior; no User or request identifier becomes a scope.
The shared `prepareChangedRowAssertion` binds the scope and aborts the enclosing D1 batch unless
the preceding statement changed exactly one row. Its successful write also changes one row,
preserving downstream `changes()` chains. Predicate checks remain owner-local. Named refusals,
per-child attribution, request-keyed controls and cursor guards retain their specialized storage.

R2 bytes and D1 state cannot commit together. Statement staging is authenticated, bounded, opaque,
and non-authoritative. Canonical publication verifies ownership, size, and digest and commits the
submission, accounting, staging promotion, and extraction intent together. Unpublished material
expires; authoritative submissions cannot reference missing or mismatched bytes. See
[ADR 0028](../../docs/adr/0028-statement-bytes-are-staged-outside-atomic-batches.md).

Statement extraction materializes bounded, private derived chunks in D1, pinned to the same User,
original digest, parser revision and retention deadline. Complete publication precedes capture;
atomic row receipts advance progress without rescanning prior outcomes. Terminal or expired
submissions delete derived material in the same D1 transition. Original bytes remain in R2.
The private Ingestion source module owns reuse, interrupted-generation recovery, parse reservation,
source validation and complete publication behind one chunk-acquisition interface. It returns verified
rows or closed rejection/unavailability failures; processing owns row capture and terminal settlement.

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
| Budgets                          | Exact spending and threshold decisions over Transactions' published exact aggregates                     |
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
| Audit                            | Accountability evidence, append-only recording, and bounded retention                                    |

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
provider failures remain failed BillingAttempts without extending paid history. All methods and periods share three-day grace and bounded renewal retries.

Failed renewals admit at most two new immutable BillingAttempts at 24 and 48 hours after the
original boundary, only during three-day grace. Pending or ambiguous collection blocks retry;
verified success grants the adjacent period once and fences queued sibling attempts. Source, terms,
and original calendar stay frozen throughout retry. Grace expiry is a read-time AccessTier decision;
TrialPeriod remains independent. Canonical Subscription cancellation shares the one-User mutation
unit, accountability, scope and confirmation policy. Its retained stop and detached-source guards
prevent new attempts and unsent collection without rewriting history. DaviPlata source void intent
uses the existing billing Queue/Workflow; a claimed PUT is never repeated and bounded matching GETs
reconcile uncertainty. Card and Nequi are detached locally because provider void semantics are not
established. See ADR 0034.

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
A direct-card creation response retains its transaction identity separately from callback hints.
Only that known transaction, authenticated final decline after the retry window, no other candidate
and no paid period permit another explicit first-payment attempt. Unknown sends remain blocked.
Source replacement atomically rechecks fresh browser authority, retires only a definitively declined
card and reserves a new card or wallet enrollment; attributable no-charge confirmation can clear a
historical failed card without fabricating its missing creation response. Pending/approved evidence,
wallet retirement and paid Subscriptions remain excluded. Rejection preserves the existing form and source. A partial
unique index retains one active source while original source identities and billing history survive.
AccessTier is derived at the decision instant, never persisted as a separate authority. Automatic
renewal includes a fixed three-day grace after the paid boundary, excluding stopped renewals and
refunded periods; grace never alters paid history. See
[ADR 0021](../../docs/adr/0021-browser-only-payment-credential-enrollment.md).

## 6. Hosted execution and delivery

Agent constructs one deep service inside the existing User coordinator. It privately owns context,
Compaction, confirmation, bounded inference, canonical execution, delivery, and terminalization.
A soft HTTP deadline cannot release serialization before owner settlement or durable recovery.
Progress observation does not start a second Turn or bypass canonical tool policy.
Inference owns format feedback and one-shot repair preparation through `repairInvalidOutput`;
Agent decides first-round eligibility and charges the subsequent execution to the original Turn
deadline and iteration budget. Repair never executes canonical tools or delivers a reply.

WhatsApp recovery restores that soft response lifecycle only after rechecking the exact Pending
Turn, User and current channel association. Its original model deadline is unchanged. A Queue
batch dispatches at most four User groups concurrently, retaining each User's message order and
individual acknowledgment/retry decisions; the User coordinator still owns execution settlement.
For an operator-configured Kapso sandbox endpoint, authenticated caller phone evidence is retained
with the exact private inbound Turn under its existing bounded retention. Queue envelopes remain
User/Turn identifiers only. Hosted and fixed voice-refusal replies use this phone only for the
matching sandbox endpoint; other endpoints use BSUID, and missing sandbox phone evidence fails closed.

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

Ingestion's `recoverHeldStatementDocument` operation owns retained-reference recovery, upload
admission, bounded media retrieval, staging and lease cleanup. Agent receives only the staged
reference or a closed refusal; it retains canonical publication, commit recovery and Transcript
evidence. Upload grants and staging primitives remain private to Ingestion.

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
reachability health. Lossy counters in the Core HTTP assembly and each User coordinator MCP residency observe
authentication, exact provider-callback validation and MCP canonical 4xx refusal bursts without
request metadata. Each observer permits at most one outstanding write; all share one fixed D1
presence row. Its scheduled
warning is not complete attack detection or admission authority; restart and distributed-traffic
blind spots remain explicit. Unreadable measurements are unavailable, not zero. D1 outage email claims use
bounded, conditional writes in the existing private R2 staging bucket,
so a failed D1 inspection or metrics read cannot disable outage notification. Claim metadata contains
no User or financial content. Conditional observations, acknowledgement and the 23-hour safe
provider retry identity survive Worker restarts; only healthy D1 inspection starts resolution.
One bounded resolved tombstone retains the firing cooldown. Ordinary alerts retain D1 claims.
See [ADR 0035](../../docs/adr/0035-d1-independent-operator-alerts.md). Operational procedures and
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
accountability and visible review; provider retrieval/extraction is not installed.
Media submissions hold indexed admission-capacity slots until bounded expiry cleanup releases them;
there is no media processing outbox or unfinished-work claim. Accepted images therefore remain
visibly extraction-unavailable, with bounded locator/caption retention. Rejected images retain no deferred bytes and admit no hosted Turn.
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

The isolated native coordinator harness exposes a bounded fixture clock advance so restore tests
can cross a retention deadline in both the operator process and real Durable Object without
changing retained rows or production clocks. Its clock control exists only in the test entry point.

The loopback browser harness controls its process clock for admission cooldowns. After a real,
declared resource refusal, browser fixtures advance that clock and the browser's timer before the
application retries. Native D1 grants, request limits and all production clocks remain unchanged.
The clock operator is confined to the loopback fixture; browser evidence explicitly proves burst
refusal before advancement and readmission afterward.

Hosted Turn integration evidence is split into transport, statement, canonical-tool and continuity
suites. Their private `agent/hosted-turn.test-fixture.ts` constructs the same native runtimes and
registers cleanup separately in each test process; every case retains an isolated database.

Verification combines dependency/publication checks, generated contracts, browser graph checks, and
behavioral evidence. Passing a fake or portable test never establishes a production adapter's
existence, durable guarantees, or launch readiness.

Transactions retain Dashboard projection control and the optional fact-revision group in one
`dashboard_projection_state` row per User. New Users have an empty ready projection and no fact
revision. The first capture installs the revision, first capture time and captured time zone;
subsequent effective-fact changes advance only that revision. Projection repair changes readiness,
version and cursor without rewriting fact metadata. A fact revision never proves readiness.
Aggregate reads and publication guards inspect both groups in one row, and recurring consumers
continue to use the published revision projection. One projections-class erasure disposition
archives and removes the combined state after its existing Transaction and projection dependencies.

Recurring stores each immutable first-confirmation snapshot and its original ID on its owning
series, independently of the mutable detected pattern. An explicit confirmation sequence preserves
digest ordering and checkpoints, including when a series predates its confirmation. New patterns
and snapshots publish in one insert. Confirmation erasure clears only the snapshot fields before
the separate series disposition removes the parent.

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

#1091 moves native pre-User WhatsApp signup to `provider-authentication`. Consent retains authenticated
initial disclosure and accepted historical evidence. The provider owner retains public handoff references,
one claimed BrowserLoginPairing and immutable reviewed provider-account association; native WhatsApp
routing consumes confirm/deny replies before Agent admission or Transcript. A one-use send claim fences
each handoff/review before bounded native spend admission and Kapso I/O. Uncertain sends never repeat.
Identity prepares only an initial association from Consent's accepted caller projection. Provider
completion adds it to the same D1 batch as proof consumption and pairing approval; the existing table's
User and Portfolio/BSUID uniqueness refuse established conflicts. Existing Users create no owner records.
Consent exchange expiry cascades transient handoffs and attempts while copied legal evidence persists.
The real public/Core/D1 suite verifies decisions, conflicts and atomicity; the built-browser fixture
substitutes only external provider/Kapso responses. Live WhatsApp and deployed provider evidence remain gates.

## Monthly budget planning

Budget queries remain observational. An explicit month on a canonical Budget write freezes that User's inherited category caps as cap records in `budget_month_plan_records`, together with its separate saved-month marker, cap edit, and Audit in one guarded D1 batch. Saved month amounts remain fixed; unsaved months preview the latest prior plan without rollover. A budget begins in its explicitly selected creation month and can be assigned to an earlier month through its existing identity. Legacy writes without a month retain the baseline-cap behavior. Current cap reads project the applied current plan, while historical spending uses the requested half-open calendar period in the supplied IANA zone.

Group labels organize categories across months. A group rename explicitly selects Category identities, updates only the caller's Budgets, and captures the selected collection's revision for OAuth review. Each named group owns one Currency through currency records in `budget_month_plan_records`, versioned from a selected month in the same canonical D1 unit as its caps and Audit. Category caps project that inherited Currency. Changes retain nominal amounts, preserve earlier month Currency, and reject incompatible precision in affected retained caps. Currency revisions invalidate Budget projections and group confirmation evidence. The browser never combines currencies or converts Money to floating-point values for totals.

Budget status reports include observed monthly income and expenses from Transactions’ published exact aggregate projection. The same requested half-open period, caller ownership, and optional category/currency filters apply to that cash flow, including when no caps match. Category spending uses those same complete aggregates. There is no separate paginated Budget contribution reader or report checkpoint. Consent and projection readiness are checked in the same native D1 batch as the totals; unavailable projections refuse the report rather than return partial spending.

### Recurring planning

`core/recurring-plans` owns local calendar projection, scoped plan transitions, exact tracking
Money, allocation decisions and currency-separated summaries. `cloudflare/recurring-plans`
publishes bounded observational reads and revision-bound mutation preparation to the existing
canonical coordinator. A User-owned D1 document retains plan revisions, pauses, exceptions,
fulfillments, exclusions and suggestion dispositions; shared metadata Audit and the document
advance in one atomic unit under live caller authority. Its finite document limits refuse growth
rather than truncate monthly totals. No account identity is synthesized from an AccountHint.

The Transaction owner publishes effective planning facts; planning never reads foreign tables or
reimplements Reconciliation. Unique fixed exact matches are derived without query-side domain
writes. Explicit mutations snapshot established effective completions before changing schedules or
allocations; bounded incomplete matching reads fail closed. Corrections invalidate retained links
visibly. Canonical declarations derive browser, hosted-agent, PAT/OAuth and MCP capabilities.
The owner supplies revision-bound lifecycle descriptions for hosted review without exposing
planning storage to the agent. Browser review metadata is derived from a live same-User,
same-Turn host challenge; model text cannot install it. Exact-input, expiry, channel and one-use
confirmation guards remain at canonical execution. Historical RecurringSeries and frozen digest reports keep their existing meaning. See
[ADR 0036](../../docs/adr/0036-recurring-planning.md).

The ingestion review workspace projects statement rows, forwarded email and media into an
expiry-ordered, metadata-only inbox and retained history. Revision-bound drafts, reversible
skip/restore decisions and permanent statement abandonment share one Ingestion-owned decision store
and transition preparation; individual reviewed capture composes Transaction and manual
SourceAttestation writes in the canonical D1 unit. The source context and original expiry
never come from the browser. Original material and deterministic suggestion reads use explicit
WebSession-only canonical policies, so originals cannot enter agent tools or immutable transcripts.
They return bounded escaped text with no-store delivery; missing media bytes permit manual completion
before expiry. Draft/suggestion retention ends at the original source deadline independently of
hosted conversation routing. Retry never commits a Transaction or overwrites User-edited facts.

The shared native D1 test fixture prepares SQL descriptors locally and sends ordinary reads,
writes, and batches through its asynchronous Worker fetch boundary. The same Miniflare D1
binding executes every statement and transaction; native metadata and errors return across
that boundary. Sessions, raw results, unsupported bindings, and mixed session batches retain
the original binding path. The fixture suite compares both transports, including BLOB values,
transaction rollback, foreign keys, FTS, and isolation. No application database implementation
or production query path uses this test transport.

For a never-opened test binding, the shared fixture may clone an immutable native D1 baseline
image captured immediately after schema installation. A separate warmup process discovers and
closes the empty slots before use. SQLite serialization includes committed WAL pages; the
standalone image uses SQLite's documented journal-header conversion. Any earlier query, native
session, raw access, or caller-owned schema disables replacement. Snapshot bytes never include
subsequent test mutations. All reads, writes, constraints, FTS, and transaction evidence still run
inside workerd's real D1 binding; Bun only serializes and copies the pristine image. Pools own
both Worker shutdown and removal of their temporary files.
Accountability records share one append-only `audit_entries` store, qualified by record type.
It retains browser/PAT/OAuth/hosted attribution, detailed call outcomes, ingestion publications,
media admission, billing transitions, admitted requests, identity reads and security mutations.
The public Audit history uses one indexed ordered query. Ordinary call/publication retention uses
one bounded deletion path; media follows its submission, billing follows its attempt, and request
admission metadata expires independently. These lifetimes remain explicit.

One erasure implementation selects each record type under its original logical purpose,
data class, archive shape and exact User-specific permit. The logical purpose IDs are permission
identifiers, not additional tables. Generated references preserve the existing Dashboard session
exception and media cascade. Billing retains its indirect User ownership through BillingAttempt.

Audit records accountability; it does not meter product usage. Canonical admission owns one shared
short-term User request policy, Quotas owns monthly Free allowances, and provider owners bound
expensive work. There is no extra daily canonical-call, batch-envelope, per-feature Audit, or
Transaction creation allowance. Child completion and owner capacity assertions remain in the
atomic canonical unit; they do not count Audit history.

Statement clarification and the review workspace write `ingestion_review_state`; statement-specific
projections translate its status without storing a second decision. Conversation resolution clears
original row evidence and settles its clarification, while workspace skips remain reversible until
the original evidence deadline. Source context and capture idempotency remain Transaction-owned.

Media submissions retain their nullable review reason and review creation time directly; a missing
legacy review marker stays absent. Forwarded email receipts retain a nullable last deferral check,
which drives the bounded fair sweep and clears on admission or expiry. These fields share their
parent's erasure and retention lifecycle; provider outboxes and immutable processing outcomes keep
their separate delivery and accountability meaning.

Recurring-charge detection evaluates changed facts no more often than seven days after that User's
last completed evaluation. New Users enter at the next hourly discovery. Completion times spread
work across Users; bounded full batches continue draining the backlog. The existing dispatch cursor
retains the hourly discovery wakeup, while indexed unfinished evaluations resume on minute
maintenance ticks. Transaction mutations invalidate the revision but do not dispatch detection.

Weekly summaries and category messages retain their optional dispatch state directly on
`insight_reports`, keyed by User, delivery kind and identity. Dispatch presence, retry counts,
creation time and last attempt remain independent of report content and WhatsApp provider state.
Publication writes the report and initial work in one insert. Indexed metadata discovery derives
expiry and content availability directly from that row; text expiry preserves dispatch progress.
Category sends retain channel-started proof across expiry and ambiguous delivery. Weekly question
work and offer requests use separate `insight_reports` kinds, preserving their request and governor
evidence without creating financial reports or InsightEvents. All delivery work uses the same
dispatch state, retry fields and metadata discovery.

A recurring-discovery offer request carries an explicit current-opportunity marker, unique per User.
Foreground request admission moves that marker atomically to the exact request, including a replay
of an older request. Request timestamps do not determine the current opportunity.

Users retain the optional stable Subscription identity and issued email-forwarding address directly.
The subscription UUID survives changes to paid standing and remains the foreign-key identity for
Refund attempts. A processing grant installs the opaque forwarding address and original issue time;
merely creating a User does not issue an address. Billing identity and forwarding address retain
separate purpose-specific archive and field-clear permissions before User deletion.

Billing attempts retain their collection dispatch cooldown and send claim directly. Email proof and replacement rows own their current work identity and
queue dispatch cooldown; a new proof generation resets that cooldown. Dispatch does not keep
separate outbox rows or unused publication timestamps. Payment authorization/reservation and
statement publication use the shared `sql_assertions` control inside their existing atomic
batches. Recurring confirmations carry their immutable `digest_excluded` marker; migrating
that marker preserves the exact set of previously excluded confirmations.

The shared `sql_assertions` store also enforces named failures for canonical request protection,
commercial authority, browser continuation commits, media capacity/publication and recurring cursor
revision checks. Insert and update guards preserve the closed signals consumed by each owner's
failure classifier. Each predicate stays inside its original D1 batch; fixed slots replace
request-keyed scratch records and their cleanup statements. Commercial consumption and its
capacity enforcement remain owned by Quotas.

Proactive insights and standalone prompts share `proactive_transcript_entries`, discriminated by
kind. InsightEvent and delivery identities remain separate; entry IDs are unique within their kind.
The original insight sequence, grouped event links and per-message expiry survive consolidation.
Grouped links reference only same-User insight entries. Authenticated reply context uses one
protected lookup; retention and erasure share one message store without creating hosted Turns.

## Consolidated identity and consent storage

The original TrialPeriod is retained as `users.trial_started_at_ms` and
`users.trial_ends_at_ms`. Onboarding creates the User and trial in one insert. Existing dates are
copied exactly; a missing original trial stays missing. A started trial cannot be restarted or
edited, and deleting its User requires the User-specific erasure permit.

Consent owns one typed append-only `consent_history` for processing grants, withdrawals and
renewals, weekly grants, rejected decisions and revocations, contextual proactivity decisions,
PAT consent, and OAuth consent. Current standing, offers, and execution state remain separate.
The record type qualifies identities and uniqueness; typed, same-User foreign keys preserve
relationships between grants, revocations and retained reports. Permission checks still select
the appropriate purpose. A shared erasure implementation retains each purpose's dependency
order, archive fields, and exact logical permit, while all history records use one physical table.

Weekly summaries and manual-entry reminders share `schedules` and typed revision/execution records in
`schedule_history`. Recurring digest instructions use a separate schedule kind; closed digest days
use a history kind that needs no fabricated schedule identity. Kind-qualified identities allow one
schedule per User per kind and keep
revision and occurrence foreign keys within that User and kind. Current schedules retain indexed
execution fields and a typed instruction snapshot; immutable revision snapshots remain unchanged
when a schedule advances or disables. Activation, advancement, and erasure use shared persistence.
Consent eligibility, recurrence calculations, governor decisions, and allowed occurrence outcomes
remain owned by their respective feature policies.

Weekly summaries, proactive messages, reminder occurrence evidence and full recurring digest reports
share `insight_reports`. Weekly and proactive delivery identities remain kind-qualified, with
same-User foreign keys from dispatch work and grouped event links. Reminder evidence and recurring
payloads live on the matching report row; their original fields remain independently retained,
including any historical detail with no delivery header. New reminder and recurring publications
write one report row in the original atomic unit. Recurring reads use the frozen payload directly,
and text expiry only clears delivery text. It cannot rewrite retained financial content, instruction
bindings, evidence deadlines or report identity. One erasure projection covers the combined store.

Authentication attempts own connection preparation and provider completion metadata, including
proof-consumption results. Completion still commits with its required evidence and caller actions
in the original atomic batch. Statement submissions own their manifest, hosted-origin binding and
clarification state; bounded derived parts remain separate. Forwarded email receipts own immutable
review metadata and their completion outcome. Parent erasure projections include the consolidated
fields and follow the resulting foreign-key dependencies.

Weekly and contextual offers share `consent_offers`; typed references preserve their separate
consent meanings. Weekly and reminder state share `proactivity_governors`, with once-only delivery
markers on their verified InsightEvent or report. Each marker retains its original receipt erasure
purpose and clears before its parent is removed. Every identity and mutation qualifies its purpose.
The policies for unanswered messages, questions and pausing remain feature-owned.

Hosted replies, weekly summaries, contextual sends and weekly questions share
`whatsapp_deliveries`. Each kind retains its original state constraints, immutable send evidence,
identity indexes and content deadlines. Hosted callback events reference only hosted correlation
tokens. Retention reads use partial deadline indexes and bounded row batches. Logical erasure
purposes retain their exact permits and archive fields through shared delivery persistence.

## Shared document and companion storage

Dashboard layouts and Recurring Planning documents share `user_documents`, keyed by User and
kind. The shared persistence operation owns encoded document reads and optimistic revision writes;
each feature retains its own codec, absent-document behavior, authorization, and mutation outcome.
Their original `projections` and `schedules` erasure purposes select only the corresponding kind.

An InsightEvent holds its optional immutable delivery receipt. Verified settlement installs receipt
identity, provider evidence, and the pending-to-delivered transition in one guarded write. Later
read/dismissed transitions preserve that evidence; delayed settlement never regresses attention.
OAuth review observes event and receipt together and guards both field groups at commit. The original
receipt erasure purpose clears only its fields before the event's independent deletion.

A User holds an optional statement-backfill entitlement group. An explicit presence marker preserves
absent, available, reserved, and consumed states. Publication reserves only for a Free User; successful
capture or review consumes the reservation. Failure releases an unconsumed reservation through the
submission transition trigger; completion and clarification retain their existing release rules.
The original ingestion erasure purpose archives and clears the group before its referenced submission
or User is deleted, preserving the separate subscription and forwarding fields.

Users retain verified email, backup recovery credentials, WhatsApp association and the verified
insight destination as independent optional field groups. Email uniqueness remains case-insensitive;
recovery lookup uses an indexed digest, and rotation/consumption keep their revision and single-use
rules. Each group retains its original credential or conversation erasure purpose.

Hosted Turns retain their verified WhatsApp inbound and optional statement attachment directly.
Delivery foreign keys require the inbound-qualified Turn identity. Inbound evidence is immutable;
its dispatch intent remains independently mutable. Staging deletion and publication clear attachment
fields without deleting a Turn. Attachment and conversation erasure remain separate.

OAuth refresh and support recovery evidence use `audit_entries`, with typed foreign keys and unique
consumed/issued refresh identities. Refresh history cannot expire through ordinary Audit retention;
support evidence follows its case's 24-calendar-month retention. The shared erasure fence maps each
record kind to its original logical permission.

Budget threshold InsightEvents retain the immutable crossing snapshot and unique delivery-group /
threshold identity. Publication creates the event and snapshot in one write. The global pending
statement-review counter stays materialized: deriving it at its 5,000-item bound examines 5,000 rows
per check instead of one, with no measured local latency benefit.

## Operational record consolidation

`recurring_evaluation_records` holds typed facts, proposals and one progress record per User.
Evaluation restart and completion clear only scratch variants; the last completed evaluation and
its revision remain available while a newer scan runs. Copied facts and the detector's captured
time zone and revision guards retain their original meaning.

`recurring_digest_items` retains independently optional staging and permanent consumption fields.
Rebuilding a staged source clears only staging, preserving consumed-only dispositions. Completeness
counts only the staged set. Each field group retains its own logical erasure permit and archive shape.

`erasure_control` separates the optional published generation, restore session and per-bucket cursors.
A restore candidate never supplies a missing published generation. Cursor compare-and-swap, scan
completion and independent restore membership remain release requirements. `erasure_custody_records`
retains typed current states and event history; a current state references the exact same-case,
same-custodian event instead of duplicating its evidence payload. Pending states need no event.
Custody migration refuses unmatched historical evidence rather than dropping or inventing it.

Subscription cancellation is an optional User field group independent of paid standing. Its original
paid period, source identity, void claim, verification budget and retry cooldown survive re-enrollment
and expire only through their billing erasure purpose. Email security counters share one store with
an explicit global variant; the global pairing limit remains 1,000/hour, User pairing remains 5/hour,
and replacement remains 5/day. Recovery admission continues to use its live admission records;
the unwritten operator-counter table and its cleanup are removed.

Voice refusal and hosted delivery callbacks share `whatsapp_event_records`, with distinct kind-qualified
identities. Voice refusals keep their User admission and seven-day replay retention; callbacks keep
their hosted delivery foreign key, immutable status events and Turn-owned retention. The channel's
shared erasure projection retains each original purpose, owner predicate and archived fields.
Reminder control decisions use `audit_entries` as exact same-User/message replay evidence. Ordinary
Audit retention never expires those decisions or counts them as product usage.

## Financial companion consolidation

Verified payment sources are an optional immutable field group on their original `card_enrollments`
row. The enrollment UUID and the payment-source UUID remain distinct unique keys: BillingAttempts
reference each by its own meaning, and cancellation retains its source key. `verified_payment_sources`
is a read projection, not a writable compatibility store. Authorization installs source identity,
provider identity, billing email, creation time and method together; reuse does not fabricate another
source. Retirement retains its existing verified-no-charge rules. The source's independent billing
erasure purpose archives and clears its fields before enrollment deletion.

Transactions retain optional same-User Reconciliation pair keys beside their original facts.
`reconciled_transactions` exposes this membership as a read relation. A composite foreign key binds
it to the retained decision, and a partial pair index supports membership counts and effective reads.
Link/unlink still commits the decision, both members and accountability atomically. Membership-only
updates do not masquerade as captured or corrected Money; their own projection triggers retain the
Dashboard linking transitions. The original membership erasure purpose clears the pair keys before
Transaction or decision deletion.

`billing_provider_transactions` retains independently optional callback-hint fields and an optional
attempt binding. `billing_callback_hints` is its bounded lookup projection. A signed hint alone can
have neither a verified status nor an attempt identity. Collection or a verified lookup may install
the attempt binding once; verified approval cannot regress. Provider and callback lookup budgets,
cooldowns and archive shapes remain independent. Callback erasure clears only hint fields; provider
erasure removes its binding/evidence while preserving any independently retained unowned hint.

Moved source, membership and callback groups retain their original archive row references. Their
read projections expose those retained references; newly created groups use purpose-qualified stable
record identities. Erasure chunks therefore keep addressing the same record across migration without
rewriting archives or external recovery objects. Clearing a group also clears its reference.

## Feature storage ownership

Each feature owns a coherent set of tables. A separate table must earn its place through cardinality,
retention, independent identity, or measured query requirements. Table count alone is not the target:
consolidation should also remove duplicated state and redundant queries without hiding relationships
inside generic payloads.

Statement processing work and hosted proposal/retention state inherit the owner of their parent row.
They do not store another User identity. Their existing revision or timestamp identifies presence;
clearing an optional group never clears the parent owner. Dispatch, acknowledgment and retention read
those parent fields directly. Erasure archive projections derive the former optional owner fields,
including their absent state, so retained archive contents keep their original meaning.

Statement extraction and refund dispatch retain no per-row protocol version: their work messages use
version 1, while publication time and the nullable verification counter respectively identify retained
work. Hosted dispatch inherits its Turn's User and uses its creation time for presence. Connection
preparation uses the consumed attempt timestamp, retaining its authenticated session binding. The
constant billing `attempt_number` is removed; `renewal_attempt_number` remains the actual retry count.
Historical erasure projections derive these removed values without changing archive shapes.

Statement materialization uses its submission's interpretation context directly: parser revision,
source format, ServiceMarket, locale and time zone become immutable while material is retained.
Manifest publication compares the supplied context inside its guarded write, rather than storing
five copies and comparing them on every retry. Source/parts hashes, representation revision and
material expiry remain independent validation evidence. Migration rejects mismatched historical
context instead of silently reinterpreting cached rows. Archive projections preserve the old fields
by deriving them only when material is present.

Billing renewal work is represented by its optional due timestamp; its former kind had only the
`renewal_due` value. Discovery reads the BillingAttempt directly. Cancellation, refund and paid
standing guards still control installation and removal of that timestamp.
