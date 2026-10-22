import { type Cause, Effect } from "effect";
/** Retain one successful Sandbox card charge, paid period, and Subscription for correction proofs. */
export const seedRefundCharge = (db: D1Database): Effect.Effect<void, Cause.UnknownError> =>
  Effect.tryPromise(() =>
    db.batch([
      db
        .prepare(
          "WITH fixture_user(id,time_zone) AS (VALUES (?, 'America/Bogota')) INSERT INTO users(id,time_zone,service_market,locale,created_at_ms) SELECT id,time_zone,'CO','es-CO',0 FROM fixture_user"
        )
        .bind("10000000-0000-4000-8000-000000000001"),
      db.prepare("INSERT OR IGNORE INTO subscriptions(id,user_id) SELECT id,id FROM users"),
      db.prepare(`INSERT INTO payment_enrollments (id,subscription_id,price_id,billing_email,status,payment_source_mode,
        contracts_json,disclosure_json,prepared_at_ms,expires_at_ms,payment_request_id,wompi_candidate_source_id,method,wompi_environment)
        VALUES ('20000000-0000-4000-8000-000000000001',(SELECT id FROM subscriptions WHERE user_id='10000000-0000-4000-8000-000000000001'),
        '22700000-0000-4000-8000-000000000001','payer@example.com','creating','create','{}','{}',0,900000,
        '50000000-0000-4000-8000-000000000001',3891,'card','sandbox')`),
      db.prepare(`INSERT INTO payment_sources(id,subscription_id,origin_enrollment_id,wompi_source_id,billing_email,verified_at_ms,method,wompi_environment,archive_row_ref)
 SELECT incoming.id,e.subscription_id,incoming.enrollment_id,incoming.wompi_source_id,incoming.billing_email,incoming.created_at_ms,incoming.method,e.wompi_environment,'source:'||incoming.id FROM (SELECT column1 AS id,column2 AS user_id,column3 AS enrollment_id,column4 AS wompi_source_id,column5 AS billing_email,column6 AS created_at_ms,column7 AS method FROM (VALUES ('30000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000001',
        '20000000-0000-4000-8000-000000000001',3891,'payer@example.com',0,'card'))) incoming
 JOIN payment_enrollments e ON e.id=incoming.enrollment_id JOIN subscriptions sub ON sub.id=e.subscription_id AND sub.user_id=incoming.user_id`),
      db.prepare("UPDATE payment_enrollments SET status='available'"),
      db.prepare(
        `INSERT INTO billing_attempts (id, subscription_id, enrollment_id, payment_request_id, payment_source_id, price_id, time_zone, wompi_environment, wompi_reference, created_at_ms) VALUES ('40000000-0000-4000-8000-000000000001', (SELECT id FROM subscriptions WHERE user_id='10000000-0000-4000-8000-000000000001'), '20000000-0000-4000-8000-000000000001', '50000000-0000-4000-8000-000000000001', '30000000-0000-4000-8000-000000000001', '22700000-0000-4000-8000-000000000001', 'America/Bogota', 'sandbox', 'fidy-test', 0)`
      ),
      db.prepare(`INSERT INTO billing_provider_transactions (transaction_id,attempt_id,status,first_observed_at_ms,finalized_at_ms)
        VALUES ('provider-charge','40000000-0000-4000-8000-000000000001','APPROVED',0,1)`),
      db.prepare(
        "UPDATE billing_attempts SET status='succeeded',finalized_at_ms=1 WHERE id='40000000-0000-4000-8000-000000000001'"
      ),
      db.prepare(
        "UPDATE billing_attempts SET paid_starts_at_ms=incoming.starts_at_ms,paid_ends_at_ms=incoming.ends_at_ms,paid_renewal_anchor_ms=incoming.renewal_anchor_ms FROM (SELECT '40000000-0000-4000-8000-000000000001' AS attempt_id,1 AS starts_at_ms,9999999999999 AS ends_at_ms,9999999999999 AS renewal_anchor_ms) AS incoming WHERE billing_attempts.id=incoming.attempt_id AND billing_attempts.paid_starts_at_ms IS NULL"
      ),
      db.prepare(
        "UPDATE subscriptions SET current_paid_attempt_id='40000000-0000-4000-8000-000000000001' WHERE user_id='10000000-0000-4000-8000-000000000001'"
      ),
    ])
  ).pipe(Effect.asVoid);
