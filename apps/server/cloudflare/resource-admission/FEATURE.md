# Resource Admission

Accepted design: [#1405](https://github.com/B4rz99/fidy-ai/issues/1405).
Admission protects infrastructure and provider capacity; it does not implement commercial allowances.
Installed Worker policy owns limits, dimensions and windows. Callers select an installed policy key
and scope, never an arbitrary public policy.

## Commit ownership

`prepareResourceAdmission` prepares a complete grant without spending capacity. The owning feature
includes all prepared statements in its D1 batch with its proof, state and outbox writes. The grant's
required claim cardinality is still enforced by D1; refusal rolls back the owner's writes as well.
Preparation is not an admission receipt. Only successful settlement permits external work.

The owner must use the configured binding, preserve preparation order and wait for its native batch
to settle on interruption. `classifyResourceAdmissionFailure` distinguishes native admission-trigger
refusal from unavailable persistence without publishing raw SQL errors. Consent's disclosure exchange
is the first owner-controlled commit using this interface.

`admitResource` retains the complete-commit interface for standalone callers. Attempt pressure remains
a distinct, deliberately committed charge before work admission: a refused work claim does not undo
its attempt charge. Outstanding release still commits with the owner's completion statements.

## Counter and ownership contracts

`ResourceAdmissionCounterTransition` admits only the accepted email pairing User/global,
email replacement, anonymous PAT pairing-source and hosted compaction variants. Email and PAT source
windows are anchored to their first accepted request; reset occurs at start <= cutoff. Compaction
uses UTC calendar days and retains separate historical days. Replacement alone carries its original
work binding. Each owner retains proof, eligibility, refusal and charging-point decisions.

`ResourceAdmissionEventOwner` distinguishes a stable User from a same-User WebSession. Global and
anonymous scopes do not acquire fabricated ownership. Source identity remains its original keyed
32-byte digest. Opaque scope keys are not authorization.

Email login and replacement now use `resource_admission_counters` through `prepareResourceCounter`
and `resourceCounterQuery`. Email supplies the exact eligible User projection and commits capacity
with its proof. The store preserves original anchored deadlines, bounded counts and replacement work
bindings. A login proof that is suppressed spends no capacity; a replacement at capacity does not
replace its last accepted work binding. Native constraints retain the five-per-hour User and
1000-per-hour global login limits and five-per-24-hour replacement limit.

Resource Admission owns the two credential erasure projections under their original logical store
IDs. Indexed policy/scope selection also checks explicit User ownership; global capacity has no User.
The counter store now accepts the three email policies and the hashed PAT source policy. #1435
adds calendar accounting with its production consumer and populated conversion. PAT review events
retain exact WebSession/User ownership; anonymous source counters have neither owner. The
[cutover guide](../../../../docs/operations/database-cutover-1428.md#email-admission-counters-1432)
contains the populated conversion for existing databases.

## Equivalence and cost gates

The existing native Resource Admission integration seam verifies exact rolling/calendar boundaries,
concurrent admission, complete grant cardinality, rollback, release, interruption and restart. The
owner-controlled one-charge/outbox commit matches the standalone path at seven row reads and eight
D1 row writes, including indexes, against equal empty history;
preparation adds no SQL query or preliminary commit. Consent's signed webhook integration covers the
production composition and refusal without disclosure/provider effects.

Measure native `D1Result.meta.rows_read` and `rows_written` at the existing owner integration seams
before and after each consumer conversion. Include the last accepted request, first refusal, exact
reset, concurrent contenders and bounded retention; compare equal retained history and active scope.

| Consumer                          | Existing seam                       | Required comparison                                                                        |
| --------------------------------- | ----------------------------------- | ------------------------------------------------------------------------------------------ |
| Email pairing/replacement (#1432) | Onboarding browser authentication   | Anchored User/global windows, original replacement binding, rejected proof rollback        |
| PAT pairing/review (#1433)        | PAT pairing native integration      | Keyed source window, atomic global pending check, exact session rolling events and erasure |
| Support recovery (#1434)          | Support recovery native integration | One invocation contributes to four rolling predicates, including malformed admitted bodies |
| Hosted compaction (#1435)         | Hosted continuity/retention         | Three admitted UTC-day attempts, abandoned work remains charged, retained older days       |

A smaller table count does not waive the cost gate. In particular, do not replace one recovery event
with four generic writes unless measurements demonstrate a concrete code/behavior benefit. Keep a
specialized representation and revisit the target if the shared representation fails that gate.

### Native baselines

The following measurements use the existing `observeRetentionCost` fixture around the actual D1
binding passed into existing operation tests. They include indexes. Counter/event-only rows below
filter the observer's executed statement measurements; they do not claim to measure every query in
an authentication or hosted Turn. Tests retain public outcomes alongside the measured budgets.

| Existing scenario                                                              | Row reads | Row writes | Measurement scope                                                          |
| ------------------------------------------------------------------------------ | --------: | ---------: | -------------------------------------------------------------------------- |
| One rolling admission plus outbox, standalone and owner-controlled             |    7 each |     8 each | Complete native batch, equal empty retained history                        |
| Email pairing: eight contenders, throttle/unknown mailbox, then anchored reset |        71 |         15 | User/global counter statements across the existing journey                 |
| Email replacement: five admitted generations, sixth suppressed                 |        25 |          6 | Replacement counter statements; wrong proofs remain covered by the journey |
| PAT source: twenty same-source contenders, refusal, one unrelated source       |       441 |         44 | Source counter statements, including original pending-pairing predicates   |
| Same PAT source immediately before/at its 600000 ms boundary                   |        25 |          2 | No write before cutoff; reset writes at equality                           |
| PAT review under either fresh or live WebSession                               |         3 |          4 | Rolling review event statement                                             |
| Recovery: six concurrent malformed verified requests, five admitted            |        59 |         20 | Full admission work, including cleanup and four predicates per event       |
| Recovery after the exact minute refill, cumulative with burst                  |        73 |         24 | Full admission work; malformed admitted body still consumes capacity       |
| Compaction: three aborted admitted attempts, fourth refused                    |        19 |          5 | Daily counter statements; fourth attempt writes nothing                    |

Read budgets are ceilings where native query ordering can affect work. Run these six files through
`bun run --cwd apps/server test:cloudflare --` to reproduce behavior and cost checks:
`cloudflare/resource-admission/resource-admission.test.ts`,
`cloudflare/onboarding/consent-ingress.test.ts`,
`cloudflare/onboarding/browser-authentication.test.ts`, `cloudflare/tokens/pats.test.ts`,
`cloudflare/recovery/support-recovery.test.ts`, and `cloudflare/agent/hosted-continuity.test.ts`.

These are baselines for the installed consumers, not evidence that their future conversions are
already equivalent. Their conversion tickets must repeat the same scenarios and historical-window
checks on the target representation. Native failed batches return an error without per-statement
row metadata; do not interpret absent metadata as zero-cost rejection. Atomic rollback and public
refusal are verified independently of those measurements.

### Email counter conversion measurements (#1432)

The same public email journeys and native observation seam retain the #1431 comparison below.
No separate preliminary counter commit or additional observation query was added. The shared store
needs one anchored identity index; adding a future calendar index before its consumer exists caused
extra reads and was removed before acceptance.

| Journey                                                           | Previous row reads / writes | Shared counter row reads / writes |
| ----------------------------------------------------------------- | --------------------------- | --------------------------------- |
| Concurrent login, suppression, unknown mailbox and anchored reset | 71 / 15                     | 71 / 14                           |
| Five replacement generations and sixth suppressed attempt         | 25 / 6                      | 25 / 6                            |

Existing proof rollback, aggregate contention and non-enumeration coverage runs unchanged in intent.
Native populated conversion checks retain sparse row references, exact original windows, counts,
ownership and replacement bindings; they also execute an injected failure after dropping the source
and reject an unrepresentable historical deadline. The erasure integration verifies both counter
policies are fenced, removes the target User's records and retains another User and global capacity.

## PAT conversion and cost (#1433)

Tokens supplies global pending-pairing eligibility and commits the shared source counter with actual
pairing creation. The twenty-per-source ten-minute window resets at its original stored deadline;
the 4000 recent-pairing constraint remains inside that same native batch. A failed pairing insert
rolls back admission. Scope is lowercase hex of the original keyed digest, with no raw address.

Public-code review charges before decoding even malformed bodies, under a live same-User WebSession.
Ten admitted attempts occupy an exact rolling ten-minute window; individual events expire at their
original instant plus ten minutes. An event and its complete one-claim grant commit together;
refusal creates neither. Review ownership cannot be reassigned independently of its WebSession.

Resource Admission owns bounded twenty-minute source/review retention and the original credential
erasure projection. It uses the existing session lookup and active-scope index for User selection;
other shared events retain their original schedule-purpose projection. Retention/erasure delete an
unshared review grant atomically through the event-deletion trigger, preserving unrelated charges
on a shared grant. The review sweep selects rowids through its retention index once.

| Existing native journey                                      | Previous reads / writes | Shared reads / writes |
| ------------------------------------------------------------ | ----------------------- | --------------------- |
| Twenty source contenders, first refusal and unrelated source | ≤441 / 44               | ≤441 / 44             |
| Same source immediately before/at original deadline          | ≤25 / 2                 | ≤29 / 2               |
| Review under either fresh or live session                    | 3 / 4                   | 9 / 7                 |

This is a measured tradeoff: review adds its shared grant, claim-cardinality verification and exact
ownership check. It removes two specialized stores and their counting/retention SQL from Tokens,
reuses anchored transitions and preserves one persistence/erasure owner. The increased review cost
is bounded to at most ten admitted attempts per WebSession per ten minutes; refused events do not
add grants. Source writes and global atomic capacity are unchanged. This is storage consolidation,
not a claim of reduced D1 spend. The original read ceilings remain recorded above for comparison.

The populated [PAT cutover](../../../../docs/operations/database-cutover-1428.md#pat-admission-1433)
retains original keyed sources, anchors, counts, review identities and session ownership alongside
existing email counters and shared events. Native checks prove exact cutoffs, rollback after source
drops and refusal of corrupt deadlines. Public integration covers mixed-age rolling attempts,
malformed admitted bodies, independent sessions, concurrent global capacity and failed creation.

### Native retention comparison

`pat-admission-retention.test.ts` runs the frozen specialized delete statements with their original
expiry/rate indexes and erasure guard, and the installed shared sweeps against equivalent four-source/four-review
histories. Two records are exactly twenty minutes old; another source/review is one millisecond
newer under a different User, and one remains inside the admission window. A separate shared policy
and an email counter remain present. Each sweep is limited to one record, proving bounded progress
without deleting active or foreign history. The cutoff is the original anchor/admission plus twenty
minutes, unchanged by conversion.

| Cleanup at the native boundary                | Specialized reads / writes | Shared reads / writes |
| --------------------------------------------- | -------------------------- | --------------------- |
| Source immediately before expiry; no deletion | 2 / 0                      | 2 / 0                 |
| Review immediately before expiry; no deletion | 2 / 0                      | 2 / 0                 |
| One source at exact expiry                    | 4 / 1                      | 5 / 1                 |
| One review at exact expiry                    | 6 / 1                      | 6 / 2                 |

These are native D1 result metadata, including the atomic orphan-grant deletion; they are separate
from insert costs above. Cleanup now avoids repeated review-candidate discovery. Shared review
cleanup adds the grant deletion while retaining the original read cost; source cleanup adds one lookup.
Idle cleanup has the same measured cost. Existing owner erasure proves that a multi-policy grant
and its foreign charge survive deleting the addressed User's review.

## Recovery conversion blocked (#1434)

The one-event/one-grant candidate passed the existing recovery behavior tests but failed the cost
gate. Its concurrent malformed-command journey used 99 reads/35 writes versus 59/20; five expired
invocations required 31 reads/10 writes to clean up versus 6/5. The four custom rolling predicates
remained necessary, so the extra work offered no concrete code/behavior benefit.

Retain Recovery's `support_recovery_admissions` store and current persistence owner under #1405's
explicit cost-gate exception. No shared recovery policy or schema conversion is installed. The
[comparison evidence](../../../../docs/operations/recovery-admission-1434.md) records the candidate,
its native measurements, exact cutoff and foreign-operator preservation, and why the conditional
mapping must be revisited before migration. The existing public recovery test now also checks
cleanup immediately before and at the one-hour cutoff; production limits and accounting are unchanged.

## Hosted compaction counters (#1435)

`hosted.compaction.user.v1` uses the calendar branch of the shared counter transition. Each User's
UTC accounting day admits at most three attempts across all hosted sessions. Hosted execution
supplies active same-User session and current authority eligibility inside the increment statement;
no preliminary admission commit or follow-up authority check is introduced. Refusal changes no row.
An admitted attempt remains charged after cancellation, model failure or abandoned work.

Retained older day windows coexist under the calendar identity index. Admission does not delete them
at midnight. Hosted execution supplies its original retention cutoff and bound to Resource Admission's
published discovery, cleanup and deadline statements. The conversation-erasure projection retains
logical ID `hosted_compaction_attempts`, original archive JSON, fence permissions and User dependency;
email credentials, source counters and other Users retain independent purposes.

| Native journey                                   | Specialized reads / writes | Shared reads / writes |
| ------------------------------------------------ | -------------------------- | --------------------- |
| Three aborted admitted attempts, then refusal    | 19 / 5                     | 27 / 5                |
| One-User cleanup just before expiry; no deletion | 2 / 0                      | 2 / 0                 |
| One expired accounting day, bounded cleanup      | 5 / 1                      | 5 / 1                 |

Shared checks add eight reads to the four-attempt journey; writes and measured cleanup are unchanged.
This bounded tradeoff removes a specialized store and gives calendar counters one persistence/erasure
owner. It is not a claim that consolidation lowers all query costs. Existing hosted retention tests
also retain their backlog, fairness and idle-work budgets. The public hosted journey preserves failed
attempt charging; native integrated admission covers concurrent sessions, exact UTC boundaries,
foreign ownership and revoked credentials. Populated native conversion checks cover historical days,
counts, unrelated shared counters, archives, invalid history, collision, in-progress erasure and
rollback after dropping the sources. See the [cutover runbook](../../../../docs/operations/database-cutover-1428.md#compaction-admission-1435).

The same regression journeys also measure the cost carried by existing anchored consumers after
installing the calendar index and conversation-erasure guards: email login uses 77 reads/14 writes
(previously 71/14), email replacement uses 31/6 (25/6), and PAT's exact source-window boundary uses
31/2 (29/2). Their original write counts, refusal, proof composition and cutoff behavior remain
unchanged. Read ceilings were updated to these measured totals; the earlier ticket tables above
remain historical comparisons. An alternative single expression identity index was measured and
rejected: it did not remove these read increases and raised the PAT burst from 44 to 63 writes by
reindexing anchored resets/updates. The final shape keeps distinct partial identity indexes so this
conversion adds no admission writes to anchored consumers.
