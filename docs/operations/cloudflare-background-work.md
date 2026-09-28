# Cloudflare background work

D1 owns accepted intent and outcomes. Queues redeliver bounded identities; a Workflow owns execution.
A successful HTTP response means the mutation and its outbox committed, not that email or billing
completed. After commit, Core tries an identity-targeted offer within its execution-context lifetime.
The offer has a two-second budget. Failure leaves the accepted response intact, and the next minute's
cron can retry after the shared publication cooldown.

## Operational signals

The Production stack enables Core's `ASYNC_HEALTH_ENABLED` inspection and binds `AsyncDeadLetters`.
In Cloudflare Workers Logs, select the Core Worker and filter `component` to `async-health`.
The private Tail Worker projects only closed platform categories into minute buckets in D1 (Worker
exceptions, CPU/memory resource limits, rejected webhook/email callbacks, and Workflow failures);
it does not copy URLs, message bodies, identifiers, or raw exception text. The Tail Worker observes
Core, Ingress, and ForwardedEmail Workers. Five application Workflows also record rejected executions
at their entrypoints; the private Queue→Workflow canary distinguishes real consumer execution from a
successful Queue send or Workflow instance creation. A delayed/missing canary completion is critical;
an unavailable inspection is a warning, never proof of execution. These probes do not change any
application Work outcome.

| Signal                                                      | Interpretation                                                                          | Action                                                                            |
| ----------------------------------------------------------- | --------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| `state=attention`, `oldestPendingAgeMilliseconds >= 120000` | Accepted work has waited at least two minutes.                                          | Check the owner Queue and Workflow alongside authoritative D1 state.              |
| `expiredUndelivered > 0`                                    | A sampled delivery or statement deadline has elapsed.                                   | Check cleanup and the owner's terminal state; do not revive an expired proof.     |
| `failedWorkflows > 0`                                       | A sampled Workflow is errored, terminated, or paused.                                   | Inspect its safe platform status and D1 outcome before considering recovery.      |
| `unavailableWorkflows > 0`                                  | Stalled instance status could not be verified, including an absent binding or instance. | Check deployment wiring and platform availability; this is not proof of delivery. |
| `operation=deadLetters`, `backlogCount > 0`                 | Queue messages exhausted delivery retries.                                              | Investigate and replay only eligible durable identities.                          |
| `state=unavailable`                                         | A measurement failed or its binding is absent.                                          | Restore monitoring; no zero or healthy result is implied.                         |

Rejected email work is measured separately through `sampledRejectedEmailWork` and
`rejectionSampleLimited`: at most eight retained rejected records whose acceptance/request is within
the last 24 hours per email owner. Any such record produces `attention` even if its Workflow completed
successfully. This is a current-state sample, not a historical rejection rate; superseded or deleted
records leave it. Rejection can mean provider refusal or exhausted proof attempts, so inspect the
owning lifecycle before attributing a cause. It never authorizes a resend.

D1 pending figures describe the oldest **eight-record sample per owner**, not global totals. `sampleLimited`
means more work may exist. Ages, sampled counts, status counts, Queue counts, and Queue bytes are the
only exported values. User ids, work ids, mailboxes, financial content, and Workflow errors/outputs
never enter these signals. Each owner inspection has a three-second budget; at most two run together.
Queue metrics have a separate two-second budget. Failure of one measurement preserves the others.
The dead-letter Queue's count and byte figures are platform backlog measurements, not D1 samples.

`component=scheduled-work`, `outcome=failed` identifies an activity failure. The scheduler still tries
all other activities and then reports a closed invocation failure. `component=outbox-publication`
identifies failed prompt publication; check subsequent cron recovery before treating it as lost work.

The Core minute schedule classifies these bounded signals and stores notification attempts in
`operational_alerts` (metadata only: fixed alert kind and owner, severity, timestamps, acknowledgement,
and attempt count). A critical condition emails the operator immediately and repeats no more often
than every 30 minutes; warnings repeat no more often than every four hours. Resolved conditions send one resolution email and stop
repeats. A failed send remains firing and unacknowledged; the scheduled activity reports a closed
failure while other activities continue. A measurement failure is `inspection_unavailable`, never
zero; until all measurements recover the alert sweep does not resolve an existing firing condition.
These records represent **notification state**, not the authoritative status of background work.

Configure `OPERATOR_ALERT_EMAIL` as a Production GitHub environment variable, alongside the existing
`RESEND_API_KEY` secret. GitHub Actions sends deployment-failure email independently of the newly
released Worker. To verify delivery, manually run **Test operator alert email** in GitHub Actions
and confirm that the configured inbox actually received it; provider acceptance alone is not receipt.
No public health or admin endpoint exposes these records. The sole operator acknowledges a firing
alert in private operational state only after reading it, recording UTC `acknowledged_ms` for the
specific `(kind, owner)` row; acknowledgement suppresses repeats but does not change domain state.
Investigate critical alerts within 30 minutes and warnings within one Bogota working day. An
unacknowledged critical alert continues to repeat every 30 minutes; if unavailable, pause risky
operations or disable new ingress by reviewed release changes rather than manufacturing a second
on-call owner. Confirm resolution against D1/Queue/Workflow before deleting or replaying any work.

The `retention` signal inspects expired, unpublished statement staging rows: one hour overdue is a
warning and 24 hours overdue is critical. It does not claim that every other retained object has
been inspected. The existing pending measurements are capped eight-record samples; `sampleLimited`
is not a global backlog count. Current email-proof rejection samples are neither a historical callback-rejection
rate nor an institutional webhook spike. Monitor native Workflow failures separately from Queue
retries: Queue acknowledgment happens after instance creation, so a later Workflow failure never
reaches the Queue dead-letter destination. Set Cloudflare's account-wide billing budget emails
at 50% and 80% of the approved monthly spend; they are informational, not hard caps.

## Private operational view and account usage alerts

Use Cloudflare's authenticated D1 console (never a public endpoint) to query the latest
metadata-only inspection. **Stale observations are unavailable**, not healthy; compare
`observed_at_ms` with the present time. This is an inspection snapshot, not a work ledger:

```sql
SELECT operation, state, datetime(observed_at_ms / 1000, 'unixepoch') AS observed_utc
FROM operational_health_view ORDER BY operation;
SELECT kind, owner, severity, state, delivery_confirmed, acknowledged_ms,
       datetime(last_seen_ms / 1000, 'unixepoch') AS last_seen_utc
FROM operational_alerts ORDER BY severity, kind, owner;
SELECT kind, datetime(last_succeeded_ms / 1000, 'unixepoch') AS last_succeeded_utc
FROM operational_canary ORDER BY kind;
SELECT kind, SUM(count) AS last_hour FROM operational_event_buckets
WHERE bucket_ms >= (unixepoch() - 3600) * 1000 GROUP BY kind;
```

The view is a last-known observation, not an authoritative Queue total; use D1 owner records,
Queue metrics and Workflow instances to confirm unfinished work. If snapshot writes fail, the
alert delivery still runs independently and the stale timestamp stays visible. D1 down means the
view and Worker-backed email may both fail; check the Cloudflare console and the independent
GitHub deployment-failure email. Neither a dashboard query nor missing telemetry rewrites domain
state or marks incomplete work successful. Provider configuration checks only presence of required
Kapso, Resend, Wompi and AI settings; they do not prove provider availability or receipt.

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

## Telemetry ownership (#716)

Each boundary records a closed Work outcome, not a propagated cross-application trace. Public HTTP
and Core HTTP observe their own request handling; Core Queue reception observes handoff only, while
each of the five Workflows observes execution independently. Cron and Email Worker reception/sweep
observe their respective invocation. The User coordinator observes its serialized request and alarm;
its soft HTTP deadline does not turn an unfinished owner into completed Work. D1 and R2 activity is
covered by the surrounding owning Worker, Workflow, or coordinator Work, rather than exporting SQL,
object keys, or a record per query. The Workers AI binding records one model invocation; Resend,
Kapso, and Wompi record transport attempts beneath Outbound HTTP's policy, including only the
provider code, response status class, outcome, release, attempt, and bounded latency. A transport
response is not proof that a provider delivery or durable Work succeeded. Separate hops must be
compared against authoritative D1 outcomes; no unapproved trace context is carried across them.

Native Effect spans are not connected to a second exporter. The explicit Work projector is the
Cloudflare export path, so an Effect error is not also reported as a separate native issue. Production
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

## Capability status and release evidence

Onboarding email, browser-pairing email, email replacement, billing collection, and statement
extraction have installed Queue/Workflow paths. Statement extraction executes bounded chunks through
the User coordinator and exposes Transactions or NeedsReviewItems with truthful terminal state.
Statement dispatch, reconciliation, and review-evidence expiry participate in independent scheduling;
its Workflow binding and Queue dead letters participate in the same operational inspection.
Statement publication uses its durable cron outbox path; the four email/billing owners also use
prompt postcommit offers. Forwarded-email ingress and retention are installed separately; this
runbook's Queue/Workflow execution claims concern Core's five consumers.

Before enabling a changed stack, run the relevant Worker/platform regression tests and deploy through
the existing GitHub Actions release path. In Production, verify a harmless accepted operation reaches
its expected terminal outcome, the corresponding signal returns to healthy, and the intended operator
channel receives its configured test alert. Local tests do not replace these live checks.
