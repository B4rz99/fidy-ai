# Automatic renewal, grace, cancellation and replacement Prices

- **Status:** Accepted
- **Date:** 2026-10-07
- **Issue:** #233 and #236, with the User's implementation decisions superseding conflicting historical text.

[ADR 0041](0041-per-user-durable-object-storage-direction.md#shared-facts-and-ordering) supersedes
the D1 publication/storage choreography for the planned migration. Immediate Price selection for
new renewals and preservation of original terms for pending attempts and renewal retries remain.
For the migration, exact shared registration fixes terms; an earlier registration may complete
within its original deadline after publication without delaying other Users. The
[background discovery decision](https://github.com/B4rz99/fidy-ai/issues/2202#issuecomment-6895944711)
supersedes the earlier wait for outstanding User admissions.
The D1 mechanics below describe the current implementation.

Weekly card renewals use the existing Cloudflare D1 outbox, Queue, Workflow and User coordinator.
Each successful period starts at its predecessor's end and advances by seven calendar days in the
captured time zone. Provider finalization authorizes settlement but never shifts renewal dates.
One unresolved collection blocks another; ambiguous submissions are reconciled without repeating
POST. Billing recovery resumes ordinary renewal processing, with no restart or separate outage flow.

An unstopped Subscription retains Pro for exactly three days after its paid boundary.
A failure never rewrites its paid history or ends grace early; expiry of grace ends that access basis.
Refund access adjustments and renewal stops exclude grace. TrialPeriod remains independent.

Price changes apply to newly admitted renewals without renewed acceptance. Trusted weekly Price
publication changes only offer selection and retains every old Price. Already-pending attempts and
bounded retries retain their original terms.

The [shared catalog decision](https://github.com/B4rz99/fidy-ai/issues/2207) supersedes automatic
Price-change notification: the operator handles announcements manually outside Fidy. Publication
creates no notice records, email work or recipient-distribution obligation, and does not wait for
an announcement. Automatic notice storage, dispatch and delivery are removed.

## Retry and cancellation policy (#236)

The User approved three-day grace for every method and billing period, with at most two retries at
24 and 48 hours after the original renewal boundary. Each retry is a new immutable BillingAttempt
with the first renewal attempt's Money, Price, source and calendar. A later published Price applies
to the next ordinary renewal, never to retry. Pending or ambiguous submissions prohibit another
collection; definitive renewal failure permits retry. No attempt, including the first renewal, is admitted or submitted at or after the original
boundary plus 72 hours. Admission and the atomic dispatch claim recheck database time so delayed
work cannot extend that window; discovery is advisory. Already-sent collections remain reconcilable
after grace and cancellation.
Verified success grants one period per renewal boundary, even when an earlier approval arrives late,
and fences any unsubmitted sibling retry. Already-submitted uncertainty still requires reconciliation.

Cancellation is an idempotent canonical mutation with write scope, required agent confirmation and
an atomic same-User stop/source detachment, accountability and collection fence. It preserves paid
access until the paid period ends, excludes grace, and never removes independent TrialPeriod access.
Provider work is separate from the atomic mutation. Card and Nequi detach locally without claiming
provider revocation. Wompi documents DaviPlata source voiding; its retained intent submits PUT once,
then verifies the same source ID/type/status with bounded GETs through the existing Queue/Workflow.
A lost PUT response cannot authorize another PUT. Unverified exhaustion remains visibly void-pending.
Historical financial facts, evidence and cancellation remain retained.

Source: [Wompi payment-source cancellation](https://docs.wompi.co/docs/colombia/fuentes-de-pago/#cuentas-daviplata).
This is development behavior; production/provider enablement remains separately gated.

Monthly and yearly periods preserve the original local calendar anchor across month-end and
leap-day clamps. Renewal execution advances by one period from the paid boundary even if
collection is late. Support correction uses Fidy attempt identities and a closed reason
vocabulary. A card void addresses the whole charge. An ambiguous submission remains pending and
continues to reserve its amount. Sandbox treatment is provisional evidence.

Claim an outbound charge before provider I/O. A crash between the claim and POST is already
ambiguous. Wompi transaction id hints from a signed callback still require an independent
bounded lookup and exact captured terms. A missing response id cannot authorize another POST.
One verified finalized approval settles the attempt; unresolved provider transactions stay
pending, and all-negative evidence waits until the provider retry window closes.

Refund and void execution starts from separately Access-authorized support and same-User
resource reservation. Durable claims prevent duplicate POST even when Workflow publication
is missed or repeated. Refund correction remains Sandbox-only under both stored and current
configuration. Read-only verification can reconcile card voids. Retain pending Money while a
refund has no verified terminal evidence. [Refund reconciliation follow-up](https://github.com/B4rz99/fidy-ai/issues/2311).
