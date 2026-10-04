import { type Cause, Effect } from "effect";

/** Retain one successful Sandbox card charge, paid period, and Subscription for correction proofs. */
export const seedRefundCharge = (db: D1Database): Effect.Effect<void, Cause.UnknownError> =>
  Effect.tryPromise(() =>
    db.batch([
      db
        .prepare("INSERT INTO users VALUES (?, 'America/Bogota')")
        .bind("10000000-0000-4000-8000-000000000001"),
      db.prepare(`INSERT INTO card_enrollments (id,user_id,price_id,billing_email,status,payment_source_mode,
        contracts_json,disclosure_json,prepared_at_ms,expires_at_ms,payment_request_id,wompi_candidate_source_id,method,wompi_environment)
        VALUES ('20000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000001',
        '22700000-0000-4000-8000-000000000001','payer@example.com','creating','create','{}','{}',0,900000,
        '50000000-0000-4000-8000-000000000001',3891,'card','sandbox')`),
      db.prepare(`INSERT INTO card_payment_sources (id,user_id,enrollment_id,wompi_source_id,billing_email,created_at_ms,method)
        VALUES ('30000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000001',
        '20000000-0000-4000-8000-000000000001',3891,'payer@example.com',0,'card')`),
      db.prepare("UPDATE card_enrollments SET status='available'"),
      db.prepare(`INSERT INTO billing_attempts (id,user_id,enrollment_id,payment_request_id,payment_source_id,price_id,
        amount,currency,billing_period,service_market,tax_treatment,time_zone,wompi_environment,wompi_reference,created_at_ms)
        VALUES ('40000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000001',
        '20000000-0000-4000-8000-000000000001','50000000-0000-4000-8000-000000000001',
        '30000000-0000-4000-8000-000000000001','22700000-0000-4000-8000-000000000001',
        '9900','COP','weekly','CO','not-taxable','America/Bogota','sandbox','fidy-test',0)`),
      db.prepare(`INSERT INTO billing_transaction_evidence (transaction_id,attempt_id,status,first_observed_at_ms,finalized_at_ms)
        VALUES ('provider-charge','40000000-0000-4000-8000-000000000001','APPROVED',0,1)`),
      db.prepare(
        "UPDATE billing_attempts SET status='succeeded',finalized_at_ms=1 WHERE id='40000000-0000-4000-8000-000000000001'"
      ),
      db.prepare(
        "INSERT INTO billing_paid_periods VALUES ('40000000-0000-4000-8000-000000000001',1,9999999999999,9999999999999)"
      ),
      db.prepare(
        "INSERT INTO subscriptions VALUES ('10000000-0000-4000-8000-000000000001','40000000-0000-4000-8000-000000000001','22700000-0000-4000-8000-000000000001',9999999999999,9999999999999)"
      ),
    ])
  ).pipe(Effect.asVoid);
