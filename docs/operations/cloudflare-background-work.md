# Cloudflare background work

Each User stores accepted intent, original deadlines, checkpoints and outcomes in its SQLite Durable Object. Queues carry bounded operation identities. Workflows claim and reconcile work with its authoritative owner. Inspect the durable outcome when a transport reports success.

## Maintenance cadence

Core invokes the shared Maintenance watchdog every minute. It checks the shared owners and traverses due Users in bounded pages. A successful User inspection covers the next two scheduled minutes, which reduces repeated SQLite reads while new Users and failed inspections remain eligible. Each owner checks its own pending families and preserves its earliest alarm. User alarms recover receipts, provider reconciliation, recurring evaluations, reminders, eligible weekly work, financial work, and private byte retention. Directory reclaims expired bootstrap proofs and capacity slots. Erasure independently checks outstanding custody.

The native minute watchdog measures time since registered Users were observed and the last
completed traversal. Coverage warns after five minutes and becomes critical after ten. A failed
shared check or deterministic migration failure is critical at detection. SQLite storage bands
warn at 70% and become critical at 80%. The existing attention monitor evaluates these messages
every ten minutes and repeats after thirty. User identifiers and financial contents stay out of
the observations. A complete native-only sweep requires fresh observations of all registered
Users and the three shared target owners. A repaired alarm schedules existing work.

## Reminder advancement

Reminder discovery wakes one User; it does not capture a schedule revision or grant authority.
Inside User coordination, Insights reads the current enabled instructions and standing, selects
only the latest due local occurrence, and commits its event, delivery intent, execution history and
next instant in one guarded User transaction. A changed revision, next instant, disabled schedule or withdrawn
grant refuses the batch. A later wake reads current state again.

The admitted deadline remains the earlier of twenty-four elapsed hours after the scheduled instant
and the following calendar occurrence. Delays skip backlog without moving the scheduled instant to
execution time. Expired opportunities record history and advance without a message. A Created result
means admitted delivery intent; WhatsApp owns send and delivery evidence separately. An unavailable
commit response does not authorize replay or extend the deadline.

## Operational signals

The Core monitor records bounded User observations, transport binding failures, actual queue canary observations and Workflow state independently. A successful watchdog tick can coexist with a stalled Workflow or unavailable queue. Track the state, age, counts, launch flags and severity from the deployed Worker. Personal identifiers, provider tokens and financial amounts stay out of logs. Compare attempted and observed counts, the oldest active observation and completed traversal. A missing complete sweep is distinct from a completed inspection that reported an unavailable owner.

### Platform monitors (#1491)

Cloudflare enforces five custom analytics policies on this account. The deployed policies use the
existing operator email destination and simple count queries with no grouping. All execute every
ten minutes, average over ten minutes and repeat after thirty minutes. The query lookback follows
execution interval; Workers Logs queries require at least ten minutes. These settings replace the
former critical thirty-minute/warning four-hour and per-owner acknowledgement policies. There is
one combined account health stream: another owner can become unhealthy during an active incident
without starting a separate email. Inspect the timestamped owner observations; platform silence is
never proof that every owner is healthy. These explicit coverage differences avoid a custom ledger.

| Monitor                            | Account-supported query condition                                                                                                       | Fires    |
| ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| Operational health attention       | `logs.workersLogs`, production Core, `message LIKE '%fidy.operational component=% severity=%'` and `message NOT LIKE '%severity=none%'` | count>0  |
| Missing complete owner inspections | `logs.workersLogs`, production Core, exact complete-sweep marker above                                                                  | count==0 |
| Native Worker failures             | `logs.issues`, account-wide occurrence count                                                                                            | count>0  |
| Missing Queue canary execution     | `events.queuesMessages`, dedicated canary Queue, `DeleteMessage` and successful outcome                                                 | count==0 |
| Missing completed Workflow canary  | `events.workflows`, dedicated canary Workflow, `WORKFLOW_SUCCESS`                                                                       | count==0 |

Do not add a `consumerType='worker'` filter: this account's successful native canary acknowledgements
were excluded by it. Do not add explicit timestamp predicates to dashboard SQL: the supplied time
range conflicts with them. Deep sums, UNION and adaptive DISTINCT were rejected by this account;
a successful preview of another function is not evidence it supports a saved monitor.

The isolated Queue→Workflow probe runs every five minutes. Publication is not success: Queue
acknowledgement and Workflow completion have independent native monitors. Messages older than ten
minutes are rejected. Do not pause business Queues, purge retained messages or manufacture User work
for a monitoring test. Cloudflare ingestion/evaluation/delivery adds delay; these are not instant or
globally independent outage detectors. A Cloudflare-wide failure can affect logs and notifications.

## Private operational view and account usage alerts

Use Cloudflare's authenticated Logs view. The configured
saved search **Fidy owner health — timestamped observations**, dataset Workers, query
`contains(message, "fidy.operational")`. It displays newest observations with UTC timestamps.
Older than ten minutes is stale; a missing owner is unknown; complete means inspected, not healthy.
Native Queue/Workflow Monitors establish execution absence independently of this search. Use the
owner's actual state, Queue metrics and Workflow instances before considering recovery actions.

**Account setup required before #717 can be closed:** in Cloudflare **Manage Account → Billing →
Billable Usage → Create budget alert**, create two account-wide USD alerts at 50% and 80% of the
approved monthly spend, each with `OPERATOR_ALERT_EMAIL` as the sole recipient. Under
**Notifications → Add → Billable Usage**, enable a Workers request or CPU usage notification at
an explicitly approved threshold (choose against observed baseline). Verify the recipient and
thresholds in the account console after each deployment and at the start of each billing period.
Budget alerts are one-time notifications each billing period, not spending caps; the invoice is
authoritative. Per-product usage alerts and budget alerts are native Cloudflare email, not a
second vendor. These account settings are **not provisioned by this repository** and have not
been verified on the Production account. Record the approved USD budget and Workers baseline in
the operator's private release checklist, not in alert dimensions or logs. [Budget alert
instructions](https://developers.cloudflare.com/billing/manage/budget-alerts/).

## Outage alert ownership

Cloudflare platform health and missing-sweep monitors own outage notification. Core labels unavailable owner checks without disclosing their contents. The monitor can alert on absent platform signals even when application execution cannot emit an event.

## Telemetry ownership (#716)

Each boundary records a closed Work outcome, not a propagated cross-application trace. Public HTTP
and Core HTTP observe their own request handling; Core Queue reception observes handoff only, while
each installed Workflow observes execution independently, including Proactivity delivery. Cron and Email Worker reception/sweep
observe their respective invocation. The User observes its serialized request and alarm.
its soft HTTP deadline does not turn an unfinished owner into completed Work. SQLite and R2 activity is
covered by the surrounding owning Worker, Workflow, or User Work, rather than exporting SQL,
object keys, or a record per query. The private hosted inference adapter records model execution. Resend,
Kapso, and Wompi record transport attempts beneath Outbound HTTP's policy, including only the
provider code, response status class, outcome, release, attempt, and bounded latency. A transport
response is not proof that a provider delivery or durable Work succeeded. Separate hops must be
compared against authoritative User outcomes; no unapproved trace context is carried across them.

Native Effect spans are not connected to a second exporter. The explicit Work projector is the
Cloudflare export path. Failed Work exports feed native Issues through a closed error envelope. Production
Cloudflare code and deployment have no Sentry runtime, preload, secret, source-map upload, or build
step. Alert delivery and test notification to an operator are owned by #717, not by these records.

## Safe recovery

1. Find the owner using the closed operation name, then inspect the private Queue/Workflow and its
   owner receipt through the private native observability procedure. Keep identities and content out of logs and issue comments.
2. Restore missing bindings or fix consumer defects first. User alarms and outboxes continue to reoffer eligible
   work even if its previous Queue message was exhausted or its prompt offer failed.
3. Reoffer only an existing, still-eligible outbox identity with its existing version and Workflow
   identity. Do not construct work from a mailbox, provider response, or copied financial payload.
4. A Workflow already created may have failed. Its existence is not successful execution; inspect
   the owner's durable lifecycle before restarting it. Preserve claim guards and expiry checks.
5. For a BillingAttempt already sent to Wompi, reconcile verified evidence. Never reset its collection
   arm to manufacture another POST. Likewise, a claimed email send with an uncertain outcome must
   follow the owner's ambiguity/replacement path rather than reuse or resend its proof.
6. Remove a dead-letter message only after its durable outcome or safe recovery is understood.

For a UserStore-owned DaviPlata Subscription cancellation, recover the original UserStore through
its private `POST /work/check` operation. The check drains expired retry receipts and offers a page
of due cancellations to the billing Queue. It preserves any earlier alarm and reports failed families
even when another family completed. The version 3 Queue and Workflow identity contains the User and
the original paid BillingAttempt. The owner retains the one-shot Wompi void claim and checks the
original source independently before recording `voided`. An exhausted verification budget leaves
the cancellation `void-pending` for reconciliation. Preserve the original claim and source identity
when investigating an ambiguous provider response.

Dead letters have finite Cloudflare retention. They support diagnosis, not authoritative storage.
The outbox remains the recovery source. Current Cloudflare behavior is documented in
[delivery guarantees](https://developers.cloudflare.com/queues/reference/delivery-guarantees/),
[dead-letter queues](https://developers.cloudflare.com/queues/configuration/dead-letter-queues/), and
[Queue metrics](https://developers.cloudflare.com/queues/observability/metrics/).
