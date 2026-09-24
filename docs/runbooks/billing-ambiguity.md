# Ambiguous Wompi collection

A sent BillingAttempt arm **must never be rearmed or POSTed again**. Wompi's [charge-tracking API](https://docs.wompi.co/docs/colombia/seguimiento-de-transacciones/) documents lookup by transaction ID, not merchant reference. A lost POST response with no callback therefore cannot be resolved automatically by reference. Keep the BillingAttempt pending until verified evidence arrives.

## Recover without a callback

1. In the privileged D1 console, identify the pending BillingAttempt and its checkout reference. Never use a browser redirect or an unverified transaction ID as settlement authority:

   ```sql
   SELECT a.id, a.user_id, a.wompi_reference, a.wompi_environment, arm.sent_at_ms
   FROM billing_attempts AS a
   JOIN billing_collection_arms AS arm ON arm.attempt_id = a.id
   WHERE a.status = 'pending' AND arm.state = 'sent'
     AND NOT EXISTS (SELECT 1 FROM billing_transaction_candidates AS c WHERE c.attempt_id = a.id);
   ```

2. Ask Wompi merchant support to locate the charge for the exact reference and environment. If it exists, obtain its transaction ID. If Wompi confirms that **no charge exists**, leave the old arm sent; the User may initiate a new checkout with a new PaymentRequestId. Never infer absence from a timeout, `404` against an unknown ID, or lack of a callback.
3. In a privileged, parameterized D1 session, insert the **ID only as a lookup hint**. Bind `:transaction_id` to Wompi's ID and `:reference` to the checkout reference recorded above. Do not interpolate either value into SQL:

   ```sql
   INSERT OR IGNORE INTO billing_event_candidates (transaction_id, received_at_ms)
   SELECT :transaction_id, unixepoch('now') * 1000
   WHERE EXISTS (
     SELECT 1 FROM billing_attempts AS a
     JOIN billing_collection_arms AS arm ON arm.attempt_id = a.id
     WHERE a.wompi_reference = :reference AND a.status = 'pending' AND arm.state = 'sent'
   );
   ```

4. The scheduled reconciler starts `lookup-wompi-billing-v1`. Only its authenticated provider GET, matching the stored reference, environment, amount, and currency (plus source when Wompi returns it), can settle the BillingAttempt in the Subscription-owned D1 atomic unit. Check `billing_transaction_evidence`, `billing_attempts`, `billing_audit`, and `subscriptions` for the outcome. If the provider ID is wrong or GET is unavailable, no settlement occurs; investigate rather than re-collecting.

This path requires Wompi to supply the transaction ID. If neither a callback nor Wompi support can establish one, the outcome remains ambiguous and the original BillingAttempt remains pending. The safe recovery is a fresh User-authorized checkout, never a retry of the sent arm.
