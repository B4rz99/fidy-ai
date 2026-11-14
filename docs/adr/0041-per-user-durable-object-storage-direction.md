# Per-User Durable Objects own application storage and atomic execution

- **Status:** Accepted migration direction, User storage/execution, routing and shared-fact
  boundaries; background discovery, recovery, operations, acceptance and migration implementation
  remain open.
- **Supersedes:** The D1 storage destination and coordination-only Durable Object role in
  [ADR 0026](0026-cloudflare-native-production-replatform.md), and the initial-platform restriction
  in [ADR 0039](0039-fresh-read-performance-contract.md).

Fidy will replace D1 with SQLite Durable Objects, with one object per stable User owning that
User's application state and atomic execution. Co-locating execution and storage removes the
remote database boundary inside the User's unit of work. This trades the simplicity of a shared
database for explicit global routing, work discovery and recovery protocols. A permanent D1/DO
hybrid is not the destination.

Live User authority checks, domain changes, accounting and Audit remain in one local transaction.
One shared directory object owns routing and pre-User bootstrap; a separate shared pricing object
owns the Price catalog and admission ordering. Independent erasure authority remains a separate
recovery boundary. A transaction in one object cannot make changes in another object atomic.
R2, Queues and Workflows retain their existing responsibilities
unless a concrete design constraint warrants changing them. Colombia versus North America is not
a storage-placement requirement.

## User storage and execution

The [User storage and atomic execution decision](https://github.com/B4rz99/fidy-ai/issues/2200)
places all User-scoped domain records, projections, credentials and grants, Consent, billing and
accounting, Audit, mutation receipts, outbox intent and hosted execution state in the User object.
Domain owners retain their module boundaries. R2 retains file bytes. Canonical queries and
mutations execute in the User object; the shared read executor's User-data role is retired.
Authentication and routing may resolve the destination beforehand, but the User transaction
rechecks the exact caller's live authority. Directory state supplies routing, never permission.

Short local transactions use the storage-backed Effect SQLite Durable Object adapter. Owner work
joins one transaction containing its authority checks, effects and required accountability. Queries
materialize their bounded result with required accounting and Audit before disclosure. Existing
atomic-batch eligibility, per-child accountability and absence of intra-batch reads are preserved.
External calls run outside transactions, allowing unrelated requests to proceed during provider
waits; hosted Turn serialization remains a separate concern. A later action rechecks its applicable
authority and revisions. Previously admitted processing work retains only its existing bounded
continuation rights. External send authorization takes effect at the durable one-shot claim.
Revocation that removes the attempt's applicable authority before that claim refuses it; an
already-claimed attempt reconciles its outcome.

Ordinary local mutations commit their completed receipt with their effects, Audit and accounting,
avoiding a separately committed pending-request state. A crash commits both effects and receipt,
or neither. The ordinary retry guarantee remains bounded to 24 hours; clients stop automatic retries
after that window. An accepted external job returns its work identity and uses its owner's existing
continuation and reconciliation state. Replay disclosure still requires current authority, and
one-time Secrets never become retained response payloads. This changes transaction composition,
not the commercial charging policy or the meaning of an admitted refusal.

## One shared lookup object

The [global identity lookup and User routing decision](https://github.com/B4rz99/fidy-ai/issues/2201)
selects one shared SQLite Durable Object for identity and credential lookup, uniqueness
reservations, pre-User bootstrap attempts and external-event routing. Existing opaque credentials
remain unchanged. There are no hash shards, per-identity objects, embedded User locators or routing
caches in the initial design. Simplicity takes precedence over removing a lookup hop; shared
capacity and availability are accepted constraints that adoption measurements must exercise.

Lookup records retain only the typed lookup key, destination User and necessary local record
reference, exact reservation/operation identity, lifecycle and expiry/reconciliation metadata.
Pre-User attempts retain their existing bounded proof digests and exact decision context; they do
not retain recoverable Secrets or duplicate User profiles, grants, Consent or financial state.
Identity keys remain personal data with purpose-bound cleanup. Public OAuth client registration
shares this physical object while retaining its existing module and admission boundaries; it
never becomes a User grant.

Register an exact destination before activating a new credential, disclosing its Secret or
starting an external effect whose callback needs that route. Reservations supply an address, not
authorization. The destination rejects absent, incomplete, expired, revoked or mismatched local
authority. All User effects, exact proof consumption, Consent, required accounting and Audit still
commit together locally. No directory RPC joins that transaction.

Before a User is known, the shared object owns the bounded login or pairing attempt. Handoff
freezes its exact evidence, permanently binds it to one User and transfers completion to that
User object. The User consumes the imported proof with its owner effects. Repeated handoff cannot
approve another User, create another session or restart expiry. Directory-assigned creation order
preserves existing same-User ready-pairing supersession; import order cannot replace it. Browser
Login remains the sole session issuer. This replaces the shared-D1 bootstrap mechanics of
[ADR 0009](0009-atomic-consent-bootstrap-across-owner-seams.md),
[ADR 0015](0015-browser-paired-web-authentication.md) and
[ADR 0020](0020-mandatory-verified-email-authentication-and-recovery.md), while preserving their
proof, identity and complete User-establishment requirements.

Concurrent first signups for one provider identity reserve the same destination. A lost response
is resolved against that exact User and operation; timeout alone never releases the identity for
another User. Release requires a conclusive local outcome, including a durable cancellation that
prevents delayed completion when the operation did not commit. Updates and cleanup match the exact
reservation so delayed work cannot remove a later binding. Recovery retains metadata, not a raw
PAT, session, OAuth credential or backup code; a lost Secret response requires the existing fresh
login or issuance flow.

Replacement reserves the new identity before atomically switching the User's binding, then cleans
up the old route. Conflicts never merge or transfer Users. Revocation takes effect at the User
commit and need not wait for directory cleanup. Retain routes needed for security recognition:
consumed OAuth refresh generations remain locatable while their connection is live, and session
routing must accommodate idle extensions through the fixed hard deadline. These are routing
retention requirements, not extensions of credential authority.

An empty or deleted destination never creates a User merely because a route points to it. Only
the exact reserved bootstrap may initialize User domain state. Erasure fences old authority and
pending handoffs before releasing identities. Once erasure is complete and the old reservation
has been safely released, fresh signup may create a new UserId. Independent restore fencing and
metadata expiry belong to the erasure decision; stale cleanup cannot affect the new User.

Register Wompi environment/reference and WhatsApp endpoint/delivery correlation before sending;
register a forwarding address before disclosure without enabling disabled ingestion. Authenticated
callbacks may wait in existing durable Queues, with acknowledgement only after durable acceptance.
The destination still checks exact retained work and provider evidence. If neither routing nor
durable acceptance is available, return a retryable failure. Requests needing an unavailable
directory report temporary unavailability, not invalid credentials; already routed work retains
its normal User-local checks. Recovery of missed handoffs and cleanup is durable work for the
background-discovery decision, never an in-memory promise or blind provider retry.

## Shared facts and ordering

The [shared catalog and admission decision](https://github.com/B4rz99/fidy-ai/issues/2207) keeps
logical domain ownership distinct from physical partitioning. Subscription owns shared Price facts
in one pricing object, separate from the directory/login object. The directory hosts the app-wide
login-email attempt limiter alongside pre-User authentication, with those owners retaining their
own policies. Neither object becomes an executor or authority for User data.

Published Prices require one authoritative ordering with new billing admissions. Once publication
completes, every newly started renewal uses the new Price. Existing BillingAttempts and bounded
retries of the same renewal retain their original terms. Publication waits for an in-flight
admission's exact outcome; an uncertain admission can delay or make publication unavailable rather
than permit a late old-price commit. This deliberately favors immediate global pricing correctness
over publication availability. The shared publication protocol does not make an RPC part of the
User's SQLite transaction. The user subsequently removed automatic Price-change announcements in
the [shared catalog decision](https://github.com/B4rz99/fidy-ai/issues/2207). The operator handles
announcements manually outside Fidy; publication has no notice-distribution or recipient-list
coordination requirement. This supersedes the earlier automatic-notice obligation without changing
the ordering of Prices and billing admissions.

The pricing object durably registers each exact new price-sensitive admission before the User can
commit it. Registration binds the User, operation, immutable inputs, selected Price and original
deadline. The User commits its live checks, BillingAttempt, captured terms, accounting, Audit and
terminal admission outcome together. Completion acknowledgements are repairable bookkeeping.
Publication durably stops new admissions for the affected offer, resolves all earlier admissions,
then atomically changes the published Price and reopens admission. It waits for admission outcomes,
not provider settlement. No cross-object RPC runs inside either SQLite transaction.

If a reply is lost, recovery reads the exact User-local outcome or durably cancels that admission.
Commit and cancellation serialize locally; cancellation that wins prevents a delayed commit, while
a committed admission retains its result. Neither a timeout nor an absent-row read proves safety.
Persist publication progress across restarts and process one publication at a time; retrying the
same publication recovers its status. Retain outcome/fence protection until delayed requests can
no longer be accepted, without extending the originating billing or enrollment deadline. This is
an owner-specific protocol, not a replacement for ordinary mutation receipts.

An open enrollment form does not guarantee its displayed Price. If publication wins before the
first BillingAttempt is admitted, the User must review and accept the new terms before that charge
starts. An already admitted BillingAttempt retains its captured terms, and bounded retries of a
renewal retain the original renewal terms. Publication never silently substitutes a higher Price
into an unaccepted enrollment.

The app-wide login-email cap becomes a simple shared attempt limiter, separate from the User-local
limit. Both checks must allow the attempt before sending; an allowed attempt that later fails still
counts. There is no distributed capacity reservation or refund protocol. This deliberately replaces
the current atomic User/global accepted-request accounting for that limit; User commercial
accounting and Audit remain local. Preserve five accepted requests per User per hour and a shared
cap of 1,000 attempts per hour, with the existing independently anchored windows. Check cheap local
eligibility first, obtain the shared allowance outside the local transaction, then recheck local
limits and authority when accepting the exact send work. The final one-shot send claim still checks
the live credential, pairing and expiry. A lost limiter reply permits no send; a fresh counted retry
may waste another slot. No allowance can authorize another email. Other source/global authentication
limits retain their pre-User owners and existing policies.

## Shared Category taxonomy and structural samples

Categories owns immutable taxonomy revisions distributed with application releases. Each operation
uses one complete revision. Stable CategoryIds survive label and order changes; retained references
remain interpretable. User keyword rules, Transaction corrections and Budget choices stay local.
This adds no runtime taxonomy publisher or shared taxonomy DO, and a taxonomy revision grants no
User authority. Operational rollout and revision compatibility belong to the schema/operations
decision.

Ingestion owns structural-sample preparation and human approval. Raw material, pending candidates,
approval evidence and publication intent remain User-scoped. The reviewer sees only the anonymised
structural candidate. An unreviewed candidate expires at the original email's 90-day deadline;
review queues never extend raw retention. Indefinite retention requires both removal of identifying
and transaction-specific values and human approval of that exact candidate revision. A sample
later found unsafe must be removable.

Approved anonymous artifacts can be shared through R2 with independent sample identities and only
their required ServiceMarket, source-format, parser and anonymisation metadata. They carry no User,
receipt or raw-material locator. User-local approval and retained intent precede publication;
external writes run outside the transaction, and recovery uses the same sample identity and
approved contents. Background discovery owns missed handoff and bounded retry. Independent
erasure/restore owns fencing and draining in-flight writes; approval is not permission to copy raw
material into shared storage. The existing automatic-approval implementation does not satisfy this
accepted migration boundary and must be replaced during implementation.

## Adoption evidence

Migration adoption requires measured improvement without correctness regressions. The existing
performance targets remain follow-on objectives; reaching 150 ms is not a prerequisite for this
storage migration. Measurements distinguish backend processing, complete HTTP responses and
click-to-fresh-usable-view latency. [ADR 0039](0039-fresh-read-performance-contract.md) retains the
fresh-read definitions, workload envelope and separate backend/browser targets; this decision does
not turn its 150 ms backend target into a browser-latency claim.

The [infrastructure prototype evidence](https://github.com/B4rz99/fidy-ai/issues/1887) motivates
reducing remote boundaries, but does not establish full-lifetime hosted acceptance, a performance
benefit from per-User partitioning, or complete migration and restore guarantees. Acceptance must
cover isolation, atomicity, revocation, retries, discovery, schema evolution and restore/erasure,
alongside representative latency and load. Exact thresholds and cutover procedures remain open.

## Design boundary

The [migration map](https://github.com/B4rz99/fidy-ai/issues/2198) owns the remaining decisions:
background discovery, independent recovery, schema operations, and acceptance/cutover. The resolved
User storage/execution, identity routing and shared catalog tickets own their detailed decision
records. The
[platform constraints research](https://github.com/B4rz99/fidy-ai/issues/2199#issuecomment-6839405060)
records source-backed findings and outstanding evidence. Dated research and decision-ticket detail
remain on the tracker.

The map produces an implementation-ready design. This ADR records the chosen boundaries; it does
not establish that the migration is implemented or authorize a destructive data reset. Fidy is
unreleased and needs no unnecessary backward compatibility, while any retained data still needs an
explicit cutover disposition. Architecture documents continue to describe the current runtime
until implementation changes it.
