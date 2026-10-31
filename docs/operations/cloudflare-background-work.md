# Cloudflare background work

D1 owns accepted intent and outcomes. Queues redeliver bounded identities; Workflows execute durable
steps. A committed mutation does not establish provider settlement or delivery. Inspect the owning
lifecycle before retrying work.

## Maintenance cadence

Core's minute trigger remains the scheduling entrypoint. Maintenance selects due activities before
executing them, using the trigger's scheduled timestamp so delayed delivery does not select a
different window. Owner expiry, authorization and retention decisions still use the current clock.
Intervals align to UTC clock minutes; hourly work runs at minute zero, and daily work at 00:00 UTC
(19:00 the preceding day in Bogota). A missed or failed window is retried at the next scheduled
window; queues, workflows and per-User recovery alarms retain their independent retry behavior.

| Work                                                                             | Interval                |
| -------------------------------------------------------------------------------- | ----------------------- |
| Operational health and reminder discovery/publication                            | One minute              |
| Subscription renewals, cancellations and price-notice recovery                   | 15 minutes              |
| Dashboard projection repair                                                      | 15 minutes              |
| Billing collection, payment-status reconciliation, refunds and void verification | Five minutes            |
| Email, WhatsApp, disclosure and statement-extraction recovery                    | Five minutes            |
| Weekly summaries and recurring-charge digest generation                          | Five minutes            |
| Authentication, pairing, admission, quota and consent-offer cleanup              | One hour                |
| Statement, media and review-evidence cleanup                                     | One hour                |
| Operational event retention and smoke-probe expiry                               | One hour                |
| Audit and terminal recovery-evidence retention                                   | One day                 |
| Forwarded-email delivery recovery / private-byte cleanup                         | Five minutes / one hour |

Recurring-charge detection retains its existing owner and scheduler behavior. This cadence change
does not configure it. WhatsApp window expiry and the combined
hosted-Turn recovery/retention sweep retain minute checks because they also settle expired delivery
state and abandoned work. Proactivity evidence retention runs hourly, independently of reminders;
delivery expiry and publication remain prompt.

Slower cleanup does not extend credential validity, processing authority or access to expired
evidence. Physical cleanup can follow expiry by up to its interval when the bounded page can drain
the backlog. Forwarded-email cleanup already selects material within a 12-hour lookahead. All cleanup
retains its existing bounded page sizes and erasure/hold guards. Verify that those bounds can drain
the deployed workload: for example, an hourly 128-grant admission cleanup can process at most 3,072
grants per day, and a daily Audit sweep selects at most eight subjects with 64 rows per projection.
The idle budget below is not evidence of production backlog capacity.

## Operational signals

Core runs bounded owner inspections under `ASYNC_HEALTH_ENABLED`. Workers Logs retain closed
metadata: owner operation, state, finite severity, sampled backlog/age and observation timestamps.
Unavailable observations never carry invented healthy zeroes. Queue totals are distinct from D1
oldest-work samples. Configuration checks establish presence, not provider availability or delivery.
No request bodies, User identifiers, financial values, credentials or raw private causes belong here.

Each enabled owner emits its observation. The final closed marker
`fidy.operational component=inspection-coverage operation=ownerInspections state=complete`
means every expected Work/Queue owner, WhatsApp, dead letters, retention and capability probe was
inspected, including unavailable outcomes; it does **not** mean healthy. An unavailable D1 probe
emits its warning and makes coverage incomplete. Proactivity owners are required only when enabled.

Severity retains the existing thresholds: accepted work warns at two minutes and becomes critical
at ten minutes or an expired undelivered deadline; confirmed failed Workflows are critical. WhatsApp
failed delivery/overdue cleanup and any dead letters are critical. Primary Queue backlog warns at 100
and becomes critical at 1,000. Retention warns at one hour and becomes critical at 24 hours. Five rejected
email proofs warn; one does not. An unreadable native Workflow sample now explicitly warns rather
than disappearing beneath a healthy age threshold. These are observations, not admission policy.

The Core refusal observer remains deliberately lossy: 100 qualifying refusals per UTC minute per
HTTP assembly or MCP residency emit one closed warning. HTTP 401/403, exact provider-callback 400/422,
and canonical MCP 4xx results qualify; discovery and forged boundary labels do not. Saturation and
backward-clock protection bound emission. Isolate restarts/distributed traffic can hide bursts.
No D1 presence write, counter, retry, acknowledgement or email delivery state is retained.

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

## D1-independent outage alert ownership

Platform health and missing-complete-sweep monitors replace the R2 email claim ledger as well as D1
alert/counter stores. Core's D1 probe still emits closed unavailability metadata without attempting
owner reads; a stopped Core sweep is independently observable through absence. No application email
retry/acknowledgement ledger remains. Historical ADR0035 records the superseded design.

## Telemetry ownership (#716)

Each boundary records a closed Work outcome, not a propagated cross-application trace. Public HTTP
and Core HTTP observe their own request handling; Core Queue reception observes handoff only, while
each installed Workflow observes execution independently, including Proactivity delivery. Cron and Email Worker reception/sweep
observe their respective invocation. The User coordinator observes its serialized request and alarm;
its soft HTTP deadline does not turn an unfinished owner into completed Work. D1 and R2 activity is
covered by the surrounding owning Worker, Workflow, or coordinator Work, rather than exporting SQL,
object keys, or a record per query. The Workers AI binding records one model invocation; Resend,
Kapso, and Wompi record transport attempts beneath Outbound HTTP's policy, including only the
provider code, response status class, outcome, release, attempt, and bounded latency. A transport
response is not proof that a provider delivery or durable Work succeeded. Separate hops must be
compared against authoritative D1 outcomes; no unapproved trace context is carried across them.

Native Effect spans are not connected to a second exporter. The explicit Work projector is the
Cloudflare export path. Failed Work exports feed native Issues through a closed error envelope. Production
Cloudflare code and deployment have no Sentry runtime, preload, secret, source-map upload, or build
step. Alert delivery and test notification to an operator are owned by #717, not by these records.

## Safe recovery

1. Find the owner using the closed operation name, then inspect the private Queue/Workflow and its
   D1 record using the Cloudflare console. Keep identities and content out of logs and issue comments.
2. Restore missing bindings or fix consumer defects first. D1 outboxes continue to reoffer eligible
   work even if its previous Queue message was exhausted or its prompt offer failed.
3. Reoffer only an existing, still-eligible outbox identity with its existing version and Workflow
   identity. Do not construct work from a mailbox, provider response, or copied financial payload.
4. A Workflow already created may have failed. Its existence is not successful execution; inspect
   the owner's durable lifecycle before restarting it. Preserve claim guards and expiry checks.
5. For a BillingAttempt already sent to Wompi, reconcile verified evidence. Never reset its collection
   arm to manufacture another POST. Likewise, a claimed email send with an uncertain outcome must
   follow the owner's ambiguity/replacement path rather than reuse or resend its proof.
6. Remove a dead-letter message only after its durable outcome or safe recovery is understood.

Dead letters have finite Cloudflare retention. They support diagnosis, not authoritative storage.
The outbox remains the recovery source. Current Cloudflare behavior is documented in
[delivery guarantees](https://developers.cloudflare.com/queues/reference/delivery-guarantees/),
[dead-letter queues](https://developers.cloudflare.com/queues/configuration/dead-letter-queues/), and
[Queue metrics](https://developers.cloudflare.com/queues/observability/metrics/).
