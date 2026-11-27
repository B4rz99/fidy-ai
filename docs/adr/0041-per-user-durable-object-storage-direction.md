# Per-User Durable Objects own application storage and atomic execution

- **Status:** Accepted. The repository implements the per-User SQLite Durable Object topology.
  Measured acceptance and opening intended admission remain separate release gates.
  Backup restoration and a new complete User-data export are outside this decision.
- **Supersedes:** The D1 storage destination and coordination-only Durable Object role in
  [ADR 0026](0026-cloudflare-native-production-replatform.md), and the initial-platform restriction
  in [ADR 0039](0039-fresh-read-performance-contract.md).

One SQLite Durable Object per stable User owns that User's application state and atomic execution. Co-locating execution and storage removes the
remote database boundary inside the User's unit of work. This trades the simplicity of a shared
database for explicit global routing, work discovery and recovery protocols. A permanent D1/DO
hybrid is not the destination.

Live User authority checks, domain changes, accounting and Audit remain in one local transaction.
One shared directory object owns routing and pre-User bootstrap; a separate shared pricing object
owns the Price catalog and admission ordering. Independent erasure authority retains deletion
progress after User-local data is removed. A transaction in one object cannot make changes in
another object atomic.
R2, Queues and Workflows retain their existing responsibilities
unless a concrete design constraint warrants changing them.

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
has been safely released, fresh signup may create a new UserId. The erasure protocol below governs
late-call refusal and metadata expiry; stale cleanup cannot affect the new User.

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
User authority. The schema and operations decision below governs release compatibility.

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
erasure owns fencing and draining in-flight writes; approval is not permission to copy raw
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

The existing Maintenance object keeps a lifetime registry and a recovery deadline for Users with pending or uncertain work. Job payloads and authority stay in the UserStore. Register each User idempotently before first accepted work/activation,
recover lost registration replies, and retain the entry for the owner's lifetime including idle time.
An unused registration grants no authority or permission to initialize User domain state. Registered application work reserves a recovery deadline before acting. A failed reservation defers admission so a crash cannot leave accepted work invisible to Maintenance. Directory uses the same recovery reservation for mutations and its native alarm handles scheduled cleanup. Pricing and
independent erasure remain fixed watchdog targets.

The existing minute cron checks indexed overdue recovery deadlines in bounded pages with durable progress and finite owner-call budgets. It seeds retained registrations once and leaves known idle Users asleep. Under supported load, attempt eligible overdue checks within five minutes. This is an acceptance target for attempted recovery. Advance past unavailable/busy Users and expose failed checks separately from
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
erasure progress remains discoverable after User-local deletion. The erasure protocol below governs
safe registry retirement, metadata horizons and rejection of late registration.
An empty User database alone never permits retirement.

Reuse metadata-only owner, Queue, Workflow and retention monitoring. Add watchdog traversal age,
coverage, overdue checks and scoped uncertainty. Unknown/unavailable is not healthy zero; complete
coverage is not successful execution. Keep User content and identifiers out of logs/alert dimensions.
The [operations resolution](https://github.com/B4rz99/fidy-ai/issues/2204#issuecomment-6951201160)
sets initial page, concurrency and call budgets; five-minute traversal, fault isolation and aggregate
load still require acceptance evidence.

## Account erasure and recovery scope

The [account erasure decision](https://github.com/B4rz99/fidy-ai/issues/2203) preserves the existing
ErasureRequest lifecycle and ordinary failure handling. The
[scope decision](https://github.com/B4rz99/fidy-ai/issues/2203#issuecomment-6939307992) excludes live
backup restoration, including individual and coordinated object restores, restricted-manual
restore procedures and selective historical extraction/import. Native PITR availability is not
a supported Fidy recovery procedure. Severe accidental data loss may have no supported recovery
path initially. A future restoration capability requires a separate design that preserves erasure.
Current-runtime D1 safeguards remain until implementation changes the runtime. The initial
fresh-install data disposition is specified below.

Keep current durable owner intent, exact external-effect records, writer tracking and bounded
retries. A process restart does not rewind storage. Do not introduce a new always-on independent
receipt journal for external actions, generic restore generations or post-restore replay. Existing
guarded code-only deployment rollback remains distinct from restoring data.

The independent erasure owner uses private SQLite storage in a separate namespace from User stores.
It owns deletion continuation, custody evidence and the minimal marker, not ordinary User queries
or an additional copy of every application action. Its own alarm and the fixed maintenance
watchdog target discover pending cases after User-local data is gone.
After handoff, that case owns cross-owner deletion progress; User-local state retains the admission
fence and owner drain facts until purging. These are not two independent completion authorities.

1. A freshly authorized ErasureRequest commits the User-local admission fence and durable handoff
   intent together. New User work, credential activation and bootstrap completion refuse under
   that fence; already-issued external work follows existing settlement rules. Register the exact
   UserId and ErasureReference with the independent owner before local data can be purged. A lost
   acknowledgement repeats that same handoff; failure leaves the User fenced and discoverable.
2. Directory/bootstrap, pricing and maintenance owners fence the old User and their bound
   operations in their own short transactions before acknowledging erasure participation. Later
   registration/completion calls for those operations refuse. Cleanup matches the original User
   and reservation/operation identity; retain the identity hold until erasure completes. Resolve
   exact committed or cancelled outcomes before removing required attribution. Missing rows,
   timeout and an unreachable owner do not prove settlement. Other Users and Price publication
   continue; anonymous shared counters and shared catalog facts are not erased with one User.
3. Drain outstanding original-byte and sample writes using existing owner records. Unknown writes
   can keep deletion pending indefinitely; cancelling a job or observing an absent file is not
   proof that an already-issued write stopped. Raw material, review candidates and approval intent
   remain User-scoped. Genuinely anonymous published samples retain their accepted shared lifetime;
   unsafe samples remain withdrawable/deletable. Approval never exempts personal material from
   erasure, and raw/candidate deadlines are not extended.
4. Before purging, independently record completed drain and shared-owner fencing, together with
   the bounded attribution needed for remaining custody cleanup. If a step still needs local
   content or a Secret, finish that step before deleting it; do not copy those values into the
   independent marker or custody evidence. Delete User records, projections and file prefixes,
   then fully clear User object storage and its alarm. Normal callbacks or an empty object never
   initialize a User; private erasure retries may repeat only that case's cleanup.
5. Continue external cleanup from the independent case. It retains phase, required owner/custodian
   outcomes, latest local-erasure time, next continuation and bounded custody evidence. Temporary
   provider/callback attribution remains only for its pending cleanup purpose; it is distinct from
   the minimal marker, which contains no User content or per-file locators. Retained callbacks may
   settle their exact obligation but cannot restart User work. Repeating cleanup never extends a
   proof's original deadline or affects a new identity binding.
6. Complete only after local/shared cleanup and all writers are settled, every applicable custodian
   is Verified or NotApplicable, and at least 30 days have passed since the latest local erasure.
   Safely release old identity holds and retire the exact maintenance entry after completion;
   temporary failure is retried from the independent case. Fresh signup requires completed
   erasure and released identity ownership and always allocates a new UserId. Keep minimal
   late-call protection until original validity/retry windows have ended and retirement is
   acknowledged, then expire deletion metadata. The independent owner remains discoverable until
   cleanup finishes; an empty User database alone never authorizes retirement.

Native historical retention is not immediate backup destruction. Retaining the existing deletion
marker/window does not assert that arbitrary restoration is safe. Ordinary entry requires live
User state, and bootstrap requires its exact current reservation and unexpired proof; neither a
lookup miss nor expired deletion metadata permits reusing an old UserId.

## Schema evolution and operations

The [schema and operations decision](https://github.com/B4rz99/fidy-ai/issues/2204#issuecomment-6951201160)
uses short, automatic SQL migrations on object activation before domain work. User, directory,
pricing, maintenance and independent erasure stores have separate ordered migration histories.
Keep the upgrade path from every schema still reachable in retained stores, including objects that
skipped deployments. Each step's SQL and version marker commit in one native transaction; a failed
step rolls back without undoing previously committed steps. Initialization ordering alone is not a
transaction. Schema initialization never creates User domain state or supplies authority.

All schema-dependent request, RPC, alarm and background paths pass the readiness gate. Unknown
newer schemas, mismatched migration history and deterministic failures refuse domain work without
resetting storage. Transient attempts are bounded and durably counted outside the failed step's
transaction; process restarts cannot reset their budget. Resume from verified progress after an
eligible retry or corrected release. A failed User store affects that User; a failed shared owner
affects the capabilities depending on it. Neither failure proves cancellation, erasure or invalid
credentials.

Validate cumulative activation time and peak temporary storage before shipping a migration. A change
that cannot fit the bounded startup path needs its own resumable design and explicit admission and
interruption behavior before release. There is no general maintenance-window requirement or generic
online backfill framework. Large changes may require an explicit pause of affected operations.

Cloudflare class/namespace lifecycle changes are separate from application SQL migrations. Preserve
resource and namespace identities and the stable User-to-object mapping across normal releases;
never delete and recreate a namespace to upgrade its schema. Lifecycle changes use the selected
deployment tool's verified native support and a separately reviewed rollout. Retirement cannot
discard retained data, uncertain outcomes or independent erasure progress.

Releases declare compatible schema and internal protocol versions and preserve compatibility across
actual Worker/object deployment overlap. Code-only rollback requires a tested release that can use
every reachable schema, protocol and taxonomy state; otherwise repair forward. No automatic
down-migration or backup restoration is part of rollback. Preserve directory pairing creation order,
original reservation deadlines and anchored limiter windows through deployment and cleanup.

The release verifier may identify two exact published protocol fingerprints as equivalent when a review of
the pinned sources proves the same contract syntax. The #2305 comment changes produced one such pair.
Workers retain their published fingerprints, and migration history and namespace checks still govern overlap.

Keep one object per User and measure actual SQLite size. The initial policy warns at 70% of the
configured storage ceiling and restricts ordinary growth at 80%, preserving validated headroom for
accountability, security actions, retained obligations, cleanup and erasure. Apply the same capacity
discipline to shared owners. These thresholds are adjustable operating choices, not proof that a
particular migration or operation fits. Required Audit/accounting writes cannot be bypassed to keep
reads available. Capacity pressure never silently drops accepted work, extends its deadlines or
authorizes deletion of retained data. Sharding, routing caches and new capacity schedulers remain
unjustified without measured need.

Validate deployed watchdog coverage with ten synthetic registered Users and the three fixed shared
owners. Stress the same watchdog in workerd with 1,000 registered User stores and the three fixed
shared owners, including idle and newly registered stores. This is a benchmark target, not a customer limit or
a demonstrated capacity claim. Retain ADR 0039's active-User and per-User data fixtures. The
resolution records adjustable initial budgets and requires measurement of idle-check cost, shared
load, failures and aggregate producer pressure. Persist traversal progress, coalesce overlapping
sweeps and separate attempted checks from successful observations. Checks perform bounded local
inspection and repeat-safe alarm/intent repair; owner alarms execute the resulting work. Bound the
underlying request and response lifetime rather than merely abandoning an awaited promise. A timed-out
check has an unknown outcome; it cannot release uniqueness or establish that no repair committed.

Category releases preserve stable identities and the ability to interpret retained revisions. Each
operation uses one complete taxonomy revision. Introduce reader support before using new identities
that older participating code cannot interpret, or delay their use until that code is no longer
participating. Apply the same rule to rollback. Schema migration cannot manufacture sample approval:
an authorized human previews and approves the exact anonymised candidate through the private CLI.
Publication, retry, withdrawal and erasure preserve the accepted sample identity, deadlines and
writer guards. Implementation must replace both automatic approval and the existing unconditional
sample deletion prohibition. The initial fresh installation discards all existing samples rather
than importing or approving them; future samples follow the human-approval and withdrawal protocol.

Use the existing short-lived, capability-specific authority for structural sample review and
Titular erasure. Identity-recovery permission remains separate. Preserve fresh, scoped browser
access to effective Transactions and record Audit for each page.

Monitor schema coverage, migration failures, storage bands, watchdog age and scoped uncertainty.
Unknown observations remain distinct from healthy ones. Bounded automatic retries keep their
existing deadlines. A deterministic failure or exhausted retry budget requires a corrected
release. Verify recovery through the original owner and subsequent watchdog observations.

## Adoption evidence

The [acceptance and cutover decision](https://github.com/B4rz99/fidy-ai/issues/2205#issuecomment-6953536107)
requires approximately 2× lower p95 latency, with 1.8× as the minimum for every comparable acceptance
case: `D1 p95 / DO p95 >= 1.8`. Apply the gate separately to operations, supported query shapes,
fixture sizes, isolated/loaded work, warm/cold cohorts, network profiles and timing boundaries.
Larger workloads, mutations, cold starts and browser journeys have the same minimum; an aggregate
improvement or a no-regression allowance cannot hide a failing case. Correctness and security
invariants remain independent requirements.

Use a pinned, contemporaneously measured D1 baseline and equivalent domain behavior, authority,
accountability, fixtures and complete results. Measurements distinguish backend processing,
complete HTTP responses and click-to-fresh-usable-view latency. Start with at least 30 comparable
observations per variant per case, report empirical nearest-rank p95 and repeat unclear results
without selecting favorable runs. This sample floor does not establish statistical confidence.
Record failed and partial attempts, errors, throttling and completed versus offered work; delayed
dispatch or reduced throughput cannot manufacture a latency pass. Cold cohorts need observed
lifecycle evidence, with unknown runtime state reported as missing evidence.

Compare both deployed variants on Cloudflare with the small fixture containing eight original
Transactions and one Reconciliation link. Run the 100,000-Transaction fixture on both variants
in workerd, including its 100 RecurringPlans with 100 revisions each and 5,000 NeedsReviewItems.
Report each environment separately. Prioritize the browser journeys that missed 1.8× and time
each through its complete fresh usable view. [Fixture decision](https://github.com/B4rz99/fidy-ai/issues/2226)

Keep network and provider delays inside the timing boundary that includes them. A case that cannot
reach 1.8× has not passed; subtracting those delays or substituting server-only gains would change
the decision. New DO-only probes without comparable D1 behavior retain their accepted absolute
correctness, capacity and coverage requirements, with actual measurements reported rather than an
invented ratio. Security, expiry and provider-settlement deadlines do not shrink with this target.

[ADR 0039](0039-fresh-read-performance-contract.md) retains the fresh-read definitions, supported
query shapes, full-lifetime fixtures and 20-active-User workload. The separate 1,000-store workerd watchdog
benchmark preserves attempted-check coverage versus completed recovery. Existing absolute
performance targets remain follow-on objectives; reaching 150 ms is not a prerequisite for this
migration, nor is its backend target a browser-latency claim.

The [infrastructure prototype evidence](https://github.com/B4rz99/fidy-ai/issues/1887) established
roughly 2–2.6× complete-HTTP p95 improvement on small hosted fixtures, alongside local full-lifetime
and query-shape evidence. Reuse that architectural justification and its valid fixtures/harnesses;
it does not establish finished-implementation acceptance, browser or verified cold-start performance,
hosted full-lifetime/shared-load behavior, partitioning benefit or complete migration guarantees.
The resolution specifies the remaining measurements and owner-by-owner correctness evidence,
including isolation, atomicity, revocation, retries, directory races, discovery, schema failures,
account erasure and separate authority for sample review and Titular erasure. Missing or failed evidence remains explicit.

## Fresh installation and cutover

The user declared the existing application data disposable and accepted downtime. Start with a
fresh D1-free installation and discard all existing development data and IngestSamples. No
retained-data importer, live transfer, dual-write phase, legacy sample review or old-D1 fallback is
required. This one-time starting-state decision does not authorize resetting future retained User
data or weakening its erasure, retention and migration obligations.

Complete the integrated runtime and local verification before provisioning through the protected
release tooling with normal admission closed. Provision SQLite classes/namespaces and bindings,
including independent erasure, then initialize shared schema and release seed facts. Initial schema
does not establish User authority. An explicit first-install path handles absent stable deployments;
ordinary release capture and compatibility guards remain effective for subsequent releases.
Namespace lifecycle changes use the pinned deployment tool's verified native support separately
from application SQL migrations.

Stop or fence any old disposable producers so late callbacks, queued work or uploads cannot
populate the new installation. Verify exact resource identities, exposure, schema readiness and
DO-native synthetic work through the real ingress and background graph, then complete the hosted
performance and correctness gates before opening intended admission. Product/provider launch
controls remain separate. Retire only the inventoried obsolete application resources and samples;
remove D1 runtime, binding, maintenance, smoke and operational dependencies. Temporary D1 benchmark
resources are comparison evidence, not a runtime fallback. A D1 quota-deferral exception cannot
satisfy DO acceptance.

The first installation has no required old-D1 rollback target. After new retained state exists,
preserve current state during incidents. Isolate the affected capability, inspect its monitoring
records and verify the owner outcome after automatic recovery or a corrected release. Code-only
rollback requires a tested target compatible with every reachable schema, protocol and Category
revision and with the resource lifecycle. It cannot restore deleted resources, return to stale D1,
down-migrate storage or justify replaying an uncertain external effect. Normal releases preserve
resource/namespace identities and account for actual Worker/object version overlap.

## Design boundary

The [migration map](https://github.com/B4rz99/fidy-ai/issues/2198) is a completed design handoff.
The resolved User storage/execution, identity routing, shared catalog, background discovery,
account erasure, schema/operations and acceptance/cutover tickets own their detailed decision records.
The acceptance resolution assigns the owner/adaptor workstreams, implementation order, repeatable
operational procedures and required evidence. The
[platform constraints research](https://github.com/B4rz99/fidy-ai/issues/2199#issuecomment-6839405060)
records source-backed findings and outstanding evidence. Dated research and decision-ticket detail
remain on the tracker.

This ADR records the storage boundaries and disposable-data cutover scope. Release evidence
records measured acceptance and deployment. When coupled records move between owners, move
their production callers with them and preserve exact authority, evidence and historical meaning.
External deletion is irreversible. Account erasure discards content under independent minimal
markers and restore enforcement while ordinary feature retention remains separate.

Retained canonical receipts use a positive allowlist so new one-time disclosures cannot become
replayable by default. Chunk large ordinary or correlated receipts before writing SQLite text,
without splitting Unicode scalars. Finishing does not extend the original retry window. If an
acknowledgment is lost, reconcile only the exact server-owned receipt or lease and never replay
owner work on that evidence.

Browser admission uses the same User pressure envelope across credentials and AccessTier.
Unmetered browser work may share one committed authorized snapshot, or acquire a lease for a
phased read with dependent work. In the phased case the final snapshot rechecks live authority,
commits the owner's Audit and releases the exact lease. Request timing exposes bounded elapsed
phases and no User or queried facts. Failed phases do not become zero-valued successful samples.

Only Memory capacity work requires the explicitly constructed counting service. Missing inference
cannot deny other local canonical commands. Categories persists stable taxonomy keys for references
and reads labels and order from the release. Owner writes recheck a referenced Category and their
live User predicate together. Keyword instructions affect future captures without rewriting
retained Transactions. Capture interprets them in the same protected snapshot as retention.

Directory lookup and reservations route to the named User. Neither a PAT route nor a bank
callback establishes local authority. Recheck the credential, mounted binding when present,
and any required original browser session there. Generation-scoped reservations are fenced
until their exact terminal result is known. Retire descendants of the original binding only.
Callback cleanup and expiry cannot unbind a different generation or the shared source budgets.

### Erasure recovery and external writers

The independent Erasure registry records the case identity, original admission and phase
acknowledgments. A participant checks the exact case and phase before serializing a local
purge. Local row absence proves disposal only after the independent case records the required
prior acknowledgments. An acknowledgment lost in transit retries just that phase. Directory
and Pricing retain their attributed registrations until their own cleanup acknowledgment.
A missing registry after any accepted case requires recovery and cannot be initialized
through ordinary data access. Native units assert the external generation in the same
transaction using a read-only rollback assertion. Independent control-marker retention stays
outside a restored D1 and extends past supported backup restore.

Retain each R2 writer's specific nonce until a returned decision or matching positive evidence
proves settlement. Absence cannot settle an ambiguous issued create. Erasure sweeps the whole
canonical User prefix in bounded continuations even when inventory rows are missing. An
independent sealed marker proves the original drain across restore and keeps old attempts from
becoming new external instructions. Native registry publication uses [the Durable Object storage synchronization boundary](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/#sync).

### Maintenance and uncertain transport

Advance the bounded watchdog range before remote I/O so restart neither repeats undiscovered
work from the same claim nor reports it as returned. Freeze this tick's upper key and rotate
fixed-owner and User priority when cleanup stalls. Deadline and body cancellation share one
budget and a slot stays owned until cleanup settles. Flush progress before forcing a reset
of an incarnation that cannot release its transport. Retire an erasure fence only after all
original registration windows elapsed and retirement was acknowledged.

Private object mutation is correlated by User namespace, exact owner reservation and
placeholder ETag. Check live reservation after the placeholder settles. Deleting its
placeholder fences a late payload. A control sweep preserves a replacement that won before
the fence and cannot proceed after an ambiguous fence acknowledgment. It cannot settle an
unknown owner writer.

Register the User lifetime outside its transaction before activation. A cold physically empty
UserStore could reflect interrupted purge. Resolve its independent erasure case before
allocating the schema again. Preserve versioned schema prefixes and retained original retry
deadlines through migrations. Observe unresolved claims separately from scheduled work.
An original writer's last check does not establish when its claim began.
