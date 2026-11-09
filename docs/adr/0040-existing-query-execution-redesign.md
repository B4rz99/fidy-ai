# Existing queries select and commit the facts they need together

- **Status:** Batch consolidation, selective Recurring reads, indexed aggregate spans, atomic application startup and Review request sharing implemented locally after approval; storage placement remains experimental.
- **Acceptance:** [ADR 0039](0039-fresh-read-performance-contract.md).

Keep the existing canonical operations. Redesign their native read preparation, data selection and
finalization instead of adding an operation for each screen. Use the existing prepared browser-read
interface as the seam for fixed, bounded observations. Keep source-dependent queries in deliberately
bounded phases rather than hiding further I/O in presentation. Feature owners retain their SQL,
decoding and policy; composition does not acquire arbitrary access to foreign tables.

## Implemented batching scope

The first implementation keeps existing canonical operation names, financial selections, full
Recurring history and deployment placement. It adds no response cache. The existing prepared
browser-read seam now includes the Review workspace/count and browser-only source context.
Category instructions needed to interpret the first detail join that snapshot. Original eligibility
and locator selection join admission; external bytes stay under a request lease, followed by a
fresh disclosure, Audit, standing and release transaction. Original presentation no longer constructs
unused draft suggestions.

Profile metadata, taxonomy, renewal and identity Audit share one transaction. Consent status uses
credential-only preparation so Missing and Revoked receipts remain accessible, with native pressure
and no commercial accounting. Application-only startup selects its exact credential, current Consent,
profile, taxonomy, renewal, pressure and identity Audit in one protected native snapshot. No lease or
second source-dependent read is needed for that observation. Transaction startup keeps two phases:
metadata/admission, then time-zone-dependent history, final Consent/context proof and lease release.
The plain current-cookie adoption recheck remains separate; no freshness bridge is extended.

Dashboard view keeps its coordinator. A restricted private browser-query
continuation carries the server-created lease; the final financial snapshot composes owner Audit,
fresh standing and exact lease release. The final proof receives a fresh clock and recovery fence.
Core consumes and strips settlement evidence only for its exact admitted lease; uncertain outcomes
retain cleanup and never replay owner work. Wide Dashboard selections finalize only in their last
bounded chunk. Non-browser Recurring callers retain their credential-specific coordinated path.
PAT, OAuth, hosted and mutation admission retain their credential-specific execution paths.

Successful ordinary browser counts are now: Dashboard view three, Recurring workspace one,
Review workspace/count/context/detail and the Dashboard catalog one each, original two, profile one,
Consent status one, PAT metadata and Subscription offers/status one each, and application startup one
(Transaction startup two), plus the separate cookie recheck. History and Budget queries remain one.
Exception/refusal cleanup and wide Dashboard planning can require additional transactions. Initial
batching measurements isolated that contribution; subsequent selective reads and request sharing
are described below. Placement remains experimental.

## Implemented selection and request sharing

Budget and Dashboard aggregate reads use the same three disjoint index ranges as projection-size
planning: complete UTC days, leading UTC minutes and trailing UTC minutes. Empty spans stay empty,
including periods shorter than a day. `UNION ALL` combines those ranges before the existing exact
count, maximum and positional-digit aggregation. Interior minute buckets are never read merely to
be discarded. Currency, half-open boundaries, named-zone calendar calculation and write-maintained
effective Transaction policy remain unchanged. No projection table or index is added.

While the Review route is active, navigation observes the same filter/page workspace query and its
pending count. Other routes retain their count-only observation. This shares one mounted read and
refresh owner; it does not copy a response into another store or extend retention. An empty workspace
page mounts no source-context request. A nonempty page retains the independently authorized context
and original-material paths, expiry checks and private evidence limits.

Pending Review selections use the stored status expression and a fresh expiry bound directly,
including source-context selection. Their count scans only that live pending range rather than
evaluating visible status across retained history. A User/status/expiry/id expression index matches
the existing Review source view; expiry remains a request-time predicate. The default count equals
the selected total, while non-pending selections retain complete independent pending and history
counts. This is an ordinary database index maintained with source writes, not a reusable response
or authorization observation. Existing protected transaction and presentation limits still apply.

PAT metadata and Subscription offers/status now participate in the existing protected browser-read
seam. Their owned queries select the exact caller's User relationally, retaining existing limits,
projection validation and owner-specific Audit. Permission remains `WebOrHosted` for the PAT listing
and the existing scoped policy for Subscription. Other credential paths retain their admission.
Nonempty query strings use the ordinary validation path. These are existing canonical operations.

OAuth connection management keeps its separate origin, resource-admission and credential policy.
After selecting at most 25 connections, it prepares each connection's existing at-most-three activity
records and live guard into one bounded native batch. Activity decoding remains with Audit; failure
of any guard or evidence refuses the page. No per-connection storage call occurs during presentation.
The outer management guards and resource admission remain separate.

Transactions retain bounded effective-fact keyset reads and the authoritative repair fallback.
Account and privacy retain their already-atomic observations. Payment-enrollment availability and
provider workflows retain their dedicated admission and freshness checks. Measurements include all
nine routes when comparing changes; a read already selecting bounded required facts does not require
a replacement implementation solely for uniformity.

## Counts and guarantees

The shared per-User request budget replenishes one admission every 100 ms, with a burst of ten
and at most two held request leases. The previous one-second replenishment exhausted the burst
during sustained interactive reads and introduced rate refusals independently of query cost.
The budget remains shared across the User's credentials and AccessTier; no feature or credential
receives an exemption. This deliberately permits ten sustained admissions per second rather than
one. Commercial allowance, dedicated transport/resource protections, lease duration, ownership,
Consent and recovery checks retain their own policies. Faster replenishment reduces refusal-driven
retry delays; it does not reduce the storage latency of an admitted request.

Every remaining D1 batch obtains its own fresh recovery generation from R2 and asserts it inside
the native transaction. These are not application locks. Combining statements reduces R2 checks
and D1 submissions; reusing a generation across separate transactions is not part of this proposal.
Pinning that generation in a Worker release is not equivalent: deletion checkpoints advance it
between releases, and restoring an older D1 snapshot can make an older running Worker's proof match
again. The native recovery tests retain this counterexample; the fresh independent check remains
required until a replacement protocol can exclude both stale traffic and restored state.
An atomic batch may contain several SQL statements. Counts below describe successful ordinary
browser paths, not every failure cleanup or unusually wide Dashboard layout.

The objective is the latency contract, not a predetermined number of batches. One batch is preferred
when it can select complete bounded facts without overfetching or duplicating domain policy. The
three-batch Dashboard path is a conservative implementation to compare against a deeper one-batch
read projection; it is not an established lower bound.

Live timing artifacts and local scaling evidence remain in ignored performance reports. They
motivate these changes but do not establish the speed of the proposed design.

## Shared execution

### One-batch feasibility

The browser Recurring observation now uses the existing prepared browser-read interface. The owned
ledger, context, matching windows and linked facts share admission, Audit and standing in one native
snapshot; pure scheduling and response construction follow it. Linked selection uses one bounded
point-lookup query and restores the previous 128-reference group ordering during decoding. This
avoids repeating credential and reference selection for every possible group. Matching windows keep
their separate 128-fact caps and truthful completeness indicators. No new canonical query, cache,
table or index is added. Full revision selection remains unchanged for full observations.

### Compact Recurring selection

The browser's existing compact query selects a private `RecurringReadProjection`. Its calculation
schedule contains the first and latest revisions, each requested matching window's predecessor and
in-window revisions, and exact as-of revisions for every retained exception and fulfillment. Distant
previous months produce separate windows. The full ledger is never reconstructed from sparse facts;
editing output keeps the existing compact document shape. Scheduling remains in the pure owner.
Default full observations, other credential paths and revision-bound mutations retain full history.

All global exceptions, fulfillments, exclusions, suggestions, pauses and stopping input remain
available. Linked Transaction validation and candidate caps retain their existing semantics. Native
selection shares the existing single protected snapshot with authority, context, facts, Audit and
standing. Revision rows are grouped once per request. No canonical operation, response cache,
persistent projection, table or index is added. The reduction depends on the requested months and
retained records; workloads requiring every historical revision can still select the entire ledger.

Recurring workspace selection is structurally preparable before reading the document: the two
matching windows come from the requested months, while the Recurring owner can prepare its linked
Transaction reference relation directly from retained fulfillments. The Transaction owner retains
effective-fact policy, readiness fallback, independent candidate caps and reference grouping. A fixed
set of reference groups can participate in one batch without first transferring their identifiers
through JavaScript. Scheduling stays pure after selection. This is a candidate for the existing
prepared browser-read seam, not a new canonical query or a generic cross-owner SQL interface.
Removing its read coordinator is conditional on selecting all owner facts, live authority and
accountability in that single snapshot; mutation coordination remains unchanged. Full revision
selection and decoding costs remain separate work.

Transaction bootstrap and Dashboard have another dependency: the current stored IANA time zone
determines calendar bounds, but the cold request does not supply that context. Native SQLite date
modifiers cannot replace the domain's named-zone calendar interpretation. A server-computed calendar
for a proposed zone can be checked against the current context inside the transaction; a mismatch
must select no financial facts and take an explicitly protected fallback, never return an empty
successful view. Such a path can use one batch when its calendar input matches, but does not make
every cold entry one batch. A complete calendar representation or context normalization would be
additional design work. Enumerating runtime time-zone names alone does not cover all accepted
aliases. Keep the separate prefetched-cookie adoption check.

Dashboard layout requirements can be selected relationally from the stored document and joined to
calendar ranges computed by the existing domain functions. Exact bucket/digit aggregation can
remain indexed; bounded list slots must preserve per-Category top-N selection and existing search
semantics. This removes the JavaScript layout dependency in principle. It does not remove the
calendar dependency or justify discarding wide-layout chunking: the current reader deliberately
bounds simultaneous raw results. A universal one-batch implementation needs a demonstrated bound
on returned bytes and decoding memory, or a different exact result representation. Keep the phased
path until those obligations are met. Neither the current three batches nor this feasibility
assessment establishes an irreducible minimum.

For eligible unmetered browser observations, prepare exact cookie/credential and Consent selection,
request pressure, owner facts, required Audit and standing in one native transaction. Present only
after it commits, with bounded decoding and pure domain calculation and no further I/O. Extend
`PreparedCanonicalBrowserRead` only to specific existing observations that meet this contract.
Authorization-header precedence and the other callers' credential-specific admission remain intact.

Multi-phase reads keep a server-owned request lease. Admission owns a narrow preparation and
settlement interface that permits its final standing, exact caller recheck and lease release to
join the owner's final transaction. Do not expose generic admission SQL or reusable credential
authority. A failed final proof withholds the response. Lost final responses do not replay work.

Keep per-User Durable Object coordination for phased Dashboard reads and credential-specific
Recurring execution. The complete native browser Recurring snapshot needs no coordinator hop;
mutation coordination is unchanged. Removing coordination from other phased reads requires complete
revision guards and conflict policy.

## Transactions

Before:

```text
Initial context: session/Consent -> pressure -> profile -> history -> final Consent -> release
Then: current-cookie binding recheck
Sometimes: separate Consent observation (four further batches)
Ordinary history/filter/page query: already one batch
```

Proposed:

```text
Initial context phase 1: exact session/Consent + pressure + profile/context/taxonomy
Initial context phase 2: bounded history + final live guards + accounting/release
Then: retain current-cookie binding recheck
If a separate Consent observation is required: one atomic batch
Ordinary history/filter/page query: retain one batch
```

Target the six-batch Transaction bootstrap at two batches, plus the existing one-batch cookie
recheck. Profile time zone determines the first history period, so the second phase is explicit.
Recheck the captured context before disclosing that history. Apply the same preparation to the
application bootstrap used by other screens; a fully preparable context-only observation can
eventually use one transaction.

The cookie recheck protects adoption of a private response prefetched during code loading. Do not
delete it or extend the 400 ms Consent bridge to hide latency. Move Transaction code preparation
earlier, before the final actual-entry observation; retain a fresh fallback when the bridge cannot
be consumed. Consolidate the existing Consent and profile observations individually instead of
relying on a retained authority result. Existing profile/taxonomy hydration must be consumed by its
published owner, and independent display revalidation must not create a serial history waterfall.

## Budgets

Before: one native batch already composes authorization, caps, exact financial aggregates, Audit
and standing. Its bucket selection mixes full-day and edge-minute predicates with an `OR`.

Proposed: retain one batch and the same exact write-maintained Transaction projections. Select
three disjoint indexed relations, combine them with `UNION ALL`, then apply the existing exact
count/maximum and positional-digit aggregation:

```text
Full UTC-day range
  + leading UTC-minute fringe
  + trailing UTC-minute fringe
  -> exact Category/Currency/direction aggregates
```

Reuse the range decomposition already used by the projection size estimator. Preserve empty and
short ranges, half-open instants, DST boundaries, current Currency separation and uncapped spending.
Keep bounded indexed cap and cap-version selection. Use statement-level plans, rows and timing to
verify the candidate before replacing the existing selection; the entire batch's measured storage
time does not prove this particular predicate caused it. The shared aggregate reader also benefits
Dashboard. No full-history scan, floating-point total or new response cache is introduced.

## Dashboard

Before, ordinary small layout:

```text
Core admission -> coordinator source -> financial facts -> Audit -> Core standing/release
5 D1 batches, each with an R2 generation check
```

Conservative proposed path:

```text
Core admission and User resolution
  -> coordinator layout/context/taxonomy source
  -> financial facts + final authority + Audit + standing/release
3 D1 batches, each with a fresh R2 generation check
```

The first Core read currently resolves the User needed to route to the coordinator. Source layout
and IANA time zone then determine the financial selection. Keep these dependencies visible. The
Transaction owner must earn a bounded finalization composition in its snapshot reader; its current
two-statement peer slot is not an arbitrary tail hook. Wide selections retain bounded planning and
chunking at one projection revision, with finalization only after successful complete selection.

Evaluate a one-batch alternative before treating three as sufficient: let a bounded native read
select the stored layout's requirements from a pre-resolved calendar range relation, together with
live authority and accounting. Dashboard has six named relative periods; charts and list predicates
still require bounded exact selection. A caller-supplied time zone could only be a selection input
checked against the current UserContext in that transaction, never authority. This may require an
input extension to the existing query, not another canonical query. Compare returned rows, query
plan complexity and CPU with the phased design. Do not fetch a broad financial-history superset
merely to obtain a one-batch count, move IANA calendar policy into ad hoc SQL, or refuse currently
supported wide layouts to manufacture a faster measurement. If the native observation is complete
in one atomic unit, it can use the existing no-lease browser pressure model and avoid the coordinator
hop for that read; otherwise keep the coordinated phased path.

## Recurring

Before:

```text
Core admission -> owner authority -> full planning document -> matching facts -> Audit -> standing
Then trim the response to its compact form
6 D1 batches; full revision rows are reconstructed and repeatedly filtered per plan
```

Proposed:

```text
Core admission
  -> combined live authority + context + required historical inputs
  -> matching facts + final authority + Audit + standing/release
3 D1 batches; internal read projection grouped once by plan
```

Introduce a private historical read projection, not a partially populated `RecurringDocument`.
For each selected or prior-unresolved month, automatic matching needs its preceding/current/following
month windows. Select the predecessor revision plus revisions within each required segment. Avoid
reading every intervening month when the unresolved month is distant. Retain earliest navigation
metadata, latest editing input, pauses/stopping, moved exceptions and completed historical facts.

Current compact output also retains global exceptions, fulfillments, exclusions, suggestions and
invalid-fulfillment reporting. Continue globally validating linked marks and selecting their exact
as-of historical plan input, including marks outside the displayed windows. A correction to an old
linked Transaction must not leave a false allocation suppressing a current match. Keep candidate
caps and truthful `matchesComplete` behavior. Default full-document observations and revision-bound
mutations keep the full ledger initially. Group revision rows once per request even where full
history is required. Narrowing the existing compact response is a separate explicit consumer/schema
change, not silently dropping fields in this refactor.

A one-batch alternative must bring the full bounded set of required plan and Transaction facts
into one native snapshot without an unbounded candidate superset or SQL reimplementation of
scheduling. Compare it against the phased design; source-dependent schedule calculation means
one batch is not established as feasible for every current input.

## Needs Review

Before:

```text
Workspace: admission -> owner rows/Audit -> standing                         (3 batches)
Context: admission -> owned excerpts/Audit -> standing                     (3 batches)
Badge: separate count observation                                         (3 batches)
Original: admission -> detail -> material -> live caller -> Audit -> standing (6 ordinarily)
```

Proposed:

```text
Workspace: exact authority + pressure + rows + Category instructions + Audit + standing (1 batch)
Context, only when rows need it: exact authority + excerpts + Audit + standing          (1 batch)
Badge while Review is mounted: consume that fresh workspace's pending count             (0 extra)
Badge elsewhere: retain the existing bounded count observation, now one batch
Original: authorized material selection -> byte retrieval -> final disclosure batch    (2 batches)
```

Prepare bounded Category instructions with the workspace so conditional suggestion interpretation
does not add a hidden read. Apply interpretation through the Category owner request-locally. Skip
context mounting for an empty page; retain the existing WebSession-only context contract and never
add original excerpts to general agent-visible metadata. A mounted workspace can supply badge
display counts; other routes still mount the existing count query with its normal refresh policy.

For originals, first select exact live authority, detail, owned locator and evidence deadline in
one prepared transaction. Retrieve and parse external bytes outside D1 under the lease. Then
recheck caller authority, evidence expiry/deletion and eligibility with Audit, standing and lease
release atomically before disclosure. Required original byte I/O cannot be included in a D1 batch.
Conditional retained-suggestion work must be prepared as part of the first transaction.

## Placement and implementation order

Run a controlled placement experiment early alongside the selective-read work. Keep public ingress
near the User; compare private Core execution nearer its storage, measuring the complete request
including the forwarding cost and coordinator. Workers placement does not relocate Durable Objects
or apply to every invocation kind; verify the actual fetch path and region rather than inferring it
from a setting. See [Cloudflare placement](https://developers.cloudflare.com/workers/configuration/placement/).
The release verifier currently requires default Core placement. A successful experiment requires a
deliberate architecture/release-guard change before promotion, not a dashboard toggle.

Implement and compare the exact aggregate range selection and request-local revision grouping;
then consolidate startup and fixed native observations; then finalize coordinated read composition
and the selective historical projection. Re-measure each contribution separately. Compare the
one-batch Dashboard alternative before accepting an intermediate three-batch endpoint as finished.
Keep public schemas stable unless an explicitly reviewed change to an existing operation is needed.

## Proof before acceptance

Prove output equivalence at documented input limits: exact Money and Currency, time zones/DST,
Reconciliation, historical revisions, moved/completed occurrences and global invalid allocations.
Independently vary lifetime history, selected-period rows, currencies, caps, revisions, linked marks
and candidate density; combined fixture growth does not isolate a cause.

Inject revocation, expiry, withdrawal, context/document revision changes, Corrections and recovery
generation changes between retained phases. A read returns coherent authorized facts or refuses
disclosure. Test two tabs, background ingestion/maintenance, pacing, lease cleanup, interrupted/lost
final batches and no owner replay. Preserve bearer precedence and credential-specific paths.

Finally measure complete deployed cold and active cohorts separately, all supported ordinary query
shapes, fresh response and fresh financial paint under the agreed network profile and workload.
Batch targets and local measurements are not a promise that p95 is already at or below 150 ms.
