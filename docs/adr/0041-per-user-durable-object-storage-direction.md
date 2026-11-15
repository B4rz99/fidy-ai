# Per-User Durable Objects own application storage and atomic execution

- **Status:** Accepted migration direction, User storage/execution, routing and shared-fact
  and background-discovery boundaries; independent restore/erasure, operations, acceptance and migration implementation
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

The [background discovery decision](https://github.com/B4rz99/fidy-ai/issues/2202#issuecomment-6895944711)
supersedes the earlier publication barrier. Publication atomically changes the current Price selection
and records its idempotent result without contacting or waiting for User objects. Every new exact
registration after publication receives the new Price. An earlier registration may still commit its
original terms within its original deadline. One unavailable User cannot block publication or other
Users' registrations.

The pricing object registers the exact User, operation, renewal/enrollment, immutable inputs, selected
Price and original deadline before User-local admission. Registration supplies terms, never authority.
Repeating the identity recovers the same registration; it cannot extend its deadline or reserve terms
for a different renewal. The User commits live checks, BillingAttempt, captured terms, accounting,
Audit and exact outcome together. Existing BillingAttempts and permitted retries retain their terms.
No cross-object RPC joins either transaction.

Lost replies, completion acknowledgements and cancellation recovery remain scoped to that operation.
Commit and cancellation serialize locally; an absent row, timeout or unreachable User does not prove
non-commit. Retain outcome/fence protection while delayed requests could be accepted. Publication has
no phase waiting for User outcomes. Replaying a completed publication recovers its result and cannot
revert a newer selection.

An open enrollment form does not reserve its displayed Price. Changed terms require review and
acceptance before exact registration; an earlier registration retains its accepted terms within its
original deadline. Never silently substitute a higher Price. Price announcements remain manual
outside Fidy, with no recipient list, fanout or acknowledgement requirement.

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

## Background discovery and recovery

The [background discovery decision](https://github.com/B4rz99/fidy-ai/issues/2202#issuecomment-6895944711)
keeps scheduling with each object that owns durable state. Each User and shared owner retains its
own due records and one alarm for its earliest required wake. The transaction changing intent also
preserves the required alarm; the selected Effect SQL/native integration must prove atomic commit
and rollback. External calls remain outside transactions. Cold activation must not overwrite an
earlier required alarm.

Ready work gets prompt post-commit handoff. Known future work wakes at its next eligible instant;
recovery preserves owner cooldowns, backoff, calendars and original deadlines. Routine cleanup keeps
existing hourly/daily batching initially. Alarm execution processes bounded owner pages, persists
progress and rearms while obligations remain. Independent owner failures cannot starve later work.
No remaining obligation requires no alarm; the next intent commit must arm it again.

The existing maintenance object keeps a minimal durable registry of object identities and checking
progress, not individual jobs. Register each User idempotently before first accepted work/activation,
recover lost registration replies, and retain the entry for the owner's lifetime including idle time.
An unused registration grants no authority or permission to initialize User domain state. Maintenance
unavailability may delay new activation; registered Users continue locally. Directory, pricing and
independent erasure owners are fixed watchdog targets too.

The existing minute cron traverses bounded registry pages with durable progress and finite owner-call
budgets. Under supported load, attempt a check of every registered object within five minutes,
including idle objects and new registrations. This is an acceptance target, not completed recovery
or outage availability. Advance past unavailable/busy Users and expose failed checks separately from
successful observations. Checks repair local missing/overdue alarms and handoffs. Registration before
intent closes missed-notification gaps; independent checking also covers exhausted native alarm
retries. Correctness does not depend on namespace enumeration.

Keep existing Queues, Workflows, stable identities, one-shot claims, retry/deadline rules and shared
admission controls. Queue acknowledgement and Workflow existence do not prove domain completion.
Reoffer only the same eligible retained identity. Unknown payments and messages reconcile exact
provider outcomes without blindly repeating a send. Per-invocation batch/concurrency limits remain
local limits; independent producers can multiply aggregate load, which acceptance must measure.
Shared allowances remain shared. KISS: no priority scheduler or reserved-capacity system; change
limits only for a demonstrated provider constraint or overload.

Directory reservations, permanent proof handoffs and cleanup remain discoverable from retained owner
state. Recover the exact committed outcome or obtain durable destination-local cancellation before
freeing uniqueness. Missing rows, expired timers and unreachability prove neither cancellation nor
non-commit. Only the affected identity/operation remains unresolved; other Users continue. Cleanup
matches the original reservation/target. Authenticate callbacks before durable acceptance, acknowledge
only after acceptance, and preserve existing bounded Queue routing and destination checks. Dead
letters are diagnostic with finite retention; owner reconciliation and expiry remain necessary.

Pricing uncertainty never blocks publication or unrelated registrations. Anonymous sample retries use
only the exact human-approved revision, independent sample identity and approved content, outside the
transaction. Original raw/candidate deadlines and independent erasure fences still apply. Independent
erasure progress remains discoverable after User-local deletion. Safe registry retirement, metadata
horizons and fencing late registration/restore belong to the independent restore/erasure decision.
An empty User database alone never permits retirement.

Reuse metadata-only owner, Queue, Workflow and retention monitoring. Add watchdog traversal age,
coverage, overdue checks and scoped uncertainty. Unknown/unavailable is not healthy zero; complete
coverage is not successful execution. Keep User content and identifiers out of logs/alert dimensions.
Operational page/concurrency/budget settings belong to the operations decision; five-minute traversal,
fault isolation and aggregate load require acceptance evidence.

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
independent restore/erasure, schema operations, and acceptance/cutover. The resolved
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
