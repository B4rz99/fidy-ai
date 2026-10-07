# Weekly card renewal, grace and notified Prices

- **Status:** Accepted
- **Date:** 2026-10-07
- **Issue:** #233, with the User's implementation decisions superseding conflicting historical text.

Weekly card renewals use the existing Cloudflare D1 outbox, Queue, Workflow and User coordinator.
Each successful period starts at its predecessor's end and advances by seven calendar days in the
captured time zone. Provider finalization authorizes settlement but never shifts renewal dates.
One unresolved collection blocks another; ambiguous submissions are reconciled without repeating
POST. Billing recovery resumes ordinary renewal processing, with no restart or separate outage flow.

An unstopped weekly card Subscription retains Pro for exactly three days after its paid boundary.
A failure never rewrites its paid history or ends grace early; expiry of grace ends that access basis.
Refund access adjustments and renewal stops exclude grace. TrialPeriod remains independent.

The User explicitly chose immediate Price-change notification and no renewed acceptance. Trusted
weekly Price publication changes only offer selection, retaining every old Price, and atomically
records billing-email notices for affected card Subscriptions. Publication offers these immediately;
minute Maintenance recovers missed offers. Resend acceptance is recorded as provider acceptance,
not proof of human receipt. A started ambiguous send is not automatically repeated. A definite provider rejection releases
the send claim for a later offer, preserving the same provider idempotency key. Newly admitted
renewals snapshot the currently published Price; already-pending attempts retain their prior terms.
Future dunning and automatic retries of definitively failed renewals remain separate product work.
