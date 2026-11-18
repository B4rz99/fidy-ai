/** Preserve the original adjustment record while installing sandbox refund intent, claims and verified settlement. */
export const refundSchema: ReadonlyArray<string> = [
  `ALTER TABLE refund_attempts ADD COLUMN intent_json TEXT CHECK(intent_json IS NULL OR json_valid(intent_json))`,
  `ALTER TABLE refund_attempts ADD COLUMN user_id TEXT GENERATED ALWAYS AS (json_extract(intent_json,'$.userId')) VIRTUAL REFERENCES users(id)`,
  `ALTER TABLE refund_attempts ADD COLUMN request_id TEXT GENERATED ALWAYS AS (json_extract(intent_json,'$.requestId')) VIRTUAL`,
  `ALTER TABLE refund_attempts ADD COLUMN kind TEXT GENERATED ALWAYS AS (json_extract(intent_json,'$.intent.kind')) VIRTUAL`,
  `ALTER TABLE refund_attempts ADD COLUMN treatment_json TEXT CHECK(treatment_json IS NULL OR json_valid(treatment_json))`,
  `ALTER TABLE refund_attempts ADD COLUMN transaction_id TEXT REFERENCES billing_provider_transactions(transaction_id)`,
  `ALTER TABLE refund_attempts ADD COLUMN wompi_environment TEXT CHECK(wompi_environment='sandbox')`,
  `ALTER TABLE refund_attempts ADD COLUMN amount_in_cents INTEGER CHECK(amount_in_cents BETWEEN 1 AND 9007199254740991)`,
  `ALTER TABLE refund_attempts ADD COLUMN operator_id TEXT CHECK(length(operator_id) BETWEEN 1 AND 128)`,
  `ALTER TABLE refund_attempts ADD COLUMN created_at_ms INTEGER`,
  `ALTER TABLE refund_attempts ADD COLUMN status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','succeeded','failed'))`,
  `ALTER TABLE refund_attempts ADD COLUMN progress TEXT NOT NULL DEFAULT 'queued' CHECK(progress IN ('queued','verifying','outcome-unknown'))`,
  `ALTER TABLE refund_attempts ADD COLUMN finalized_at_ms INTEGER`,
  `ALTER TABLE refund_attempts ADD COLUMN failure TEXT CHECK(failure IN ('provider-declined','provider-cancelled','provider-refused'))`,
  `ALTER TABLE refund_attempts ADD COLUMN dispatch_last_attempt_at_ms INTEGER`,
  `ALTER TABLE refund_attempts ADD COLUMN verification_attempts INTEGER NOT NULL DEFAULT 0 CHECK(verification_attempts BETWEEN 0 AND 8)`,
  `ALTER TABLE refund_attempts ADD COLUMN last_verification_at_ms INTEGER`,
  `ALTER TABLE refund_attempts ADD COLUMN submission_claimed_at_ms INTEGER`,
  `ALTER TABLE refund_attempts ADD COLUMN provider_refund_id TEXT`,
  `ALTER TABLE refund_attempts ADD COLUMN verified_status TEXT CHECK(verified_status IN ('APPROVED','DECLINED','CANCELLED','VOIDED'))`,
  `ALTER TABLE refund_attempts ADD COLUMN observed_at_ms INTEGER`,
  `ALTER TABLE refund_attempts ADD COLUMN renewal_stopped_at_ms INTEGER`,
  `CREATE UNIQUE INDEX refund_request ON refund_attempts(user_id,request_id)`,
  `CREATE UNIQUE INDEX refund_provider_identity ON refund_attempts(wompi_environment,provider_refund_id)`,
  `CREATE INDEX refund_offer_due ON refund_attempts(status,progress,dispatch_last_attempt_at_ms) WHERE intent_json IS NOT NULL`,
  `CREATE VIEW refund_charge_context AS
SELECT a.*,CAST(substr(a.amount,1,instr(a.amount||'.','.')-1) AS INTEGER)*100
  +CAST(substr(substr(a.amount,instr(a.amount||'.','.')+1)||'00',1,2) AS INTEGER) AS original_cents
FROM billing_attempt_context a
WHERE original_cents BETWEEN 1 AND 9007199254740991
  AND a.currency='COP' AND length(a.amount) BETWEEN 1 AND 17
  AND a.amount NOT GLOB '*[^0-9.]*'
  AND length(a.amount)-length(replace(a.amount,'.',''))<=1
  AND length(substr(a.amount,1,instr(a.amount||'.','.')-1)) BETWEEN 1 AND 14
  AND (instr(a.amount,'.')=0 OR length(a.amount)-instr(a.amount,'.') BETWEEN 1 AND 2)
  AND (length(substr(a.amount,1,instr(a.amount||'.','.')-1))=1 OR substr(a.amount,1,1)<>'0')`,
  `CREATE VIEW refund_attempt_context AS
SELECT r.rowid,r.*,a.subscription_id,a.price_id,a.currency,a.original_cents,
 CASE WHEN r.access_ends_at_ms IS NOT NULL THEN r.billing_attempt_id END AS adjusted_attempt_id,
 CASE WHEN r.renewal_stopped_at_ms IS NOT NULL THEN r.user_id END AS renewal_stopped_user_id
FROM refund_attempts r JOIN refund_charge_context a ON a.id=r.billing_attempt_id`,
  `CREATE TRIGGER refund_acceptance_limit BEFORE INSERT ON refund_attempts
WHEN (SELECT COUNT(*) FROM refund_attempts WHERE user_id=NEW.user_id AND status='pending')>=4
 OR (SELECT COUNT(*) FROM refund_attempts WHERE user_id=NEW.user_id
   AND created_at_ms>NEW.created_at_ms-3600000)>=12
BEGIN
 SELECT RAISE(IGNORE);
END`,
  `CREATE TRIGGER refund_claim_immutable BEFORE UPDATE OF submission_claimed_at_ms ON refund_attempts
WHEN OLD.submission_claimed_at_ms IS NOT NULL AND (NEW.submission_claimed_at_ms IS NOT OLD.submission_claimed_at_ms)
BEGIN
 SELECT RAISE(ABORT, 'refund_claim_immutable');
END`,
  `CREATE TRIGGER refund_claim_requires_pending BEFORE UPDATE OF submission_claimed_at_ms ON refund_attempts
WHEN OLD.submission_claimed_at_ms IS NULL AND NEW.submission_claimed_at_ms IS NOT NULL AND (NOT EXISTS (SELECT 1 FROM refund_attempts r
  JOIN billing_attempt_context a ON a.id=r.billing_attempt_id
  JOIN billing_provider_transactions e ON e.transaction_id=r.transaction_id AND e.attempt_id=a.id
  WHERE r.id=NEW.id AND r.status='pending' AND a.status='succeeded'
    AND a.wompi_environment='sandbox' AND e.status='APPROVED'
    AND (SELECT COUNT(*) FROM billing_provider_transactions AS billing_transaction_evidence
      WHERE attempt_id=a.id AND status='APPROVED')=1))
BEGIN
 SELECT RAISE(IGNORE);
END`,
  `CREATE TRIGGER refund_companions_initial BEFORE INSERT ON refund_attempts WHEN NEW.intent_json IS NOT NULL AND (NEW.dispatch_last_attempt_at_ms IS NOT NULL OR NEW.verification_attempts IS NOT 0 OR NEW.last_verification_at_ms IS NOT NULL OR NEW.submission_claimed_at_ms IS NOT NULL OR NEW.verified_status IS NOT NULL OR NEW.access_ends_at_ms IS NOT NULL OR NEW.renewal_stopped_at_ms IS NOT NULL) BEGIN SELECT RAISE(ABORT,'refund_companions_initial'); END`,
  `CREATE TRIGGER refund_evidence_immutable BEFORE UPDATE OF provider_refund_id,verified_status,observed_at_ms ON refund_attempts
WHEN OLD.verified_status IS NOT NULL AND (NEW.provider_refund_id IS NOT OLD.provider_refund_id OR NEW.verified_status IS NOT OLD.verified_status OR NEW.observed_at_ms IS NOT OLD.observed_at_ms)
BEGIN
 SELECT RAISE(ABORT, 'refund_evidence_immutable');
END`,
  `CREATE TRIGGER refund_evidence_requires_claim BEFORE UPDATE OF provider_refund_id,verified_status,observed_at_ms ON refund_attempts
WHEN OLD.verified_status IS NULL AND NEW.verified_status IS NOT NULL AND (NOT EXISTS (SELECT 1 FROM refund_attempts r JOIN (SELECT rowid,id AS refund_id,submission_claimed_at_ms AS claimed_at_ms FROM refund_attempts WHERE submission_claimed_at_ms IS NOT NULL) c ON c.refund_id=r.id
  WHERE r.id=NEW.id AND r.status='pending' AND NEW.observed_at_ms>=r.created_at_ms
    AND ((r.kind='refund' AND NEW.verified_status IN ('APPROVED','DECLINED','CANCELLED'))
      OR (r.kind='card-void' AND NEW.verified_status='VOIDED'))))
BEGIN
 SELECT RAISE(ABORT, 'refund_evidence_invalid_claim');
END`,
  `CREATE TRIGGER refund_reservation_guard BEFORE INSERT ON refund_attempts
WHEN NEW.intent_json IS NOT NULL AND (NOT EXISTS (SELECT 1 FROM billing_attempt_context a
  JOIN billing_provider_transactions e ON e.attempt_id=a.id
  JOIN payment_source_context p ON p.id=a.payment_source_id
  WHERE a.id=NEW.billing_attempt_id AND a.user_id=NEW.user_id AND a.wompi_environment=NEW.wompi_environment
    AND a.status='succeeded' AND a.wompi_environment='sandbox' AND a.currency='COP'
    AND e.transaction_id=NEW.transaction_id AND e.status='APPROVED'
    AND (NEW.kind='refund' OR p.method='card')
    AND (SELECT COUNT(*) FROM billing_provider_transactions AS billing_transaction_evidence WHERE attempt_id=a.id AND status='APPROVED')=1)
  OR NEW.amount_in_cents > (SELECT original_cents FROM refund_charge_context WHERE id=NEW.billing_attempt_id) - COALESCE((SELECT SUM(amount_in_cents)
    FROM refund_attempts WHERE billing_attempt_id=NEW.billing_attempt_id AND status<>'failed'),0)
  OR NOT EXISTS (SELECT 1 FROM refund_charge_context a WHERE a.id=NEW.billing_attempt_id)
  OR (NEW.kind='card-void' AND NEW.amount_in_cents<>(SELECT original_cents FROM refund_charge_context WHERE id=NEW.billing_attempt_id)) )
BEGIN
 SELECT RAISE(IGNORE);
END`,
  `CREATE TRIGGER refund_snapshot_immutable BEFORE UPDATE ON refund_attempts
WHEN NEW.id<>OLD.id OR NEW.user_id<>OLD.user_id
 OR NEW.billing_attempt_id<>OLD.billing_attempt_id OR NEW.transaction_id<>OLD.transaction_id OR NEW.wompi_environment<>OLD.wompi_environment
 OR NEW.request_id<>OLD.request_id OR NEW.intent_json<>OLD.intent_json OR NEW.treatment_json<>OLD.treatment_json
 OR NEW.amount_in_cents<>OLD.amount_in_cents
 OR NEW.kind<>OLD.kind OR NEW.operator_id<>OLD.operator_id OR NEW.created_at_ms<>OLD.created_at_ms
 OR (OLD.status<>'pending' AND (NEW.status<>OLD.status OR NEW.finalized_at_ms IS NOT OLD.finalized_at_ms
   OR NEW.failure IS NOT OLD.failure OR NEW.progress<>OLD.progress))
BEGIN
 SELECT RAISE(ABORT, 'refund_history_immutable');
END`,
  `CREATE TRIGGER refund_verified_settlement AFTER UPDATE OF provider_refund_id,verified_status,observed_at_ms ON refund_attempts
WHEN OLD.verified_status IS NULL AND NEW.verified_status IS NOT NULL
BEGIN
 UPDATE refund_attempts SET status=CASE WHEN NEW.verified_status IN ('APPROVED','VOIDED')
    THEN 'succeeded' ELSE 'failed' END, finalized_at_ms=NEW.observed_at_ms,
    failure=CASE NEW.verified_status WHEN 'DECLINED' THEN 'provider-declined'
      WHEN 'CANCELLED' THEN 'provider-cancelled' ELSE NULL END
    WHERE id=NEW.id AND status='pending';
 UPDATE refund_attempts SET access_ends_at_ms=incoming.ends_at_ms FROM (SELECT id AS refund_id,billing_attempt_id AS attempt_id,NEW.observed_at_ms AS ends_at_ms FROM refund_attempts
    WHERE id=NEW.id AND status='succeeded') AS incoming WHERE refund_attempts.id=incoming.refund_id AND refund_attempts.access_ends_at_ms IS NULL;
 UPDATE refund_attempts SET renewal_stopped_at_ms=incoming.stopped_at_ms FROM (SELECT id AS refund_id,user_id AS user_id,NEW.observed_at_ms AS stopped_at_ms FROM refund_attempts
    WHERE id=NEW.id AND status='succeeded') AS incoming WHERE refund_attempts.id=incoming.refund_id AND refund_attempts.renewal_stopped_at_ms IS NULL;
 INSERT OR IGNORE INTO subscription_renewal_fences(user_id) SELECT user_id FROM refund_attempts WHERE id=NEW.id AND status='succeeded';
 UPDATE billing_attempts SET followup_due_at_ms=NULL WHERE id=NEW.billing_attempt_id AND EXISTS(SELECT 1 FROM refund_attempts WHERE id=NEW.id AND status='succeeded');
END`,
];
