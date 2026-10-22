# Ambiguous Wompi collection

A sent BillingAttempt arm must never be rearmed or POSTed again. Wompi's
[charge-tracking API](https://docs.wompi.co/docs/colombia/seguimiento-de-transacciones/)
provides authenticated lookup by transaction ID, not merchant reference. A lost creation response
is missing evidence, not a reason to repeat collection or fabricate a checkout response.

## Recover a lost creation response

1. Identify the BillingAttempt's exact reference and provider environment in privileged D1. The
   Wompi merchant dashboard can search by reference in the matching environment. If it finds a
   transaction, retain its ID as investigation context. A screenshot, browser redirect, local failure or
   signed callback alone cannot authorize settlement or replacement.

2. Check retained `billing_provider_transactions` for that attempt. If Fidy already verified the
   matching transaction, use that evidence; no additional callback or provider request is needed.
   The automatic reconciler discovers retained pending transaction candidates and authenticated
   callback hints. Its authenticated provider GET must match reference, environment, exact Money
   and source when supplied before publishing verified evidence. The signed callback store is not
   an unsigned operator ingress: do not invent callback metadata, bind an unverified ID to an
   attempt, or copy dashboard status into provider evidence. If the discovered ID has no supported
   retained lookup path, escalate for a reviewed authenticated lookup or support investigation.
   Do not reset an exhausted lookup budget or repeatedly offer a failed lookup.

3. A failed, sent BillingAttempt qualifies for `billing_retry_clearances` when exactly one retained
   transaction has a verified `DECLINED` status and finalization no later than the attempt's failure,
   the existing three-minute retry opportunity elapsed after the negative observation, and no paid
   period exists. If an original checkout transaction ID was captured, it must match. Losing that
   original response no longer requires support when these conditions hold. The original response
   remains absent; recovery never rewrites its provenance.

4. The User must explicitly authorize a new PaymentEnrollment/PaymentRequestId and its terms. Card
   replacement preserves the original source, BillingAttempt and provider evidence. The atomic
   retirement guard checks every attempt on the source and rejects pending, approved, conflicting,
   unverified or uncleared work; active or cancelled paid Subscription history also blocks retirement.
   Later verified approval retains the ordinary success/paid-period reconciliation path.

## When support is still needed

An empty dashboard search, unknown ID, timeout, missing finalization, provider error or local
`failed` state does not prove a final decline. Keep collection and replacement blocked until verified
outcomes resolve the uncertainty. Ask Wompi merchant support only when dashboard lookup and the
reconciler cannot resolve it.

If support explicitly confirms no charge exists for the exact reference/environment and cannot
later approve, retain its genuine case ID and accountable operator before recording the guarded,
write-once `no_charge_case_id`, `no_charge_operator_id` and `no_charge_confirmed_at_ms` fields on that BillingAttempt in privileged D1. This exception authorizes a
new User decision, never another POST on the sent arm. Never invent support evidence or clear
billing history. Match the operator's reviewed reference/environment against the immutable attempt
in the same guarded write; those identities are derived rather than copied into no-charge evidence.
Inspect `no_charge_case_id` and `late_approval_observed_at_ms` if later approval contradicts that
confirmation, and investigate the resulting payment/refund obligations.
