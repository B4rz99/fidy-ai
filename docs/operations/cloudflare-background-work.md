# Cloudflare background work

D1 owns accepted intent and outcomes. Queues redeliver bounded identities; a Workflow owns execution.
A successful HTTP response means the mutation and its outbox committed, not that email or billing
completed. After commit, Core tries an identity-targeted offer within its execution-context lifetime.
The offer has a two-second budget. Failure leaves the accepted response intact, and the next minute's
cron can retry after the shared publication cooldown.

## Operational signals

The Production stack enables Core's `ASYNC_HEALTH_ENABLED` inspection and binds `AsyncDeadLetters`.
In Cloudflare Workers Logs, select the Core Worker and filter `component` to `async-health`.

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

The stack provides queryable warning signals. Delivery to a configured operator channel, notification
threshold persistence, and a test alert to that channel remain part of
[#717](https://github.com/B4rz99/fidy-ai/issues/717); logs alone do not prove operator notification.
Monitor native Workflow failures separately from Queue retries: Queue acknowledgment happens after
instance creation, so a later Workflow failure never reaches the Queue dead-letter destination.

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
