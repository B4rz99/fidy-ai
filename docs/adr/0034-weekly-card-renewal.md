# Automatic renewal, grace, cancellation and notified Prices

- **Status:** Accepted
- **Date:** 2026-10-07
- **Issue:** #233 and #236, with the User's implementation decisions superseding conflicting historical text.

Weekly card renewals use the existing Cloudflare D1 outbox, Queue, Workflow and User coordinator.
Each successful period starts at its predecessor's end and advances by seven calendar days in the
captured time zone. Provider finalization authorizes settlement but never shifts renewal dates.
One unresolved collection blocks another; ambiguous submissions are reconciled without repeating
POST. Billing recovery resumes ordinary renewal processing, with no restart or separate outage flow.

An unstopped Subscription retains Pro for exactly three days after its paid boundary.
A failure never rewrites its paid history or ends grace early; expiry of grace ends that access basis.
Refund access adjustments and renewal stops exclude grace. TrialPeriod remains independent.

The User explicitly chose immediate Price-change notification and no renewed acceptance. Trusted
weekly Price publication changes only offer selection, retaining every old Price, and atomically
records billing-email notices for affected card Subscriptions. Publication offers these immediately;
minute Maintenance recovers missed offers. Resend acceptance is recorded as provider acceptance,
not proof of human receipt. A started ambiguous send is not automatically repeated. A definite provider rejection releases
the send claim for a later offer, preserving the same provider idempotency key. Newly admitted
renewals snapshot the currently published Price; already-pending attempts retain their prior terms.

## Retry and cancellation policy (#236)

The User approved three-day grace for every method and billing period, with at most two retries at
24 and 48 hours after the original renewal boundary. Each retry is a new immutable BillingAttempt
with the first renewal attempt's Money, Price, source and calendar. A later published Price applies
to the next ordinary renewal, never to retry. Pending or ambiguous submissions prohibit another
collection; definitive renewal failure permits retry. No retry is admitted or submitted after grace.
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
