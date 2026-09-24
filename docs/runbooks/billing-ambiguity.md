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

2. Ask Wompi merchant support to locate the charge for the exact reference and environment. If it exists, obtain its transaction ID. A timeout, `404` against an unknown ID, lack of callback, or a verified negative alone does **not** confirm that no charge can later be approved. Until support definitively confirms no charge, a different checkout for this User stays blocked.

   If support confirms **no charge exists**, retain its case ID and the accountable operator ID, then insert an append-only confirmation in a privileged, parameterized D1 session. Bind `:attempt_id`, `:reference`, `:environment`, `:provider_case_id`, and `:operator_id` to the exact investigation. The database rejects unsent arms and mismatched facts. This does not change the BillingAttempt's verified outcome or permit another POST on its sent arm; it only permits a _new User-authorized_ PaymentRequestId. Check `billing_recovery_reviews` for a later verified approval; investigate any subsequent collection and refund where needed:

   ```sql
   INSERT INTO billing_no_charge_confirmations
     (attempt_id, wompi_reference, wompi_environment, provider_case_id, operator_id, confirmed_at_ms)
   VALUES (:attempt_id, :reference, :environment, :provider_case_id, :operator_id,
     unixepoch('now') * 1000);
   ```

3. If support provides an ID, in a privileged, parameterized D1 session, insert the **ID only as a lookup hint**. Bind `:transaction_id` to Wompi's ID and `:reference` to the checkout reference recorded above. Do not interpolate either value into SQL:

   ```sql
   INSERT OR IGNORE INTO billing_event_candidates (transaction_id, received_at_ms)
   SELECT :transaction_id, unixepoch('now') * 1000
   WHERE EXISTS (
     SELECT 1 FROM billing_attempts AS a
     JOIN billing_collection_arms AS arm ON arm.attempt_id = a.id
     WHERE a.wompi_reference = :reference AND a.status IN ('pending', 'failed') AND arm.state = 'sent'
   );
   ```

   If a previous callback already inserted this ID and all eight bounded lookups failed during a Wompi outage, renew **only this confirmed hint** (including when `INSERT OR IGNORE` found an existing row). This does not rearm the POST:

   ```sql
   UPDATE billing_event_candidates
   SET received_at_ms = unixepoch('now') * 1000,
       last_checked_at_ms = NULL, lookup_attempts = 0, resolved_at_ms = NULL
   WHERE transaction_id = :transaction_id
     AND EXISTS (
       SELECT 1 FROM billing_attempts AS a
       JOIN billing_collection_arms AS arm ON arm.attempt_id = a.id
       WHERE a.wompi_reference = :reference AND a.status IN ('pending', 'failed') AND arm.state = 'sent'
     );
   ```

4. The scheduled reconciler starts `lookup-wompi-billing-v1`. Only its authenticated provider GET, matching the stored reference, environment, amount, and currency (plus source when Wompi returns it), can settle the BillingAttempt in the Subscription-owned D1 atomic unit. Check `billing_transaction_evidence`, `billing_attempts`, `billing_audit`, and `subscriptions` for the outcome. If the provider ID is wrong or GET is unavailable, no settlement occurs; investigate rather than re-collecting.

If neither a callback nor Wompi support can establish an ID **or** definitively confirm no charge, the outcome remains ambiguous and the original BillingAttempt remains pending. The User cannot initiate another collection until the original succeeds or the attributable no-charge confirmation is recorded. Never retry the sent arm.
