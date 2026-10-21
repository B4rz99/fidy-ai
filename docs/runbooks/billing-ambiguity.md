# Ambiguous Wompi collection

A sent BillingAttempt arm must never be rearmed or POSTed again. Wompi's
[charge-tracking API](https://docs.wompi.co/docs/colombia/seguimiento-de-transacciones/)
provides authenticated lookup by transaction ID, not merchant reference. A lost creation response
is missing evidence, not a reason to repeat collection or fabricate a checkout response.

## Recover a lost creation response

1. Identify the BillingAttempt's exact reference and provider environment in privileged D1. The
   Wompi merchant dashboard can search by reference in the matching environment. If it finds a
   transaction, retain its ID as a lookup hint. A screenshot, browser redirect, local failure or
   signed callback alone cannot authorize settlement or replacement.

2. Check retained `billing_provider_transactions` for that attempt. If Fidy already verified the
   matching transaction, use that evidence; no additional callback or provider request is needed.
   Otherwise, offer only the transaction ID to the existing reconciler through a privileged,
   parameterized D1 session:

   ```sql
   INSERT OR IGNORE INTO billing_provider_transactions(transaction_id,event_received_at_ms)
   SELECT :transaction_id, unixepoch('now') * 1000
   WHERE EXISTS (
     SELECT 1 FROM billing_attempts
     WHERE wompi_reference=:reference AND wompi_environment=:environment
       AND status IN ('pending','failed') AND collection_state='sent'
   );
   ```

   This does not associate the hint with an attempt or alter its outcome. Only the reconciler's
   authenticated provider GET, matching reference, environment, exact Money and source when
   supplied, can publish verified evidence. Do not reset an exhausted lookup budget or repeatedly
   offer a failed lookup; investigate the provider failure.

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
write-once `no_charge_*` fields on that BillingAttempt in privileged D1. This exception authorizes a
new User decision, never another POST on the sent arm. Never invent support evidence or clear
billing history. Inspect the attempt's `recovery_case_id`/`recovery_reviewed_at_ms` if later approval
contradicts that confirmation, and investigate the resulting payment/refund obligations.
