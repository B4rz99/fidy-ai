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

Browser and PAT atomic batches use the canonical catalog to identify eligible children. The
UserStore checks every child's current authority before a receipt can be disclosed. Local owners
prepare decisions from the same starting snapshot and reserve any conflicting targets. Their
guarded writes, per-child Audit, one commercial admission and one batch receipt commit together.
PAT retries retain reviewed result types under the original 24-hour expiry and split large results
across receipt rows. Browser batches execute under their current WebSession. Uninstalled owners return a child-addressed failure.

The Core minute Cron calls Maintenance to traverse the lifetime registry and check Directory,
Pricing and independent Erasure. A private check inspects retained owner work and repairs the
earliest required alarm. Owner alarms execute the continuation. Maintenance persists its cursor
before each batch and reports interrupted or unanswered checks as unknown. A repaired alarm and
a confirmed domain outcome have separate evidence. A probe whose cancellation cannot settle
stops the tick. Maintenance flushes its progress before resetting the object to release outstanding
I/O. A stalled shared owner runs after the User page budget on the next tick. A stalled User
restores shared-owner priority.

The Directory reserves a Wompi environment and billing reference, a WhatsApp business endpoint
and delivery correlation, or a forwarding local part at the configured domain. Each route names
one User and one retained operation. The route must exist before a charge, message send, or
forwarding-address disclosure. The Email Worker continues to refuse inbound forwarded messages.

Core verifies provider proof before awaiting durable Queue acceptance. A billing Workflow looks up
the signed Wompi transaction ID and routes its verified reference. The User checks the captured
payment facts and commits settlement, standing, and billing Audit together. The WhatsApp consumer
routes authenticated lifecycle evidence to the named User. The User checks its one-shot send,
portfolio, endpoint, recipient, provider message, and event time before recording the result.
Verified delivery can resume the Agent’s retained Turn or proactive occurrence through its private
coordinator. In-flight and rejected effects keep their original identity.

The User stages signed WhatsApp statement documents and eligible private Email in its R2 prefix.
User SQLite retains each source identity, digest, original deadline, and processing intent. Queue
messages and Workflow activities carry the User and source IDs. User alarms recover unfinished
stages and remove expired originals and derived material. A forwarded Email's deadline is 90 days
from its first receipt. Erasure must drain the User's statement staging and Email prefixes together
with its SQLite review evidence, materialized rows, and sample candidates.

Forwarded Email capacity is shared in the Directory. It stores up to 10,000 reusable slots with
opaque receipt IDs, generations, original deadlines and outstanding or retained state. At most
1,000 receipts can be outstanding. Before R2 staging the User persists an offered slot and
generation, then claims that exact generation. Repeating an uncertain claim consumes one slot.
The User settles it after committing the processing outcome. Original expiry releases capacity
even before physical cleanup. Directory alarms clear expired receipt IDs and preserve only the
slot generation needed to refuse stale claims.

When disposing of staged Email or erasing a User, fence further local admissions and drain its
private writers. For each local receipt with a capacity slot, send the private Directory
`Release` command with its original slot, generation, receipt ID and expiry. Retry the same
command until acknowledgement before deleting the local receipt. Release also fences an offered
generation whose claim acknowledgement was lost. A stale release preserves the current holder.

Hosted Agent admission can call `retainLocalStatementDocumentOrigin` in its User transaction
before staging a document. The retained message, Session, Turn, occurrence and deadline bind later
statement decisions to that origin. Browser and batch review owners enforce the same boundary.

Eligible Email interpretation can retain a structural IngestSample candidate with its receipt,
revision, market, parser revision, anonymization revision and expiry. Private human review owns
approval. Candidate creation records no approval and the User expires the candidate alongside the
original Email.

Unmigrated paths still use D1. Canonical mutation units commit live authority, owner
changes, accounting and Audit together. Database guards enforce ownership and revisions alongside
per-User coordination. Shared reads preserve the same authorization and accountability boundaries.

R2 writes and provider calls cannot join that transaction. Retained intent connects committed state
to external execution; ambiguous outcomes require owner reconciliation. Erasure coordinates owner
cleanup and uses an independent registry to prevent restored data from regaining authority.
See [atomic accountability](../../docs/adr/0029-atomic-batch-accountability-boundaries.md) and
[statement staging](../../docs/adr/0028-statement-bytes-are-staged-outside-atomic-batches.md).

Connections retains each User’s ConnectionAttempts, encrypted grants, Accounts, and Synchronization progress in that User’s SQLite store. Account discovery commits the grant generation and first eligible Synchronization with its recovery alarm. Queue messages and Workflow instances carry the User and job identities. The User claims one read of the captured Account and cursor, releases SQLite during the provider wait, and checks the grant, cursor, registration, erasure standing, and original deadline again before committing a page. The financial owner commits each new institution movement with its source attestation. A unique Account and movement reference prevents a later page from duplicating a Transaction. Recurring admissions check live processing Consent. The deployed institution registry stays closed and the Bancolombia sandbox exposes only its implemented capabilities.

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

### Account erasure admission

The mounted browser sends its binding and cookie to the User through the Directory session route.
The User checks freshness in the SQLite transaction that commits the ErasureReference, admitting
session, request time, local admission fence and required handoff alarm. Processing Consent is
independent of this privacy right. A retry from the same still-fresh session receives its original
receipt. A lost handoff leaves the User fenced.

The private Erasure namespace confirms the original admission with the named User before
registering an independent case. Its alarm and the fixed Maintenance watchdog target retain
discovery. The case records separate Directory, Pricing and Maintenance acknowledgements. Each
shared owner preserves its exact barrier and the original operation identities. Directory can
recover a committed or cancelled bootstrap and retains the old identity hold. Pricing reconciles
the original BillingRegistration at the User. Maintenance checks the independent case before
fencing the User lifetime, and requires that case to be Complete before retirement.

A signed WhatsApp status or the original send reply can settle its exact started delivery during
Draining. The disposition stays with the User and cannot start Transcript or reminder work.
A verified Wompi observation can settle an already-issued charge during Draining. The original
Subscription, immutable BillingAttempt and payment evidence stay at the User for settlement.
The fence blocks new collection and renewal admission. Shared Price history remains with Pricing.
Fencing all participants leaves the case Draining until the independent drain and custody
protocol establishes the remaining deletion conditions.
