# Cloudflare background work

D1 owns accepted intent and outcomes. Queues redeliver bounded identities; a Workflow owns execution.
A successful HTTP response means the mutation and its outbox committed, not that email or billing
completed. After commit, Core tries an identity-targeted offer within its execution-context lifetime.
The offer has a two-second budget. Failure leaves the accepted response intact, and the next
five-minute recovery sweep can retry after the shared publication cooldown.

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

## Idle D1 budget

Core inspects operational health every minute. Unchanged health snapshots refresh every
five minutes; state changes persist immediately, and older observations cannot replace newer ones.
The Queue→Workflow canary publishes in the first minute of each five-minute period, with the existing
ten-minute stale threshold. A missed publication window is detected by that threshold rather than
replayed on every subsequent minute. Repeated empty/final-page control-object sweeps do not rewrite
a cursor; multi-page cursors still advance durably and lawful-hold checks remain unchanged.

`maintenance/idle-budget.test.ts` installs every migration in native D1, applies the production
recovery wrapper, and runs Core, Email and all control-bucket sweeps over a complete hourly
cycle, adding the midnight tick's cost to the daily projection. It budgets downstream canary writes
and asserts fewer than 10,000 projected daily
idle writes (10% of the Free allowance) and 750,000 reads. This protects idle overhead, not total
account usage: real work, incidents and other databases still consume the account-wide allowance.
The opt-in performance benchmark also includes the recovery guard.

## Recurring-charge detection cadence

A completed User evaluation becomes eligible again after seven days, and only changed Transaction
facts require another analysis. The first evaluation is eligible at the next discovery. Completion
times anchor each User's cadence rather than one product-wide weekday. Discovery checks for newly
due Users hourly when idle, recording its next wakeup on the existing fair-dispatch cursor.

Core's other maintenance still runs each minute. Between discovery sweeps, recurring work reads only
its schedule row and indexed unfinished User identities. Interrupted evaluations resume on these
minute ticks, including when changed facts require restarting that unfinished evaluation. Full
four-User batches keep discovery open until the backlog drains; each tick retains bounded work and
round-robin fairness rather than postponing all remaining Users for another hour. A missed tick
catches up from the durable due timestamp, and account erasure can remove and recreate the cursor.
The seven-day boundary is an eligibility time, not an exact delivery deadline: discovery, backlog,
retries and bounded evaluation steps can delay completion. No Transaction write triggers detection.

## Operational signals

The Production stack enables Core's `ASYNC_HEALTH_ENABLED` inspection and binds `AsyncDeadLetters`.
The Core, Ingress, ForwardedEmail, and web asset Workers use Cloudflare Workers Logs with persistence
enabled and automatic invocation logs disabled. On Workers Free, Cloudflare documents an allowance
of 200,000 log events per day and three-day retention; check the current
[Workers Logs limits](https://developers.cloudflare.com/workers/observability/logs/workers-logs/).
In Cloudflare Workers Logs, select Core and filter `component` to `async-health`. Fidy-emitted log
records are closed metadata; request URLs, bodies, identifiers, and raw exception text are not logged.
These logs are for diagnosis, not an email-alert source.

The paid-only Tail Worker has been removed. Worker exception, CPU/memory-limit, and rejected
callback counters are no longer aggregated into D1 or delivered as operational email alerts; inspect
native Worker metrics and Workers Logs manually for those conditions. The `workflow_failure` D1
counter remains independent: each application Workflow records rejected executions at its entrypoint,
and the scheduled Core health sweep continues to alert on them. Core sweeps event buckets after 24
hours with a bounded hourly deletion, including historical Tail-only counters. The private
Queue→Workflow canary distinguishes real consumer execution from a successful Queue send or
Workflow instance creation. A delayed/missing canary completion is critical; an unavailable inspection
is a warning, never proof of execution. These probes do not change any application Work outcome.

Core additionally records a **lossy concentrated-refusal signal**. Its HTTP assembly counts
completed 401/403 responses, 400/422 responses from the exact Kapso/Wompi callback paths, and
4xx transport responses from the exact `/mcp` path. MCP also observes decoded canonical 4xx tool
results (including rate limiting) before the protocol carries them inside HTTP 200. Discovery,
successful calls and provider/server 5xx failures do not count. The boundary is selected by the
owning adapter; headers, callback-like path prefixes and tool arguments cannot supply it.

Each Core HTTP assembly and each User coordinator's MCP residency owns one counter. Creating or
evicting a protocol session does not reset its coordinator's counter. At 100 refusals within one UTC
minute, that observer admits one best-effort D1 presence write. Later refusals in that minute do not
write, failed writes are not retried, and at most one native write remains outstanding per observer
even after the 250 ms wait expires. The count saturates at 100. A new minute can admit another attempt
only after 100 new refusals; a backward clock cannot reopen an old minute. The bound is per observer,
not a deployment-wide write cap: different isolates or User coordinators can each admit a write.
This is telemetry, never authorization or request admission.

Scheduled health logs include `severity: none | warning | critical`, selected by the existing
alert policy for that observation. An `attention` sample below its alert threshold has `none`;
an unavailable inspection has `warning`. Any critical alert for an owner takes precedence over
its warnings. This field augments the same bounded observation, without another emission or
retained state. Queries must distinguish missing observations from observations with `none`.

Each detected burst also emits the closed `core-rejections / coreRejectionBursts / attention`
warning directly to platform logs. Database failures or a previous unresolved native write do not
suppress this observation; the existing threshold and one observation per observer per minute still
apply. The record contains no request or error details. This emission is preparation for #1491,
not evidence that platform alert queries and delivery are configured or verified.

The single `operational_event_buckets` presence row with `kind = 'core_rejection'` and `bucket_ms = 0`
stores the most recent minute timestamp; monotonic writes cannot replace it with older evidence. The scheduled health sweep
emits `core_rejection_burst / coreRejectionBursts` as a warning while that minute is less than five
minutes old. Missing evidence means no recorded burst, not absence of attacks. Failed reads or a
future timestamp are unavailable, not healthy. The ordinary warning delivery/acknowledgement policy
applies. Retention deletes the row at 24 hours; it remains at most one row even if cleanup stops.

Restarts and low-rate or distributed traffic can lose this signal. Stalled writes and scheduling
outages can also lose its D1-backed scheduled observation; the direct log emission is independent.
It excludes edge refusals, OAuth provider refusals represented by redirects, and MCP SDK protocol
errors carried in HTTP 200 before canonical dispatch. Native-confirmation failures projected as
unavailable are not counted as client 4xx refusals. A warning is evidence of refusals, not proof of
malicious activity; ordinary invalid inputs, absent records and legitimate rate limiting can trigger it.
No request path, IP, User, credential, body, error detail or caller-supplied dimension is retained.
The native MCP observation test substitutes canonical dispatch and proves protocol detection;
existing canonical suites remain the authorization evidence. Live receipt and response evidence
remains #1262.

### Platform migration verification (#1491)

On 2026-10-23, the account dashboard saved and enabled **Fidy production: Core rejection bursts**
(`fc9c5304807746699773a58bb8287594`), scoped to the deployed Core Worker. It reports a one-minute
check interval, threshold `> 0`, five-minute averaging and four-hour notification repeats. Its email
destination matches the existing deployed `OPERATOR_ALERT_EMAIL`. The saved query is:

```sql
SELECT count() AS "value"
FROM "logs"."workersLogs"
WHERE "scriptName" = 'fidycloudflare-core-production-hdv5cspnk7fai6vg'
  AND "message" LIKE '%fidy.operational component=core-rejections operation=coreRejectionBursts state=attention severity=warning%'
```

The original message-word query was not coverage: live inspection showed that Cloudflare extracts
Effect's object arguments into structured attributes while the message contains only the log prefix.
The account's monitor SQL rejects custom columns (`component`) and filtering the JSON `attributes`
column (HTTP422). The health records now supply an explicit closed `message` containing component,
operation, state and policy severity, alongside their existing bounded fields. Match complete
`state=unavailable` / `severity=warning` tokens, never the word `unavailable`, which also occurs in
the healthy `unavailableWorkflows: 0` field. The direct burst uses the same fixed message format.
These changes are deployed through trunk `66ae1f476b28e491f498cb49c0cc08fb0d142c21`.
Dashboard inspection of Workers Logs on 2026-10-23 returned the closed operational messages for
capabilities, Workflows, owner work and Queues. This establishes ingestion and the dashboard query
match; it does not establish historical monitor evaluations or notification delivery.

Both manual timestamp expressions, `NOW() - INTERVAL '5' MINUTE` and
`NOW() - toIntervalMinute(5)`, failed account preview with `RecursionLimitExceeded` (HTTP422).
The saved and reopened monitor instead retains the automatic one-minute query interval and averages
its nonnegative counts over five minutes, triggering above zero. This verifies persisted configuration;
it does not establish actual rolling-window evaluation semantics. Cloudflare's sample-notification
action was submitted once; a sample is not actual threshold-firing evidence.

Additional saved, enabled monitors use that same operator recipient and report one-minute checks:

| Monitor                                            | Saved identifier                   | Query / detection                                                                                                                                                                       | Repeat |
| -------------------------------------------------- | ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| Fidy production: Critical operational health       | `ad301e0eac8b4f99b375b07b909ace5a` | Core Workers Logs message `LIKE '%fidy.operational component=% severity=critical%'`; count >=1, average1m                                                                               | 30m    |
| Fidy production: Operational health warnings       | `0735ba4d6f53402c976a3ad4ae6c16c1` | Core message `LIKE '%fidy.operational component=% severity=warning%'`, excluding `LIKE '% operation=coreRejectionBursts state=attention %'` already covered above; count >=1, average1m | 4h     |
| Fidy production: Missing Queue canary execution    | `80833aeb00654828b52123b940170f1e` | Native `events.queuesMessages` successful `DeleteMessage` observations for the canary Queue; count ==0, average10m                                                                      | 30m    |
| Fidy production: Missing completed Workflow canary | `db498d28ab1447b0acdd80ea6ce6ead8` | Native `events.workflows`, exact canary name and `eventType='WORKFLOW_SUCCESS'`; count ==0, average10m                                                                                  | 30m    |

The canary queries have no grouping, so absence can produce numeric zero. Their ten-minute
averaging setting and one-minute execution interval are independent; the average is zero only
when the contributing nonnegative counts are all zero. Saved settings are not proof of the
platform's initial-window, stale-data, sampling or evaluation semantics. Queue concurrency does
not prove completion and is not used for this detection. Queue acknowledgment does not prove
Workflow completion; the second query checks actual native Workflow success separately.

The deployed canary Queue is `a0a2a566d54f4566905c769738b61078`; the Workflow is
`fidycloudflare-core-production-hdv5cspnk7fai6vg-operati-a29777df`. Read-only Wrangler listing
identified these resources. The Workflow success preview showed about one completion every five
minutes, consistent with its deployed instance listing. The Queue acknowledgment preview showed
a stable ten-minute average around 0.2, consistent with one success every five minutes, after removing `consumerType='worker'`: that filter incorrectly
produced zero in this account's SQL dataset. Wrangler reports exactly one producer and one consumer,
both the deployed Core Worker. The saved query therefore filters exact Queue identity,
`actionType='DeleteMessage'` and `outcome='success'` without the consumer-type restriction. Neither
preview establishes actual alert firing, notification receipt, controlled absence or recovery. Do not treat a missing Queue row as proof
of zero backlog, or a successful Queue acknowledgment as successful business delivery.

Completed Work and caught-failure exports also supply fixed platform-query messages, on the
same records as before. `fidy.work` contains only the closed operation, outcome and HTTP status
class (or `none`); `fidy.failure` contains only component, operation, safe error code and failure
classification. Span events and the portable telemetry contracts are unchanged. Native tests
exercise the production console exporter, preserve the original rejected Promise/success result
when logging throws, and check the full captured output for private failure/prompt/credential
sentinels. These exports are deployed. Workers Logs search for `fidy.work` returned the closed
messages for scheduled work, Maintenance, Queue execution, the canary Workflow and Email scheduling.
A last-hour `fidy.failure` search returned zero records, so live caught-failure ingestion remains
unverified. Neither export establishes native runtime-limit coverage when execution cannot emit a
record.

The policy monitors currently combine owners by severity, whereas the old Fidy alert state
has independent kind/owner cooldowns and acknowledgment. A new failing owner can therefore share
an already-firing platform monitor and wait for its repeat; these definitions do not prove equivalent
per-owner notification timing. Verify or resolve that difference, owner-specific stale/missing
observations, platform initial-window behavior and independent outage delivery before retirement.

The full #1491 coverage gate remains open. Required next evidence includes monitor policy-severity queries,
native Queue and completed Workflow observations, missing/stale inspections, actual firing and
resolution, delivery results, account-supported execution cadence, privacy and independent outage
behavior. Keep the operational tables and existing notification machinery until these pass.

#### Dashboard verification checkpoint — 2026-10-23

The private account dashboard
[Fidy production: operational signals](https://dash.cloudflare.com/a32350b6918ad7e78bc589b6630af1c2/dashboards/2223e9f9-2898-40aa-8f19-5157711ed0ac)
contains two saved Workers Observability Logs timeseries. Both filter `$metadata.message` with
the prefix `fidy.operational component=`. One groups observation counts by `operation`; the other
groups them by `severity`. Both rendered live records after saving. They show historical observation
counts, not latest owner status; group selection and time-range aggregation can hide an owner.
No observations means unknown, never healthy. This dashboard alone does not satisfy #1492's current
health and stale-owner gate.

For timestamped owner inspection, use the account's Workers Logs search for `fidy.operational`, then
restrict the closed component/operation and inspect the newest observation and its bounded fields.
The live records included `deadLetters state=attention severity=critical`. Native Queue inspection
showed a realtime backlog of 449 messages; the six-message preview included October 18–20 messages,
and the first expanded body had the operational canary's `version`/`sentAtMs` shape. This is a partial
preview, not a classification of all 449 messages or proof that replay is safe. No messages were
replayed, acknowledged or purged during this verification.

The dashboard's monitor actions expose a sample-notification test, not an actual evaluation history.
The Platform Notifications view also did not expose delivery history in this inspection.
[Cloudflare documents alert history through its API](https://developers.cloudflare.com/notifications/notification-history/);
the existing Wrangler login received HTTP403 for that read. Dashboard access remains usable for
configuration, preview, log queries and native resource inspection. Subsequent operator-mailbox
inspection verified real Cloudflare threshold-triggered and resolved emails for critical health,
warning health and both canary monitors, distinct from sample notifications. The critical thread
included `Trigger: 1 >= 1` and a new alert start at `2026-10-24T00:16:02Z`; the Queue recovery
thread included `Trigger: 0.1 == 0`, demonstrating a nonzero recovery value, with an alert start
at `2026-10-24T00:42:59Z`. This establishes actual mail delivery and platform-reported transitions,
not correct business health: numerous preceding canary alert/recovery cycles still need correlation
with native executions, sampling and observation gaps. Cloudflare documents that event datasets may
be [adaptively sampled](https://developers.cloudflare.com/analytics/sql-api/datasets/); weighted counts cannot recover an omitted event. The aggregate Queue baseline
showed 283 ingested and acknowledged messages, zero retries and zero realtime backlog over the last day.
Neither that aggregate nor a resolved email proves uninterrupted execution.

A controlled absence check began on October 23 at approximately 19:48 America/Bogota: only delivery
on the dedicated operational canary Queue was paused, through its Messages tab. Business Queues,
consumers, schedules and monitor definitions were unchanged. Producer publication remains every
five minutes; resume before the oldest retained probe exceeds its existing ten-minute payload-age
limit. Correlate new alert start times with this interval, then verify consumption and Workflow
completion plus delivered resolution after resuming. Historical emails are not controlled-test proof.
The Queue was resumed and visibly returned to Active at approximately 19:58 America/Bogota.
The real Cloudflare Queue alert received at 20:01 reports `Trigger: 0 == 0` and alert start
`2026-10-24T00:57:59Z`, inside the deliberate pause. Native Workflow instances
`operational-canary-5976010` and `operational-canary-5976011` both completed after delivery resumed;
`operational-canary-5976012` then completed on the ordinary publication cadence. This establishes
controlled Queue absence detection, actual alert delivery and downstream execution recovery.
A subsequent real Queue Resolved email arrived at 20:11 America/Bogota, reporting
`Trigger: 0.1 == 0` and an “Alert started” field of `2026-10-24T01:07:59Z`. This verifies
delivered recovery after resumption. That field differs from the triggering email; treat it as
reported message metadata, not a stable incident identifier or proof of exact incident matching.

Native Workflow instance `operational-canary-5976007` completed its D1 step at
`2026-10-24 00:35:33 UTC` (827ms wall time, Completed). The delivered missing-Workflow alert reports
`Trigger: 0 == 0`, alert started `2026-10-24T00:37:57Z`. The supposed ten-minute absence therefore
fired less than three minutes after a real completion. The detector is not verified coverage and must
be corrected before retirement. These timestamps predate the controlled pause. Do not attribute
this contradiction to sampling alone without isolating sampling, ingestion delay and evaluation-window
behavior. A subsequent unsaved Workflow SQL draft with
`timestamp >= CURRENT_TIMESTAMP() - INTERVAL '10' MINUTE` also failed preview with
`RecursionLimitExceeded` (HTTP422). Reducing that draft to only the Workflow dataset and
`timestamp >= NOW() - INTERVAL '10' MINUTE` exposed a more specific HTTP422:
`query already contains time predicates on timestamp; remove them to use time_range`.
The dashboard editor inspected here supplies an automatic request time range but exposes no
manual-range selector in either its SQL or builder tab. Both drafts were cancelled; no broken
query was saved. Current API-token metadata also has no Notifications scope (the expired login's
read returned HTTP401), so direct policy inspection/configuration needs an appropriately authorized
Notifications credential rather than browser-session extraction. Existing saved monitors remain enabled.
Missing/stale-owner coverage and independent owner cooldowns remain unresolved.

#### Account verification checkpoint — 2026-10-24

PR #1530 merged and its Production deployment succeeded (run `40093477574`). The latest
trunk deployment's earlier capture timeout also succeeded on one retry without changing the
release deadline. No additional schema transition or table removal ran in this checkpoint.

After explicit User approval, a temporary account-scoped Notifications Edit token allowed policy
and delivery-history reads. The two existing canary monitors now retain a `10m` execution interval,
verified through the policy API after dashboard saves. In automatic mode this expands the actual
query range to ten minutes; a ten-minute averaging setting alone did not do so. This changes the
possible absence-notification delay to twenty minutes plus provider delivery latency. Live
false-absence and controlled recovery verification remain required before retirement.

The account's available-alert metadata includes `workers_observability_real_time_issue`. Native
policy `5b351c3174e142a8b52b8ad883f8c85e` was created and enabled for the existing private operator
destination. A dedicated instance `operational-alert-verification-20261024` used only
`{"version":2,"sentAtMs":0}`; native status reports Errored at `2026-10-24 12:34:28 UTC` with the
closed error `Invalid operational canary`. This verifies the controlled failure, not native issue
notification delivery or runtime-limit coverage. No User work was replayed or changed.

Notifications permission alone cannot configure SQL-backed policies: the API returned HTTP400,
code `17203`, `requesting user cannot access this query`. Cloudflare's
[SQL API prerequisites](https://developers.cloudflare.com/analytics/sql-api/get-started/)
require Account Analytics Read, with possible product-specific permissions for particular datasets.
The dashboard also returned to its final creation form without creating either a native-issue SQL
monitor or a simple per-owner healthy-heartbeat monitor; its console exposed only `Object`.
Those drafts were cancelled. Do not attribute this to a plan limit without evidence.
A combined eighteen-owner conditional query hit the account's SQL recursion limit (HTTP422);
prefer independent, simple owner queries when configuration access works. The native built-in
issue policy is saved, but owner freshness, independent owner response and live issue delivery
remain unresolved. The three operational tables and fallback machinery remain installed.

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

D1 pending figures describe the oldest **eight-record sample per owner**, including incomplete
forwarded-email receipts without a terminal outcome, not global totals. `sampleLimited`
means more work may exist. Ages, sampled counts, status counts, Queue counts, and Queue bytes are the
only exported values. User ids, work ids, mailboxes, financial content, and Workflow errors/outputs
never enter these signals. Each owner inspection has a three-second budget; at most two run together.
Queue metrics have a separate two-second budget. Canary publication stops waiting after two seconds
without retrying the uncertain offer, so a stalled monitoring Queue cannot hold later Maintenance
activities. Queue acceptance, including a late result after timeout, is never execution proof.
Failure of one measurement preserves the others.

The shared Proactivity delivery Queue reports `proactivityQueue` when weekly summaries or category
proactivity are enabled. `proactivity` samples at most eight oldest unfinished identities across only
the enabled categories (weekly summaries/questions and category messages). Index-backed per-source
limits keep terminal history out of this read. Its Workflow identities are inspected without exposing
User IDs, recipient data, report content, or platform error messages. Missing bindings and failed
measurements remain unavailable. Neither observation nor migration 0076 enables a feature or sends
product messages. `workflow.proactivityDelivery` records one safe Work outcome, and terminal failures
join the existing bounded `workflow_failure` buckets without replacing their original rejection.
The dead-letter Queue's count and byte figures are platform backlog measurements, not D1 samples.

`component=scheduled-work`, `outcome=failed` identifies an activity failure. The scheduler still tries
all other activities and then reports a closed invocation failure. `component=outbox-publication`
identifies failed prompt publication; check subsequent cron recovery before treating it as lost work.

The Core minute schedule classifies these bounded signals and stores notification attempts in
`operational_alerts` (metadata only: fixed alert kind and owner, severity, timestamps, acknowledgement,
and attempt count). A critical condition emails the operator immediately and repeats no more often
than every 30 minutes; warnings repeat no more often than every four hours. Resolved conditions send one resolution email and stop
repeats. A failed send remains firing and unacknowledged; the scheduled activity reports a closed
failure while other activities continue. An ambiguous send reuses the same idempotency key within
the provider window; afterward a new operator-only email attempt uses a fresh key rather than
falling permanently silent. This may produce a duplicate alert email, never duplicate application
Work. A measurement failure is `inspection_unavailable`, never
zero; until all measurements recover the alert sweep does not resolve an existing firing condition.
These records represent **notification state**, not the authoritative status of background work.
Unchanged firing observations refresh `last_seen_ms` at most every five minutes. New conditions,
severity changes, and recovery still persist immediately. Resolution excludes the current sweep's
active `(kind, owner)` pairs rather than treating an unchanged heartbeat timestamp as recovery.
This bounds observation writes without changing notification cooldowns or acknowledgement policy.

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

The `retention` signal inspects expired unpublished statement staging rows, published statement
bytes awaiting deletion beyond their submission retention deadline, forwarded-email receipts
whose bytes are overdue for deletion, and statement NeedsReviewItem evidence that remains past its
evidence deadline: one hour overdue is a warning and 24 hours overdue is critical.
This is an eight-row sample, not an R2 inventory; byte deletion and durable receipt/submission state
remain authoritative. The existing pending measurements are capped eight-record samples; `sampleLimited`
is not a global backlog count. Current email-proof rejection samples are neither a historical callback-rejection
rate nor an institutional webhook spike. Monitor native Workflow failures separately from Queue
retries: Queue acknowledgment happens after instance creation, so a later Workflow failure never
reaches the Queue dead-letter destination. Previous Tail-only alert rows are retired by the normal
alert sweep when this source is removed; that reflects discontinued monitoring, not proof that a
Worker condition was corrected. Set Cloudflare's account-wide billing budget emails
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
SELECT SUM(count) AS workflow_failures_last_hour FROM operational_event_buckets
WHERE kind = 'workflow_failure' AND bucket_ms >= (unixepoch() - 3600) * 1000;
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

## D1-independent outage alerts (#1160)

Operational Health owns a single metadata-only R2 ledger at `operational/alerts/d1-v1` in the
existing private statement staging bucket. See [ADR 0035](../adr/0035-d1-independent-operator-alerts.md).
The Core minute inspection probes D1 before attempting database-backed telemetry. Unavailable D1
reaches this independent ledger and the existing approved `OPERATOR_ALERT_EMAIL` / `RESEND_API_KEY`
boundary. Other alert coordinates continue to use `operational_alerts` in D1.

R2 ETag conditions admit each attempt before sending. Concurrent ticks and Worker restarts share
one durable ledger. The D1 inspection alert preserves its warning severity and four-hour repeat;
critical delivery repeats after 30 minutes. A failed or lost response retries after five minutes,
at most six times under the same email identity and original release. That identity remains fixed
for the 23-hour safe provider idempotency window, including after retry exhaustion. After the window,
another eligible attempt starts a fresh identity. Provider acceptance is not inbox receipt; a duplicate
operator email remains possible after the provider window or provider ambiguity.

For acknowledgement, use authenticated private R2 access to read this exact object and its ETag.
Check that `phase` is `firing` and its `started` timestamp identifies the notification you read.
Conditionally replace that same JSON with only `acknowledged` changed to `true`, using `If-Match`
with the read ETag. If the condition fails, reread and recheck the notification before retrying;
do not overwrite a newer claim. This suppresses firing repeats and retries, without declaring
recovery. Preserve every other field, never delete the object, and do not update D1 to acknowledge
this R2-owned coordinate. No public administrative endpoint exists.

Only a healthy D1 capability probe with available D1-backed owner inspection starts resolution.
Missing or failed measurements cannot resolve. A resolution clears acknowledgement and sends once,
using the same bounded retry policy if its response is lost. The firing cooldown survives resolution
to bound rapid flapping; older observations cannot regress newer state. Retention overwrites one
object of at most 1 KiB, including its resolved tombstone; no per-tick history accumulates. Staging
cleanup operates on its own statement prefix and must not delete the operational ledger.

Verified local tests exercise actual R2 conditional writes, persistent runtime recreation, Core
maintenance/operational inspection, unavailable D1, concurrent ticks, failed and ambiguous provider
transport, cooldown, acknowledgement and recovery. These tests do not prove production inbox receipt.
Delivery requires Core execution and its minute trigger, R2 and Resend to remain available. This
owner cannot independently establish Core cron liveness or detect a Cloudflare-wide outage. An
external independently scheduled monitor is required for cron liveness. GitHub deployment-failure
email observes release failures, not runtime D1 availability. No new credentials, recipient changes,
or production infrastructure enablement follow from this implementation.

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
Cloudflare export path, so an Effect error is not also reported as a separate native issue. Production
Cloudflare code and deployment have no Sentry runtime, preload, secret, source-map upload, or build
step. Alert delivery and test notification to an operator are owned by #717, not by these records.

### Account monitor capacity and inspection coverage — October 24

A further dashboard creation attempt exposed the concrete rejection: **“an account can have at most
5 custom analytics policies.”** All five custom slots are occupied. The unsaved billing-owner draft
was cancelled; no sixth custom policy exists. Additional API permissions do not resolve this limit.
A balanced sum of owner-presence aggregates still failed with HTTP422 `RecursionLimitExceeded`
(limit 10). `COUNT(DISTINCT message)` failed with HTTP422 because this account rejects distinct
aggregates on adaptive datasets. Do not treat a successful simple preview as permission to save an
additional monitor, or assume the generic Log Explorer function list overrides this observed error.

The existing health entrypoint now emits one additional closed inspection-coverage observation per
completed sweep. It checks the expected Work and Queue owners under the deployed Proactivity flags,
WhatsApp, dead letters, retention and the four capability inspections. `state=complete` means all
expected inspections returned an observation, **including unavailable observations**; it does not
mean healthy. When unavailable D1 prevents the owner sweep, coverage is incomplete. Existing owner
observations and policy severity remain unchanged. The summary contains no owner identities,
exceptions, financial data or new retained state. This prepares a single count-based absence query
without an expression per owner or sampled distinct counting; deployment and live verification are
still required before using it to retire storage.

The native Worker Issues sample-notification action was submitted at 16:59 UTC. Notification history
records that test dispatch, and the configured operator mailbox received the sample “Workers
real-time issue detected” email. Its example `checkout-worker` is sample data, not evidence of a
Fidy failure. This proves the notification destination works, not actual exception/resource-limit
coverage or safe contents of future real issue notifications.

Current notification history also records repeated warning start/end pairs about one minute apart.
These are real delivered alerts, not proof of stable owner health or valid per-owner resolution.
Keep the old monitoring stores until the replacement policy, owner freshness, native failure
coverage and actual absence/recovery behavior have been verified.

### Native issue activation and controlled missing-signal test

The deployed Core Issues page still displayed **Enable issue detection** after the native
notification policy had been enabled. A sample notification does not activate Worker detection.
The stack now requests `observability.issues.enabled=true`, preserving query redaction, disabled
automatic invocation logs and disabled release tracing. The selected provider serializer previously
omitted the Issues field; its existing narrow Worker metadata patch now retains that field. The
production release script-settings request and read-back require native detection and query privacy
before staging, including gradual releases. These source changes still require deployment and live
verification. See [Issues activation](https://developers.cloudflare.com/workers/observability/issues/)
and [detected failures](https://developers.cloudflare.com/workers/observability/issues/investigate/).

Failed Work exports now use the error console level with the same closed metadata envelope; the
private cause is not added, and success/rejection/interruption retain their existing projection.
The selected Effect default logger normally uses `console.log` even for an error log level; the
failed export explicitly selects its stderr console reference. Export failure still cannot change
the original Work result. This supplies the native detector with caught failures without another
application counter. Verify the resulting live issue context and notification contain no private
content before removing existing coverage; source configuration alone does not prove that.

At 17:13:40 UTC, the missing-Workflow monitor was temporarily pointed at a nonexistent closed test
name, leaving the actual canary and all business work running. Cloudflare recorded a real zero-count
firing at **17:22:57 UTC** (correlation `2114045810818682880`); its operator email arrived at
**17:26:14 UTC**. The original actual-canary success query was restored and read back at
**17:30:03 UTC**, retaining the ten-minute interval and thirty-minute repeat. This verifies the
zero-signal detector and delivery, not a real Workflow outage. Recovery receipt is still pending.

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

### October 20 retained-canary investigation

At 13:20 UTC, the shared dead-letter Queue reported 679 messages, no consumer, and zero ingestions
or retries in the preceding 24 hours. All ten dashboard-preview messages were operational canaries
(`version`, `sentAtMs`) from October 18; this sample does not classify every retained message.
The source canary Queue reported 286 ingestions, 286 acknowledgements, no retries and no current
backlog over the same rolling day. Current canary execution has recovered; a nonempty dead-letter
Queue is not evidence that it is still failing.

The source consumer logs confirm rejected canary invocations during October 18's D1 outage,
including 18:59:11 UTC, adjacent to the latest sampled dead letter. Those logs retain only a generic
Promise failure, so they cannot establish each message's original provider error. Production run
39157824267 independently confirmed the daily D1 quota refusal at 19:17 UTC that day. The canary
consumer writes its D1 execution checkpoint before Workflow handoff; refusal therefore prevents
acknowledgement and can exhaust its three Queue retries. This is consistent with the sampled failure path,
not every message or the first October 10 incident. The alert's October 10 `first_seen_ms` is a
continuous-condition timestamp, not the age of each currently retained message.

The dashboard displays 86,400-second retention, while Cloudflare's DLQ-specific documentation says
messages without a consumer persist four days. The October 18 previews were still present on
October 20; do not promise immediate expiry from the generic settings alone. No message was
acknowledged, replayed or purged during this investigation. Expired canaries must not be replayed:
they cannot prove present health. Inspect all remaining identities before any destructive cleanup.

The unnecessary D1 writes came from the alert observation UPSERT, not a consumer repeatedly running
these retained messages. Its prior minute refresh cost up to 1,440 observation writes per active
alert per day. The five-minute heartbeat reduces that steady observation component to 288;
notification claims, confirmations and actual state changes retain their separate writes.

## Capability status and release evidence

Browser-pairing email, email replacement, billing collection, and statement
extraction have installed Queue/Workflow paths. Statement extraction executes bounded chunks through
the User coordinator and exposes Transactions or NeedsReviewItems with truthful terminal state.
Statement dispatch, reconciliation, and review-evidence expiry participate in independent scheduling;
its Workflow binding and Queue dead letters participate in the same operational inspection.
Statement publication uses its durable cron outbox path; the three email/billing owners also use
prompt postcommit offers. Forwarded-email ingress and retention are installed separately; this
runbook's Queue/Workflow execution claims concern the four listed Core consumers.

Before enabling a changed stack, run the relevant Worker/platform regression tests and deploy through
the existing GitHub Actions release path. In Production, verify a harmless accepted operation reaches
its expected terminal outcome, the corresponding signal returns to healthy, and the intended operator
channel receives its configured test alert. Local tests do not replace these live checks.
