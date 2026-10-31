-- Historical populated migration rehearsals. Each named block executes independently.

-- email-counter-copy:start
INSERT INTO resource_admission_counters
  (rowid,policy_key,scope_key,window_kind,window_start_ms,window_ends_ms,used,last_work_id,owner_user_id)
SELECT rowid,
  CASE kind WHEN 'pairing' THEN 'email.pairing.user.v1'
    WHEN 'pairing-global' THEN 'email.pairing.global.v1'
    WHEN 'replacement' THEN 'email.replacement.user.v1' END,
  CASE WHEN kind='pairing-global' THEN 'global' ELSE user_id END,
  'anchored',window_started_at_ms,
  window_started_at_ms+CASE WHEN kind='replacement' THEN 86400000 ELSE 3600000 END,
  requests,last_work_id,user_id
FROM email_security_limits;

INSERT INTO sql_assertions(scope,accepted)
SELECT 'email_counter_cutover',CASE WHEN
  (SELECT count(*) FROM email_security_limits)=(SELECT count(*) FROM resource_admission_counters)
  AND NOT EXISTS (
    SELECT 1 FROM email_security_limits old
    LEFT JOIN resource_admission_counters next ON next.rowid=old.rowid
    WHERE next.rowid IS NULL OR next.owner_user_id IS NOT old.user_id
      OR next.used IS NOT old.requests OR next.last_work_id IS NOT old.last_work_id
      OR next.window_start_ms IS NOT old.window_started_at_ms
      OR next.window_ends_ms IS NOT (old.window_started_at_ms+
        CASE WHEN old.kind='replacement' THEN 86400000 ELSE 3600000 END)
  ) AND NOT EXISTS(SELECT 1 FROM pragma_foreign_key_check)
  THEN 1 ELSE 0 END
ON CONFLICT(scope) DO UPDATE SET accepted=excluded.accepted;
DELETE FROM sql_assertions WHERE scope='email_counter_cutover';
DROP TABLE email_security_limits;
-- email-counter-copy:end

-- pat-admission-copy:start
INSERT INTO sql_assertions(scope,accepted)
SELECT 'pat_admission_cutover',CASE WHEN NOT EXISTS(SELECT 1 FROM erasure_chunk)
 AND NOT EXISTS(SELECT 1 FROM pragma_foreign_key_check)
 AND NOT EXISTS(SELECT 1 FROM resource_admission_events WHERE policy_key='pat.review.session.v1')
 AND NOT EXISTS(SELECT 1 FROM resource_admission_counters WHERE policy_key='pat.pairing.source.v1')
 THEN 1 ELSE 0 END ON CONFLICT(scope) DO UPDATE SET accepted=excluded.accepted;

INSERT INTO resource_admission_counters_next
 (rowid,policy_key,scope_key,window_kind,window_start_ms,window_ends_ms,used,last_work_id,owner_user_id)
SELECT rowid,policy_key,scope_key,window_kind,window_start_ms,window_ends_ms,used,last_work_id,owner_user_id
FROM resource_admission_counters;
INSERT INTO resource_admission_counters_next
 (policy_key,scope_key,window_kind,window_start_ms,window_ends_ms,used)
SELECT 'pat.pairing.source.v1',lower(hex(source_digest)),'anchored',window_start_ms,
 window_start_ms+600000,started_count FROM pat_pairing_admission;

INSERT INTO resource_admission_events_next
 (rowid,grant_id,policy_key,dimension,scope_key,policy_kind,units,admitted_at_epoch_ms,
 window_start_epoch_ms,expires_at_epoch_ms,released_at_epoch_ms)
SELECT rowid,grant_id,policy_key,dimension,scope_key,policy_kind,units,admitted_at_epoch_ms,
 window_start_epoch_ms,expires_at_epoch_ms,released_at_epoch_ms FROM resource_admission_events;
INSERT INTO resource_admission_events_next
 (grant_id,policy_key,dimension,scope_key,policy_kind,units,admitted_at_epoch_ms,
 window_start_epoch_ms,expires_at_epoch_ms,owner_user_id,owner_session_id)
SELECT r.id,'pat.review.session.v1','source',r.session_id,'rolling_window',1,r.occurred_at_ms,
 max(0,r.occurred_at_ms-600000),r.occurred_at_ms+600000,s.user_id,r.session_id
FROM pat_review_attempts r JOIN web_sessions s ON s.id=r.session_id;

INSERT INTO sql_assertions(scope,accepted)
SELECT 'pat_admission_cutover',CASE WHEN
 (SELECT count(*) FROM resource_admission_events_next)=
 (SELECT count(*) FROM resource_admission_events)+(SELECT count(*) FROM pat_review_attempts)
 AND (SELECT count(*) FROM resource_admission_counters_next)=
 (SELECT count(*) FROM resource_admission_counters)+(SELECT count(*) FROM pat_pairing_admission)
 AND NOT EXISTS(SELECT 1 FROM pat_review_attempts r
  LEFT JOIN resource_admission_events_next n ON n.grant_id=r.id AND n.policy_key='pat.review.session.v1'
  LEFT JOIN web_sessions s ON s.id=r.session_id
  WHERE n.grant_id IS NULL OR n.owner_session_id IS NOT r.session_id OR n.owner_user_id IS NOT s.user_id
   OR n.admitted_at_epoch_ms IS NOT r.occurred_at_ms OR n.expires_at_epoch_ms IS NOT r.occurred_at_ms+600000)
 AND NOT EXISTS(SELECT 1 FROM pat_pairing_admission r
  LEFT JOIN resource_admission_counters_next n ON n.policy_key='pat.pairing.source.v1' AND n.scope_key=lower(hex(r.source_digest))
  WHERE n.scope_key IS NULL OR n.used IS NOT r.started_count OR n.window_start_ms IS NOT r.window_start_ms
   OR n.window_ends_ms IS NOT r.window_start_ms+600000)
 THEN 1 ELSE 0 END ON CONFLICT(scope) DO UPDATE SET accepted=excluded.accepted;

DROP TRIGGER resource_admission_require_every_claim;
DROP TABLE pat_review_attempts;
DROP TABLE pat_pairing_admission;
DROP TABLE resource_admission_events;
DROP TABLE resource_admission_counters;
ALTER TABLE resource_admission_events_next RENAME TO resource_admission_events;
ALTER TABLE resource_admission_counters_next RENAME TO resource_admission_counters;
-- pat-admission-copy:end

-- pat-admission-grants:start
INSERT INTO resource_admission_grants(id,admitted_at_epoch_ms,claim_count)
SELECT grant_id,admitted_at_epoch_ms,1 FROM resource_admission_events WHERE policy_key='pat.review.session.v1';
INSERT INTO sql_assertions(scope,accepted)
SELECT 'pat_admission_cutover',CASE WHEN NOT EXISTS(SELECT 1 FROM pragma_foreign_key_check)
 AND NOT EXISTS(SELECT 1 FROM resource_admission_events e
  WHERE e.policy_key='pat.review.session.v1' AND NOT EXISTS(
   SELECT 1 FROM web_sessions s WHERE s.id=e.owner_session_id AND s.user_id=e.owner_user_id))
 THEN 1 ELSE 0 END ON CONFLICT(scope) DO UPDATE SET accepted=excluded.accepted;
DELETE FROM sql_assertions WHERE scope='pat_admission_cutover';
-- pat-admission-grants:end

-- compaction-counter-copy:start
INSERT INTO sql_assertions(scope,accepted)
SELECT 'compaction_counter_cutover',CASE WHEN
 NOT EXISTS(SELECT 1 FROM erasure_chunk)
 AND NOT EXISTS(SELECT 1 FROM pragma_foreign_key_check)
 AND NOT EXISTS(SELECT 1 FROM resource_admission_counters WHERE policy_key='hosted.compaction.user.v1')
 AND NOT EXISTS(SELECT 1 FROM erasure_requests q WHERE q.restoring=1 OR
   (q.state<>'Complete' AND EXISTS(SELECT 1 FROM hosted_compaction_attempts r WHERE r.user_id=q.user_id)))
 THEN 1 ELSE 0 END ON CONFLICT(scope) DO UPDATE SET accepted=excluded.accepted;

INSERT INTO resource_admission_counters_next
 (rowid,policy_key,scope_key,window_kind,window_start_ms,window_ends_ms,used,last_work_id,owner_user_id)
SELECT rowid,policy_key,scope_key,window_kind,window_start_ms,window_ends_ms,used,last_work_id,owner_user_id
FROM resource_admission_counters;
INSERT INTO resource_admission_counters_next
 (rowid,policy_key,scope_key,window_kind,window_start_ms,window_ends_ms,used,owner_user_id)
SELECT r.rowid+(SELECT coalesce(max(rowid),0) FROM resource_admission_counters),
 'hosted.compaction.user.v1',r.user_id,'calendar',r.day_ms,r.day_ms+86400000,r.used,r.user_id
FROM hosted_compaction_attempts r;

INSERT INTO sql_assertions(scope,accepted)
SELECT 'compaction_counter_cutover',CASE WHEN
 (SELECT count(*) FROM resource_admission_counters_next)=
 (SELECT count(*) FROM resource_admission_counters)+(SELECT count(*) FROM hosted_compaction_attempts)
 AND NOT EXISTS(SELECT 1 FROM hosted_compaction_attempts r
  LEFT JOIN resource_admission_counters_next n ON n.policy_key='hosted.compaction.user.v1'
   AND n.scope_key=r.user_id AND n.window_start_ms=r.day_ms
  WHERE n.scope_key IS NULL OR n.owner_user_id IS NOT r.user_id OR n.used IS NOT r.used
   OR n.window_ends_ms IS NOT r.day_ms+86400000)
 THEN 1 ELSE 0 END ON CONFLICT(scope) DO UPDATE SET accepted=excluded.accepted;

DROP TABLE hosted_compaction_attempts;
DROP TABLE resource_admission_counters;
ALTER TABLE resource_admission_counters_next RENAME TO resource_admission_counters;
-- compaction-counter-copy:end

-- compaction-counter-verify:start
INSERT INTO sql_assertions(scope,accepted)
SELECT 'compaction_counter_cutover',CASE WHEN NOT EXISTS(SELECT 1 FROM pragma_foreign_key_check)
 THEN 1 ELSE 0 END ON CONFLICT(scope) DO UPDATE SET accepted=excluded.accepted;
DELETE FROM sql_assertions WHERE scope='compaction_counter_cutover';
-- compaction-counter-verify:end

-- audit-retention-permit-cutover:start
INSERT INTO sql_assertions(scope,accepted)
SELECT 'audit_retention_cutover',CASE WHEN
 NOT EXISTS(SELECT 1 FROM users WHERE audit_retention_cutoff_ms IS NOT NULL)
 AND NOT EXISTS(SELECT 1 FROM erasure_chunk)
 AND NOT EXISTS(SELECT 1 FROM pragma_foreign_key_check)
 THEN 1 ELSE 0 END ON CONFLICT(scope) DO UPDATE SET accepted=excluded.accepted;
DROP TRIGGER audit_entries_no_delete;
DROP TRIGGER erasure_fence_audit_retention_permits_insert;
DROP TRIGGER erasure_fence_audit_retention_permits_update;
DROP TRIGGER erasure_fence_audit_retention_permits_delete;
DROP TRIGGER erasure_preserve_audit_retention_permits_delete;
DROP TRIGGER erasure_preserve_audit_retention_permits_delete_clear;
ALTER TABLE users DROP COLUMN audit_retention_cutoff_ms;
-- audit-retention-permit-cutover:end

-- audit-retention-permit-verify:start
INSERT INTO sql_assertions(scope,accepted)
SELECT 'audit_retention_cutover',CASE WHEN
 NOT EXISTS(SELECT 1 FROM pragma_foreign_key_check)
 AND NOT EXISTS(SELECT 1 FROM audit_retention_permits)
 THEN 1 ELSE 0 END ON CONFLICT(scope) DO UPDATE SET accepted=excluded.accepted;
DELETE FROM sql_assertions WHERE scope='audit_retention_cutover';
-- audit-retention-permit-verify:end

-- consent-offers-preflight:start
INSERT INTO sql_assertions(scope,accepted)
SELECT 'consent_offers_cutover',CASE WHEN
 NOT EXISTS(SELECT 1 FROM consent_offers o WHERE
   NOT json_valid(o.disclosure_json) OR o.expires_at_ms<=o.created_at_ms
   OR (o.decision IS NOT NULL AND o.disclosure_message_id IS NULL)
   OR (o.rejection_id IS NOT NULL AND NOT EXISTS (
     SELECT 1 FROM consent_history r WHERE r.user_id=o.user_id
     AND r.record_type='weekly_rejection' AND r.id=o.rejection_id))
   OR (o.replaces_offer_id IS NOT NULL AND NOT EXISTS (
     SELECT 1 FROM consent_offers old WHERE old.user_id=o.user_id AND old.kind=o.kind
     AND old.id=o.replaces_offer_id AND old.id<>o.id)))
 AND NOT EXISTS(SELECT 1 FROM consent_history h WHERE
   (h.weekly_offer_reference IS NOT NULL AND NOT EXISTS (
     SELECT 1 FROM consent_offers o WHERE o.user_id=h.user_id
     AND o.kind='weekly-summary' AND o.id=h.weekly_offer_reference))
   OR (h.proactivity_offer_reference IS NOT NULL AND NOT EXISTS (
     SELECT 1 FROM consent_offers o WHERE o.user_id=h.user_id
     AND o.kind=h.kind AND o.id=h.proactivity_offer_reference)))
 AND NOT EXISTS(SELECT 1 FROM pragma_foreign_key_check)
 THEN 1 ELSE 0 END ON CONFLICT(scope) DO UPDATE SET accepted=excluded.accepted;
-- consent-offers-preflight:end

-- consent-offers-verify:start
INSERT INTO sql_assertions(scope,accepted)
SELECT 'consent_offers_cutover',CASE WHEN
 NOT EXISTS(SELECT 1 FROM pragma_foreign_key_check)
 THEN 1 ELSE 0 END ON CONFLICT(scope) DO UPDATE SET accepted=excluded.accepted;
DELETE FROM sql_assertions WHERE scope='consent_offers_cutover';
-- consent-offers-verify:end

-- consent-history-preflight:start
INSERT INTO sql_assertions(scope,accepted)
SELECT 'consent_history_cutover',CASE WHEN
 NOT EXISTS(SELECT 1 FROM erasure_chunk)
 AND NOT EXISTS(SELECT 1 FROM pragma_foreign_key_check)
 AND NOT EXISTS(SELECT 1 FROM consent_history WHERE
   (record_type IN ('processing_grant','processing_renewal','pat_grant','oauth_grant') AND (accepted_at_ms IS NULL OR occurred_at_ms IS NOT NULL))
   OR (record_type NOT IN ('processing_grant','processing_renewal','pat_grant','oauth_grant') AND accepted_at_ms IS NOT NULL)
   OR (record_type IN ('pat_grant','pat_revocation','oauth_grant','oauth_user_revocation') AND (disclosure_revision IS NULL OR disclosure_text IS NULL OR disclosure_json IS NOT NULL))
   OR (record_type NOT IN ('pat_grant','pat_revocation','oauth_grant','oauth_user_revocation') AND (disclosure_revision IS NOT NULL OR disclosure_text IS NOT NULL))
   OR (record_type='pat_revocation' AND reason IS NOT NULL)
   OR (record_type<>'pat_revocation' AND policy_reason IS NOT NULL))
 THEN 1 ELSE 0 END ON CONFLICT(scope) DO UPDATE SET accepted=excluded.accepted;
-- consent-history-preflight:end

-- consent-history-copy:start
INSERT INTO consent_history_next (sequence, record_type, id, user_id, disclosure_json, disclosure_message_id, decision_message_id, decision_received_at_ms, grant_record_id, session_id, occurred_at_ms, withdrawal_id, grant_id, offer_id, record_json, decision, kind, pairing_id, request_id, grant_consent_id, pat_id, connection_id, reason)
SELECT sequence,
 record_type,
 id,
 user_id,
 CASE WHEN record_type IN ('pat_grant','pat_revocation','oauth_grant','oauth_user_revocation') THEN json_object('revision',disclosure_revision,'text',disclosure_text) ELSE disclosure_json END,
 disclosure_message_id,
 decision_message_id,
 decision_received_at_ms,
 grant_record_id,
 session_id,
 CASE WHEN record_type IN ('processing_grant','processing_renewal','pat_grant','oauth_grant') THEN accepted_at_ms ELSE occurred_at_ms END,
 withdrawal_id,
 grant_id,
 offer_id,
 record_json,
 decision,
 kind,
 pairing_id,
 request_id,
 grant_consent_id,
 pat_id,
 connection_id,
 CASE WHEN record_type='pat_revocation' THEN policy_reason ELSE reason END
FROM consent_history ORDER BY sequence;
UPDATE sqlite_sequence SET seq=(SELECT seq FROM sqlite_sequence WHERE name='consent_history')
WHERE name='consent_history_next' AND EXISTS(SELECT 1 FROM sqlite_sequence WHERE name='consent_history');
INSERT INTO sqlite_sequence(name,seq)
SELECT 'consent_history_next',seq FROM sqlite_sequence WHERE name='consent_history'
 AND NOT EXISTS(SELECT 1 FROM sqlite_sequence WHERE name='consent_history_next');
INSERT INTO sql_assertions(scope,accepted)
SELECT 'consent_history_cutover',CASE WHEN
 (SELECT count(*) FROM consent_history)=(SELECT count(*) FROM consent_history_next)
 AND NOT EXISTS(SELECT * FROM (
 SELECT sequence,
 record_type,
 id,
 user_id,
 CASE WHEN record_type IN ('pat_grant','pat_revocation','oauth_grant','oauth_user_revocation') THEN json_object('revision',disclosure_revision,'text',disclosure_text) ELSE disclosure_json END,
 disclosure_message_id,
 decision_message_id,
 decision_received_at_ms,
 grant_record_id,
 session_id,
 CASE WHEN record_type IN ('processing_grant','processing_renewal','pat_grant','oauth_grant') THEN accepted_at_ms ELSE occurred_at_ms END,
 withdrawal_id,
 grant_id,
 offer_id,
 record_json,
 decision,
 kind,
 pairing_id,
 request_id,
 grant_consent_id,
 pat_id,
 connection_id,
 CASE WHEN record_type='pat_revocation' THEN policy_reason ELSE reason END
 FROM consent_history EXCEPT SELECT sequence, record_type, id, user_id, disclosure_json, disclosure_message_id, decision_message_id, decision_received_at_ms, grant_record_id, session_id, occurred_at_ms, withdrawal_id, grant_id, offer_id, record_json, decision, kind, pairing_id, request_id, grant_consent_id, pat_id, connection_id, reason FROM consent_history_next))
 THEN 1 ELSE 0 END ON CONFLICT(scope) DO UPDATE SET accepted=excluded.accepted;
-- consent-history-copy:end

-- consent-history-swap:start
DROP TABLE consent_history;
ALTER TABLE consent_history_next RENAME TO consent_history;
-- consent-history-swap:end

-- consent-history-verify:start
INSERT INTO sql_assertions(scope,accepted)
SELECT 'consent_history_cutover',CASE WHEN
 NOT EXISTS(SELECT 1 FROM pragma_foreign_key_check)
 THEN 1 ELSE 0 END ON CONFLICT(scope) DO UPDATE SET accepted=excluded.accepted;
PRAGMA defer_foreign_keys=OFF;
DELETE FROM sql_assertions WHERE scope='consent_history_cutover';
-- consent-history-verify:end

-- consent-exchanges-preflight:start
INSERT INTO sql_assertions(scope,accepted)
SELECT 'consent_exchanges_cutover',CASE WHEN
 NOT EXISTS(SELECT 1 FROM erasure_chunk)
 AND NOT EXISTS(SELECT 1 FROM pragma_foreign_key_check)
 AND NOT EXISTS(SELECT 1 FROM pending_consent_exchanges WHERE
   (decision_value IS NULL AND (decision_portfolio_id IS NOT NULL OR decision_bsuid IS NOT NULL OR decision_phone_number_id IS NOT NULL OR decision_disclosure_json IS NOT NULL OR decision_disclosure_message_id IS NOT NULL))
   OR (decision_value IS NOT NULL AND (decision_portfolio_id IS NOT portfolio_id OR decision_bsuid IS NOT bsuid OR decision_phone_number_id IS NOT phone_number_id OR decision_disclosure_json IS NOT disclosure_json OR decision_disclosure_message_id IS NOT disclosure_message_id)))
 THEN 1 ELSE 0 END ON CONFLICT(scope) DO UPDATE SET accepted=excluded.accepted;
-- consent-exchanges-preflight:end

-- consent-exchanges-copy:start
CREATE TABLE whatsapp_provider_handoffs_consent_cutover AS SELECT rowid AS source_rowid, * FROM whatsapp_provider_handoffs WHERE 1;
CREATE TABLE provider_authentication_attempts_consent_cutover AS SELECT rowid AS source_rowid, * FROM provider_authentication_attempts WHERE handoff_id IS NOT NULL;
INSERT INTO pending_consent_exchanges_next (rowid, id, portfolio_id, bsuid, phone_number_id, initiating_message_id, initiating_body_sha256, correlation_token, disclosure_json, disclosure_message_id, created_at_ms, disclosed_at_ms, decision_not_before_ms, expires_at_ms, state, rejected_at_ms, sandbox_phone, delivery_phone_number_id, delivery_message_id, delivery_occurred_at_ms, delivery_received_at_ms, delivery_not_before_ms, decision_value, decision_message_id, decision_delivery_key, decision_body_sha256, decision_occurred_at_ms, decision_received_at_ms)
SELECT rowid, id, portfolio_id, bsuid, phone_number_id, initiating_message_id, initiating_body_sha256, correlation_token, disclosure_json, disclosure_message_id, created_at_ms, disclosed_at_ms, decision_not_before_ms, expires_at_ms, state, rejected_at_ms, sandbox_phone, delivery_phone_number_id, delivery_message_id, delivery_occurred_at_ms, delivery_received_at_ms, delivery_not_before_ms, decision_value, decision_message_id, decision_delivery_key, decision_body_sha256, decision_occurred_at_ms, decision_received_at_ms FROM pending_consent_exchanges ORDER BY rowid;
INSERT INTO sql_assertions(scope,accepted)
SELECT 'consent_exchanges_cutover',CASE WHEN
 (SELECT count(*) FROM pending_consent_exchanges)=(SELECT count(*) FROM pending_consent_exchanges_next)
 AND NOT EXISTS(SELECT rowid, id, portfolio_id, bsuid, phone_number_id, initiating_message_id, initiating_body_sha256, correlation_token, disclosure_json, disclosure_message_id, created_at_ms, disclosed_at_ms, decision_not_before_ms, expires_at_ms, state, rejected_at_ms, sandbox_phone, delivery_phone_number_id, delivery_message_id, delivery_occurred_at_ms, delivery_received_at_ms, delivery_not_before_ms, decision_value, decision_message_id, decision_delivery_key, decision_body_sha256, decision_occurred_at_ms, decision_received_at_ms FROM pending_consent_exchanges
   EXCEPT SELECT rowid, id, portfolio_id, bsuid, phone_number_id, initiating_message_id, initiating_body_sha256, correlation_token, disclosure_json, disclosure_message_id, created_at_ms, disclosed_at_ms, decision_not_before_ms, expires_at_ms, state, rejected_at_ms, sandbox_phone, delivery_phone_number_id, delivery_message_id, delivery_occurred_at_ms, delivery_received_at_ms, delivery_not_before_ms, decision_value, decision_message_id, decision_delivery_key, decision_body_sha256, decision_occurred_at_ms, decision_received_at_ms FROM pending_consent_exchanges_next)
 THEN 1 ELSE 0 END ON CONFLICT(scope) DO UPDATE SET accepted=excluded.accepted;
-- consent-exchanges-copy:end

-- consent-exchanges-swap:start
DROP TABLE pending_consent_exchanges;
ALTER TABLE pending_consent_exchanges_next RENAME TO pending_consent_exchanges;
INSERT INTO whatsapp_provider_handoffs (rowid, id, exchange_id, created_at_ms, expires_at_ms, handoff_send_started_ms, pairing_id, review_code, review_started_ms, review_message_id, decision, decision_message_id, confirmed_at_ms, consumed_at_ms) SELECT source_rowid, id, exchange_id, created_at_ms, expires_at_ms, handoff_send_started_ms, pairing_id, review_code, review_started_ms, review_message_id, decision, decision_message_id, confirmed_at_ms, consumed_at_ms FROM whatsapp_provider_handoffs_consent_cutover;
INSERT INTO sql_assertions(scope,accepted) SELECT 'consent_exchanges_cutover',CASE WHEN
 NOT EXISTS(SELECT source_rowid, id, exchange_id, created_at_ms, expires_at_ms, handoff_send_started_ms, pairing_id, review_code, review_started_ms, review_message_id, decision, decision_message_id, confirmed_at_ms, consumed_at_ms FROM whatsapp_provider_handoffs_consent_cutover
 EXCEPT SELECT rowid, id, exchange_id, created_at_ms, expires_at_ms, handoff_send_started_ms, pairing_id, review_code, review_started_ms, review_message_id, decision, decision_message_id, confirmed_at_ms, consumed_at_ms FROM whatsapp_provider_handoffs) THEN 1 ELSE 0 END
 ON CONFLICT(scope) DO UPDATE SET accepted=excluded.accepted;
DROP TABLE whatsapp_provider_handoffs_consent_cutover;
INSERT INTO provider_authentication_attempts (rowid, id, pairing_id, cookie_digest, nonce, intent, disclosure_json, consent_at_ms, created_at_ms, expires_at_ms, state, issuer, subject, contact_email, user_id, provider, handoff_id, completed_at_ms, created_user) SELECT source_rowid, id, pairing_id, cookie_digest, nonce, intent, disclosure_json, consent_at_ms, created_at_ms, expires_at_ms, state, issuer, subject, contact_email, user_id, provider, handoff_id, completed_at_ms, created_user FROM provider_authentication_attempts_consent_cutover;
INSERT INTO sql_assertions(scope,accepted) SELECT 'consent_exchanges_cutover',CASE WHEN
 NOT EXISTS(SELECT source_rowid, id, pairing_id, cookie_digest, nonce, intent, disclosure_json, consent_at_ms, created_at_ms, expires_at_ms, state, issuer, subject, contact_email, user_id, provider, handoff_id, completed_at_ms, created_user FROM provider_authentication_attempts_consent_cutover
 EXCEPT SELECT rowid, id, pairing_id, cookie_digest, nonce, intent, disclosure_json, consent_at_ms, created_at_ms, expires_at_ms, state, issuer, subject, contact_email, user_id, provider, handoff_id, completed_at_ms, created_user FROM provider_authentication_attempts) THEN 1 ELSE 0 END
 ON CONFLICT(scope) DO UPDATE SET accepted=excluded.accepted;
DROP TABLE provider_authentication_attempts_consent_cutover;
-- consent-exchanges-swap:end

-- consent-exchanges-verify:start
INSERT INTO sql_assertions(scope,accepted)
SELECT 'consent_exchanges_cutover',CASE WHEN
 NOT EXISTS(SELECT 1 FROM pragma_foreign_key_check)
 THEN 1 ELSE 0 END ON CONFLICT(scope) DO UPDATE SET accepted=excluded.accepted;
PRAGMA defer_foreign_keys=OFF;
DELETE FROM sql_assertions WHERE scope='consent_exchanges_cutover';
-- consent-exchanges-verify:end

-- email-credential-preflight:start
INSERT INTO sql_assertions(scope,accepted)
SELECT 'email_credential_cutover',CASE WHEN
 NOT EXISTS(SELECT 1 FROM erasure_chunk)
 AND NOT EXISTS(SELECT 1 FROM pragma_foreign_key_check)
 AND NOT EXISTS(SELECT 1 FROM users WHERE
   (verified_email_address IS NULL)<>(email_verified_at_ms IS NULL)
   OR (verified_email_address IS NOT NULL AND verified_email_address COLLATE BINARY<>lower(trim(verified_email_address))))
 AND (SELECT count(verified_email_address) FROM users)=
     (SELECT count(DISTINCT verified_email_address COLLATE NOCASE) FROM users)
 THEN 1 ELSE 0 END ON CONFLICT(scope) DO UPDATE SET accepted=excluded.accepted;
-- email-credential-preflight:end

-- email-credential-copy:start
INSERT INTO verified_email_credentials(rowid,user_id,address,verified_at_ms)
SELECT rowid,id,verified_email_address,email_verified_at_ms FROM users WHERE verified_email_address IS NOT NULL;
INSERT INTO sql_assertions(scope,accepted)
SELECT 'email_credential_cutover',CASE WHEN
 (SELECT count(*) FROM verified_email_credentials)=(SELECT count(*) FROM users WHERE verified_email_address IS NOT NULL)
 AND NOT EXISTS(SELECT rowid,id,verified_email_address,email_verified_at_ms FROM users WHERE verified_email_address IS NOT NULL
 EXCEPT SELECT rowid,user_id,address,verified_at_ms FROM verified_email_credentials)
 THEN 1 ELSE 0 END ON CONFLICT(scope) DO UPDATE SET accepted=excluded.accepted;
-- email-credential-copy:end

-- email-credential-remove-source:start
DROP INDEX users_verified_email;
ALTER TABLE users DROP COLUMN email_verified_at_ms;
ALTER TABLE users DROP COLUMN verified_email_address;
-- email-credential-remove-source:end

-- email-credential-verify:start
INSERT INTO sql_assertions(scope,accepted)
SELECT 'email_credential_cutover',CASE WHEN NOT EXISTS(SELECT 1 FROM pragma_foreign_key_check)
 THEN 1 ELSE 0 END ON CONFLICT(scope) DO UPDATE SET accepted=excluded.accepted;
DELETE FROM sql_assertions WHERE scope='email_credential_cutover';
-- email-credential-verify:end

-- recovery-credential-preflight:start
INSERT INTO sql_assertions(scope,accepted)
SELECT 'recovery_credential_cutover',CASE WHEN
 NOT EXISTS(SELECT 1 FROM erasure_chunk)
 AND NOT EXISTS(SELECT 1 FROM pragma_foreign_key_check)
 AND NOT EXISTS(SELECT 1 FROM users WHERE
   (recovery_code_digest IS NULL AND (recovery_created_at_ms IS NOT NULL OR recovery_consumed_at_ms IS NOT NULL OR recovery_revision IS NOT NULL))
   OR (recovery_code_digest IS NOT NULL AND (typeof(recovery_code_digest)<>'blob' OR length(recovery_code_digest)<>32 OR recovery_created_at_ms IS NULL OR recovery_revision IS NULL)))
 AND (SELECT count(recovery_code_digest) FROM users)=(SELECT count(DISTINCT recovery_code_digest) FROM users)
 THEN 1 ELSE 0 END ON CONFLICT(scope) DO UPDATE SET accepted=excluded.accepted;
-- recovery-credential-preflight:end

-- recovery-credential-copy:start
INSERT INTO backup_recovery_credentials(rowid,user_id,code_digest,created_at_ms,consumed_at_ms,revision)
SELECT rowid,id,recovery_code_digest,recovery_created_at_ms,recovery_consumed_at_ms,recovery_revision
FROM users WHERE recovery_code_digest IS NOT NULL;
INSERT INTO sql_assertions(scope,accepted)
SELECT 'recovery_credential_cutover',CASE WHEN
 (SELECT count(*) FROM backup_recovery_credentials)=(SELECT count(*) FROM users WHERE recovery_code_digest IS NOT NULL)
 AND NOT EXISTS(SELECT rowid,id,recovery_code_digest,recovery_created_at_ms,recovery_consumed_at_ms,recovery_revision FROM users WHERE recovery_code_digest IS NOT NULL
 EXCEPT SELECT rowid,user_id,code_digest,created_at_ms,consumed_at_ms,revision FROM backup_recovery_credentials)
 THEN 1 ELSE 0 END ON CONFLICT(scope) DO UPDATE SET accepted=excluded.accepted;
-- recovery-credential-copy:end

-- recovery-credential-remove-source:start
DROP INDEX users_recovery_digest;
ALTER TABLE users DROP COLUMN recovery_revision;
ALTER TABLE users DROP COLUMN recovery_consumed_at_ms;
ALTER TABLE users DROP COLUMN recovery_created_at_ms;
ALTER TABLE users DROP COLUMN recovery_code_digest;
-- recovery-credential-remove-source:end

-- recovery-credential-verify:start
INSERT INTO sql_assertions(scope,accepted)
SELECT 'recovery_credential_cutover',CASE WHEN NOT EXISTS(SELECT 1 FROM pragma_foreign_key_check)
 THEN 1 ELSE 0 END ON CONFLICT(scope) DO UPDATE SET accepted=excluded.accepted;
DELETE FROM sql_assertions WHERE scope='recovery_credential_cutover';
-- recovery-credential-verify:end

-- recovery-evidence-references:start
INSERT INTO sql_assertions(scope,accepted)
SELECT 'recovery_evidence_cutover',CASE WHEN NOT EXISTS(
 SELECT 1 FROM pragma_foreign_key_list('__TABLE_NAME__') WHERE "table"='audit_entries')
 THEN 1 ELSE 0 END ON CONFLICT(scope) DO UPDATE SET accepted=excluded.accepted;
-- recovery-evidence-references:end

-- recovery-evidence-preflight:start
INSERT INTO sql_assertions(scope,accepted)
SELECT 'recovery_evidence_cutover',CASE WHEN
 NOT EXISTS(SELECT 1 FROM erasure_chunk)
 AND NOT EXISTS(SELECT 1 FROM erasure_requests WHERE state<>'Complete')
 AND NOT EXISTS(SELECT 1 FROM pragma_foreign_key_check)
 AND NOT EXISTS(SELECT 1 FROM support_recovery_cases c WHERE
   NOT EXISTS(SELECT 1 FROM browser_login_pairings p WHERE p.id=c.pairing_id AND p.user_id=c.user_id)
   OR (SELECT count(*) FROM audit_entries e WHERE e.record_type='support_recovery' AND e.recovery_case_id=c.id)<>2
   OR (SELECT count(*) FROM audit_entries e WHERE e.record_type='support_recovery' AND e.recovery_case_id=c.id AND e.recovery_action='opened')<>1
   OR (SELECT count(*) FROM audit_entries e WHERE e.record_type='support_recovery' AND e.recovery_case_id=c.id AND e.recovery_action=c.state)<>1)
 AND NOT EXISTS(SELECT 1 FROM audit_entries e LEFT JOIN support_recovery_cases c ON c.id=e.recovery_case_id
   WHERE e.record_type='support_recovery' AND (c.id IS NULL OR e.user_id IS NOT c.user_id
   OR e.operator_issuer IS NOT c.operator_issuer OR e.operator_subject IS NOT c.operator_subject
   OR (e.recovery_action='opened' AND e.occurred_at_ms IS NOT c.opened_at_ms)
   OR (e.recovery_action<>'opened' AND (e.recovery_action IS NOT c.state OR e.occurred_at_ms IS NOT c.closed_at_ms))))
 THEN 1 ELSE 0 END ON CONFLICT(scope) DO UPDATE SET accepted=excluded.accepted;
-- recovery-evidence-preflight:end

-- recovery-evidence-copy:start
ALTER TABLE support_recovery_cases ADD COLUMN opened_event_id TEXT;
ALTER TABLE support_recovery_cases ADD COLUMN opened_event_row_ref TEXT CHECK((opened_event_id IS NULL)=(opened_event_row_ref IS NULL));
ALTER TABLE support_recovery_cases ADD COLUMN decision_event_id TEXT;
ALTER TABLE support_recovery_cases ADD COLUMN decision_event_row_ref TEXT CHECK((decision_event_id IS NULL)=(decision_event_row_ref IS NULL));
UPDATE support_recovery_cases AS c SET
 opened_event_id=(SELECT id FROM audit_entries e WHERE e.record_type='support_recovery' AND e.recovery_case_id=c.id AND e.recovery_action='opened'),
 opened_event_row_ref=(SELECT CAST(sequence AS TEXT) FROM audit_entries e WHERE e.record_type='support_recovery' AND e.recovery_case_id=c.id AND e.recovery_action='opened'),
 decision_event_id=(SELECT id FROM audit_entries e WHERE e.record_type='support_recovery' AND e.recovery_case_id=c.id AND e.recovery_action=c.state),
 decision_event_row_ref=(SELECT CAST(sequence AS TEXT) FROM audit_entries e WHERE e.record_type='support_recovery' AND e.recovery_case_id=c.id AND e.recovery_action=c.state);
INSERT INTO audit_entries_1442(sequence,record_type,id,user_id,session_id,operation,outcome,occurred_at_ms,pat_id,oauth_connection_id,oauth_credential_id,hosted_turn_id,attempt_id,transition,accepted_at_ms,refresh_connection_id,consumed_refresh_id,issued_refresh_id)
SELECT sequence,record_type,id,user_id,session_id,operation,outcome,occurred_at_ms,pat_id,oauth_connection_id,oauth_credential_id,hosted_turn_id,attempt_id,transition,accepted_at_ms,refresh_connection_id,consumed_refresh_id,issued_refresh_id FROM audit_entries WHERE record_type<>'support_recovery';
UPDATE sqlite_sequence SET seq=max(seq,COALESCE((SELECT seq FROM sqlite_sequence WHERE name='audit_entries'),0)) WHERE name='audit_entries_1442';
INSERT INTO sql_assertions(scope,accepted)
SELECT 'recovery_evidence_cutover',CASE WHEN
 (SELECT count(*) FROM audit_entries_1442)=(SELECT count(*) FROM audit_entries WHERE record_type<>'support_recovery')
 AND NOT EXISTS(SELECT sequence,record_type,id,user_id,session_id,operation,outcome,occurred_at_ms,pat_id,oauth_connection_id,oauth_credential_id,hosted_turn_id,attempt_id,transition,accepted_at_ms,refresh_connection_id,consumed_refresh_id,issued_refresh_id FROM audit_entries WHERE record_type<>'support_recovery'
 EXCEPT SELECT sequence,record_type,id,user_id,session_id,operation,outcome,occurred_at_ms,pat_id,oauth_connection_id,oauth_credential_id,hosted_turn_id,attempt_id,transition,accepted_at_ms,refresh_connection_id,consumed_refresh_id,issued_refresh_id FROM audit_entries_1442)
 AND NOT EXISTS(SELECT 1 FROM audit_entries e JOIN support_recovery_cases c ON c.id=e.recovery_case_id WHERE e.record_type='support_recovery'
   AND ((e.recovery_action='opened' AND (c.opened_event_id IS NOT e.id OR c.opened_event_row_ref IS NOT CAST(e.sequence AS TEXT)))
   OR (e.recovery_action=c.state AND (c.decision_event_id IS NOT e.id OR c.decision_event_row_ref IS NOT CAST(e.sequence AS TEXT)))))
 AND COALESCE((SELECT seq FROM sqlite_sequence WHERE name='audit_entries_1442'),0)=COALESCE((SELECT seq FROM sqlite_sequence WHERE name='audit_entries'),0)
 THEN 1 ELSE 0 END ON CONFLICT(scope) DO UPDATE SET accepted=excluded.accepted;
-- recovery-evidence-copy:end

-- recovery-evidence-replace:start
DROP TABLE audit_entries;
ALTER TABLE audit_entries_1442 RENAME TO audit_entries;
-- recovery-evidence-replace:end

-- recovery-evidence-verify:start
INSERT INTO sql_assertions(scope,accepted)
SELECT 'recovery_evidence_cutover',CASE WHEN NOT EXISTS(SELECT 1 FROM pragma_foreign_key_check)
 THEN 1 ELSE 0 END ON CONFLICT(scope) DO UPDATE SET accepted=excluded.accepted;
DELETE FROM sql_assertions WHERE scope='recovery_evidence_cutover';
-- recovery-evidence-verify:end

-- browser-session-index:start
CREATE INDEX browser_login_pairings_retention ON browser_login_pairings(expires_at_ms,id);
CREATE INDEX web_sessions_by_user ON web_sessions(user_id);
-- browser-session-index:end

-- provider-onboarding-preflight:start
INSERT INTO sql_assertions(scope,accepted)
SELECT 'provider_onboarding_cutover',CASE WHEN
 NOT EXISTS(SELECT 1 FROM pragma_foreign_key_check)
 AND NOT EXISTS(SELECT 1 FROM erasure_chunk)
 AND NOT EXISTS(SELECT 1 FROM erasure_requests WHERE state<>'Complete')
 AND NOT EXISTS(SELECT 1 FROM provider_authentication_attempts a
   LEFT JOIN browser_login_pairings p ON p.id=a.pairing_id
   LEFT JOIN provider_credentials c ON c.issuer=a.issuer AND c.subject=a.subject
   WHERE (a.state='completed')<>(a.completed_at_ms IS NOT NULL)
   OR (a.completed_at_ms IS NOT NULL AND (
     a.user_id IS NULL OR a.issuer IS NULL OR a.subject IS NULL
     OR a.cookie_digest IS NOT zeroblob(32) OR a.nonce<>'' OR a.contact_email IS NOT NULL
     OR a.created_user IS NULL
     OR (p.state IN('ready','consumed') AND p.user_id IS NOT a.user_id)
     OR p.state NOT IN('ready','consumed','invalidated')
     OR (p.state='invalidated' AND (p.user_id IS NOT NULL OR p.wrong_attempts<>5))
     OR a.expires_at_ms<=a.completed_at_ms OR p.expires_at_ms<=a.completed_at_ms
     OR (c.user_id IS NOT NULL AND c.user_id IS NOT a.user_id))))
 THEN 1 ELSE 0 END ON CONFLICT(scope) DO UPDATE SET accepted=excluded.accepted;
-- provider-onboarding-preflight:end

-- provider-handoff-preflight:start
INSERT INTO sql_assertions(scope,accepted)
SELECT 'provider_handoff_cutover',CASE WHEN
 NOT EXISTS(SELECT 1 FROM pragma_foreign_key_check)
 AND NOT EXISTS(SELECT 1 FROM erasure_chunk)
 AND NOT EXISTS(SELECT 1 FROM erasure_requests WHERE state<>'Complete')
 AND NOT EXISTS(SELECT 1 FROM whatsapp_provider_handoffs h
   JOIN pending_consent_exchanges e ON e.id=h.exchange_id
   WHERE e.state<>'accepted' OR e.decision_value IS NOT 'accepted' OR h.expires_at_ms>e.expires_at_ms
   OR (h.pairing_id IS NULL)<>(h.review_code IS NULL)
   OR (h.review_started_ms IS NOT NULL AND h.pairing_id IS NULL)
   OR (h.review_message_id IS NOT NULL AND h.review_started_ms IS NULL)
   OR (h.decision IS NULL AND (h.decision_message_id IS NOT NULL OR h.confirmed_at_ms IS NOT NULL))
   OR (h.decision IS NOT NULL AND (h.decision_message_id IS NULL OR h.confirmed_at_ms IS NULL
     OR h.review_message_id IS NULL OR h.review_started_ms IS NULL OR h.pairing_id IS NULL))
   OR (h.consumed_at_ms IS NOT NULL AND h.decision IS NOT 'confirmed'))
 AND NOT EXISTS(SELECT 1 FROM provider_authentication_attempts a
   JOIN whatsapp_provider_handoffs h ON h.id=a.handoff_id
   WHERE a.pairing_id IS NOT h.pairing_id
   OR (a.completed_at_ms IS NOT NULL AND (h.decision IS NOT 'confirmed' OR h.consumed_at_ms IS NOT a.completed_at_ms))
   OR (a.completed_at_ms IS NULL AND h.consumed_at_ms IS NOT NULL))
 THEN 1 ELSE 0 END ON CONFLICT(scope) DO UPDATE SET accepted=excluded.accepted;
-- provider-handoff-preflight:end

-- oauth-lineage-preflight:start
INSERT INTO sql_assertions(scope,accepted)
SELECT 'oauth_lineage_cutover',CASE WHEN
 NOT EXISTS(SELECT 1 FROM erasure_permits) AND NOT EXISTS(SELECT 1 FROM erasure_chunk)
 AND NOT EXISTS(SELECT 1 FROM audit_retention_permits)
 AND NOT EXISTS(SELECT 1 FROM pragma_foreign_key_check)
 AND NOT EXISTS(SELECT 1 FROM oauth_credentials c LEFT JOIN oauth_connections g ON g.id=c.connection_id
 WHERE c.user_id IS NULL OR c.user_id IS NOT g.user_id OR c.expires_at_ms>g.expires_at_ms
 OR NOT json_valid(c.scopes_json) OR json_type(c.scopes_json)<>'array' OR json_array_length(c.scopes_json)=0
 OR EXISTS(SELECT 1 FROM json_each(c.scopes_json) s WHERE s.type<>'text' OR s.value NOT IN('read','write','dashboard')
 OR NOT EXISTS(SELECT 1 FROM json_each(g.scopes_json) a WHERE a.value=s.value)))
 AND NOT EXISTS(SELECT 1 FROM audit_entries e
 LEFT JOIN oauth_credentials c ON c.kind='refresh' AND c.id=e.consumed_refresh_id
 LEFT JOIN oauth_credentials n ON n.kind='refresh' AND n.id=e.issued_refresh_id
 WHERE e.record_type='oauth_refresh' AND (c.id IS NULL OR n.id IS NULL OR c.id=n.id
 OR c.user_id IS NOT e.user_id OR n.user_id IS NOT e.user_id
 OR c.connection_id IS NOT e.refresh_connection_id OR n.connection_id IS NOT e.refresh_connection_id
 OR c.consumed_at_ms IS NOT e.occurred_at_ms OR n.issued_at_ms IS NOT e.occurred_at_ms
 OR e.occurred_at_ms<c.issued_at_ms OR e.occurred_at_ms>=c.expires_at_ms
 OR EXISTS(SELECT 1 FROM json_each(n.scopes_json) s WHERE NOT EXISTS(SELECT 1 FROM json_each(c.scopes_json) a WHERE a.value=s.value))))
 AND NOT EXISTS(SELECT consumed_refresh_id FROM audit_entries WHERE record_type='oauth_refresh' GROUP BY consumed_refresh_id HAVING count(*)<>1)
 AND NOT EXISTS(SELECT issued_refresh_id FROM audit_entries WHERE record_type='oauth_refresh' GROUP BY issued_refresh_id HAVING count(*)<>1)
 AND NOT EXISTS(SELECT 1 FROM oauth_credentials c WHERE c.kind='refresh' AND c.consumed_at_ms IS NOT NULL
 AND NOT EXISTS(SELECT 1 FROM audit_entries e WHERE e.record_type='oauth_refresh' AND e.consumed_refresh_id=c.id))
 THEN 1 ELSE 0 END ON CONFLICT(scope) DO UPDATE SET accepted=excluded.accepted;
-- oauth-lineage-preflight:end

-- oauth-lineage-references:start
INSERT INTO sql_assertions(scope,accepted)
SELECT 'oauth_lineage_cutover',CASE WHEN NOT EXISTS(
 SELECT 1 FROM pragma_foreign_key_list('__TABLE_NAME__')
 WHERE "table"='audit_entries' OR ("table"='oauth_credentials' AND NOT (
 '__TABLE_NAME__'='audit_entries' AND (("from"='oauth_credential_id' AND "to"='access_id')
 OR ("from" IN('consumed_refresh_id','issued_refresh_id') AND "to"='refresh_id'))))
) THEN 1 ELSE 0 END ON CONFLICT(scope) DO UPDATE SET accepted=excluded.accepted;
-- oauth-lineage-references:end

-- oauth-lineage-copy:start
INSERT INTO oauth_credentials_1446(rowid,kind,id,connection_id,user_id,digest,issued_at_ms,expires_at_ms,consumed_at_ms,scopes_json,replacement_refresh_id,refresh_event_id,refresh_event_row_ref)
SELECT c.rowid,c.kind,c.id,c.connection_id,c.user_id,c.digest,c.issued_at_ms,c.expires_at_ms,c.consumed_at_ms,c.scopes_json,e.issued_refresh_id,e.id,CAST(e.sequence AS TEXT)
FROM oauth_credentials c LEFT JOIN audit_entries e ON e.record_type='oauth_refresh' AND c.kind='refresh' AND e.consumed_refresh_id=c.id;
INSERT INTO audit_entries_1446(sequence,record_type,id,user_id,session_id,operation,outcome,occurred_at_ms,pat_id,oauth_connection_id,oauth_credential_id,hosted_turn_id,attempt_id,transition) SELECT sequence,record_type,id,user_id,session_id,operation,outcome,CASE WHEN record_type='request_admission' THEN accepted_at_ms ELSE occurred_at_ms END,pat_id,oauth_connection_id,oauth_credential_id,hosted_turn_id,attempt_id,transition FROM audit_entries WHERE record_type<>'oauth_refresh';
UPDATE sqlite_sequence SET seq=(SELECT seq FROM sqlite_sequence WHERE name='audit_entries') WHERE name='audit_entries_1446';
INSERT INTO sqlite_sequence(name,seq) SELECT 'audit_entries_1446',seq FROM sqlite_sequence WHERE name='audit_entries'
 AND NOT EXISTS(SELECT 1 FROM sqlite_sequence WHERE name='audit_entries_1446');
INSERT INTO sql_assertions(scope,accepted)
SELECT 'oauth_lineage_cutover',CASE WHEN
 (SELECT count(*) FROM oauth_credentials)=(SELECT count(*) FROM oauth_credentials_1446)
 AND NOT EXISTS(SELECT rowid,kind,id,connection_id,user_id,digest,issued_at_ms,expires_at_ms,consumed_at_ms,scopes_json FROM oauth_credentials EXCEPT SELECT rowid,kind,id,connection_id,user_id,digest,issued_at_ms,expires_at_ms,consumed_at_ms,scopes_json FROM oauth_credentials_1446)
 AND (SELECT count(*) FROM audit_entries WHERE record_type='oauth_refresh')=(SELECT count(*) FROM oauth_credentials_1446 WHERE replacement_refresh_id IS NOT NULL)
 AND NOT EXISTS(SELECT sequence,id,user_id,refresh_connection_id,consumed_refresh_id,issued_refresh_id,occurred_at_ms FROM audit_entries WHERE record_type='oauth_refresh'
 EXCEPT SELECT CAST(refresh_event_row_ref AS INTEGER),refresh_event_id,user_id,connection_id,id,replacement_refresh_id,consumed_at_ms FROM oauth_credentials_1446 WHERE replacement_refresh_id IS NOT NULL)
 AND (SELECT count(*) FROM audit_entries WHERE record_type<>'oauth_refresh')=(SELECT count(*) FROM audit_entries_1446)
 AND NOT EXISTS(SELECT sequence,record_type,id,user_id,session_id,operation,outcome,CASE WHEN record_type='request_admission' THEN accepted_at_ms ELSE occurred_at_ms END,pat_id,oauth_connection_id,oauth_credential_id,hosted_turn_id,attempt_id,transition FROM audit_entries WHERE record_type<>'oauth_refresh' EXCEPT SELECT sequence,record_type,id,user_id,session_id,operation,outcome,occurred_at_ms,pat_id,oauth_connection_id,oauth_credential_id,hosted_turn_id,attempt_id,transition FROM audit_entries_1446)
 THEN 1 ELSE 0 END ON CONFLICT(scope) DO UPDATE SET accepted=excluded.accepted;
-- oauth-lineage-copy:end

-- oauth-lineage-replace:start
DROP TABLE audit_entries;
DROP TABLE oauth_credentials;
ALTER TABLE oauth_credentials_1446 RENAME TO oauth_credentials;
ALTER TABLE audit_entries_1446 RENAME TO audit_entries;
-- oauth-lineage-replace:end

-- oauth-lineage-verify:start
INSERT INTO sql_assertions(scope,accepted)
SELECT 'oauth_lineage_cutover',CASE WHEN NOT EXISTS(SELECT 1 FROM pragma_foreign_key_check)
 THEN 1 ELSE 0 END ON CONFLICT(scope) DO UPDATE SET accepted=excluded.accepted;
DELETE FROM sql_assertions WHERE scope='oauth_lineage_cutover';
-- oauth-lineage-verify:end

-- oauth-intent-preflight:start
INSERT INTO sql_assertions(scope,accepted)
SELECT 'oauth_intent_cutover',CASE WHEN
 NOT EXISTS(SELECT 1 FROM erasure_permits) AND NOT EXISTS(SELECT 1 FROM erasure_chunk)
 AND NOT EXISTS(SELECT 1 FROM pragma_foreign_key_check)
 AND NOT EXISTS(SELECT 1 FROM oauth_operation_intents i WHERE
  NOT EXISTS(SELECT 1 FROM oauth_connections g WHERE g.id=i.connection_id AND g.user_id=i.user_id)
  OR (i.browser_approved_at_ms IS NULL)<>(i.browser_session_id IS NULL)
  OR (i.browser_approved_at_ms IS NOT NULL AND (
   typeof(i.browser_approved_at_ms)<>'integer' OR i.browser_approved_at_ms<i.created_at_ms OR i.browser_approved_at_ms>=i.expires_at_ms
   OR NOT EXISTS(SELECT 1 FROM web_sessions s WHERE s.id=i.browser_session_id AND s.user_id=i.user_id))))
 THEN 1 ELSE 0 END ON CONFLICT(scope) DO UPDATE SET accepted=excluded.accepted;
-- oauth-intent-preflight:end

-- oauth-intent-verify:start
INSERT INTO sql_assertions(scope,accepted)
SELECT 'oauth_intent_cutover',CASE WHEN NOT EXISTS(SELECT 1 FROM pragma_foreign_key_check)
 THEN 1 ELSE 0 END ON CONFLICT(scope) DO UPDATE SET accepted=excluded.accepted;
DELETE FROM sql_assertions WHERE scope='oauth_intent_cutover';
-- oauth-intent-verify:end

-- pat-grants-preflight:start
INSERT INTO sql_assertions(scope,accepted)
SELECT 'pat_grants_cutover',CASE WHEN
 NOT EXISTS(SELECT 1 FROM erasure_permits) AND NOT EXISTS(SELECT 1 FROM erasure_chunk)
 AND NOT EXISTS(SELECT 1 FROM pragma_foreign_key_check)
 AND NOT EXISTS(SELECT 1 FROM pat_pairings q WHERE
  (q.approved_at_ms IS NOT NULL AND (q.approved_at_ms<q.created_at_ms OR q.approved_at_ms>=q.expires_at_ms
   OR NOT EXISTS(SELECT 1 FROM consent_history g WHERE g.record_type='pat_grant'
    AND g.pairing_id=q.id AND g.user_id=q.user_id AND g.occurred_at_ms=q.approved_at_ms))))
 AND NOT EXISTS(SELECT 1 FROM pats p WHERE p.expires_at_ms<=p.issued_at_ms
  OR (p.request_id IS NOT NULL AND (p.created_at_ms<>p.issued_at_ms
   OR NOT EXISTS(SELECT 1 FROM consent_history g WHERE g.record_type='pat_grant'
    AND g.request_id=p.request_id AND g.user_id=p.user_id AND g.occurred_at_ms=p.created_at_ms)))
  OR (p.pairing_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM pat_pairings q
   WHERE q.id=p.pairing_id AND q.user_id=p.user_id AND q.state='claimed'
    AND q.approved_at_ms=p.created_at_ms AND q.expires_at_ms>p.issued_at_ms
    AND q.pat_expires_at_ms>=p.expires_at_ms AND p.issued_at_ms>=q.approved_at_ms
    AND q.recipient_label=p.recipient_label AND q.scopes_json=p.scopes_json AND q.lifetime_days=p.lifetime_days)))
 THEN 1 ELSE 0 END ON CONFLICT(scope) DO UPDATE SET accepted=excluded.accepted;
-- pat-grants-preflight:end

-- pat-grants-verify:start
INSERT INTO sql_assertions(scope,accepted)
SELECT 'pat_grants_cutover',CASE WHEN NOT EXISTS(SELECT 1 FROM pragma_foreign_key_check)
 THEN 1 ELSE 0 END ON CONFLICT(scope) DO UPDATE SET accepted=excluded.accepted;
DELETE FROM sql_assertions WHERE scope='pat_grants_cutover';
-- pat-grants-verify:end

-- subscription-source-preflight:start
PRAGMA defer_foreign_keys=ON;
INSERT INTO sql_assertions(scope,accepted)
SELECT 'subscription_source_cutover',CASE WHEN
 NOT EXISTS(SELECT 1 FROM erasure_permits) AND NOT EXISTS(SELECT 1 FROM erasure_chunk)
 AND NOT EXISTS(SELECT 1 FROM erasure_requests WHERE state<>'Complete')
 AND NOT EXISTS(SELECT 1 FROM pragma_foreign_key_check)
 AND NOT EXISTS(SELECT 1 FROM card_enrollments e WHERE e.payment_source_id IS NOT NULL AND (
  e.source_method<>e.method OR e.source_billing_email<>e.billing_email
  OR (e.wompi_environment IS NULL AND (SELECT count(DISTINCT a.wompi_environment) FROM billing_attempts a WHERE a.payment_source_id=e.payment_source_id)<>1)
  OR EXISTS(SELECT 1 FROM billing_attempts a WHERE a.payment_source_id=e.payment_source_id
   AND (a.user_id<>e.user_id OR (e.wompi_environment IS NOT NULL AND a.wompi_environment<>e.wompi_environment)))))
 AND NOT EXISTS(SELECT 1 FROM billing_attempts a WHERE NOT EXISTS(SELECT 1 FROM card_enrollments e
  JOIN card_enrollments origin ON origin.payment_source_id=a.payment_source_id
  WHERE e.id=a.enrollment_id AND e.user_id=a.user_id AND origin.user_id=a.user_id
   AND e.method=origin.source_method AND (e.wompi_environment IS NULL OR e.wompi_environment=a.wompi_environment)))
 AND NOT EXISTS(SELECT 1 FROM card_enrollments e WHERE
  (e.status='available' AND e.payment_source_id IS NULL AND (SELECT count(DISTINCT a.payment_source_id) FROM billing_attempts a WHERE a.enrollment_id=e.id)<>1)
  OR (SELECT count(DISTINCT a.payment_source_id) FROM billing_attempts a WHERE a.enrollment_id=e.id)>1)
 AND NOT EXISTS(SELECT 1 FROM refund_attempts r JOIN users u ON u.id=r.user_id WHERE u.subscription_id IS NOT r.subscription_id)
 THEN 1 ELSE 0 END ON CONFLICT(scope) DO UPDATE SET accepted=excluded.accepted;
-- subscription-source-preflight:end

-- subscription-source-copy:start
INSERT INTO subscriptions(rowid,id,user_id)
SELECT u.rowid,COALESCE(u.subscription_id,lower(hex(randomblob(4))||'-'||hex(randomblob(2))||'-4'||substr(hex(randomblob(2)),2)||'-a'||substr(hex(randomblob(2)),2)||'-'||hex(randomblob(6)))),u.id
FROM users u WHERE u.subscription_id IS NOT NULL OR EXISTS(SELECT 1 FROM card_enrollments e WHERE e.user_id=u.id);
INSERT INTO payment_enrollments(rowid,id,subscription_id,price_id,billing_email,status,payment_source_mode,contracts_json,disclosure_json,prepared_at_ms,expires_at_ms,accepted_at_ms,payment_request_id,wompi_candidate_source_id,verification_attempts,last_verification_at_ms,refusal_reason,method,wompi_environment,authorization_digest,payment_source_id)
SELECT e.rowid,e.id,s.id,e.price_id,e.billing_email,e.status,e.payment_source_mode,e.contracts_json,e.disclosure_json,e.prepared_at_ms,e.expires_at_ms,e.accepted_at_ms,e.payment_request_id,e.wompi_candidate_source_id,e.verification_attempts,e.last_verification_at_ms,e.refusal_reason,e.method,COALESCE(e.wompi_environment,(SELECT a.wompi_environment FROM billing_attempts a WHERE a.enrollment_id=e.id LIMIT 1)),e.authorization_digest,COALESCE(e.payment_source_id,(SELECT a.payment_source_id FROM billing_attempts a WHERE a.enrollment_id=e.id LIMIT 1))
FROM card_enrollments e JOIN subscriptions s ON s.user_id=e.user_id;
INSERT INTO payment_sources(id,subscription_id,origin_enrollment_id,wompi_environment,wompi_source_id,billing_email,method,verified_at_ms,retired_at_ms,archive_row_ref)
SELECT e.payment_source_id,s.id,e.id,COALESCE(e.wompi_environment,(SELECT a.wompi_environment FROM billing_attempts a WHERE a.payment_source_id=e.payment_source_id LIMIT 1)),e.source_wompi_id,e.source_billing_email,e.source_method,e.source_created_at_ms,e.source_retired_at_ms,COALESCE(e.source_row_ref,'source:'||e.payment_source_id)
FROM card_enrollments e JOIN subscriptions s ON s.user_id=e.user_id WHERE e.payment_source_id IS NOT NULL;
-- subscription-source-copy:end

-- subscription-source-copy-check:start
INSERT INTO sql_assertions(scope,accepted)
SELECT 'subscription_source_cutover',CASE WHEN
 (SELECT count(*) FROM card_enrollments)=(SELECT count(*) FROM payment_enrollments)
 AND (SELECT count(*) FROM card_enrollments WHERE payment_source_id IS NOT NULL)=(SELECT count(*) FROM payment_sources)
 AND NOT EXISTS(SELECT rowid,subscription_id,id FROM users WHERE subscription_id IS NOT NULL
  EXCEPT SELECT rowid,id,user_id FROM subscriptions)
 AND NOT EXISTS(SELECT e.rowid,e.id,e.user_id,e.price_id,e.billing_email,e.status,e.payment_source_mode,e.contracts_json,e.disclosure_json,e.prepared_at_ms,e.expires_at_ms,e.accepted_at_ms,e.payment_request_id,e.wompi_candidate_source_id,e.verification_attempts,e.last_verification_at_ms,e.refusal_reason,e.method,e.authorization_digest FROM card_enrollments e
  EXCEPT SELECT e.rowid,e.id,s.user_id,e.price_id,e.billing_email,e.status,e.payment_source_mode,e.contracts_json,e.disclosure_json,e.prepared_at_ms,e.expires_at_ms,e.accepted_at_ms,e.payment_request_id,e.wompi_candidate_source_id,e.verification_attempts,e.last_verification_at_ms,e.refusal_reason,e.method,e.authorization_digest FROM payment_enrollments e JOIN subscriptions s ON s.id=e.subscription_id)
 AND NOT EXISTS(SELECT e.payment_source_id,e.user_id,e.id,e.source_wompi_id,e.source_billing_email,e.source_method,e.source_created_at_ms,e.source_retired_at_ms,COALESCE(e.source_row_ref,'source:'||e.payment_source_id) FROM card_enrollments e WHERE e.payment_source_id IS NOT NULL
  EXCEPT SELECT p.id,s.user_id,p.origin_enrollment_id,p.wompi_source_id,p.billing_email,p.method,p.verified_at_ms,p.retired_at_ms,p.archive_row_ref FROM payment_sources p JOIN subscriptions s ON s.id=p.subscription_id)
 THEN 1 ELSE 0 END ON CONFLICT(scope) DO UPDATE SET accepted=excluded.accepted;
-- subscription-source-copy-check:end

-- subscription-source-verify:start
INSERT INTO sql_assertions(scope,accepted)
SELECT 'subscription_source_cutover',CASE WHEN NOT EXISTS(SELECT 1 FROM pragma_foreign_key_check)
 AND NOT EXISTS(SELECT 1 FROM payment_enrollments e JOIN payment_sources p ON p.id=e.payment_source_id
  WHERE e.subscription_id<>p.subscription_id OR e.method<>p.method OR e.wompi_environment IS NOT p.wompi_environment)
 THEN 1 ELSE 0 END ON CONFLICT(scope) DO UPDATE SET accepted=excluded.accepted;
DELETE FROM sql_assertions WHERE scope='subscription_source_cutover';
PRAGMA defer_foreign_keys=OFF;
-- subscription-source-verify:end

-- subscription-standing-preflight:start
PRAGMA defer_foreign_keys=ON;
INSERT INTO sql_assertions(scope,accepted)
SELECT 'subscription-standing-commercial',NOT EXISTS (
 SELECT 1 FROM billing_attempts a LEFT JOIN subscription_prices p ON p.id=a.price_id
 WHERE p.id IS NULL OR a.amount IS NOT p.amount OR a.currency IS NOT p.currency
 OR a.billing_period IS NOT p.billing_period OR a.service_market IS NOT p.service_market
 OR a.tax_treatment IS NOT p.tax_treatment);
INSERT INTO sql_assertions(scope,accepted)
SELECT 'subscription-standing-owner',NOT EXISTS (
 SELECT 1 FROM billing_attempts a LEFT JOIN subscriptions s ON s.user_id=a.user_id
 LEFT JOIN payment_enrollments e ON e.id=a.enrollment_id
 LEFT JOIN payment_sources source ON source.id=a.payment_source_id
 LEFT JOIN billing_attempts prior ON prior.id=a.previous_paid_attempt_id
 WHERE s.id IS NULL OR e.subscription_id IS NOT s.id OR source.subscription_id IS NOT s.id
 OR source.wompi_environment IS NOT a.wompi_environment
 OR (a.previous_paid_attempt_id IS NOT NULL AND (prior.user_id IS NOT a.user_id OR prior.paid_starts_at_ms IS NULL)));
INSERT INTO sql_assertions(scope,accepted)
SELECT 'subscription-standing-selected',NOT EXISTS (
 SELECT 1 FROM users u LEFT JOIN subscriptions s ON s.user_id=u.id
 LEFT JOIN billing_attempts a ON a.id=u.paid_attempt_id
 WHERE (u.paid_attempt_id IS NULL AND (u.paid_price_id IS NOT NULL OR u.paid_period_ends_at_ms IS NOT NULL OR u.paid_renewal_anchor_ms IS NOT NULL))
 OR (u.paid_attempt_id IS NOT NULL AND (s.id IS NULL OR a.user_id IS NOT u.id OR a.status IS NOT 'succeeded'
 OR a.paid_starts_at_ms IS NULL OR u.paid_price_id IS NOT a.price_id
 OR u.paid_period_ends_at_ms IS NOT a.paid_ends_at_ms OR u.paid_renewal_anchor_ms IS NOT a.paid_renewal_anchor_ms)));
INSERT INTO sql_assertions(scope,accepted)
SELECT 'subscription-standing-no-charge',NOT EXISTS (
 SELECT 1 FROM billing_attempts a WHERE
 (a.no_charge_confirmed_at_ms IS NULL AND (a.no_charge_reference IS NOT NULL OR a.no_charge_environment IS NOT NULL OR a.no_charge_case_id IS NOT NULL OR a.no_charge_operator_id IS NOT NULL))
 OR (a.no_charge_confirmed_at_ms IS NOT NULL AND (a.no_charge_reference IS NOT a.wompi_reference OR a.no_charge_environment IS NOT a.wompi_environment OR a.no_charge_case_id IS NULL OR a.no_charge_operator_id IS NULL))
 OR ((a.recovery_case_id IS NULL)<>(a.recovery_reviewed_at_ms IS NULL))
 OR (a.recovery_reviewed_at_ms IS NOT NULL AND (a.recovery_case_id IS NOT a.no_charge_case_id OR a.no_charge_confirmed_at_ms IS NULL OR a.status IS NOT 'succeeded')));
-- subscription-standing-preflight:end

-- subscription-standing-copy:start
INSERT INTO users_1450(rowid,id,service_market,locale,time_zone,created_at_ms,trial_started_at_ms,trial_ends_at_ms,forwarding_address_id,forwarding_local_part,forwarding_issued_at_ms,backfill_present,backfill_submission_id,backfill_consumed_at_ms,whatsapp_portfolio_id,whatsapp_bsuid,whatsapp_verified_at_ms,route_portfolio_id,route_bsuid,route_phone_number_id,route_verified_at_ms,cancellation_paid_attempt_id,cancellation_payment_source_id,cancellation_cancelled_at_ms,cancellation_paid_through_ms,cancellation_source_cancellation,cancellation_void_started_at_ms,cancellation_void_verified_at_ms,cancellation_verification_count,cancellation_last_offered_at_ms)
SELECT r.rowid,r.id,r.service_market,r.locale,r.time_zone,r.created_at_ms,r.trial_started_at_ms,r.trial_ends_at_ms,r.forwarding_address_id,r.forwarding_local_part,r.forwarding_issued_at_ms,r.backfill_present,r.backfill_submission_id,r.backfill_consumed_at_ms,r.whatsapp_portfolio_id,r.whatsapp_bsuid,r.whatsapp_verified_at_ms,r.route_portfolio_id,r.route_bsuid,r.route_phone_number_id,r.route_verified_at_ms,r.cancellation_paid_attempt_id,r.cancellation_payment_source_id,r.cancellation_cancelled_at_ms,r.cancellation_paid_through_ms,r.cancellation_source_cancellation,r.cancellation_void_started_at_ms,r.cancellation_void_verified_at_ms,r.cancellation_verification_count,r.cancellation_last_offered_at_ms FROM users r;
INSERT INTO subscriptions_1450(rowid,id,user_id,current_paid_attempt_id)
SELECT r.rowid,r.id,r.user_id,(SELECT paid_attempt_id FROM users WHERE id=r.user_id) FROM subscriptions r;
INSERT INTO billing_attempts_1450(rowid,id,subscription_id,enrollment_id,payment_request_id,payment_source_id,price_id,time_zone,wompi_environment,wompi_reference,status,created_at_ms,finalized_at_ms,previous_paid_attempt_id,period_starts_at_ms,period_ends_at_ms,calendar_anchor_ms,renewal_attempt_number,paid_starts_at_ms,paid_ends_at_ms,paid_renewal_anchor_ms,checkout_transaction_id,collection_state,collection_sent_at_ms,collection_last_attempt_at_ms,followup_due_at_ms,no_charge_case_id,no_charge_operator_id,no_charge_confirmed_at_ms,late_approval_observed_at_ms)
SELECT r.rowid,r.id,(SELECT id FROM subscriptions WHERE user_id=r.user_id),r.enrollment_id,r.payment_request_id,r.payment_source_id,r.price_id,r.time_zone,r.wompi_environment,r.wompi_reference,r.status,r.created_at_ms,r.finalized_at_ms,r.previous_paid_attempt_id,r.period_starts_at_ms,r.period_ends_at_ms,r.calendar_anchor_ms,r.renewal_attempt_number,r.paid_starts_at_ms,r.paid_ends_at_ms,r.paid_renewal_anchor_ms,r.checkout_transaction_id,r.collection_state,r.collection_sent_at_ms,r.collection_last_attempt_at_ms,r.followup_due_at_ms,r.no_charge_case_id,r.no_charge_operator_id,r.no_charge_confirmed_at_ms,r.recovery_reviewed_at_ms FROM billing_attempts r;
-- subscription-standing-copy:end

-- subscription-standing-copy-check:start
INSERT INTO sql_assertions(scope,accepted) SELECT 'subscription-standing-copy-users',
 (SELECT count(*) FROM users)=(SELECT count(*) FROM users_1450) AND NOT EXISTS (
 SELECT 1 FROM users r LEFT JOIN users_1450 t ON t.rowid=r.rowid WHERE t.rowid IS NULL OR t.id IS NOT r.id
 OR t.service_market IS NOT r.service_market
 OR t.locale IS NOT r.locale
 OR t.time_zone IS NOT r.time_zone
 OR t.created_at_ms IS NOT r.created_at_ms
 OR t.trial_started_at_ms IS NOT r.trial_started_at_ms
 OR t.trial_ends_at_ms IS NOT r.trial_ends_at_ms
 OR t.forwarding_address_id IS NOT r.forwarding_address_id
 OR t.forwarding_local_part IS NOT r.forwarding_local_part
 OR t.forwarding_issued_at_ms IS NOT r.forwarding_issued_at_ms
 OR t.backfill_present IS NOT r.backfill_present
 OR t.backfill_submission_id IS NOT r.backfill_submission_id
 OR t.backfill_consumed_at_ms IS NOT r.backfill_consumed_at_ms
 OR t.whatsapp_portfolio_id IS NOT r.whatsapp_portfolio_id
 OR t.whatsapp_bsuid IS NOT r.whatsapp_bsuid
 OR t.whatsapp_verified_at_ms IS NOT r.whatsapp_verified_at_ms
 OR t.route_portfolio_id IS NOT r.route_portfolio_id
 OR t.route_bsuid IS NOT r.route_bsuid
 OR t.route_phone_number_id IS NOT r.route_phone_number_id
 OR t.route_verified_at_ms IS NOT r.route_verified_at_ms
 OR t.cancellation_paid_attempt_id IS NOT r.cancellation_paid_attempt_id
 OR t.cancellation_payment_source_id IS NOT r.cancellation_payment_source_id
 OR t.cancellation_cancelled_at_ms IS NOT r.cancellation_cancelled_at_ms
 OR t.cancellation_paid_through_ms IS NOT r.cancellation_paid_through_ms
 OR t.cancellation_source_cancellation IS NOT r.cancellation_source_cancellation
 OR t.cancellation_void_started_at_ms IS NOT r.cancellation_void_started_at_ms
 OR t.cancellation_void_verified_at_ms IS NOT r.cancellation_void_verified_at_ms
 OR t.cancellation_verification_count IS NOT r.cancellation_verification_count
 OR t.cancellation_last_offered_at_ms IS NOT r.cancellation_last_offered_at_ms);
INSERT INTO sql_assertions(scope,accepted) SELECT 'subscription-standing-copy-subscriptions',
 (SELECT count(*) FROM subscriptions)=(SELECT count(*) FROM subscriptions_1450) AND NOT EXISTS (
 SELECT 1 FROM subscriptions r LEFT JOIN subscriptions_1450 t ON t.rowid=r.rowid WHERE t.rowid IS NULL OR t.id IS NOT r.id
 OR t.user_id IS NOT r.user_id
 OR t.current_paid_attempt_id IS NOT (SELECT paid_attempt_id FROM users WHERE id=r.user_id));
INSERT INTO sql_assertions(scope,accepted) SELECT 'subscription-standing-copy-billing_attempts',
 (SELECT count(*) FROM billing_attempts)=(SELECT count(*) FROM billing_attempts_1450) AND NOT EXISTS (
 SELECT 1 FROM billing_attempts r LEFT JOIN billing_attempts_1450 t ON t.rowid=r.rowid WHERE t.rowid IS NULL OR t.id IS NOT r.id
 OR t.subscription_id IS NOT (SELECT id FROM subscriptions WHERE user_id=r.user_id)
 OR t.enrollment_id IS NOT r.enrollment_id
 OR t.payment_request_id IS NOT r.payment_request_id
 OR t.payment_source_id IS NOT r.payment_source_id
 OR t.price_id IS NOT r.price_id
 OR t.time_zone IS NOT r.time_zone
 OR t.wompi_environment IS NOT r.wompi_environment
 OR t.wompi_reference IS NOT r.wompi_reference
 OR t.status IS NOT r.status
 OR t.created_at_ms IS NOT r.created_at_ms
 OR t.finalized_at_ms IS NOT r.finalized_at_ms
 OR t.previous_paid_attempt_id IS NOT r.previous_paid_attempt_id
 OR t.period_starts_at_ms IS NOT r.period_starts_at_ms
 OR t.period_ends_at_ms IS NOT r.period_ends_at_ms
 OR t.calendar_anchor_ms IS NOT r.calendar_anchor_ms
 OR t.renewal_attempt_number IS NOT r.renewal_attempt_number
 OR t.paid_starts_at_ms IS NOT r.paid_starts_at_ms
 OR t.paid_ends_at_ms IS NOT r.paid_ends_at_ms
 OR t.paid_renewal_anchor_ms IS NOT r.paid_renewal_anchor_ms
 OR t.checkout_transaction_id IS NOT r.checkout_transaction_id
 OR t.collection_state IS NOT r.collection_state
 OR t.collection_sent_at_ms IS NOT r.collection_sent_at_ms
 OR t.collection_last_attempt_at_ms IS NOT r.collection_last_attempt_at_ms
 OR t.followup_due_at_ms IS NOT r.followup_due_at_ms
 OR t.no_charge_case_id IS NOT r.no_charge_case_id
 OR t.no_charge_operator_id IS NOT r.no_charge_operator_id
 OR t.no_charge_confirmed_at_ms IS NOT r.no_charge_confirmed_at_ms
 OR t.late_approval_observed_at_ms IS NOT r.recovery_reviewed_at_ms);
-- subscription-standing-copy-check:end

-- subscription-standing-user-remove:start
DROP TABLE users_1450;
ALTER TABLE users DROP COLUMN paid_renewal_anchor_ms;
ALTER TABLE users DROP COLUMN paid_period_ends_at_ms;
ALTER TABLE users DROP COLUMN paid_price_id;
ALTER TABLE users DROP COLUMN paid_attempt_id;
-- subscription-standing-user-remove:end

-- subscription-standing-verify:start
INSERT INTO sql_assertions(scope,accepted)
SELECT 'subscription-standing-final-owner',NOT EXISTS (
 SELECT 1 FROM subscriptions s JOIN billing_attempts a ON a.id=s.current_paid_attempt_id
 WHERE a.subscription_id<>s.id OR a.status<>'succeeded' OR a.paid_starts_at_ms IS NULL);
INSERT INTO sql_assertions(scope,accepted)
SELECT 'subscription-standing-final-fks',NOT EXISTS(SELECT 1 FROM pragma_foreign_key_check);
PRAGMA defer_foreign_keys=OFF;
-- subscription-standing-verify:end

-- subscription-cancellation-preflight:start
INSERT INTO sql_assertions(scope,accepted)
SELECT 'subscription-cancellation-preflight',CASE WHEN NOT EXISTS (
 SELECT 1 FROM users u LEFT JOIN subscriptions s ON s.user_id=u.id
 LEFT JOIN billing_attempts a ON a.id=u.cancellation_paid_attempt_id
 LEFT JOIN payment_sources p ON p.id=u.cancellation_payment_source_id
 WHERE u.cancellation_cancelled_at_ms IS NOT NULL AND (
  s.id IS NULL OR a.id IS NULL OR p.id IS NULL OR a.subscription_id IS NOT s.id
  OR p.subscription_id IS NOT s.id OR a.payment_source_id IS NOT p.id
  OR a.status<>'succeeded' OR a.paid_starts_at_ms IS NULL
  OR u.cancellation_paid_through_ms>a.paid_ends_at_ms
  OR u.cancellation_verification_count NOT BETWEEN 0 AND 8
  OR u.cancellation_source_cancellation NOT IN ('detached','void-pending','voided')
 )) THEN 1 ELSE 0 END;
-- subscription-cancellation-preflight:end

-- subscription-cancellation-copy:start
INSERT INTO subscription_cancellations(rowid,subscription_id,paid_attempt_id,payment_source_id,cancelled_at_ms,paid_through_ms,source_cancellation_state,void_started_at_ms,void_verified_at_ms,verification_count,last_offered_at_ms)
SELECT u.rowid,s.id,u.cancellation_paid_attempt_id,u.cancellation_payment_source_id,u.cancellation_cancelled_at_ms,u.cancellation_paid_through_ms,u.cancellation_source_cancellation,u.cancellation_void_started_at_ms,u.cancellation_void_verified_at_ms,u.cancellation_verification_count,u.cancellation_last_offered_at_ms FROM users u JOIN subscriptions s ON s.user_id=u.id WHERE u.cancellation_cancelled_at_ms IS NOT NULL;
-- subscription-cancellation-copy:end

-- subscription-cancellation-copy-check:start
INSERT INTO sql_assertions(scope,accepted)
SELECT 'subscription-cancellation-copy',CASE WHEN
 (SELECT count(*) FROM subscription_cancellations)=(SELECT count(*) FROM users WHERE cancellation_cancelled_at_ms IS NOT NULL)
 AND NOT EXISTS(SELECT 1 FROM users u JOIN subscriptions s ON s.user_id=u.id
 LEFT JOIN subscription_cancellations c ON c.subscription_id=s.id
 WHERE u.cancellation_cancelled_at_ms IS NOT NULL AND (c.rowid IS NOT u.rowid
  OR c.paid_attempt_id IS NOT u.cancellation_paid_attempt_id
  OR c.payment_source_id IS NOT u.cancellation_payment_source_id
  OR c.cancelled_at_ms IS NOT u.cancellation_cancelled_at_ms
  OR c.paid_through_ms IS NOT u.cancellation_paid_through_ms
  OR c.source_cancellation_state IS NOT u.cancellation_source_cancellation
  OR c.void_started_at_ms IS NOT u.cancellation_void_started_at_ms
  OR c.void_verified_at_ms IS NOT u.cancellation_void_verified_at_ms
  OR c.verification_count IS NOT u.cancellation_verification_count
  OR c.last_offered_at_ms IS NOT u.cancellation_last_offered_at_ms
)) THEN 1 ELSE 0 END;
-- subscription-cancellation-copy-check:end

-- subscription-cancellation-remove:start
ALTER TABLE users DROP COLUMN cancellation_last_offered_at_ms;
ALTER TABLE users DROP COLUMN cancellation_verification_count;
ALTER TABLE users DROP COLUMN cancellation_void_verified_at_ms;
ALTER TABLE users DROP COLUMN cancellation_void_started_at_ms;
ALTER TABLE users DROP COLUMN cancellation_source_cancellation;
ALTER TABLE users DROP COLUMN cancellation_paid_through_ms;
ALTER TABLE users DROP COLUMN cancellation_cancelled_at_ms;
ALTER TABLE users DROP COLUMN cancellation_payment_source_id;
ALTER TABLE users DROP COLUMN cancellation_paid_attempt_id;
-- subscription-cancellation-remove:end

-- subscription-cancellation-verify:start
INSERT INTO sql_assertions(scope,accepted)
SELECT 'subscription-cancellation-final',CASE WHEN NOT EXISTS(SELECT 1 FROM pragma_foreign_key_check) THEN 1 ELSE 0 END;
-- subscription-cancellation-verify:end

-- subscription-refund-preflight:start
INSERT INTO sql_assertions(scope,accepted)
SELECT 'subscription-refund-preflight',CASE WHEN NOT EXISTS(
 SELECT 1 FROM refund_attempts r LEFT JOIN refund_charge_context a ON a.id=r.billing_attempt_id
 WHERE a.id IS NULL OR r.user_id IS NOT a.user_id OR r.subscription_id IS NOT a.subscription_id
 OR r.original_cents IS NOT a.original_cents
 OR json_extract(r.intent_json,'$.userId') IS NOT r.user_id
 OR json_extract(r.intent_json,'$.billingAttemptId') IS NOT r.billing_attempt_id
 OR json_extract(r.intent_json,'$.requestId') IS NOT r.request_id
 OR json_extract(r.intent_json,'$.intent.kind') IS NOT r.kind
 OR json_extract(r.snapshot_json,'$.id') IS NOT r.id
 OR json_extract(r.snapshot_json,'$.userId') IS NOT r.user_id
 OR json_extract(r.snapshot_json,'$.subscriptionId') IS NOT r.subscription_id
 OR json_extract(r.snapshot_json,'$.billingAttemptId') IS NOT r.billing_attempt_id
 OR json_extract(r.snapshot_json,'$.priceId') IS NOT a.price_id
 OR json_extract(r.snapshot_json,'$.kind') IS NOT r.kind
 OR json_extract(r.snapshot_json,'$.requestId') IS NOT r.request_id
 OR json_extract(r.snapshot_json,'$.reason') IS NOT json_extract(r.intent_json,'$.reason')
 OR json_extract(r.snapshot_json,'$.reason') NOT IN('user-request','duplicate-collection','service-error')
 OR json_extract(r.snapshot_json,'$.money.currency') IS NOT a.currency
 OR json_extract(r.snapshot_json,'$.money.amount') IS NOT
   (CAST(CAST(r.amount_in_cents/100 AS INTEGER) AS TEXT)||CASE WHEN r.amount_in_cents%100=0 THEN '' ELSE '.'||rtrim(printf('%02d',r.amount_in_cents%100),'0') END)
 OR (r.kind='refund' AND (json_extract(r.intent_json,'$.intent.money.amount') IS NOT json_extract(r.snapshot_json,'$.money.amount')
   OR json_extract(r.intent_json,'$.intent.money.currency') IS NOT a.currency))
 OR (r.kind='card-void' AND r.amount_in_cents<>a.original_cents)
 OR json_extract(r.snapshot_json,'$.createdAt') IS NOT
   (strftime('%Y-%m-%dT%H:%M:%S',CAST(r.created_at_ms/1000 AS INTEGER),'unixepoch')||printf('.%03dZ',r.created_at_ms%1000))
 OR json_extract(r.snapshot_json,'$.status') IS NOT 'pending'
 OR json_extract(r.snapshot_json,'$.progress') IS NOT 'queued'
 OR json_extract(r.snapshot_json,'$.treatment.policyId') IS NOT 'refund-ends-paid-period-v1'
 OR json_extract(r.snapshot_json,'$.treatment.taxTreatment') IS NOT a.tax_treatment
 OR json_extract(r.snapshot_json,'$.treatment.paidPeriodEffect') IS NOT 'end-refunded-period-at-verification'
 OR json_extract(r.snapshot_json,'$.treatment.renewalEffect') IS NOT 'stop-future-renewals'
 OR json_extract(r.snapshot_json,'$.treatment.accounting.kind') IS NOT 'sandbox-only'
 OR (r.adjusted_attempt_id IS NOT NULL AND r.adjusted_attempt_id IS NOT r.billing_attempt_id)
 OR (r.renewal_stopped_user_id IS NOT NULL AND r.renewal_stopped_user_id IS NOT r.user_id)
 OR NOT EXISTS(SELECT 1 FROM billing_provider_transactions e WHERE e.transaction_id=r.transaction_id AND e.attempt_id=r.billing_attempt_id AND e.status='APPROVED')
 OR a.wompi_environment<>'sandbox' OR a.status<>'succeeded' OR a.paid_starts_at_ms IS NULL
 OR (SELECT COUNT(*) FROM billing_provider_transactions e WHERE e.attempt_id=a.id AND e.status='APPROVED')<>1
 OR (r.kind='card-void' AND NOT EXISTS(SELECT 1 FROM payment_source_context p WHERE p.id=a.payment_source_id AND p.method='card'))
 OR (r.status='succeeded' AND (r.verified_status NOT IN('APPROVED','VOIDED') OR r.observed_at_ms IS NULL OR r.finalized_at_ms IS NOT r.observed_at_ms OR r.access_ends_at_ms IS NOT r.observed_at_ms OR r.renewal_stopped_at_ms IS NOT r.observed_at_ms))
 OR (r.status='failed' AND (r.verified_status NOT IN('DECLINED','CANCELLED') OR r.observed_at_ms IS NULL OR r.finalized_at_ms IS NOT r.observed_at_ms))
 OR (SELECT SUM(other.amount_in_cents) FROM refund_attempts other WHERE other.billing_attempt_id=r.billing_attempt_id AND other.status<>'failed')>a.original_cents
) THEN 1 ELSE 0 END;
-- subscription-refund-preflight:end

-- subscription-refund-copy:start
INSERT INTO refund_attempts_1453(rowid,id,billing_attempt_id,wompi_environment,transaction_id,request_id,intent_json,treatment_json,amount_in_cents,kind,operator_id,created_at_ms,status,progress,finalized_at_ms,failure,dispatch_last_attempt_at_ms,verification_attempts,last_verification_at_ms,submission_claimed_at_ms,provider_refund_id,verified_status,observed_at_ms,access_ends_at_ms,renewal_stopped_at_ms)
 SELECT r.rowid,r.id,r.billing_attempt_id,a.wompi_environment,r.transaction_id,r.request_id,r.intent_json,json_extract(r.snapshot_json,'$.treatment'),r.amount_in_cents,r.kind,r.operator_id,r.created_at_ms,r.status,r.progress,r.finalized_at_ms,r.failure,r.dispatch_last_attempt_at_ms,r.verification_attempts,r.last_verification_at_ms,r.submission_claimed_at_ms,r.provider_refund_id,r.verified_status,r.observed_at_ms,r.access_ends_at_ms,r.renewal_stopped_at_ms
 FROM refund_attempts r JOIN refund_charge_context a ON a.id=r.billing_attempt_id;
-- subscription-refund-copy:end

-- subscription-refund-copy-check:start
INSERT INTO sql_assertions(scope,accepted)
SELECT 'subscription-refund-copy',CASE WHEN NOT EXISTS(
 SELECT rowid,id,billing_attempt_id,wompi_environment,transaction_id,request_id,intent_json,treatment_json,amount_in_cents,kind,operator_id,created_at_ms,status,progress,finalized_at_ms,failure,dispatch_last_attempt_at_ms,verification_attempts,last_verification_at_ms,submission_claimed_at_ms,provider_refund_id,verified_status,observed_at_ms,access_ends_at_ms,renewal_stopped_at_ms FROM refund_attempts_1453
 EXCEPT SELECT r.rowid,r.id,r.billing_attempt_id,a.wompi_environment,r.transaction_id,r.request_id,r.intent_json,json_extract(r.snapshot_json,'$.treatment'),r.amount_in_cents,r.kind,r.operator_id,r.created_at_ms,r.status,r.progress,r.finalized_at_ms,r.failure,r.dispatch_last_attempt_at_ms,r.verification_attempts,r.last_verification_at_ms,r.submission_claimed_at_ms,r.provider_refund_id,r.verified_status,r.observed_at_ms,r.access_ends_at_ms,r.renewal_stopped_at_ms FROM refund_attempts r JOIN refund_charge_context a ON a.id=r.billing_attempt_id
) AND (SELECT COUNT(*) FROM refund_attempts_1453)=(SELECT COUNT(*) FROM refund_attempts) THEN 1 ELSE 0 END;
-- subscription-refund-copy-check:end

-- subscription-refund-swap:start
DROP TABLE refund_attempts;
ALTER TABLE refund_attempts_1453 RENAME TO refund_attempts;
-- subscription-refund-swap:end

-- subscription-refund-verify:start
INSERT INTO sql_assertions(scope,accepted)
SELECT 'subscription-refund-final',CASE WHEN NOT EXISTS(SELECT 1 FROM pragma_foreign_key_check) THEN 1 ELSE 0 END;
-- subscription-refund-verify:end

-- subscription-price-notice-preflight:start
INSERT INTO sql_assertions(scope,accepted)
SELECT 'subscription-price-notice-preflight',CASE WHEN NOT EXISTS(
 SELECT 1 FROM billing_price_notices n LEFT JOIN subscriptions s ON s.user_id=n.user_id
 WHERE s.id IS NULL OR (n.accepted_at_ms IS NOT NULL AND n.send_started_at_ms IS NULL)
) THEN 1 ELSE 0 END;
-- subscription-price-notice-preflight:end

-- subscription-price-notice-copy:start
INSERT INTO billing_price_notices_1454(rowid,subscription_id,price_id,created_at_ms,last_offered_at_ms,send_started_at_ms,provider_accepted_at_ms)
SELECT n.rowid,s.id,n.price_id,n.created_at_ms,n.last_offered_at_ms,n.send_started_at_ms,n.accepted_at_ms
FROM billing_price_notices n JOIN subscriptions s ON s.user_id=n.user_id;
-- subscription-price-notice-copy:end

-- subscription-price-notice-copy-check:start
INSERT INTO sql_assertions(scope,accepted)
SELECT 'subscription-price-notice-copy',CASE WHEN NOT EXISTS(
 SELECT rowid,subscription_id,price_id,created_at_ms,last_offered_at_ms,send_started_at_ms,provider_accepted_at_ms FROM billing_price_notices_1454
 EXCEPT SELECT n.rowid,s.id,n.price_id,n.created_at_ms,n.last_offered_at_ms,n.send_started_at_ms,n.accepted_at_ms FROM billing_price_notices n JOIN subscriptions s ON s.user_id=n.user_id
) AND (SELECT COUNT(*) FROM billing_price_notices_1454)=(SELECT COUNT(*) FROM billing_price_notices) THEN 1 ELSE 0 END;
-- subscription-price-notice-copy-check:end

-- subscription-price-notice-swap:start
DROP TABLE billing_price_notices;
ALTER TABLE billing_price_notices_1454 RENAME TO billing_price_notices;
-- subscription-price-notice-swap:end

-- subscription-price-notice-verify:start
INSERT INTO sql_assertions(scope,accepted)
SELECT 'subscription-price-notice-final',CASE WHEN NOT EXISTS(SELECT 1 FROM pragma_foreign_key_check) THEN 1 ELSE 0 END;
-- subscription-price-notice-verify:end

-- forwarding-address-preflight:start
INSERT INTO sql_assertions(scope,accepted)
SELECT 'forwarding-address-preflight',CASE WHEN NOT EXISTS(
 SELECT 1 FROM users WHERE
 (forwarding_address_id IS NULL OR forwarding_local_part IS NULL OR forwarding_issued_at_ms IS NULL)
 AND (forwarding_address_id IS NOT NULL OR forwarding_local_part IS NOT NULL OR forwarding_issued_at_ms IS NOT NULL)
) THEN 1 ELSE 0 END;
-- forwarding-address-preflight:end

-- forwarding-address-copy:start
INSERT INTO forwarding_addresses(rowid,id,user_id,local_part,issued_at_ms)
SELECT rowid,forwarding_address_id,id,forwarding_local_part,forwarding_issued_at_ms
FROM users WHERE forwarding_address_id IS NOT NULL;
-- forwarding-address-copy:end

-- forwarding-address-copy-check:start
INSERT INTO sql_assertions(scope,accepted)
SELECT 'forwarding-address-copy',CASE WHEN NOT EXISTS(
 SELECT rowid,id,user_id,local_part,issued_at_ms FROM forwarding_addresses
 EXCEPT SELECT rowid,forwarding_address_id,id,forwarding_local_part,forwarding_issued_at_ms
 FROM users WHERE forwarding_address_id IS NOT NULL
) AND (SELECT COUNT(*) FROM forwarding_addresses)=(SELECT COUNT(*) FROM users WHERE forwarding_address_id IS NOT NULL)
THEN 1 ELSE 0 END;
-- forwarding-address-copy-check:end

-- forwarding-address-swap:start
ALTER TABLE users DROP COLUMN forwarding_issued_at_ms;
ALTER TABLE users DROP COLUMN forwarding_local_part;
ALTER TABLE users DROP COLUMN forwarding_address_id;
-- forwarding-address-swap:end

-- forwarding-address-verify:start
INSERT INTO sql_assertions(scope,accepted)
SELECT 'forwarding-address-final',CASE WHEN NOT EXISTS(SELECT 1 FROM pragma_foreign_key_check) THEN 1 ELSE 0 END;
-- forwarding-address-verify:end

-- statement-materialization-preflight:start
INSERT INTO sql_assertions(scope,accepted)
SELECT 'statement-materialization-preflight',CASE WHEN NOT EXISTS(
 SELECT 1 FROM statement_submissions s LEFT JOIN statement_staging_objects o ON o.id=s.staging_id
 WHERE (s.material_state IS NULL AND (s.material_source_sha256 IS NOT NULL OR s.material_parts_sha256 IS NOT NULL
 OR s.material_representation_revision IS NOT NULL OR s.material_expires_at_ms IS NOT NULL OR s.material_headers_json IS NOT NULL
 OR s.material_row_count IS NOT NULL OR s.material_part_count IS NOT NULL OR s.material_byte_length IS NOT NULL))
 OR (s.material_state IS NOT NULL AND (s.material_source_sha256 IS NULL OR s.material_parts_sha256 IS NULL
 OR s.material_representation_revision IS NULL OR s.material_expires_at_ms IS NULL OR s.material_headers_json IS NULL
 OR s.material_row_count IS NULL OR s.material_part_count IS NULL OR s.material_byte_length IS NULL
 OR s.material_source_sha256 IS NOT o.sha256 OR s.material_expires_at_ms IS NOT s.retention_expires_at_ms
 OR s.parser_revision IS NULL OR s.source_format IS NULL OR s.service_market IS NULL OR s.locale IS NULL OR s.time_zone IS NULL
 OR s.status NOT IN ('queued','processing')
 OR (s.material_state='ready' AND (s.material_part_count<>(SELECT COUNT(*) FROM statement_materialization_parts p WHERE p.submission_id=s.id)
 OR s.material_byte_length IS NOT (SELECT SUM(length(CAST(body AS BLOB))) FROM statement_materialization_parts p WHERE p.submission_id=s.id)))))
) AND NOT EXISTS(SELECT 1 FROM statement_materialization_parts p LEFT JOIN statement_submissions s ON s.id=p.submission_id
 WHERE s.id IS NULL OR s.material_state IS NULL) THEN 1 ELSE 0 END;
-- statement-materialization-preflight:end

-- statement-materialization-copy:start
INSERT INTO statement_materializations(rowid,submission_id,source_sha256,parts_sha256,representation_revision,expires_at_ms,headers_json,row_count,part_count,byte_length,state)
SELECT rowid,id,material_source_sha256,material_parts_sha256,material_representation_revision,material_expires_at_ms,material_headers_json,material_row_count,material_part_count,material_byte_length,material_state
FROM statement_submissions WHERE material_state IS NOT NULL;
INSERT INTO statement_materialization_parts_1457(rowid,submission_id,chunk_index,part_index,body,sha256)
SELECT rowid,submission_id,chunk_index,part_index,body,sha256 FROM statement_materialization_parts;
-- statement-materialization-copy:end

-- statement-materialization-copy-check:start
INSERT INTO sql_assertions(scope,accepted)
SELECT 'statement-materialization-copy',CASE WHEN NOT EXISTS(
 SELECT rowid,submission_id,source_sha256,parts_sha256,representation_revision,expires_at_ms,headers_json,row_count,part_count,byte_length,state FROM statement_materializations
 EXCEPT SELECT rowid,id,material_source_sha256,material_parts_sha256,material_representation_revision,material_expires_at_ms,material_headers_json,material_row_count,material_part_count,material_byte_length,material_state FROM statement_submissions WHERE material_state IS NOT NULL
) AND (SELECT COUNT(*) FROM statement_materializations)=(SELECT COUNT(*) FROM statement_submissions WHERE material_state IS NOT NULL)
AND NOT EXISTS(SELECT rowid,submission_id,chunk_index,part_index,body,sha256 FROM statement_materialization_parts_1457
 EXCEPT SELECT rowid,submission_id,chunk_index,part_index,body,sha256 FROM statement_materialization_parts)
AND (SELECT COUNT(*) FROM statement_materialization_parts_1457)=(SELECT COUNT(*) FROM statement_materialization_parts)
THEN 1 ELSE 0 END;
-- statement-materialization-copy-check:end

-- statement-materialization-swap:start
DROP TABLE statement_materialization_parts;
ALTER TABLE statement_materialization_parts_1457 RENAME TO statement_materialization_parts;
ALTER TABLE statement_submissions DROP COLUMN material_state;
ALTER TABLE statement_submissions DROP COLUMN material_byte_length;
ALTER TABLE statement_submissions DROP COLUMN material_part_count;
ALTER TABLE statement_submissions DROP COLUMN material_row_count;
ALTER TABLE statement_submissions DROP COLUMN material_headers_json;
ALTER TABLE statement_submissions DROP COLUMN material_expires_at_ms;
ALTER TABLE statement_submissions DROP COLUMN material_representation_revision;
ALTER TABLE statement_submissions DROP COLUMN material_parts_sha256;
ALTER TABLE statement_submissions DROP COLUMN material_source_sha256;
-- statement-materialization-swap:end

-- statement-materialization-verify:start
INSERT INTO sql_assertions(scope,accepted)
SELECT 'statement-materialization-final',CASE WHEN NOT EXISTS(SELECT 1 FROM pragma_foreign_key_check) THEN 1 ELSE 0 END;
-- statement-materialization-verify:end

-- statement-review-preflight:start
INSERT INTO sql_assertions(scope,accepted)
SELECT 'statement-review-preflight',CASE WHEN
NOT EXISTS(SELECT 1 FROM pragma_foreign_key_check)
AND (SELECT pending_count FROM statement_review_capacity WHERE id=1)=
 (SELECT count(*) FROM statement_needs_review WHERE status='pending')
AND NOT EXISTS(SELECT 1 FROM statement_needs_review r JOIN ingestion_review_state w ON w.user_id=r.user_id AND w.id=r.id
 WHERE w.created_at_ms IS NOT r.created_at_ms OR w.expires_at_ms IS NOT r.evidence_expires_at_ms)
AND NOT EXISTS(SELECT 1 FROM statement_needs_review r JOIN forwarded_email_receipts e ON e.user_id=r.user_id AND e.review_id=r.id)
AND NOT EXISTS(SELECT 1 FROM statement_needs_review r JOIN media_submissions m ON m.user_id=r.user_id AND m.id=r.id AND m.review_reason IS NOT NULL)
THEN 1 ELSE 0 END;
-- statement-review-preflight:end

-- statement-review-copy:start
INSERT INTO ingestion_review_items(rowid,id,user_id,source_kind,statement_submission_id,record_number,reason,created_at_ms,evidence_expires_at_ms,service_market,locale,time_zone,source_format,parser_revision,extractor_revision,original_evidence,known_money_json,issues_json,evidence_state,suggestions_json,workspace_state,workspace_revision,draft_json,transaction_id,workspace_updated_at_ms,workspace_archive_row_ref)
SELECT r.rowid,r.id,r.user_id,'statement',r.submission_id,r.record_number,r.reason,r.created_at_ms,r.evidence_expires_at_ms,r.service_market,r.locale,r.time_zone,r.source_format,r.parser_revision,r.extractor_revision,r.original_evidence,r.known_money,r.issues,CASE r.status WHEN 'pending' THEN 'retained' ELSE r.status END,r.review_suggestions_json,w.status,w.revision,w.draft_json,w.transaction_id,w.updated_at_ms,CAST(w.rowid AS TEXT)
FROM statement_needs_review r LEFT JOIN ingestion_review_state w ON w.user_id=r.user_id AND w.id=r.id;
-- statement-review-copy:end

-- statement-review-copy-check:start
INSERT INTO sql_assertions(scope,accepted)
SELECT 'statement-review-copy',CASE WHEN
(SELECT count(*) FROM ingestion_review_items)=(SELECT count(*) FROM statement_needs_review)
AND NOT EXISTS(SELECT rowid,id,user_id,submission_id,record_number,reason,created_at_ms,evidence_expires_at_ms,service_market,locale,time_zone,source_format,parser_revision,extractor_revision,original_evidence,known_money,issues,status,review_suggestions_json FROM statement_needs_review
EXCEPT SELECT rowid,id,user_id,statement_submission_id,record_number,reason,created_at_ms,evidence_expires_at_ms,service_market,locale,time_zone,source_format,parser_revision,extractor_revision,original_evidence,known_money_json,issues_json,CASE evidence_state WHEN 'retained' THEN 'pending' ELSE evidence_state END,suggestions_json FROM ingestion_review_items)
AND NOT EXISTS(SELECT CAST(w.rowid AS TEXT),w.id,w.user_id,w.status,w.revision,w.draft_json,w.transaction_id,w.updated_at_ms FROM ingestion_review_state w JOIN statement_needs_review r ON r.user_id=w.user_id AND r.id=w.id
EXCEPT SELECT workspace_archive_row_ref,id,user_id,workspace_state,workspace_revision,draft_json,transaction_id,workspace_updated_at_ms FROM ingestion_review_items WHERE workspace_updated_at_ms IS NOT NULL)
THEN 1 ELSE 0 END;
-- statement-review-copy-check:end

-- statement-review-swap:start
DELETE FROM ingestion_review_state WHERE (user_id,id) IN(SELECT user_id,id FROM ingestion_review_items);
DROP TABLE statement_needs_review;
-- statement-review-swap:end

-- statement-review-verify:start
INSERT INTO sql_assertions(scope,accepted)
SELECT 'statement-review-final',CASE WHEN NOT EXISTS(SELECT 1 FROM pragma_foreign_key_check)
AND (SELECT pending_count FROM statement_review_capacity WHERE id=1)=(SELECT count(*) FROM ingestion_review_items WHERE source_kind='statement' AND evidence_state='retained')
AND NOT EXISTS(SELECT 1 FROM ingestion_review_state w JOIN ingestion_review_items r ON r.user_id=w.user_id AND r.id=w.id)
THEN 1 ELSE 0 END;
-- statement-review-verify:end

-- email-media-review-preflight:start
INSERT INTO sql_assertions(scope,accepted)
SELECT 'email-media-review-preflight',CASE WHEN NOT EXISTS(SELECT 1 FROM pragma_foreign_key_check)
AND NOT EXISTS(SELECT 1 FROM ingestion_review_state w WHERE
 (SELECT count(*) FROM forwarded_email_receipts e WHERE e.user_id=w.user_id AND e.review_id=w.id AND e.review_created_at_ms=w.created_at_ms AND e.review_evidence_expires_at_ms=w.expires_at_ms)
 +(SELECT count(*) FROM media_submissions m WHERE m.user_id=w.user_id AND m.id=w.id AND m.review_reason IS NOT NULL AND m.review_created_at_ms=w.created_at_ms AND m.expires_at_ms=w.expires_at_ms)<>1)
AND NOT EXISTS(SELECT 1 FROM forwarded_email_receipts e JOIN media_submissions m ON m.user_id=e.user_id AND m.id=e.review_id WHERE m.review_reason IS NOT NULL)
AND NOT EXISTS(SELECT 1 FROM forwarded_email_receipts e WHERE e.outcome='needs-review' AND e.outcome_review_id IS NOT e.review_id)
THEN 1 ELSE 0 END;
-- email-media-review-preflight:end

-- email-media-review-copy:start
INSERT INTO forwarded_email_receipts_1459(rowid,id,user_id,delivery_digest,object_key,byte_length,state,received_at_ms,expires_at_ms,time_zone,deferred_checked_at_ms,outcome,outcome_transaction_id,outcome_review_id,outcome_completed_at_ms,dispatch_pending,dispatch_sent_at_ms) SELECT rowid,id,user_id,delivery_digest,object_key,byte_length,state,received_at_ms,expires_at_ms,time_zone,deferred_checked_at_ms,outcome,outcome_transaction_id,outcome_review_id,outcome_completed_at_ms,(dispatch_user_id IS NOT NULL),dispatch_sent_at_ms FROM forwarded_email_receipts;
INSERT INTO ingestion_review_items(id,user_id,source_kind,email_receipt_id,media_submission_id,reason,created_at_ms,evidence_expires_at_ms,service_market,locale,time_zone,workspace_state,workspace_revision,draft_json,transaction_id,workspace_updated_at_ms,workspace_archive_row_ref)
SELECT r.*,w.status,w.revision,w.draft_json,w.transaction_id,w.updated_at_ms,CAST(w.rowid AS TEXT)
FROM (SELECT e.review_id AS id,e.user_id,'email' AS source_kind,e.id AS email_receipt_id,NULL AS media_submission_id,e.review_reason AS reason,e.review_created_at_ms AS created_at_ms,e.review_evidence_expires_at_ms AS evidence_expires_at_ms,'CO' AS service_market,'es-CO' AS locale,e.time_zone FROM forwarded_email_receipts e WHERE e.review_id IS NOT NULL UNION ALL SELECT m.id,m.user_id,'media',NULL,m.id,m.review_reason,m.review_created_at_ms,m.expires_at_ms,m.service_market,m.locale,m.time_zone FROM media_submissions m WHERE m.review_reason IS NOT NULL) r LEFT JOIN ingestion_review_state w ON w.user_id=r.user_id AND w.id=r.id;
-- email-media-review-copy:end

-- email-media-review-copy-check:start
INSERT INTO sql_assertions(scope,accepted)
SELECT 'email-media-review-copy',CASE WHEN
NOT EXISTS(SELECT rowid,id,user_id,delivery_digest,object_key,byte_length,state,received_at_ms,expires_at_ms,time_zone,deferred_checked_at_ms,outcome,outcome_transaction_id,outcome_review_id,outcome_completed_at_ms,(dispatch_user_id IS NOT NULL),dispatch_sent_at_ms FROM forwarded_email_receipts EXCEPT SELECT rowid,id,user_id,delivery_digest,object_key,byte_length,state,received_at_ms,expires_at_ms,time_zone,deferred_checked_at_ms,outcome,outcome_transaction_id,outcome_review_id,outcome_completed_at_ms,dispatch_pending,dispatch_sent_at_ms FROM forwarded_email_receipts_1459)
AND (SELECT count(*) FROM forwarded_email_receipts)=(SELECT count(*) FROM forwarded_email_receipts_1459)
AND NOT EXISTS(SELECT e.review_id,e.user_id,'email',e.id,NULL,e.review_reason,e.review_created_at_ms,e.review_evidence_expires_at_ms,'CO','es-CO',e.time_zone FROM forwarded_email_receipts e WHERE e.review_id IS NOT NULL UNION ALL SELECT m.id,m.user_id,'media',NULL,m.id,m.review_reason,m.review_created_at_ms,m.expires_at_ms,m.service_market,m.locale,m.time_zone FROM media_submissions m WHERE m.review_reason IS NOT NULL EXCEPT SELECT id,user_id,source_kind,email_receipt_id,media_submission_id,reason,created_at_ms,evidence_expires_at_ms,service_market,locale,time_zone FROM ingestion_review_items WHERE source_kind<>'statement')
AND (SELECT count(*) FROM ingestion_review_items WHERE source_kind<>'statement')=(SELECT count(*) FROM (SELECT e.review_id,e.user_id,'email',e.id,NULL,e.review_reason,e.review_created_at_ms,e.review_evidence_expires_at_ms,'CO','es-CO',e.time_zone FROM forwarded_email_receipts e WHERE e.review_id IS NOT NULL UNION ALL SELECT m.id,m.user_id,'media',NULL,m.id,m.review_reason,m.review_created_at_ms,m.expires_at_ms,m.service_market,m.locale,m.time_zone FROM media_submissions m WHERE m.review_reason IS NOT NULL))
AND NOT EXISTS(SELECT CAST(rowid AS TEXT),id,user_id,status,revision,draft_json,transaction_id,updated_at_ms FROM ingestion_review_state EXCEPT SELECT workspace_archive_row_ref,id,user_id,workspace_state,workspace_revision,draft_json,transaction_id,workspace_updated_at_ms FROM ingestion_review_items WHERE source_kind<>'statement' AND workspace_updated_at_ms IS NOT NULL)
THEN 1 ELSE 0 END;
-- email-media-review-copy-check:end

-- email-media-review-swap:start
DROP TABLE forwarded_email_receipts;
ALTER TABLE forwarded_email_receipts_1459 RENAME TO forwarded_email_receipts;
DROP TABLE ingestion_review_state;
ALTER TABLE media_submissions DROP COLUMN review_created_at_ms;
ALTER TABLE media_submissions DROP COLUMN review_reason;
-- email-media-review-swap:end

-- email-media-review-verify:start
INSERT INTO sql_assertions(scope,accepted)
SELECT 'email-media-review-final',CASE WHEN NOT EXISTS(SELECT 1 FROM pragma_foreign_key_check)
AND NOT EXISTS(SELECT 1 FROM forwarded_email_receipts e WHERE e.outcome='needs-review' AND NOT EXISTS(SELECT 1 FROM ingestion_review_items r WHERE r.source_kind='email' AND r.user_id=e.user_id AND r.email_receipt_id=e.id AND r.id=e.outcome_review_id))
AND (SELECT pending_count FROM statement_review_capacity WHERE id=1)=(SELECT count(*) FROM ingestion_review_items WHERE source_kind='statement' AND evidence_state='retained')
THEN 1 ELSE 0 END;
-- email-media-review-verify:end

-- backfill-progress-preflight:start
INSERT INTO sql_assertions(scope,accepted)
SELECT 'backfill-progress-preflight',CASE WHEN NOT EXISTS(SELECT 1 FROM pragma_foreign_key_check)
AND NOT EXISTS(SELECT 1 FROM users u WHERE (u.backfill_present IS NULL AND (u.backfill_submission_id IS NOT NULL OR u.backfill_consumed_at_ms IS NOT NULL)) OR (u.backfill_present IS NOT NULL AND u.backfill_present IS NOT 1) OR (u.backfill_submission_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM statement_submissions s WHERE s.id=u.backfill_submission_id AND s.user_id=u.id)))
AND NOT EXISTS(SELECT 1 FROM statement_submissions s WHERE processed_rows NOT BETWEEN 0 AND 20000 OR processed_rows<>processed_accepted_rows+processed_review_rows
 OR input_rows IS NOT CASE WHEN status='completed' OR (status='failed' AND processed_rows>0) THEN processed_rows END
 OR accepted_rows IS NOT CASE WHEN status='completed' OR (status='failed' AND processed_rows>0) THEN processed_accepted_rows END
 OR needs_review_rows IS NOT CASE WHEN status='completed' OR (status='failed' AND processed_rows>0) THEN processed_review_rows END)
THEN 1 ELSE 0 END;
-- backfill-progress-preflight:end

-- backfill-progress-copy:start
INSERT INTO statement_backfill_entitlements(rowid,user_id,submission_id,consumed_at_ms)
SELECT rowid,id,backfill_submission_id,backfill_consumed_at_ms FROM users WHERE backfill_present IS NOT NULL;
-- backfill-progress-copy:end

-- backfill-progress-copy-check:start
INSERT INTO sql_assertions(scope,accepted)
SELECT 'backfill-progress-copy',CASE WHEN (SELECT count(*) FROM statement_backfill_entitlements)=(SELECT count(*) FROM users WHERE backfill_present IS NOT NULL)
AND NOT EXISTS(SELECT rowid,id,backfill_submission_id,backfill_consumed_at_ms FROM users WHERE backfill_present IS NOT NULL EXCEPT SELECT rowid,user_id,submission_id,consumed_at_ms FROM statement_backfill_entitlements)
THEN 1 ELSE 0 END;
-- backfill-progress-copy-check:end

-- backfill-progress-swap:start
ALTER TABLE users DROP COLUMN backfill_consumed_at_ms;
ALTER TABLE users DROP COLUMN backfill_submission_id;
ALTER TABLE users DROP COLUMN backfill_present;
ALTER TABLE statement_submissions DROP COLUMN needs_review_rows;
ALTER TABLE statement_submissions DROP COLUMN accepted_rows;
ALTER TABLE statement_submissions DROP COLUMN input_rows;
-- backfill-progress-swap:end

-- backfill-progress-verify:start
INSERT INTO sql_assertions(scope,accepted)
SELECT 'backfill-progress-final',CASE WHEN NOT EXISTS(SELECT 1 FROM pragma_foreign_key_check)
AND NOT EXISTS(SELECT 1 FROM statement_backfill_entitlements e WHERE e.submission_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM statement_submissions s WHERE s.user_id=e.user_id AND s.id=e.submission_id))
THEN 1 ELSE 0 END;
-- backfill-progress-verify:end

-- category-keyword-preflight:start
PRAGMA defer_foreign_keys=ON;
INSERT INTO sql_assertions(scope,accepted)
SELECT 'category-keyword-preflight',NOT EXISTS(SELECT 1 FROM erasure_permits)
 AND NOT EXISTS(SELECT 1 FROM erasure_chunk)
 AND NOT EXISTS(SELECT 1 FROM erasure_requests WHERE state<>'Complete')
 AND NOT EXISTS(SELECT 1 FROM pragma_foreign_key_check)
 AND NOT EXISTS(SELECT user_id,normalized_keyword FROM keyword_rules GROUP BY user_id,normalized_keyword HAVING count(*)<>1);
-- category-keyword-preflight:end

-- category-keyword-row-preflight:start
INSERT INTO sql_assertions(scope,accepted)
SELECT 'category-keyword-row',?=1 AND EXISTS(SELECT 1 FROM keyword_rules
 WHERE rowid=? AND keyword IS ? AND normalized_keyword IS ? AND created_at IS ? AND updated_at IS ?
 AND CAST(round(unixepoch(created_at,'subsec')*1000) AS INTEGER) IS ?
 AND CAST(round(unixepoch(updated_at,'subsec')*1000) AS INTEGER) IS ?)
ON CONFLICT(scope) DO UPDATE SET accepted=excluded.accepted;
-- category-keyword-row-preflight:end

-- category-keyword-copy:start
INSERT INTO keyword_rules_1461(rowid,id,user_id,keyword,category_id,created_at_ms,updated_at_ms)
SELECT rowid,id,user_id,normalized_keyword,category_id,
 CAST(round(unixepoch(created_at,'subsec')*1000) AS INTEGER),
 CAST(round(unixepoch(updated_at,'subsec')*1000) AS INTEGER) FROM keyword_rules;
-- category-keyword-copy:end

-- category-keyword-copy-check:start
INSERT INTO sql_assertions(scope,accepted)
SELECT 'category-keyword-copy',(SELECT count(*) FROM keyword_rules)=(SELECT count(*) FROM keyword_rules_1461)
 AND NOT EXISTS(SELECT rowid,id,user_id,normalized_keyword,category_id,
 CAST(round(unixepoch(created_at,'subsec')*1000) AS INTEGER),
 CAST(round(unixepoch(updated_at,'subsec')*1000) AS INTEGER) FROM keyword_rules
 EXCEPT SELECT rowid,id,user_id,keyword,category_id,created_at_ms,updated_at_ms FROM keyword_rules_1461);
-- category-keyword-copy-check:end

-- category-keyword-swap:start
DROP TABLE keyword_rules;
ALTER TABLE keyword_rules_1461 RENAME TO keyword_rules;
-- category-keyword-swap:end

-- category-keyword-verify:start
INSERT INTO sql_assertions(scope,accepted)
SELECT 'category-keyword-final',NOT EXISTS(SELECT 1 FROM pragma_foreign_key_check);
DELETE FROM sql_assertions WHERE scope IN('category-keyword-preflight','category-keyword-row','category-keyword-copy','category-keyword-final');
PRAGMA defer_foreign_keys=OFF;
-- category-keyword-verify:end

-- transaction-history-preflight:start
PRAGMA defer_foreign_keys=ON;
INSERT INTO sql_assertions(scope,accepted)
SELECT 'transaction-history-preflight',NOT EXISTS(SELECT 1 FROM pragma_foreign_key_check)
 AND NOT EXISTS(SELECT 1 FROM erasure_requests WHERE state<>'Complete')
 AND NOT EXISTS(SELECT 1 FROM erasure_permits) AND NOT EXISTS(SELECT 1 FROM erasure_chunk)
 AND NOT EXISTS(SELECT 1 FROM source_attestations a JOIN statement_submissions s ON s.id=a.statement_submission_id WHERE s.user_id<>a.user_id)
 AND NOT EXISTS(SELECT 1 FROM source_attestations a WHERE a.review_item_id IS NOT NULL AND ((NOT EXISTS(SELECT 1 FROM ingestion_review_items r WHERE r.id=a.review_item_id AND r.user_id=a.user_id) AND EXISTS(SELECT 1 FROM ingestion_review_items r WHERE r.id=a.review_item_id)) OR EXISTS(SELECT 1 FROM ingestion_review_items r WHERE r.id=a.review_item_id AND r.user_id=a.user_id AND r.transaction_id IS NOT NULL AND r.transaction_id<>a.transaction_id)))
 AND NOT EXISTS(SELECT user_id,review_item_id FROM source_attestations WHERE review_item_id IS NOT NULL GROUP BY user_id,review_item_id HAVING count(*)>1)
 AND NOT EXISTS(SELECT 1 FROM transaction_reconciliation_decisions d WHERE
   (d.state='linked' AND (SELECT count(*) FROM transactions t WHERE t.user_id=d.user_id AND t.reconciliation_first_id=d.first_transaction_id AND t.reconciliation_second_id=d.second_transaction_id AND t.deleted_at_ms IS NULL)<>2)
   OR (d.state='keep-separate' AND EXISTS(SELECT 1 FROM transactions t WHERE t.user_id=d.user_id AND t.reconciliation_first_id=d.first_transaction_id AND t.reconciliation_second_id=d.second_transaction_id)));
-- transaction-history-preflight:end

-- transaction-history-row-transactions:start
INSERT INTO sql_assertions(scope,accepted)
SELECT 'transaction-history-row',?=1 AND EXISTS(SELECT 1 FROM transactions WHERE rowid=? AND occurred_at IS ? AND ? BETWEEN -62135596800000 AND 253402300799999 AND created_at IS ? AND ? BETWEEN -62135596800000 AND 253402300799999)
ON CONFLICT(scope) DO UPDATE SET accepted=excluded.accepted;
-- transaction-history-row-transactions:end

-- transaction-history-copy-transactions:start
INSERT INTO transactions_1462(rowid,id,user_id,amount,currency,direction,counterparty,category_id,notes,occurred_at_ms,created_at_ms,revision,user_decisions,deleted_at_ms,reconciliation_row_ref,reconciliation_first_id,reconciliation_second_id)
SELECT rowid,id,user_id,amount,currency,direction,counterparty,category_id,notes,?,?,revision,user_decisions,deleted_at_ms,reconciliation_row_ref,reconciliation_first_id,reconciliation_second_id FROM transactions WHERE rowid=? AND occurred_at IS ? AND created_at IS ?;
INSERT INTO sql_assertions(scope,accepted)
SELECT 'transaction-history-row-copy',changes()=1 AND EXISTS(SELECT 1 FROM transactions_1462 WHERE rowid=? AND occurred_at_ms IS ? AND created_at_ms IS ?)
ON CONFLICT(scope) DO UPDATE SET accepted=excluded.accepted;
-- transaction-history-copy-transactions:end

-- transaction-history-copy-check-transactions:start
INSERT INTO sql_assertions(scope,accepted)
SELECT 'transaction-history-copy-transactions',(SELECT count(*) FROM transactions)=(SELECT count(*) FROM transactions_1462)
 AND NOT EXISTS(SELECT rowid,id,user_id,amount,currency,direction,counterparty,category_id,notes,revision,user_decisions,deleted_at_ms,reconciliation_row_ref,reconciliation_first_id,reconciliation_second_id FROM transactions
 EXCEPT SELECT rowid,id,user_id,amount,currency,direction,counterparty,category_id,notes,revision,user_decisions,deleted_at_ms,reconciliation_row_ref,reconciliation_first_id,reconciliation_second_id FROM transactions_1462);
-- transaction-history-copy-check-transactions:end

-- transaction-history-row-source_attestations:start
INSERT INTO sql_assertions(scope,accepted)
SELECT 'transaction-history-row',?=1 AND EXISTS(SELECT 1 FROM source_attestations WHERE rowid=? AND created_at IS ? AND ? BETWEEN -62135596800000 AND 253402300799999)
ON CONFLICT(scope) DO UPDATE SET accepted=excluded.accepted;
-- transaction-history-row-source_attestations:end

-- transaction-history-copy-source_attestations:start
INSERT INTO source_attestations_1462(rowid,id,user_id,transaction_id,kind,service_market,locale,time_zone,interpretation_revision,created_at_ms,statement_submission_id,statement_record_number,statement_content_hash,source_format,received_email_id,message_content_sha256,message_evidence,deterministic_interpretation,extractor_revision,review_item_id,user_provided_fields)
SELECT rowid,id,user_id,transaction_id,kind,service_market,locale,time_zone,interpretation_revision,?,statement_submission_id,statement_record_number,statement_content_hash,source_format,received_email_id,message_content_sha256,message_evidence,deterministic_interpretation,extractor_revision,review_item_id,user_provided_fields FROM source_attestations WHERE rowid=? AND created_at IS ?;
INSERT INTO sql_assertions(scope,accepted)
SELECT 'transaction-history-row-copy',changes()=1 AND EXISTS(SELECT 1 FROM source_attestations_1462 WHERE rowid=? AND created_at_ms IS ?)
ON CONFLICT(scope) DO UPDATE SET accepted=excluded.accepted;
-- transaction-history-copy-source_attestations:end

-- transaction-history-copy-check-source_attestations:start
INSERT INTO sql_assertions(scope,accepted)
SELECT 'transaction-history-copy-source_attestations',(SELECT count(*) FROM source_attestations)=(SELECT count(*) FROM source_attestations_1462)
 AND NOT EXISTS(SELECT rowid,id,user_id,transaction_id,kind,service_market,locale,time_zone,interpretation_revision,statement_submission_id,statement_record_number,statement_content_hash,source_format,received_email_id,message_content_sha256,message_evidence,deterministic_interpretation,extractor_revision,review_item_id,user_provided_fields FROM source_attestations
 EXCEPT SELECT rowid,id,user_id,transaction_id,kind,service_market,locale,time_zone,interpretation_revision,statement_submission_id,statement_record_number,statement_content_hash,source_format,received_email_id,message_content_sha256,message_evidence,deterministic_interpretation,extractor_revision,review_item_id,user_provided_fields FROM source_attestations_1462);
-- transaction-history-copy-check-source_attestations:end

-- transaction-history-row-transaction_corrections:start
INSERT INTO sql_assertions(scope,accepted)
SELECT 'transaction-history-row',?=1 AND EXISTS(SELECT 1 FROM transaction_corrections WHERE rowid=? AND corrected_at IS ? AND ? BETWEEN -62135596800000 AND 253402300799999)
ON CONFLICT(scope) DO UPDATE SET accepted=excluded.accepted;
-- transaction-history-row-transaction_corrections:end

-- transaction-history-copy-transaction_corrections:start
INSERT INTO transaction_corrections_1462(rowid,id,user_id,transaction_id,previous_revision,changed_fields,before_facts,after_facts,corrected_at_ms)
SELECT rowid,id,user_id,transaction_id,previous_revision,changed_fields,before_facts,after_facts,? FROM transaction_corrections WHERE rowid=? AND corrected_at IS ?;
INSERT INTO sql_assertions(scope,accepted)
SELECT 'transaction-history-row-copy',changes()=1 AND EXISTS(SELECT 1 FROM transaction_corrections_1462 WHERE rowid=? AND corrected_at_ms IS ?)
ON CONFLICT(scope) DO UPDATE SET accepted=excluded.accepted;
-- transaction-history-copy-transaction_corrections:end

-- transaction-history-copy-check-transaction_corrections:start
INSERT INTO sql_assertions(scope,accepted)
SELECT 'transaction-history-copy-transaction_corrections',(SELECT count(*) FROM transaction_corrections)=(SELECT count(*) FROM transaction_corrections_1462)
 AND NOT EXISTS(SELECT rowid,id,user_id,transaction_id,previous_revision,changed_fields,before_facts,after_facts FROM transaction_corrections
 EXCEPT SELECT rowid,id,user_id,transaction_id,previous_revision,changed_fields,before_facts,after_facts FROM transaction_corrections_1462);
-- transaction-history-copy-check-transaction_corrections:end

-- transaction-history-row-transaction_reconciliation_decisions:start
INSERT INTO sql_assertions(scope,accepted)
SELECT 'transaction-history-row',?=1 AND EXISTS(SELECT 1 FROM transaction_reconciliation_decisions WHERE rowid=? AND decided_at IS ? AND ? BETWEEN -62135596800000 AND 253402300799999)
ON CONFLICT(scope) DO UPDATE SET accepted=excluded.accepted;
-- transaction-history-row-transaction_reconciliation_decisions:end

-- transaction-history-copy-transaction_reconciliation_decisions:start
INSERT INTO transaction_reconciliation_decisions_1462(rowid,user_id,first_transaction_id,second_transaction_id,state,visible_transaction_id,decided_at_ms)
SELECT rowid,user_id,first_transaction_id,second_transaction_id,state,visible_transaction_id,? FROM transaction_reconciliation_decisions WHERE rowid=? AND decided_at IS ?;
INSERT INTO sql_assertions(scope,accepted)
SELECT 'transaction-history-row-copy',changes()=1 AND EXISTS(SELECT 1 FROM transaction_reconciliation_decisions_1462 WHERE rowid=? AND decided_at_ms IS ?)
ON CONFLICT(scope) DO UPDATE SET accepted=excluded.accepted;
-- transaction-history-copy-transaction_reconciliation_decisions:end

-- transaction-history-copy-check-transaction_reconciliation_decisions:start
INSERT INTO sql_assertions(scope,accepted)
SELECT 'transaction-history-copy-transaction_reconciliation_decisions',(SELECT count(*) FROM transaction_reconciliation_decisions)=(SELECT count(*) FROM transaction_reconciliation_decisions_1462)
 AND NOT EXISTS(SELECT rowid,user_id,first_transaction_id,second_transaction_id,state,visible_transaction_id FROM transaction_reconciliation_decisions
 EXCEPT SELECT rowid,user_id,first_transaction_id,second_transaction_id,state,visible_transaction_id FROM transaction_reconciliation_decisions_1462);
-- transaction-history-copy-check-transaction_reconciliation_decisions:end

-- transaction-history-swap:start
DROP TABLE transactions;
DROP TABLE source_attestations;
DROP TABLE transaction_corrections;
DROP TABLE transaction_reconciliation_decisions;
ALTER TABLE transactions_1462 RENAME TO transactions;
ALTER TABLE source_attestations_1462 RENAME TO source_attestations;
ALTER TABLE transaction_corrections_1462 RENAME TO transaction_corrections;
ALTER TABLE transaction_reconciliation_decisions_1462 RENAME TO transaction_reconciliation_decisions;
-- transaction-history-swap:end

-- transaction-history-verify:start
INSERT INTO sql_assertions(scope,accepted) SELECT 'transaction-history-final',NOT EXISTS(SELECT 1 FROM pragma_foreign_key_check);
DELETE FROM sql_assertions WHERE scope IN('transaction-history-preflight','transaction-history-row','transaction-history-row-copy','transaction-history-final','transaction-history-copy-transactions','transaction-history-copy-source_attestations','transaction-history-copy-transaction_corrections','transaction-history-copy-transaction_reconciliation_decisions');
PRAGMA defer_foreign_keys=OFF;
-- transaction-history-verify:end

-- financial-projection-preflight:start
INSERT INTO sql_assertions(scope,accepted) SELECT 'financial-projection-cutover',
 NOT EXISTS(SELECT 1 FROM pragma_foreign_key_check)
 AND NOT EXISTS(SELECT 1 FROM erasure_chunk)
 AND NOT EXISTS(SELECT 1 FROM erasure_requests WHERE state<>'Complete')
 AND NOT EXISTS(SELECT 1 FROM erasure_archives WHERE store_id IN('dashboard_projection_state','dashboard_projection_leaf','dashboard_projection_bucket','dashboard_projection_digit'))
 AND NOT EXISTS(SELECT 1 FROM dashboard_projection_bucket WHERE
  coalesce(nullif(max_minor,''),'0')<>coalesce(nullif(ltrim(CASE WHEN instr(maximum,'.')=0 THEN maximum||'0000' ELSE replace(maximum,'.','')||substr('0000',1,4-(length(maximum)-instr(maximum,'.'))) END,'0'),''),'0'))
 ON CONFLICT(scope) DO UPDATE SET accepted=excluded.accepted;
-- financial-projection-preflight:end

-- financial-projection-leaf-guard:start
INSERT INTO sql_assertions(scope,accepted) SELECT 'financial-projection-cutover',?=1 AND EXISTS(
 SELECT 1 FROM dashboard_projection_leaf WHERE rowid=? AND occurred_at IS ? AND created_at IS ? AND ? BETWEEN -62135596800000 AND 253402300799999 AND ? BETWEEN -62135596800000 AND 253402300799999)
 ON CONFLICT(scope) DO UPDATE SET accepted=excluded.accepted;
-- financial-projection-leaf-guard:end

-- financial-projection-state-guard:start
INSERT INTO sql_assertions(scope,accepted) SELECT 'financial-projection-cutover',?=1 AND EXISTS(
 SELECT 1 FROM dashboard_projection_state WHERE rowid=? AND first_captured_at IS ? AND
 ((first_captured_at IS NULL AND ? IS NULL) OR (? BETWEEN -62135596800000 AND 253402300799999)))
 ON CONFLICT(scope) DO UPDATE SET accepted=excluded.accepted;
-- financial-projection-state-guard:end

-- financial-projection-money-guard:start
INSERT INTO sql_assertions(scope,accepted) VALUES('financial-projection-cutover',?) ON CONFLICT(scope) DO UPDATE SET accepted=excluded.accepted;
-- financial-projection-money-guard:end

-- financial-projection-leaf-copy:start
INSERT INTO transaction_projection_leaf(rowid,user_id,id,amount,currency,direction,category_id,counterparty,notes,occurred_at_ms,created_at_ms,revision)
 SELECT rowid,user_id,id,amount,currency,direction,category_id,counterparty,notes,?,?,revision FROM dashboard_projection_leaf WHERE rowid=?;
INSERT INTO sql_assertions(scope,accepted) VALUES('financial-projection-cutover',changes()=1) ON CONFLICT(scope) DO UPDATE SET accepted=excluded.accepted;
-- financial-projection-leaf-copy:end

-- financial-projection-state-copy:start
INSERT INTO transaction_projection_state(rowid,user_id,version,readiness,cursor_id,attempted_at_ms,fact_revision,first_captured_at_ms,time_zone)
 SELECT rowid,user_id,version,readiness,cursor_id,attempted_at_ms,fact_revision,?,time_zone FROM dashboard_projection_state WHERE rowid=?;
INSERT INTO sql_assertions(scope,accepted) VALUES('financial-projection-cutover',changes()=1) ON CONFLICT(scope) DO UPDATE SET accepted=excluded.accepted;
-- financial-projection-state-copy:end

-- financial-projection-aggregate-copy:start
INSERT INTO transaction_projection_bucket(rowid,user_id,size_seconds,bucket,currency,direction,category_id,count,max_minor)
 SELECT rowid,user_id,size_seconds,bucket,currency,direction,category_id,count,coalesce(nullif(max_minor,''),'0') FROM dashboard_projection_bucket;
INSERT INTO transaction_projection_digit(rowid,user_id,size_seconds,bucket,currency,direction,category_id,position,digit_sum) SELECT rowid,user_id,size_seconds,bucket,currency,direction,category_id,position,digit_sum FROM dashboard_projection_digit;
-- financial-projection-aggregate-copy:end

-- financial-projection-copy-check:start
INSERT INTO sql_assertions(scope,accepted) SELECT 'financial-projection-cutover',
 (SELECT count(*) FROM dashboard_projection_leaf)=(SELECT count(*) FROM transaction_projection_leaf)
 AND (SELECT count(*) FROM dashboard_projection_state)=(SELECT count(*) FROM transaction_projection_state)
 AND (SELECT count(*) FROM dashboard_projection_bucket)=(SELECT count(*) FROM transaction_projection_bucket)
 AND (SELECT count(*) FROM dashboard_projection_digit)=(SELECT count(*) FROM transaction_projection_digit)
 ON CONFLICT(scope) DO UPDATE SET accepted=excluded.accepted;
-- financial-projection-copy-check:end

-- financial-projection-swap:start
DROP TABLE dashboard_projection_digit;
DROP TABLE dashboard_projection_bucket;
DROP TABLE dashboard_projection_leaf;
DROP TABLE dashboard_projection_state;
-- financial-projection-swap:end

-- financial-projection-verify:start
INSERT INTO sql_assertions(scope,accepted) SELECT 'financial-projection-cutover',NOT EXISTS(SELECT 1 FROM pragma_foreign_key_check)
 ON CONFLICT(scope) DO UPDATE SET accepted=excluded.accepted;
DELETE FROM sql_assertions WHERE scope='financial-projection-cutover';
-- financial-projection-verify:end

-- recurring-planning-copy:start
INSERT INTO sql_assertions(scope,accepted)
VALUES('recurring_plan',CASE WHEN
 NOT EXISTS(SELECT 1 FROM erasure_requests WHERE state<>'Complete')
 AND NOT EXISTS(SELECT 1 FROM erasure_archives WHERE store_id='recurring_plan_documents')
 AND NOT EXISTS(SELECT 1 FROM recurring_plans)
 AND NOT EXISTS(SELECT 1 FROM recurring_plan_revisions)
 AND NOT EXISTS(SELECT 1 FROM recurring_plan_exceptions)
 AND NOT EXISTS(SELECT 1 FROM recurring_plan_fulfillments)
 AND NOT EXISTS(SELECT 1 FROM user_documents WHERE kind='recurring-plan' AND
 (json_type(document_json,'$.revision') IS NOT 'integer' OR json_extract(document_json,'$.revision')<>revision
 OR json_type(document_json,'$.plans') IS NOT 'array' OR json_type(document_json,'$.exceptions') IS NOT 'array'
 OR json_type(document_json,'$.fulfillments') IS NOT 'array'))
 THEN 1 ELSE 0 END) ON CONFLICT(scope) DO UPDATE SET accepted=excluded.accepted;
INSERT INTO recurring_plans(user_id,id,position,pauses_json,stopped_on)
SELECT r.user_id,json_extract(p.value,'$.id'),CAST(p.key AS INTEGER),json_extract(p.value,'$.pauses'),json_extract(p.value,'$.stoppedOn')
FROM user_documents r,json_each(r.document_json,'$.plans') p WHERE r.kind='recurring-plan';
INSERT INTO recurring_plan_revisions(user_id,plan_id,position,from_date,plan_json)
SELECT r.user_id,json_extract(p.value,'$.id'),CAST(v.key AS INTEGER),json_extract(v.value,'$.from'),json_extract(v.value,'$.plan')
FROM user_documents r,json_each(r.document_json,'$.plans') p,json_each(p.value,'$.revisions') v WHERE r.kind='recurring-plan';
INSERT INTO recurring_plan_exceptions(user_id,plan_id,position,local_date,skipped,replacement_json)
SELECT r.user_id,json_extract(e.value,'$.planId'),CAST(e.key AS INTEGER),json_extract(e.value,'$.date'),json_extract(e.value,'$.skipped'),json_extract(e.value,'$.replacement')
FROM user_documents r,json_each(r.document_json,'$.exceptions') e WHERE r.kind='recurring-plan';
INSERT INTO recurring_plan_fulfillments(user_id,id,plan_id,position,local_date,actual_date,amount,currency,settled,automatic,transaction_id)
SELECT r.user_id,json_extract(f.value,'$.id'),json_extract(f.value,'$.planId'),CAST(f.key AS INTEGER),json_extract(f.value,'$.date'),json_extract(f.value,'$.actualDate'),json_extract(f.value,'$.money.amount'),json_extract(f.value,'$.money.currency'),json_extract(f.value,'$.settled'),json_extract(f.value,'$.automatic'),json_extract(f.value,'$.transactionId')
FROM user_documents r,json_each(r.document_json,'$.fulfillments') f WHERE r.kind='recurring-plan';
UPDATE user_documents SET document_json=json_object('excludedTransactionIds',json(json_extract(document_json,'$.excludedTransactionIds')),'suggestions',json(json_extract(document_json,'$.suggestions'))) WHERE kind='recurring-plan';
-- recurring-planning-copy:end

-- recurring-planning-rollback:start
INSERT INTO sql_assertions(scope,accepted) VALUES('recurring_plan',CASE WHEN
 NOT EXISTS(SELECT 1 FROM erasure_requests WHERE state<>'Complete')
 AND NOT EXISTS(SELECT 1 FROM erasure_archives WHERE store_id IN('recurring_plan_documents','recurring_plans','recurring_plan_revisions','recurring_plan_exceptions','recurring_plan_fulfillments'))
 AND NOT EXISTS(SELECT 1 FROM recurring_plans p WHERE NOT EXISTS(SELECT 1 FROM user_documents r WHERE r.user_id=p.user_id AND r.kind='recurring-plan'))
 THEN 1 ELSE 0 END) ON CONFLICT(scope) DO UPDATE SET accepted=excluded.accepted;
UPDATE user_documents AS r SET document_json=json_set(document_json,'$.revision',revision,
 '$.plans',json((SELECT json_group_array(json(body)) FROM (SELECT json_patch(json_object('id',p.id,'pauses',json(p.pauses_json),'revisions',json((SELECT json_group_array(json(body)) FROM (SELECT json_object('from',v.from_date,'plan',json(v.plan_json)) AS body FROM recurring_plan_revisions v WHERE v.user_id=p.user_id AND v.plan_id=p.id ORDER BY v.position)))),CASE WHEN p.stopped_on IS NULL THEN '{}' ELSE json_object('stoppedOn',p.stopped_on) END) AS body FROM recurring_plans p WHERE p.user_id=r.user_id ORDER BY p.position))),
 '$.exceptions',json((SELECT json_group_array(json(body)) FROM (SELECT json_patch(json_object('planId',e.plan_id,'date',e.local_date,'skipped',json(CASE e.skipped WHEN 1 THEN 'true' ELSE 'false' END)),CASE WHEN e.replacement_json IS NULL THEN '{}' ELSE json_object('replacement',json(e.replacement_json)) END) AS body FROM recurring_plan_exceptions e WHERE e.user_id=r.user_id ORDER BY e.position))),
 '$.fulfillments',json((SELECT json_group_array(json(body)) FROM (SELECT json_patch(json_patch(json_object('id',f.id,'planId',f.plan_id,'date',f.local_date,'actualDate',f.actual_date,'money',json_object('amount',f.amount,'currency',f.currency),'settled',json(CASE f.settled WHEN 1 THEN 'true' ELSE 'false' END)),CASE WHEN f.automatic IS NULL THEN '{}' ELSE json_object('automatic',json(CASE f.automatic WHEN 1 THEN 'true' ELSE 'false' END)) END),CASE WHEN f.transaction_id IS NULL THEN '{}' ELSE json_object('transactionId',f.transaction_id) END) AS body FROM recurring_plan_fulfillments f WHERE f.user_id=r.user_id ORDER BY f.position))))
WHERE r.kind='recurring-plan';
DELETE FROM recurring_plan_fulfillments;
DELETE FROM recurring_plan_exceptions;
DELETE FROM recurring_plan_revisions;
DELETE FROM recurring_plans;
-- recurring-planning-rollback:end

-- budget-months-guard:start
INSERT INTO sql_assertions(scope,accepted) VALUES('budget_mutation',CASE WHEN
 (SELECT count(*) FROM budgets)=? AND (SELECT count(*) FROM budget_month_latches)=?
 AND (SELECT count(*) FROM budget_threshold_alerts)=? AND (SELECT count(*) FROM budget_month_plan_records)=?
 AND NOT EXISTS(SELECT 1 FROM erasure_requests WHERE state<>'Complete')
 AND NOT EXISTS(SELECT 1 FROM erasure_archives WHERE store_id IN('budgets','budget_month_latches','budget_threshold_alerts','budget_month_caps','budget_plan_months','budget_group_currencies'))
 THEN 1 ELSE 0 END) ON CONFLICT(scope) DO UPDATE SET accepted=excluded.accepted;
-- budget-months-guard:end

-- budget-months-budget-guard:start
INSERT INTO sql_assertions(scope,accepted) VALUES('budget_mutation',CASE WHEN ?=1 AND EXISTS(SELECT 1 FROM budgets WHERE rowid=? AND created_at=? AND updated_at=?) THEN 1 ELSE 0 END) ON CONFLICT(scope) DO UPDATE SET accepted=excluded.accepted;
-- budget-months-budget-guard:end

-- budget-months-budget-copy:start
INSERT INTO cutover_budgets(rowid,id,user_id,category_id,currency,cap,created_at_ms,updated_at_ms,group_name,starts_month)
SELECT rowid,id,user_id,category_id,currency,cap,?,?,group_name,starts_month FROM budgets WHERE rowid=?;
-- budget-months-budget-copy:end

-- budget-months-budget_month_latches-guard:start
INSERT INTO sql_assertions(scope,accepted) VALUES('budget_mutation',CASE WHEN ?=1 AND EXISTS(SELECT 1 FROM budget_month_latches WHERE rowid=? AND from_utc=?) THEN 1 ELSE 0 END) ON CONFLICT(scope) DO UPDATE SET accepted=excluded.accepted;
-- budget-months-budget_month_latches-guard:end

-- budget-months-budget_month_latches-copy:start
INSERT INTO cutover_budget_month_latches(rowid,user_id,budget_id,from_utc_ms,time_zone,highest_reached)
SELECT rowid,user_id,budget_id,?,time_zone,CASE WHEN reached_80=0 AND reached_100=0 THEN 0 WHEN reached_80=1 AND reached_100=0 THEN 80 WHEN reached_80=1 AND reached_100=1 THEN 100 ELSE -1 END FROM budget_month_latches WHERE rowid=?;
-- budget-months-budget_month_latches-copy:end

-- budget-months-budget_threshold_alerts-guard:start
INSERT INTO sql_assertions(scope,accepted) VALUES('budget_mutation',CASE WHEN ?=1 AND EXISTS(SELECT 1 FROM budget_threshold_alerts WHERE rowid=? AND from_utc=?) THEN 1 ELSE 0 END) ON CONFLICT(scope) DO UPDATE SET accepted=excluded.accepted;
-- budget-months-budget_threshold_alerts-guard:end

-- budget-months-budget_threshold_alerts-copy:start
INSERT INTO cutover_budget_threshold_alerts(rowid,user_id,budget_id,from_utc_ms,time_zone,threshold,state,crossing_json,delivery_group_id,consent_grant_id)
SELECT rowid,user_id,budget_id,?,time_zone,threshold,state,crossing_json,delivery_group_id,consent_grant_id FROM budget_threshold_alerts WHERE rowid=?;
-- budget-months-budget_threshold_alerts-copy:end

-- budget-months-plans-copy:start
INSERT INTO cutover_budget_month_plan_records(rowid,kind,user_id,month,budget_id,group_name,cap,currency) SELECT rowid,kind,user_id,month,budget_id,group_name,cap,currency FROM budget_month_plan_records;
-- budget-months-plans-copy:end

-- budget-months-rollback-copy:start
INSERT INTO cutover_budgets(rowid,id,user_id,category_id,currency,cap,created_at,updated_at,group_name,starts_month) SELECT rowid,id,user_id,category_id,currency,cap,strftime('%Y-%m-%dT%H:%M:%fZ',created_at_ms/1000.0,'unixepoch'),strftime('%Y-%m-%dT%H:%M:%fZ',updated_at_ms/1000.0,'unixepoch'),group_name,starts_month FROM budgets;
INSERT INTO cutover_budget_month_latches(rowid,user_id,budget_id,from_utc,time_zone,reached_80,reached_100) SELECT rowid,user_id,budget_id,strftime('%Y-%m-%dT%H:%M:%fZ',from_utc_ms/1000.0,'unixepoch'),time_zone,CASE WHEN highest_reached>=80 THEN 1 ELSE 0 END,CASE WHEN highest_reached=100 THEN 1 ELSE 0 END FROM budget_month_latches;
INSERT INTO cutover_budget_threshold_alerts(rowid,user_id,budget_id,from_utc,time_zone,threshold,state,crossing_json,delivery_group_id,consent_grant_id) SELECT rowid,user_id,budget_id,strftime('%Y-%m-%dT%H:%M:%fZ',from_utc_ms/1000.0,'unixepoch'),time_zone,threshold,state,crossing_json,delivery_group_id,consent_grant_id FROM budget_threshold_alerts;
INSERT INTO cutover_budget_month_plan_records(rowid,kind,user_id,month,budget_id,group_name,cap,currency) SELECT rowid,kind,user_id,month,budget_id,group_name,cap,currency FROM budget_month_plan_records;
-- budget-months-rollback-copy:end

-- budget-work-guard:start
INSERT INTO sql_assertions(scope,accepted)
SELECT 'budget_work_cutover',CASE WHEN
 (SELECT count(*) FROM budget_state)=?
 AND NOT EXISTS(SELECT 1 FROM erasure_requests WHERE state<>'Complete')
 AND NOT EXISTS(SELECT 1 FROM erasure_archives WHERE store_id IN
  ('budget_user_state','budget_reconciliation_work','budget_crossing_publications'))
 AND NOT EXISTS(SELECT 1 FROM budget_state WHERE
  (kind='work' AND version<1) OR
  abs(coalesce(detected_at_ms,0))>8640000000000000 OR
  abs(coalesce(materialized_at_ms,0))>8640000000000000 OR
  abs(coalesce(created_at_ms,0))>8640000000000000 OR
  abs(coalesce(offer_requested_at_ms,0))>8640000000000000 OR
  abs(coalesce(first_last_evaluated_at_ms,0))>8640000000000000 OR
  abs(coalesce(last_evaluated_at_ms,0))>8640000000000000)
 THEN 1 ELSE 0 END ON CONFLICT(scope) DO UPDATE SET accepted=excluded.accepted;
-- budget-work-guard:end

-- budget-work-roots-copy:start
INSERT INTO cutover_budget_user_state(rowid,user_id,revision,first_budget_id,first_created_at_ms,offer_requested_at_ms,last_evaluated_at_ms)
SELECT r.rowid,r.user_id,coalesce(r.revision,0),r.budget_id,r.created_at_ms,r.offer_requested_at_ms,
 coalesce((SELECT min(clock) FROM (
  SELECT user_id,last_evaluated_at_ms AS clock FROM budget_state WHERE kind='work'
  UNION ALL SELECT user_id,last_evaluated_at_ms FROM budget_state WHERE kind='publication' AND materialized_at_ms IS NULL
  UNION ALL SELECT user_id,first_last_evaluated_at_ms FROM budget_state WHERE kind='user' AND budget_id IS NOT NULL AND offer_requested_at_ms IS NULL
 ) p WHERE p.user_id=r.user_id),0)
FROM budget_state r WHERE r.kind='user';
INSERT INTO cutover_budget_user_state(rowid,user_id,last_evaluated_at_ms)
SELECT (SELECT coalesce(max(rowid),0) FROM budget_state)+row_number() OVER(ORDER BY user_id),user_id,min(clock)
FROM (
 SELECT user_id,last_evaluated_at_ms AS clock FROM budget_state WHERE kind='work'
 UNION ALL SELECT user_id,last_evaluated_at_ms FROM budget_state WHERE kind='publication' AND materialized_at_ms IS NULL
) p WHERE NOT EXISTS(SELECT 1 FROM cutover_budget_user_state s WHERE s.user_id=p.user_id) GROUP BY user_id;
INSERT INTO cutover_budget_publications(rowid,user_id,delivery_group_id,detected_at_ms,materialized_at_ms)
SELECT rowid,user_id,record_id,detected_at_ms,materialized_at_ms FROM budget_state WHERE kind='publication';
-- budget-work-roots-copy:end

-- budget-work-instant-guard:start
INSERT INTO sql_assertions(scope,accepted)
SELECT 'budget_work_instant',CASE WHEN ?=1 AND EXISTS(
 SELECT 1 FROM budget_state WHERE kind='work' AND rowid=? AND occurred_at=? AND version=?)
 THEN 1 ELSE 0 END ON CONFLICT(scope) DO UPDATE SET accepted=excluded.accepted;
-- budget-work-instant-guard:end

-- budget-work-instant-copy:start
INSERT INTO cutover_budget_evaluation_work(rowid,user_id,occurred_at_ms,version)
SELECT rowid,user_id,?,version FROM budget_state WHERE kind='work' AND rowid=?;
-- budget-work-instant-copy:end

-- budget-work-rollback-copy:start
INSERT INTO cutover_budget_state(kind,user_id,revision,budget_id,created_at_ms,offer_requested_at_ms,first_last_evaluated_at_ms,version,last_evaluated_at_ms)
SELECT 'user',user_id,nullif(revision,0),first_budget_id,first_created_at_ms,offer_requested_at_ms,
 CASE WHEN first_budget_id IS NOT NULL THEN last_evaluated_at_ms END,NULL,NULL FROM budget_user_state;
INSERT INTO cutover_budget_state(kind,user_id,occurred_at,version,last_evaluated_at_ms)
SELECT 'work',w.user_id,strftime('%Y-%m-%dT%H:%M:%fZ',w.occurred_at_ms/1000.0,'unixepoch'),w.version,s.last_evaluated_at_ms
FROM budget_evaluation_work w JOIN budget_user_state s ON s.user_id=w.user_id;
INSERT INTO cutover_budget_state(kind,user_id,record_id,detected_at_ms,materialized_at_ms,version,last_evaluated_at_ms)
SELECT 'publication',p.user_id,p.delivery_group_id,p.detected_at_ms,p.materialized_at_ms,NULL,coalesce(s.last_evaluated_at_ms,0)
FROM budget_publications p LEFT JOIN budget_user_state s ON s.user_id=p.user_id;
-- budget-work-rollback-copy:end

-- budget-work-rollback-guard:start
INSERT INTO sql_assertions(scope,accepted)
SELECT 'budget_work_rollback',CASE WHEN
 (SELECT count(*) FROM budget_user_state)=? AND
 (SELECT count(*) FROM budget_evaluation_work)=? AND
 (SELECT count(*) FROM budget_publications)=? AND
 NOT EXISTS(SELECT 1 FROM erasure_requests WHERE state<>'Complete') AND
 NOT EXISTS(SELECT 1 FROM erasure_archives WHERE store_id IN
 ('budget_user_state','budget_reconciliation_work','budget_crossing_publications')) AND
 NOT EXISTS(SELECT 1 FROM budget_evaluation_work w WHERE
  NOT EXISTS(SELECT 1 FROM budget_user_state s WHERE s.user_id=w.user_id) OR
  occurred_at_ms IS NOT CAST(round(unixepoch(strftime('%Y-%m-%dT%H:%M:%fZ',occurred_at_ms/1000.0,'unixepoch'),'subsec')*1000) AS INTEGER))
 THEN 1 ELSE 0 END ON CONFLICT(scope) DO UPDATE SET accepted=excluded.accepted;
-- budget-work-rollback-guard:end

-- recurring-instant-guard:start
INSERT INTO sql_assertions(scope,accepted)
SELECT 'recurring_instant_cutover',CASE WHEN
 (SELECT count(*) FROM recurring_evaluation_records)=? AND
 (SELECT count(*) FROM recurring_series)=? AND
 NOT EXISTS(SELECT 1 FROM erasure_requests WHERE state<>'Complete') AND
 NOT EXISTS(SELECT 1 FROM erasure_archives WHERE store_id IN
 ('recurring_facts','recurring_progress','recurring_proposals','recurring_series','recurring_confirmations')) AND
 NOT EXISTS(SELECT 1 FROM recurring_evaluation_records WHERE
  (occurred_at IS NOT NULL AND strftime('%Y-%m-%dT%H:%M:%fZ',occurred_at) IS NOT occurred_at) OR
  (cursor_at IS NOT NULL AND cursor_at<>'' AND strftime('%Y-%m-%dT%H:%M:%fZ',cursor_at) IS NOT cursor_at) OR
  (evaluated_at IS NOT NULL AND strftime('%Y-%m-%dT%H:%M:%fZ',evaluated_at) IS NOT evaluated_at) OR
  (first_captured_at IS NOT NULL AND strftime('%Y-%m-%dT%H:%M:%fZ',first_captured_at) IS NOT first_captured_at) OR
  (kind='progress' AND (revision<1 OR evaluated_revision<0 OR
   (cursor_at='')<>(cursor_id='') OR (evaluated_at IS NULL)<>(evaluated_revision=0) OR
   (phase='complete' AND (evaluated_revision<>revision OR evaluated_at IS NULL)))) OR
  (kind='fact' AND (json_extract(fact_json,'$.id') IS NOT id OR
   json_extract(fact_json,'$.occurredAt') IS NOT occurred_at))) AND
 NOT EXISTS(SELECT 1 FROM recurring_series WHERE
  json_extract(series_json,'$.id') IS NOT id OR json_extract(series_json,'$.money.currency') IS NOT currency OR
  (confirmed_at IS NOT NULL AND (strftime('%Y-%m-%dT%H:%M:%fZ',confirmed_at) IS NOT confirmed_at OR
   json_extract(confirmation_json,'$.id') IS NOT confirmation_id OR
   json_extract(confirmation_json,'$.seriesId') IS NOT id OR
   json_extract(confirmation_json,'$.confirmedAt') IS NOT confirmed_at OR
   json_extract(series_json,'$.confirmedAt') IS NOT confirmed_at)))
 THEN 1 ELSE 0 END ON CONFLICT(scope) DO UPDATE SET accepted=excluded.accepted;
-- recurring-instant-guard:end

-- recurring-instant-series-guard:start
INSERT INTO sql_assertions(scope,accepted)
SELECT 'recurring_series_projection',CASE WHEN EXISTS(
 SELECT 1 FROM recurring_series WHERE rowid=? AND series_json=? AND counterparty_key=?
) THEN 1 ELSE 0 END ON CONFLICT(scope) DO UPDATE SET accepted=excluded.accepted;
-- recurring-instant-series-guard:end

-- recurring-instant-copy:start
INSERT INTO cutover_recurring_evaluation_records
(rowid,user_id,kind,id,group_key,occurred_at_ms,fact_json,proposal_json,revision,phase,cursor_at_ms,cursor_id,evaluated_at_ms,evaluated_revision,first_captured_at_ms,time_zone)
SELECT rowid,user_id,kind,id,group_key,CAST(round(unixepoch(occurred_at,'subsec')*1000) AS INTEGER),fact_json,proposal_json,revision,phase,
 CAST(round(unixepoch(nullif(cursor_at,''),'subsec')*1000) AS INTEGER),cursor_id,
 CAST(round(unixepoch(evaluated_at,'subsec')*1000) AS INTEGER),evaluated_revision,
 CAST(round(unixepoch(first_captured_at,'subsec')*1000) AS INTEGER),time_zone FROM recurring_evaluation_records;
INSERT INTO cutover_recurring_series
(rowid,user_id,id,currency,counterparty_key,series_json,evidence_json,reference_json,valid,confirmation_id,confirmed_at_ms,confirmation_context_json,confirmation_json,digest_excluded,confirmation_sequence)
SELECT rowid,user_id,id,currency,counterparty_key,series_json,evidence_json,reference_json,valid,confirmation_id,
 CAST(round(unixepoch(confirmed_at,'subsec')*1000) AS INTEGER),confirmation_context_json,confirmation_json,digest_excluded,confirmation_sequence FROM recurring_series;
-- recurring-instant-copy:end

-- recurring-instant-rollback-guard:start
INSERT INTO sql_assertions(scope,accepted)
SELECT 'recurring_instant_rollback',CASE WHEN
 (SELECT count(*) FROM recurring_evaluation_records)=? AND
 (SELECT count(*) FROM recurring_series)=? AND
 NOT EXISTS(SELECT 1 FROM erasure_requests WHERE state<>'Complete') AND
 NOT EXISTS(SELECT 1 FROM erasure_archives WHERE store_id IN
 ('recurring_facts','recurring_progress','recurring_proposals','recurring_series','recurring_confirmations')) AND
 NOT EXISTS(SELECT 1 FROM (
 SELECT occurred_at_ms AS instant FROM recurring_evaluation_records UNION ALL
 SELECT cursor_at_ms FROM recurring_evaluation_records UNION ALL
 SELECT evaluated_at_ms FROM recurring_evaluation_records UNION ALL
 SELECT first_captured_at_ms FROM recurring_evaluation_records UNION ALL
 SELECT confirmed_at_ms FROM recurring_series
 ) WHERE instant IS NOT NULL AND (instant NOT BETWEEN -62135596800000 AND 253402300799999 OR
 instant IS NOT CAST(round(unixepoch(strftime('%Y-%m-%dT%H:%M:%fZ',instant/1000.0,'unixepoch'),'subsec')*1000) AS INTEGER)))
 THEN 1 ELSE 0 END ON CONFLICT(scope) DO UPDATE SET accepted=excluded.accepted;
-- recurring-instant-rollback-guard:end

-- recurring-instant-rollback-copy:start
INSERT INTO cutover_recurring_evaluation_records
(rowid,user_id,kind,id,group_key,occurred_at,fact_json,proposal_json,revision,phase,cursor_at,cursor_id,evaluated_at,evaluated_revision,first_captured_at,time_zone)
SELECT rowid,user_id,kind,id,group_key,strftime('%Y-%m-%dT%H:%M:%fZ',occurred_at_ms/1000.0,'unixepoch'),fact_json,proposal_json,revision,phase,
 CASE WHEN kind='progress' AND cursor_at_ms IS NULL THEN '' ELSE strftime('%Y-%m-%dT%H:%M:%fZ',cursor_at_ms/1000.0,'unixepoch') END,cursor_id,
 strftime('%Y-%m-%dT%H:%M:%fZ',evaluated_at_ms/1000.0,'unixepoch'),evaluated_revision,
 strftime('%Y-%m-%dT%H:%M:%fZ',first_captured_at_ms/1000.0,'unixepoch'),time_zone FROM recurring_evaluation_records;
INSERT INTO cutover_recurring_series
(rowid,user_id,id,currency,counterparty_key,series_json,evidence_json,reference_json,valid,confirmation_id,confirmed_at,confirmation_context_json,confirmation_json,digest_excluded,confirmation_sequence)
SELECT rowid,user_id,id,currency,counterparty_key,series_json,evidence_json,reference_json,valid,confirmation_id,
 strftime('%Y-%m-%dT%H:%M:%fZ',confirmed_at_ms/1000.0,'unixepoch'),confirmation_context_json,confirmation_json,digest_excluded,confirmation_sequence FROM recurring_series;
-- recurring-instant-rollback-copy:end

-- insight-content-guard:start
INSERT INTO sql_assertions(scope,accepted)
SELECT 'insight_content_cutover',CASE WHEN
 (SELECT count(*) FROM insight_events)=? AND (SELECT count(*) FROM insight_reports)=? AND
 NOT EXISTS(SELECT 1 FROM erasure_requests WHERE state<>'Complete') AND
 NOT EXISTS(SELECT 1 FROM erasure_archives WHERE store_id IN ('insight_events','insight_delivery_attempts','insight_reports','proactive_messages','proactivity_offer_requests','weekly_question_intents','proactivity_message_events','reminder_delivery_receipts')) AND
 NOT EXISTS(SELECT 1 FROM insight_events WHERE
  strftime('%Y-%m-%dT%H:%M:%fZ',scheduled_at) IS NOT scheduled_at OR
  (delivery_sent_at IS NOT NULL AND strftime('%Y-%m-%dT%H:%M:%fZ',delivery_sent_at) IS NOT delivery_sent_at)) AND
 NOT EXISTS(SELECT 1 FROM insight_reports r LEFT JOIN insight_events e ON e.user_id=r.user_id AND e.id=r.delivery_id WHERE
  (r.kind='weekly-summary' AND (e.kind IS NOT 'weekly-summary' OR r.scheduled_at_ms IS NOT CAST(round(unixepoch(e.scheduled_at,'subsec')*1000) AS INTEGER))) OR
  (r.reminder_grant_id IS NOT NULL AND (e.kind IS NOT 'manual-entry-reminder' OR
   (r.scheduled_at_ms IS NOT NULL AND (r.consent_grant_id IS NOT r.reminder_grant_id OR r.expires_at_ms IS NOT r.reminder_expires_at_ms)))) OR
  (r.report_json IS NOT NULL AND (e.kind IS NOT 'new-recurring-series' OR
   json_extract(r.report_json,'$.insightEventId') IS NOT e.id OR
   json_extract(r.report_json,'$.serviceMarket') IS NOT e.service_market OR
   json_extract(r.report_json,'$.locale') IS NOT e.locale OR
   json_extract(r.report_json,'$.scheduledAt') IS NOT e.scheduled_at OR
   r.instruction_id IS NOT e.schedule_id OR r.instruction_version IS NOT e.schedule_version OR
   json_extract(r.report_json,'$.payload.confirmationDay.timeZone') IS NOT e.time_zone OR
   json_extract(r.report_json,'$.payload.confirmationDay.localDate') IS NOT r.local_date OR
   CAST(round(unixepoch(json_extract(r.report_json,'$.payload.confirmationDay.from'),'subsec')*1000) AS INTEGER) IS NOT r.day_from_ms OR
   CAST(round(unixepoch(json_extract(r.report_json,'$.payload.confirmationDay.toExclusive'),'subsec')*1000) AS INTEGER) IS NOT r.day_to_ms OR
   strftime('%Y-%m-%dT%H:%M:%fZ',json_extract(r.report_json,'$.expiresAt')) IS NOT json_extract(r.report_json,'$.expiresAt') OR
   (r.scheduled_at_ms IS NOT NULL AND (r.consent_grant_id IS NOT r.grant_id OR r.scheduled_at_ms IS NOT CAST(round(unixepoch(e.scheduled_at,'subsec')*1000) AS INTEGER) OR r.expires_at_ms IS NOT CAST(round(unixepoch(json_extract(r.report_json,'$.expiresAt'),'subsec')*1000) AS INTEGER))) OR
   EXISTS(SELECT 1 FROM json_each(r.report_json) WHERE key NOT IN ('insightEventId','serviceMarket','locale','scheduledAt','expiresAt','payload')))))
 THEN 1 ELSE 0 END;
-- insight-content-guard:end

-- insight-content-json-guard:start
INSERT INTO sql_assertions(scope,accepted)
SELECT 'insight_content_json',CASE WHEN EXISTS(SELECT 1 FROM insight_reports
 WHERE rowid=? AND payload_json IS ? AND presentation_json IS ? AND report_json IS ?)
 THEN 1 ELSE 0 END
ON CONFLICT(scope) DO UPDATE SET accepted=excluded.accepted;
-- insight-content-json-guard:end

-- insight-content-copy:start
INSERT INTO cutover_insight_events(rowid,id,user_id,kind,schedule_id,schedule_version,service_market,locale,time_zone,scheduled_at_ms,money_groups_json,lifecycle_state,delivery_receipt_id,delivery_sent_at_ms,delivery_channel,delivery_provider,delivery_provider_message_id,budget_delivery_group_id,budget_threshold,budget_crossing_json,transcript_id,transcript_kind,weekly_governor_counted,reminder_grant_id,reminder_evidence_expires_at_ms) SELECT e.rowid,e.id,e.user_id,e.kind,e.schedule_id,e.schedule_version,e.service_market,e.locale,e.time_zone,CAST(round(unixepoch(e.scheduled_at,'subsec')*1000) AS INTEGER),e.money_groups_json,e.lifecycle_state,e.delivery_receipt_id,CAST(round(unixepoch(e.delivery_sent_at,'subsec')*1000) AS INTEGER),e.delivery_channel,e.delivery_provider,e.delivery_provider_message_id,e.budget_delivery_group_id,e.budget_threshold,e.budget_crossing_json,e.transcript_id,e.transcript_kind,e.weekly_governor_counted,r.reminder_grant_id,r.reminder_expires_at_ms FROM insight_events e LEFT JOIN insight_reports r ON r.kind='proactivity-delivery' AND r.user_id=e.user_id AND r.delivery_id=e.id;

INSERT INTO cutover_insight_reports(rowid,user_id,insight_event_id,kind,consent_grant_id,payload_json,presentation_json,content_expires_at_ms,local_date,day_from_ms,day_to_ms,original_delivery_expires_at_ms) SELECT rowid,user_id,delivery_id,CASE kind WHEN 'weekly-summary' THEN 'weekly-summary' ELSE 'recurring-digest' END,CASE kind WHEN 'weekly-summary' THEN consent_grant_id ELSE grant_id END,CASE kind WHEN 'weekly-summary' THEN payload_json ELSE json_extract(report_json,'$.payload') END,presentation_json,CASE WHEN kind='weekly-summary' THEN expires_at_ms END,local_date,day_from_ms,day_to_ms,CASE WHEN report_json IS NOT NULL THEN CAST(round(unixepoch(json_extract(report_json,'$.expiresAt'),'subsec')*1000) AS INTEGER) END FROM insight_reports WHERE kind='weekly-summary' OR report_json IS NOT NULL;

INSERT INTO cutover_proactive_messages(rowid,kind,id,user_id,role,report_event_id,consent_grant_id,offer_id,text,scheduled_at_ms,expires_at_ms,time_zone,created_at_ms,dispatch_state,dispatch_created_at_ms,dispatch_last_attempt_at_ms,dispatch_restart_attempts,reminder_governor_counted) SELECT r.rowid,r.kind,r.delivery_id,r.user_id,CASE r.kind WHEN 'weekly-summary' THEN 'weekly-summary' ELSE r.role END,CASE WHEN r.kind='weekly-summary' OR r.report_json IS NOT NULL THEN r.delivery_id END,r.consent_grant_id,r.offer_id,r.text,r.scheduled_at_ms,r.expires_at_ms,CASE r.kind WHEN 'weekly-summary' THEN e.time_zone ELSE r.time_zone END,CASE r.kind WHEN 'weekly-summary' THEN r.dispatch_created_at_ms ELSE r.created_at_ms END,r.dispatch_state,r.dispatch_created_at_ms,r.dispatch_last_attempt_at_ms,r.dispatch_restart_attempts,r.reminder_governor_counted FROM insight_reports r LEFT JOIN insight_events e ON e.user_id=r.user_id AND e.id=r.delivery_id WHERE (r.kind='weekly-summary' AND r.dispatch_state IS NOT NULL) OR (r.kind='proactivity-delivery' AND r.scheduled_at_ms IS NOT NULL);

INSERT INTO cutover_insight_offer_requests(rowid,id,user_id,request_kind,request_message_id,created_at_ms,last_evaluated_at_ms,materialized_at_ms,offer_message_id,current_recurring_opportunity) SELECT rowid,delivery_id,user_id,request_kind,request_message_id,created_at_ms,last_evaluated_at_ms,materialized_at_ms,offer_delivery_id,current_recurring_opportunity FROM insight_reports WHERE kind='offer-request';

INSERT INTO cutover_weekly_question_requests(rowid,id,user_id,origin,request_message_id,rejection_offer_id,created_at_ms,state,last_attempt_at_ms,restart_attempts) SELECT rowid,delivery_id,user_id,origin,request_message_id,rejection_offer_id,created_at_ms,dispatch_state,dispatch_last_attempt_at_ms,dispatch_restart_attempts FROM insight_reports WHERE kind='weekly-question';

UPDATE cutover_insight_events AS e SET message_kind='proactivity-delivery',message_id=(SELECT old.report_delivery_id FROM insight_events old WHERE old.user_id=e.user_id AND old.id=e.id) WHERE EXISTS(SELECT 1 FROM insight_events old WHERE old.user_id=e.user_id AND old.id=e.id AND old.report_delivery_id IS NOT NULL);

UPDATE cutover_insight_events AS e SET message_kind='weekly-summary',message_id=e.id WHERE e.kind='weekly-summary' AND EXISTS(SELECT 1 FROM cutover_proactive_messages m WHERE m.kind='weekly-summary' AND m.user_id=e.user_id AND m.id=e.id);
INSERT INTO cutover_proactive_transcript_entries(sequence,kind,id,user_id,insight_event_id,delivery_id,role,occurred_at_ms,text,expires_at_ms) SELECT sequence,kind,id,user_id,insight_event_id,delivery_id,role,occurred_at_ms,text,expires_at_ms FROM proactive_transcript_entries;
UPDATE sqlite_sequence SET seq=max(seq,coalesce((SELECT seq FROM sqlite_sequence WHERE name='proactive_transcript_entries'),0)) WHERE name='cutover_proactive_transcript_entries';
-- insight-content-copy:end

-- insight-content-rollback-guard:start
INSERT INTO sql_assertions(scope,accepted)
SELECT 'insight_content_rollback',CASE WHEN
 NOT EXISTS(SELECT 1 FROM erasure_requests WHERE state<>'Complete') AND
 NOT EXISTS(SELECT 1 FROM erasure_archives WHERE store_id IN ('insight_events','insight_delivery_attempts','insight_reports','proactive_messages','proactivity_offer_requests','weekly_question_intents','proactivity_message_events','reminder_delivery_receipts')) AND
 NOT EXISTS(SELECT 1 FROM proactive_messages WHERE report_event_id IS NOT NULL AND report_event_id<>id) AND
 NOT EXISTS(SELECT 1 FROM proactive_messages m JOIN insight_reports r ON r.user_id=m.user_id AND r.insight_event_id=m.report_event_id WHERE m.consent_grant_id<>r.consent_grant_id OR (r.kind='recurring-digest' AND m.expires_at_ms<>r.original_delivery_expires_at_ms) OR (r.kind='weekly-summary' AND (m.expires_at_ms<>r.content_expires_at_ms OR m.dispatch_state IS NULL))) AND
 NOT EXISTS(SELECT 1 FROM insight_events e JOIN proactive_messages m ON m.user_id=e.user_id AND m.kind=e.message_kind AND m.id=e.message_id WHERE e.kind='weekly-summary' AND (m.kind<>'weekly-summary' OR m.id<>e.id)) AND
 NOT EXISTS(SELECT 1 FROM insight_events WHERE message_kind='proactivity-delivery' AND kind='weekly-summary')
 THEN 1 ELSE 0 END;
-- insight-content-rollback-guard:end

-- insight-content-rollback-copy:start
INSERT INTO cutover_insight_events(rowid,id,user_id,kind,schedule_id,schedule_version,service_market,locale,time_zone,scheduled_at,money_groups_json,lifecycle_state,delivery_receipt_id,delivery_sent_at,delivery_channel,delivery_provider,delivery_provider_message_id,budget_delivery_group_id,budget_threshold,budget_crossing_json,transcript_id,transcript_kind,weekly_governor_counted) SELECT e.rowid,e.id,e.user_id,e.kind,e.schedule_id,e.schedule_version,e.service_market,e.locale,e.time_zone,strftime('%Y-%m-%dT%H:%M:%fZ',e.scheduled_at_ms/1000.0,'unixepoch'),e.money_groups_json,e.lifecycle_state,e.delivery_receipt_id,strftime('%Y-%m-%dT%H:%M:%fZ',e.delivery_sent_at_ms/1000.0,'unixepoch'),e.delivery_channel,e.delivery_provider,e.delivery_provider_message_id,e.budget_delivery_group_id,e.budget_threshold,e.budget_crossing_json,e.transcript_id,e.transcript_kind,e.weekly_governor_counted FROM insight_events e;

INSERT INTO cutover_insight_reports(kind,user_id,delivery_id,role,consent_grant_id,offer_id,text,scheduled_at_ms,expires_at_ms,time_zone,created_at_ms,payload_json,presentation_json,reminder_grant_id,reminder_expires_at_ms,instruction_id,instruction_version,grant_id,local_date,day_from_ms,day_to_ms,report_json,dispatch_state,dispatch_created_at_ms,dispatch_last_attempt_at_ms,dispatch_restart_attempts,reminder_governor_counted) SELECT CASE r.kind WHEN 'weekly-summary' THEN 'weekly-summary' ELSE 'proactivity-delivery' END,r.user_id,r.insight_event_id,CASE WHEN r.kind='recurring-digest' THEN m.role END,CASE WHEN r.kind='weekly-summary' THEN r.consent_grant_id ELSE m.consent_grant_id END,m.offer_id,m.text,CASE WHEN r.kind='weekly-summary' THEN e.scheduled_at_ms ELSE m.scheduled_at_ms END,CASE WHEN r.kind='weekly-summary' THEN r.content_expires_at_ms ELSE m.expires_at_ms END,CASE WHEN r.kind='recurring-digest' THEN m.time_zone END,CASE WHEN r.kind='recurring-digest' THEN m.created_at_ms END,CASE WHEN r.kind='weekly-summary' THEN r.payload_json END,r.presentation_json,NULL,NULL,CASE WHEN r.kind='recurring-digest' THEN e.schedule_id END,CASE WHEN r.kind='recurring-digest' THEN e.schedule_version END,CASE WHEN r.kind='recurring-digest' THEN r.consent_grant_id END,r.local_date,r.day_from_ms,r.day_to_ms,CASE WHEN r.kind='recurring-digest' THEN json_object('insightEventId',r.insight_event_id,'serviceMarket',e.service_market,'locale',e.locale,'scheduledAt',strftime('%Y-%m-%dT%H:%M:%fZ',e.scheduled_at_ms/1000.0,'unixepoch'),'expiresAt',strftime('%Y-%m-%dT%H:%M:%fZ',r.original_delivery_expires_at_ms/1000.0,'unixepoch'),'payload',json(r.payload_json)) END,m.dispatch_state,m.dispatch_created_at_ms,m.dispatch_last_attempt_at_ms,m.dispatch_restart_attempts,m.reminder_governor_counted FROM insight_reports r JOIN insight_events e ON e.user_id=r.user_id AND e.id=r.insight_event_id LEFT JOIN proactive_messages m ON m.user_id=r.user_id AND m.report_event_id=r.insight_event_id;

INSERT INTO cutover_insight_reports(kind,user_id,delivery_id,role,consent_grant_id,offer_id,text,scheduled_at_ms,expires_at_ms,time_zone,created_at_ms,reminder_grant_id,reminder_expires_at_ms,dispatch_state,dispatch_created_at_ms,dispatch_last_attempt_at_ms,dispatch_restart_attempts,reminder_governor_counted) SELECT m.kind,m.user_id,m.id,m.role,m.consent_grant_id,m.offer_id,m.text,m.scheduled_at_ms,m.expires_at_ms,m.time_zone,m.created_at_ms,e.reminder_grant_id,e.reminder_evidence_expires_at_ms,m.dispatch_state,m.dispatch_created_at_ms,m.dispatch_last_attempt_at_ms,m.dispatch_restart_attempts,m.reminder_governor_counted FROM proactive_messages m LEFT JOIN insight_events e ON e.user_id=m.user_id AND e.id=m.id AND e.kind='manual-entry-reminder' WHERE m.report_event_id IS NULL;

INSERT INTO cutover_insight_reports(kind,user_id,delivery_id,reminder_grant_id,reminder_expires_at_ms) SELECT 'proactivity-delivery',e.user_id,e.id,e.reminder_grant_id,e.reminder_evidence_expires_at_ms FROM insight_events e WHERE e.reminder_grant_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM proactive_messages m WHERE m.kind='proactivity-delivery' AND m.user_id=e.user_id AND m.id=e.id);

INSERT INTO cutover_insight_reports(kind,user_id,delivery_id,request_kind,request_message_id,created_at_ms,last_evaluated_at_ms,materialized_at_ms,offer_delivery_id,current_recurring_opportunity) SELECT 'offer-request',user_id,id,request_kind,request_message_id,created_at_ms,last_evaluated_at_ms,materialized_at_ms,offer_message_id,current_recurring_opportunity FROM insight_offer_requests;

INSERT INTO cutover_insight_reports(kind,user_id,delivery_id,origin,request_message_id,rejection_offer_id,created_at_ms,dispatch_state,dispatch_created_at_ms,dispatch_last_attempt_at_ms,dispatch_restart_attempts) SELECT 'weekly-question',user_id,id,origin,request_message_id,rejection_offer_id,created_at_ms,state,created_at_ms,last_attempt_at_ms,restart_attempts FROM weekly_question_requests;

UPDATE cutover_insight_events AS e SET report_delivery_id=(SELECT message_id FROM insight_events old WHERE old.user_id=e.user_id AND old.id=e.id AND old.message_kind='proactivity-delivery') WHERE EXISTS(SELECT 1 FROM insight_events old WHERE old.user_id=e.user_id AND old.id=e.id AND old.message_kind='proactivity-delivery');
INSERT INTO cutover_proactive_transcript_entries(sequence,kind,id,user_id,insight_event_id,delivery_id,role,occurred_at_ms,text,expires_at_ms) SELECT sequence,kind,id,user_id,insight_event_id,delivery_id,role,occurred_at_ms,text,expires_at_ms FROM proactive_transcript_entries;
UPDATE sqlite_sequence SET seq=max(seq,coalesce((SELECT seq FROM sqlite_sequence WHERE name='proactive_transcript_entries'),0)) WHERE name='cutover_proactive_transcript_entries';
-- insight-content-rollback-copy:end

-- reminder-control-guard:start
INSERT INTO sql_assertions(scope,accepted)
SELECT 'reminder_control_cutover',CASE WHEN
 (SELECT count(*) FROM audit_entries WHERE record_type='reminder_control')=? AND
 (SELECT count(*) FROM proactive_messages)=? AND NOT EXISTS(SELECT 1 FROM erasure_requests WHERE state<>'Complete') AND NOT EXISTS(SELECT 1 FROM erasure_archives WHERE store_id IN ('reminder_control_receipts','proactive_messages')) AND
 NOT EXISTS(SELECT 1 FROM audit_entries a WHERE a.record_type='reminder_control' AND
  (a.sequence<1 OR json_extract(a.id,'$[0]') IS NOT a.user_id OR json_type(a.id,'$[1]') IS NOT 'text' OR length(json_extract(a.id,'$[1]'))=0 OR
   (SELECT count(*) FROM proactive_messages m WHERE a.record_type='reminder_control' AND a.user_id=m.user_id AND m.kind='proactivity-delivery' AND m.role='reminder-question' AND a.outcome IN ('reminder:'||m.id||':continue','reminder:'||m.id||':stop'))<>1)) AND
 NOT EXISTS(SELECT 1 FROM proactive_messages m WHERE
  (SELECT count(*) FROM audit_entries a WHERE a.record_type='reminder_control' AND a.user_id=m.user_id AND m.kind='proactivity-delivery' AND m.role='reminder-question' AND a.outcome IN ('reminder:'||m.id||':continue','reminder:'||m.id||':stop'))>1)
 THEN 1 ELSE 0 END
ON CONFLICT(scope) DO UPDATE SET accepted=excluded.accepted;
-- reminder-control-guard:end

-- reminder-control-copy:start
INSERT INTO cutover_audit_entries(sequence,record_type,id,user_id,session_id,operation,outcome,occurred_at_ms,pat_id,oauth_connection_id,oauth_credential_id,hosted_turn_id,attempt_id,transition) SELECT sequence,record_type,id,user_id,session_id,operation,outcome,CASE WHEN record_type='request_admission' THEN accepted_at_ms ELSE occurred_at_ms END,pat_id,oauth_connection_id,oauth_credential_id,hosted_turn_id,attempt_id,transition FROM audit_entries WHERE record_type<>'reminder_control';

UPDATE sqlite_sequence SET seq=max(seq,coalesce((SELECT seq FROM sqlite_sequence WHERE name='audit_entries'),0)) WHERE name='cutover_audit_entries';

INSERT INTO cutover_proactive_messages(rowid,kind,id,user_id,role,report_event_id,consent_grant_id,offer_id,text,scheduled_at_ms,expires_at_ms,time_zone,created_at_ms,dispatch_state,dispatch_created_at_ms,dispatch_last_attempt_at_ms,dispatch_restart_attempts,reminder_governor_counted,control_message_id,control_choice,control_audit_sequence)
 SELECT m.rowid,m.kind,m.id,m.user_id,m.role,m.report_event_id,m.consent_grant_id,m.offer_id,m.text,m.scheduled_at_ms,m.expires_at_ms,m.time_zone,m.created_at_ms,m.dispatch_state,m.dispatch_created_at_ms,m.dispatch_last_attempt_at_ms,m.dispatch_restart_attempts,m.reminder_governor_counted,json_extract(a.id,'$[1]'),a.outcome,a.sequence
 FROM proactive_messages m LEFT JOIN audit_entries a ON a.record_type='reminder_control' AND a.user_id=m.user_id AND m.kind='proactivity-delivery' AND m.role='reminder-question' AND a.outcome IN ('reminder:'||m.id||':continue','reminder:'||m.id||':stop');
-- reminder-control-copy:end

-- reminder-control-rollback-guard:start
INSERT INTO sql_assertions(scope,accepted)
SELECT 'reminder_control_rollback',CASE WHEN NOT EXISTS(SELECT 1 FROM proactive_messages m JOIN audit_entries a ON a.sequence=m.control_audit_sequence) AND NOT EXISTS(SELECT 1 FROM erasure_requests WHERE state<>'Complete') AND NOT EXISTS(SELECT 1 FROM erasure_archives WHERE store_id IN ('reminder_control_receipts','proactive_messages')) AND
 NOT EXISTS(SELECT 1 FROM proactive_messages WHERE control_message_id IS NOT NULL AND
  (role<>'reminder-question' OR kind<>'proactivity-delivery' OR control_choice NOT IN ('reminder:'||id||':continue','reminder:'||id||':stop')))
 THEN 1 ELSE 0 END
ON CONFLICT(scope) DO UPDATE SET accepted=excluded.accepted;
-- reminder-control-rollback-guard:end

-- reminder-control-rollback-copy:start
INSERT INTO cutover_audit_entries(sequence,record_type,id,user_id,session_id,operation,outcome,occurred_at_ms,pat_id,oauth_connection_id,oauth_credential_id,hosted_turn_id,attempt_id,transition,accepted_at_ms) SELECT sequence,record_type,id,user_id,session_id,operation,outcome,CASE WHEN record_type='request_admission' THEN NULL ELSE occurred_at_ms END,pat_id,oauth_connection_id,oauth_credential_id,hosted_turn_id,attempt_id,transition,CASE WHEN record_type='request_admission' THEN occurred_at_ms END FROM audit_entries;

UPDATE sqlite_sequence SET seq=max(seq,coalesce((SELECT seq FROM sqlite_sequence WHERE name='audit_entries'),0)) WHERE name='cutover_audit_entries';

INSERT INTO cutover_audit_entries(sequence,record_type,id,user_id,outcome)
 SELECT control_audit_sequence,'reminder_control',json_array(user_id,control_message_id),user_id,control_choice
 FROM proactive_messages WHERE control_audit_sequence IS NOT NULL ORDER BY control_audit_sequence;

INSERT INTO cutover_audit_entries(record_type,id,user_id,outcome)
 SELECT 'reminder_control',json_array(user_id,control_message_id),user_id,control_choice
 FROM proactive_messages WHERE control_message_id IS NOT NULL AND control_audit_sequence IS NULL ORDER BY user_id,control_message_id;

INSERT INTO cutover_proactive_messages(rowid,kind,id,user_id,role,report_event_id,consent_grant_id,offer_id,text,scheduled_at_ms,expires_at_ms,time_zone,created_at_ms,dispatch_state,dispatch_created_at_ms,dispatch_last_attempt_at_ms,dispatch_restart_attempts,reminder_governor_counted) SELECT rowid,kind,id,user_id,role,report_event_id,consent_grant_id,offer_id,text,scheduled_at_ms,expires_at_ms,time_zone,created_at_ms,dispatch_state,dispatch_created_at_ms,dispatch_last_attempt_at_ms,dispatch_restart_attempts,reminder_governor_counted FROM proactive_messages;
-- reminder-control-rollback-copy:end

-- insight-governor-guard:start
INSERT INTO sql_assertions(scope,accepted) SELECT 'insight_governor_cutover',CASE WHEN NOT EXISTS(SELECT 1 FROM erasure_requests WHERE state<>'Complete') AND NOT EXISTS(SELECT 1 FROM erasure_archives WHERE store_id IN ('weekly_governors','reminder_governors','proactive_transcript_entries','proactive_transcript_event_links')) AND (SELECT count(*) FROM proactivity_governors)=? AND (SELECT count(*) FROM proactive_transcript_entries)=? AND NOT EXISTS(SELECT 1 FROM proactive_transcript_entries t WHERE t.kind='message' AND NOT EXISTS(SELECT 1 FROM proactive_messages m WHERE m.user_id=t.user_id AND m.kind='proactivity-delivery' AND m.role=t.role AND m.id=t.delivery_id)) THEN 1 ELSE 0 END ON CONFLICT(scope) DO UPDATE SET accepted=excluded.accepted;
-- insight-governor-guard:end

-- insight-governor-copy:start
INSERT INTO cutover_weekly_proactivity_state(rowid,user_id,unanswered,last_reply_at_ms,question_needed,question_delivered,question_delivered_at_ms,question_event_id,paused_at_ms,notice_session_id,notice_turn_id,notice_completed) SELECT rowid,user_id,unanswered,last_reply_at_ms,question_needed,question_delivered,question_delivered_at_ms,question_event_id,paused_at_ms,notice_session_id,notice_turn_id,notice_completed FROM proactivity_governors WHERE kind='weekly';
INSERT INTO cutover_reminder_proactivity_state(rowid,user_id,standing_json,last_reply_at_ms,question_id,question_delivered_at_ms,notice_turn_id,notice_completed) SELECT rowid,user_id,standing_json,last_reply_at_ms,question_id,question_delivered_at_ms,notice_turn_id,notice_completed FROM proactivity_governors WHERE kind='reminder';
INSERT INTO cutover_proactive_transcript_entries(sequence,kind,id,user_id,insight_event_id,delivery_id,role,occurred_at_ms,text,expires_at_ms) SELECT sequence,kind,id,user_id,insight_event_id,delivery_id,role,occurred_at_ms,text,expires_at_ms FROM proactive_transcript_entries;
UPDATE sqlite_sequence SET seq=max(seq,coalesce((SELECT seq FROM sqlite_sequence WHERE name='proactive_transcript_entries'),0)) WHERE name='cutover_proactive_transcript_entries';
-- insight-governor-copy:end

-- insight-governor-rollback-guard:start
INSERT INTO sql_assertions(scope,accepted) SELECT 'insight_governor_rollback',CASE WHEN NOT EXISTS(SELECT 1 FROM erasure_requests WHERE state<>'Complete') AND NOT EXISTS(SELECT 1 FROM erasure_archives WHERE store_id IN ('weekly_governors','reminder_governors','proactive_transcript_entries','proactive_transcript_event_links')) AND NOT EXISTS(SELECT 1 FROM weekly_proactivity_state w JOIN reminder_proactivity_state r ON r.rowid=w.rowid) THEN 1 ELSE 0 END ON CONFLICT(scope) DO UPDATE SET accepted=excluded.accepted;
-- insight-governor-rollback-guard:end

-- insight-governor-rollback-copy:start
INSERT INTO cutover_proactivity_governors(rowid,kind,user_id,unanswered,last_reply_at_ms,question_needed,question_delivered,question_delivered_at_ms,question_event_id,paused_at_ms,notice_session_id,notice_turn_id,notice_completed) SELECT rowid,'weekly',user_id,unanswered,last_reply_at_ms,question_needed,question_delivered,question_delivered_at_ms,question_event_id,paused_at_ms,notice_session_id,notice_turn_id,notice_completed FROM weekly_proactivity_state;
INSERT INTO cutover_proactivity_governors(rowid,kind,user_id,standing_json,last_reply_at_ms,question_id,question_delivered_at_ms,notice_turn_id,notice_completed) SELECT rowid,'reminder',user_id,standing_json,last_reply_at_ms,question_id,question_delivered_at_ms,notice_turn_id,notice_completed FROM reminder_proactivity_state;
INSERT INTO cutover_proactive_transcript_entries(sequence,kind,id,user_id,insight_event_id,delivery_id,role,occurred_at_ms,text,expires_at_ms) SELECT sequence,kind,id,user_id,insight_event_id,delivery_id,role,occurred_at_ms,text,expires_at_ms FROM proactive_transcript_entries;
UPDATE sqlite_sequence SET seq=max(seq,coalesce((SELECT seq FROM sqlite_sequence WHERE name='proactive_transcript_entries'),0)) WHERE name='cutover_proactive_transcript_entries';
-- insight-governor-rollback-copy:end

-- audit-clock-guard:start
INSERT INTO sql_assertions(scope,accepted) SELECT 'audit_clock_cutover',CASE WHEN NOT EXISTS(SELECT 1 FROM erasure_requests WHERE state<>'Complete') AND (SELECT count(*) FROM audit_entries)=? AND NOT EXISTS(SELECT 1 FROM audit_entries WHERE (record_type='request_admission' AND (accepted_at_ms IS NULL OR occurred_at_ms IS NOT NULL)) OR (record_type<>'request_admission' AND accepted_at_ms IS NOT NULL)) THEN 1 ELSE 0 END ON CONFLICT(scope) DO UPDATE SET accepted=excluded.accepted;
-- audit-clock-guard:end

-- audit-clock-copy:start
INSERT INTO cutover_audit_entries(sequence,record_type,id,user_id,session_id,operation,outcome,occurred_at_ms,pat_id,oauth_connection_id,oauth_credential_id,hosted_turn_id,attempt_id,transition) SELECT sequence,record_type,id,user_id,session_id,operation,outcome,CASE WHEN record_type='request_admission' THEN accepted_at_ms ELSE occurred_at_ms END,pat_id,oauth_connection_id,oauth_credential_id,hosted_turn_id,attempt_id,transition FROM audit_entries;
UPDATE sqlite_sequence SET seq=max(seq,coalesce((SELECT seq FROM sqlite_sequence WHERE name='audit_entries'),0)) WHERE name='cutover_audit_entries';
-- audit-clock-copy:end

-- audit-clock-rollback-guard:start
INSERT INTO sql_assertions(scope,accepted) SELECT 'audit_clock_rollback',CASE WHEN NOT EXISTS(SELECT 1 FROM erasure_requests WHERE state<>'Complete') THEN 1 ELSE 0 END ON CONFLICT(scope) DO UPDATE SET accepted=excluded.accepted;
-- audit-clock-rollback-guard:end

-- audit-clock-rollback-copy:start
INSERT INTO cutover_audit_entries(sequence,record_type,id,user_id,session_id,operation,outcome,occurred_at_ms,pat_id,oauth_connection_id,oauth_credential_id,hosted_turn_id,attempt_id,transition,accepted_at_ms) SELECT sequence,record_type,id,user_id,session_id,operation,outcome,CASE WHEN record_type='request_admission' THEN NULL ELSE occurred_at_ms END,pat_id,oauth_connection_id,oauth_credential_id,hosted_turn_id,attempt_id,transition,CASE WHEN record_type='request_admission' THEN occurred_at_ms END FROM audit_entries;
UPDATE sqlite_sequence SET seq=max(seq,coalesce((SELECT seq FROM sqlite_sequence WHERE name='audit_entries'),0)) WHERE name='cutover_audit_entries';
-- audit-clock-rollback-copy:end

-- memory-clock-guard:start
INSERT INTO sql_assertions(scope,accepted) SELECT 'memory_clock_cutover',CASE WHEN NOT EXISTS(SELECT 1 FROM erasure_requests WHERE state<>'Complete') AND (SELECT count(*) FROM memories)=? AND NOT EXISTS(SELECT 1 FROM memories WHERE created_at IS NOT strftime('%Y-%m-%dT%H:%M:%fZ',created_at) OR updated_at IS NOT strftime('%Y-%m-%dT%H:%M:%fZ',updated_at) OR CAST(substr(created_at,1,4) AS INTEGER) NOT BETWEEN 1 AND 9999 OR CAST(substr(updated_at,1,4) AS INTEGER) NOT BETWEEN 1 AND 9999) THEN 1 ELSE 0 END ON CONFLICT(scope) DO UPDATE SET accepted=excluded.accepted;
-- memory-clock-guard:end

-- memory-clock-copy:start
INSERT INTO cutover_memories(rowid,id,user_id,text,created_at_ms,updated_at_ms) SELECT rowid,id,user_id,text,CAST(round(unixepoch(created_at,'subsec')*1000) AS INTEGER),CAST(round(unixepoch(updated_at,'subsec')*1000) AS INTEGER) FROM memories;
-- memory-clock-copy:end

-- memory-clock-rollback-guard:start
INSERT INTO sql_assertions(scope,accepted) SELECT 'memory_clock_rollback',CASE WHEN NOT EXISTS(SELECT 1 FROM erasure_requests WHERE state<>'Complete') AND NOT EXISTS(SELECT 1 FROM memories WHERE created_at_ms NOT BETWEEN -62135596800000 AND 253402300799999 OR updated_at_ms NOT BETWEEN -62135596800000 AND 253402300799999) THEN 1 ELSE 0 END ON CONFLICT(scope) DO UPDATE SET accepted=excluded.accepted;
-- memory-clock-rollback-guard:end

-- memory-clock-rollback-copy:start
INSERT INTO cutover_memories(rowid,id,user_id,text,created_at,updated_at) SELECT rowid,id,user_id,text,strftime('%Y-%m-%dT%H:%M:%fZ',created_at_ms/1000.0,'unixepoch'),strftime('%Y-%m-%dT%H:%M:%fZ',updated_at_ms/1000.0,'unixepoch') FROM memories;
-- memory-clock-rollback-copy:end

-- hosted-guard-guard:start
INSERT INTO sql_assertions(scope,accepted) SELECT 'hosted_guard_cutover',CASE WHEN NOT EXISTS(SELECT 1 FROM erasure_requests WHERE state<>'Complete') AND (SELECT count(*) FROM hosted_agent_sessions)=? AND (SELECT count(*) FROM hosted_mutation_commits)=? AND NOT EXISTS(SELECT 1 FROM hosted_mutation_commits m LEFT JOIN hosted_turns t ON t.id=m.turn_id AND t.user_id=m.user_id WHERE t.id IS NULL OR m.valid<>1) THEN 1 ELSE 0 END ON CONFLICT(scope) DO UPDATE SET accepted=excluded.accepted;
-- hosted-guard-guard:end

-- hosted-guard-copy:start
INSERT INTO cutover_hosted_agent_sessions(rowid,id,user_id,consent_basis_json,started_at_ms,last_activity_at_ms,status,compacted_text,compacted_through_sequence,compacted_revision,compacted_at_ms) SELECT rowid,id,user_id,consent_basis_json,started_at_ms,last_activity_at_ms,status,compacted_text,compacted_through_sequence,compacted_revision,compacted_at_ms FROM hosted_agent_sessions;
INSERT INTO cutover_hosted_mutation_commits(rowid,turn_id,tool_call_id,user_id,committed_at_ms) SELECT rowid,turn_id,tool_call_id,user_id,committed_at_ms FROM hosted_mutation_commits;
-- hosted-guard-copy:end

-- hosted-guard-rollback-guard:start
INSERT INTO sql_assertions(scope,accepted) SELECT 'hosted_guard_rollback',CASE WHEN NOT EXISTS(SELECT 1 FROM erasure_requests WHERE state<>'Complete') AND NOT EXISTS(SELECT 1 FROM hosted_agent_sessions s WHERE s.compacted_revision IS NOT NULL AND (SELECT count(*) FROM json_each(?) j WHERE json_extract(j.value,'$.id')=s.id AND json_extract(j.value,'$.user_id')=s.user_id AND json_extract(j.value,'$.compacted_revision')=s.compacted_revision AND json_extract(j.value,'$.compacted_nonce') IS NOT NULL)<>1) THEN 1 ELSE 0 END ON CONFLICT(scope) DO UPDATE SET accepted=excluded.accepted;
-- hosted-guard-rollback-guard:end

-- hosted-guard-rollback-copy:start
INSERT INTO cutover_hosted_agent_sessions(rowid,id,user_id,consent_basis_json,started_at_ms,last_activity_at_ms,status,compacted_text,compacted_through_sequence,compacted_revision,compacted_nonce,compacted_at_ms) SELECT s.rowid,s.id,s.user_id,s.consent_basis_json,s.started_at_ms,s.last_activity_at_ms,s.status,s.compacted_text,s.compacted_through_sequence,s.compacted_revision,(SELECT json_extract(j.value,'$.compacted_nonce') FROM json_each(?) j WHERE json_extract(j.value,'$.id')=s.id AND json_extract(j.value,'$.user_id')=s.user_id AND json_extract(j.value,'$.compacted_revision')=s.compacted_revision),s.compacted_at_ms FROM hosted_agent_sessions s;
INSERT INTO cutover_hosted_mutation_commits(rowid,turn_id,tool_call_id,user_id,committed_at_ms,valid) SELECT rowid,turn_id,tool_call_id,user_id,committed_at_ms,1 FROM hosted_mutation_commits;
-- hosted-guard-rollback-copy:end

-- hosted-guard-verify:start
INSERT INTO sql_assertions(scope,accepted) SELECT 'hosted_guard_foreign_keys',CASE WHEN NOT EXISTS(SELECT 1 FROM pragma_foreign_key_check) THEN 1 ELSE 0 END ON CONFLICT(scope) DO UPDATE SET accepted=excluded.accepted;
PRAGMA defer_foreign_keys=OFF;
-- hosted-guard-verify:end

-- transcript-session-guard:start
INSERT INTO sql_assertions(scope,accepted) SELECT 'transcript_session_cutover',CASE WHEN NOT EXISTS(SELECT 1 FROM erasure_requests WHERE state<>'Complete') AND (SELECT count(*) FROM transcript_entries)=? AND NOT EXISTS(SELECT 1 FROM transcript_entries e LEFT JOIN hosted_turns t ON t.user_id=e.user_id AND t.id=e.turn_id WHERE t.id IS NULL OR t.hosted_session_id IS NOT e.hosted_session_id) AND NOT EXISTS(SELECT 1 FROM pragma_foreign_key_check) THEN 1 ELSE 0 END ON CONFLICT(scope) DO UPDATE SET accepted=excluded.accepted;
-- transcript-session-guard:end

-- hosted-document-clock-guard:start
INSERT INTO sql_assertions(scope,accepted) SELECT 'hosted_document_clock_cutover',CASE WHEN NOT EXISTS(SELECT 1 FROM erasure_requests WHERE state<>'Complete') AND (SELECT count(*) FROM hosted_turns)=? AND NOT EXISTS(SELECT 1 FROM hosted_turns WHERE (document_media_id IS NOT NULL AND document_created_at_ms IS NOT started_at_ms) OR (document_media_id IS NULL AND document_created_at_ms IS NOT NULL)) THEN 1 ELSE 0 END ON CONFLICT(scope) DO UPDATE SET accepted=excluded.accepted;
-- hosted-document-clock-guard:end

-- hosted-document-clock-copy:start
INSERT INTO cutover_hosted_mutation_commits(rowid,turn_id,tool_call_id,user_id,committed_at_ms) SELECT rowid,turn_id,tool_call_id,user_id,committed_at_ms FROM hosted_mutation_commits;
INSERT INTO cutover_hosted_turns(rowid,id,user_id,hosted_session_id,started_at_ms,terminal_at_ms,status,failure_reason,proposal_receipt_digest,proposed_at_ms,proposal_text,retention_terminal_at_ms,inbound_portfolio_id,inbound_bsuid,inbound_message_id,inbound_business_phone_number_id,inbound_occurred_at_ms,inbound_received_at_ms,inbound_reply_to_message_id,inbound_sandbox_phone,dispatch_offered_at_ms,dispatch_created_at_ms,document_media_id,document_staging_id,document_upload_grant_id,document_upload_expires_at_ms,document_reference_json) SELECT rowid,id,user_id,hosted_session_id,started_at_ms,terminal_at_ms,status,failure_reason,proposal_receipt_digest,proposed_at_ms,proposal_text,retention_terminal_at_ms,inbound_portfolio_id,inbound_bsuid,inbound_message_id,inbound_business_phone_number_id,inbound_occurred_at_ms,inbound_received_at_ms,inbound_reply_to_message_id,inbound_sandbox_phone,dispatch_offered_at_ms,dispatch_created_at_ms,document_media_id,document_staging_id,document_upload_grant_id,document_upload_expires_at_ms,document_reference_json FROM hosted_turns;
-- hosted-document-clock-copy:end

-- hosted-document-clock-rollback-copy:start
INSERT INTO cutover_hosted_mutation_commits(rowid,turn_id,tool_call_id,user_id,committed_at_ms) SELECT rowid,turn_id,tool_call_id,user_id,committed_at_ms FROM hosted_mutation_commits;
INSERT INTO cutover_hosted_turns(rowid,id,user_id,hosted_session_id,started_at_ms,terminal_at_ms,status,failure_reason,proposal_receipt_digest,proposed_at_ms,proposal_text,retention_terminal_at_ms,inbound_portfolio_id,inbound_bsuid,inbound_message_id,inbound_business_phone_number_id,inbound_occurred_at_ms,inbound_received_at_ms,inbound_reply_to_message_id,inbound_sandbox_phone,dispatch_offered_at_ms,dispatch_created_at_ms,document_media_id,document_staging_id,document_upload_grant_id,document_upload_expires_at_ms,document_reference_json,document_created_at_ms) SELECT rowid,id,user_id,hosted_session_id,started_at_ms,terminal_at_ms,status,failure_reason,proposal_receipt_digest,proposed_at_ms,proposal_text,retention_terminal_at_ms,inbound_portfolio_id,inbound_bsuid,inbound_message_id,inbound_business_phone_number_id,inbound_occurred_at_ms,inbound_received_at_ms,inbound_reply_to_message_id,inbound_sandbox_phone,dispatch_offered_at_ms,dispatch_created_at_ms,document_media_id,document_staging_id,document_upload_grant_id,document_upload_expires_at_ms,document_reference_json,CASE WHEN document_media_id IS NOT NULL THEN started_at_ms END FROM hosted_turns;
-- hosted-document-clock-rollback-copy:end

-- hosted-document-clock-verify:start
INSERT INTO sql_assertions(scope,accepted) SELECT 'hosted_document_clock_foreign_keys',CASE WHEN NOT EXISTS(SELECT 1 FROM pragma_foreign_key_check) THEN 1 ELSE 0 END ON CONFLICT(scope) DO UPDATE SET accepted=excluded.accepted;
PRAGMA defer_foreign_keys=OFF;
-- hosted-document-clock-verify:end

-- hosted-document-clock-rollback-guard:start
INSERT INTO sql_assertions(scope,accepted) SELECT 'hosted_document_clock_rollback',CASE WHEN NOT EXISTS(SELECT 1 FROM erasure_requests WHERE state<>'Complete') THEN 1 ELSE 0 END ON CONFLICT(scope) DO UPDATE SET accepted=excluded.accepted;
-- hosted-document-clock-rollback-guard:end

-- whatsapp-window-guard:start
INSERT INTO sql_assertions(scope,accepted) SELECT 'whatsapp_window_cutover',CASE WHEN NOT EXISTS(SELECT 1 FROM erasure_requests WHERE state<>'Complete') AND (SELECT count(*) FROM hosted_whatsapp_windows)=? AND NOT EXISTS(SELECT 1 FROM hosted_whatsapp_windows WHERE closes_at_ms IS NOT last_verified_inbound_at_ms+86400000) THEN 1 ELSE 0 END ON CONFLICT(scope) DO UPDATE SET accepted=excluded.accepted;
-- whatsapp-window-guard:end

-- whatsapp-window-copy:start
INSERT INTO cutover_whatsapp_service_windows(rowid,user_id,portfolio_id,bsuid,last_verified_inbound_at_ms) SELECT rowid,user_id,portfolio_id,bsuid,last_verified_inbound_at_ms FROM hosted_whatsapp_windows;
-- whatsapp-window-copy:end

-- whatsapp-window-rollback-guard:start
INSERT INTO sql_assertions(scope,accepted) SELECT 'whatsapp_window_rollback',CASE WHEN NOT EXISTS(SELECT 1 FROM erasure_requests WHERE state<>'Complete') THEN 1 ELSE 0 END ON CONFLICT(scope) DO UPDATE SET accepted=excluded.accepted;
-- whatsapp-window-rollback-guard:end

-- whatsapp-window-rollback-copy:start
INSERT INTO cutover_hosted_whatsapp_windows(rowid,user_id,portfolio_id,bsuid,last_verified_inbound_at_ms,closes_at_ms) SELECT rowid,user_id,portfolio_id,bsuid,last_verified_inbound_at_ms,last_verified_inbound_at_ms+86400000 FROM whatsapp_service_windows;
-- whatsapp-window-rollback-copy:end

-- whatsapp-delivery-guard:start
INSERT INTO sql_assertions(scope,accepted) SELECT 'whatsapp_delivery_cutover',CASE WHEN NOT EXISTS(SELECT 1 FROM erasure_requests WHERE state<>'Complete') AND (SELECT count(*) FROM whatsapp_deliveries)=? AND NOT EXISTS(SELECT 1 FROM whatsapp_deliveries WHERE last_attempt_at_ms IS NOT 0 OR (kind='weekly-question' AND consent_grant_id IS NOT NULL) OR (kind<>'weekly-question' AND grant_id IS NOT NULL)) THEN 1 ELSE 0 END ON CONFLICT(scope) DO UPDATE SET accepted=excluded.accepted;
-- whatsapp-delivery-guard:end

-- whatsapp-delivery-copy:start
INSERT INTO cutover_whatsapp_deliveries(rowid,kind,user_id,insight_event_id,correlation_token,portfolio_id,bsuid,business_phone_number_id,summary_json,text,scheduled_at_ms,expires_at_ms,time_zone,state,send_started_at_ms,provider_message_id,delivered_at_ms,last_received_at_ms,delivery_id,role,consent_grant_id,template_json,id,offer_id,created_at_ms,offer_json,turn_id,proposed_at_ms) SELECT rowid,kind,user_id,insight_event_id,correlation_token,portfolio_id,bsuid,business_phone_number_id,summary_json,text,scheduled_at_ms,expires_at_ms,time_zone,state,send_started_at_ms,provider_message_id,delivered_at_ms,last_received_at_ms,delivery_id,role,CASE WHEN kind='weekly-question' THEN grant_id ELSE consent_grant_id END,template_json,id,offer_id,created_at_ms,offer_json,turn_id,proposed_at_ms FROM whatsapp_deliveries;
INSERT INTO cutover_whatsapp_event_records(rowid,kind,portfolio_id,message_id,user_id,claimed_at_ms,outcome,correlation_token,provider_message_id,status,occurred_at_ms,received_at_ms) SELECT rowid,* FROM whatsapp_event_records;
-- whatsapp-delivery-copy:end

-- whatsapp-delivery-rollback-guard:start
INSERT INTO sql_assertions(scope,accepted) SELECT 'whatsapp_delivery_rollback',CASE WHEN NOT EXISTS(SELECT 1 FROM erasure_requests WHERE state<>'Complete') THEN 1 ELSE 0 END ON CONFLICT(scope) DO UPDATE SET accepted=excluded.accepted;
-- whatsapp-delivery-rollback-guard:end

-- whatsapp-delivery-rollback-copy:start
INSERT INTO cutover_whatsapp_deliveries(rowid,kind,user_id,insight_event_id,correlation_token,portfolio_id,bsuid,business_phone_number_id,summary_json,text,scheduled_at_ms,expires_at_ms,time_zone,state,send_started_at_ms,provider_message_id,delivered_at_ms,last_received_at_ms,delivery_id,role,consent_grant_id,template_json,id,offer_id,created_at_ms,offer_json,turn_id,proposed_at_ms,grant_id,last_attempt_at_ms) SELECT rowid,kind,user_id,insight_event_id,correlation_token,portfolio_id,bsuid,business_phone_number_id,summary_json,text,scheduled_at_ms,expires_at_ms,time_zone,state,send_started_at_ms,provider_message_id,delivered_at_ms,last_received_at_ms,delivery_id,role,CASE WHEN kind='weekly-question' THEN NULL ELSE consent_grant_id END,template_json,id,offer_id,created_at_ms,offer_json,turn_id,proposed_at_ms,CASE WHEN kind='weekly-question' THEN consent_grant_id END,0 FROM whatsapp_deliveries;
INSERT INTO cutover_whatsapp_event_records(rowid,kind,portfolio_id,message_id,user_id,claimed_at_ms,outcome,correlation_token,provider_message_id,status,occurred_at_ms,received_at_ms) SELECT rowid,* FROM whatsapp_event_records;
-- whatsapp-delivery-rollback-copy:end

-- whatsapp-delivery-verify:start
INSERT INTO sql_assertions(scope,accepted) SELECT 'whatsapp_delivery_foreign_keys',CASE WHEN NOT EXISTS(SELECT 1 FROM pragma_foreign_key_check) THEN 1 ELSE 0 END ON CONFLICT(scope) DO UPDATE SET accepted=excluded.accepted;
PRAGMA defer_foreign_keys=OFF;
-- whatsapp-delivery-verify:end

-- connection-owner-guard:start
INSERT INTO sql_assertions(scope,accepted) SELECT 'connection_owner_cutover',CASE WHEN NOT EXISTS(SELECT 1 FROM erasure_requests WHERE state<>'Complete') AND (SELECT count(*) FROM connections)=? AND (SELECT count(*) FROM connection_attempts)=? AND (SELECT count(*) FROM connection_institution_gate)=1 AND EXISTS(SELECT 1 FROM connection_institution_gate WHERE rowid=1 AND institution_id='bancolombia' AND enabled=0) AND NOT EXISTS(SELECT 1 FROM connection_attempts a LEFT JOIN connections c ON c.id=a.connection_id WHERE c.id IS NULL OR c.user_id IS NOT a.user_id OR c.institution_id IS NOT a.institution_id) THEN 1 ELSE 0 END ON CONFLICT(scope) DO UPDATE SET accepted=excluded.accepted;
-- connection-owner-guard:end

-- connection-owner-copy:start
INSERT INTO cutover_connections(rowid,id,user_id,institution_id,state,created_at_ms,updated_at_ms) SELECT rowid,* FROM connections;
INSERT INTO cutover_connection_attempts(rowid,id,connection_id,public_reference,status,created_at_ms,expires_at_ms,consumed_at_ms,prepared_session_id) SELECT rowid,id,connection_id,public_reference,status,created_at_ms,expires_at_ms,consumed_at_ms,prepared_session_id FROM connection_attempts;
-- connection-owner-copy:end

-- connection-owner-rollback-guard:start
INSERT INTO sql_assertions(scope,accepted) SELECT 'connection_owner_rollback',CASE WHEN NOT EXISTS(SELECT 1 FROM erasure_requests WHERE state<>'Complete') AND NOT EXISTS(SELECT 1 FROM connections WHERE institution_id<>'bancolombia') THEN 1 ELSE 0 END ON CONFLICT(scope) DO UPDATE SET accepted=excluded.accepted;
-- connection-owner-rollback-guard:end

-- connection-owner-rollback-copy:start
INSERT INTO cutover_connection_institution_gate(rowid,institution_id,enabled) VALUES(1,'bancolombia',0);
INSERT INTO cutover_connections(rowid,id,user_id,institution_id,state,created_at_ms,updated_at_ms) SELECT rowid,* FROM connections;
INSERT INTO cutover_connection_attempts(rowid,id,user_id,connection_id,institution_id,public_reference,status,created_at_ms,expires_at_ms,consumed_at_ms,prepared_session_id) SELECT a.rowid,a.id,c.user_id,a.connection_id,c.institution_id,a.public_reference,a.status,a.created_at_ms,a.expires_at_ms,a.consumed_at_ms,a.prepared_session_id FROM connection_attempts a JOIN connections c ON c.id=a.connection_id;
-- connection-owner-rollback-copy:end

-- connection-owner-verify:start
INSERT INTO sql_assertions(scope,accepted) SELECT 'connection_owner_foreign_keys',CASE WHEN NOT EXISTS(SELECT 1 FROM pragma_foreign_key_check) THEN 1 ELSE 0 END ON CONFLICT(scope) DO UPDATE SET accepted=excluded.accepted;
PRAGMA defer_foreign_keys=OFF;
-- connection-owner-verify:end

-- user-file-prefix-guard:start
WITH manifest AS(SELECT json_extract(value,'$.kind') AS kind,json_extract(value,'$.id') AS id,json_extract(value,'$.userId') AS user_id,json_extract(value,'$.oldKey') AS old_key,json_extract(value,'$.newKey') AS new_key,json_extract(value,'$.byteLength') AS byte_length,json_extract(value,'$.sha256') AS sha256,(json_type(value)='object' AND json_type(value,'$.kind')='text' AND json_type(value,'$.id')='text' AND length(json_extract(value,'$.id'))>0 AND json_type(value,'$.userId')='text' AND length(json_extract(value,'$.userId'))>0 AND json_type(value,'$.oldKey')='text' AND json_type(value,'$.newKey')='text' AND json_type(value,'$.byteLength')='integer' AND json_extract(value,'$.byteLength')>0 AND json_type(value,'$.sha256')='text' AND length(json_extract(value,'$.sha256'))=64 AND json_extract(value,'$.sha256') NOT GLOB '*[^0-9a-f]*') AS valid FROM json_each(?))
INSERT INTO sql_assertions(scope,accepted) SELECT 'user_file_prefix_cutover',CASE WHEN NOT EXISTS(SELECT 1 FROM erasure_requests WHERE state<>'Complete') AND NOT EXISTS(SELECT 1 FROM erasure_archives) AND NOT EXISTS(SELECT 1 FROM erasure_objects) AND NOT EXISTS(SELECT 1 FROM erasure_writers)
AND (SELECT count(*) FROM manifest)=(SELECT count(*) FROM forwarded_email_receipts WHERE substr(object_key,1,length('users/'||user_id||'/'))<>'users/'||user_id||'/')+(SELECT count(*) FROM statement_staging_objects WHERE substr(object_key,1,length('users/'||user_id||'/'))<>'users/'||user_id||'/')
AND (SELECT count(*) FROM manifest)=(SELECT count(DISTINCT kind||':'||id) FROM manifest)
AND NOT EXISTS(SELECT 1 FROM manifest m LEFT JOIN forwarded_email_receipts e ON m.kind='email' AND e.id=m.id LEFT JOIN statement_staging_objects s ON m.kind='statement' AND s.id=m.id WHERE m.valid IS NOT 1 OR m.kind NOT IN('email','statement') OR (m.kind='email' AND e.id IS NULL) OR (m.kind='statement' AND s.id IS NULL) OR coalesce(e.user_id,s.user_id) IS NOT m.user_id OR coalesce(e.object_key,s.object_key) IS NOT m.old_key OR coalesce(e.byte_length,s.byte_length) IS NOT m.byte_length OR (m.kind='email' AND e.delivery_digest IS NOT m.sha256) OR (m.kind='statement' AND s.sha256 IS NOT m.sha256) OR m.new_key IS NOT 'users/'||m.user_id||'/'||m.old_key OR length(m.new_key)>1024 OR (m.kind='email' AND m.old_key NOT LIKE 'email/v1/%') OR (m.kind='statement' AND m.old_key NOT LIKE 'staging/statement/v1/%'))
THEN 1 ELSE 0 END ON CONFLICT(scope) DO UPDATE SET accepted=excluded.accepted;
-- user-file-prefix-guard:end

-- user-file-prefix-copy:start
UPDATE forwarded_email_receipts SET object_key='users/'||user_id||'/'||object_key WHERE substr(object_key,1,length('users/'||user_id||'/'))<>'users/'||user_id||'/';
UPDATE statement_staging_objects SET object_key='users/'||user_id||'/'||object_key WHERE substr(object_key,1,length('users/'||user_id||'/'))<>'users/'||user_id||'/';
-- user-file-prefix-copy:end

-- user-file-prefix-rollback-copy:start
UPDATE forwarded_email_receipts SET object_key=(SELECT json_extract(value,'$.oldKey') FROM json_each(?) WHERE json_extract(value,'$.kind')='email' AND json_extract(value,'$.id')=forwarded_email_receipts.id AND json_extract(value,'$.userId')=forwarded_email_receipts.user_id AND json_extract(value,'$.newKey')=forwarded_email_receipts.object_key) WHERE EXISTS(SELECT 1 FROM json_each(?) WHERE json_extract(value,'$.kind')='email' AND json_extract(value,'$.id')=forwarded_email_receipts.id AND json_extract(value,'$.userId')=forwarded_email_receipts.user_id AND json_extract(value,'$.newKey')=forwarded_email_receipts.object_key);
UPDATE statement_staging_objects SET object_key=(SELECT json_extract(value,'$.oldKey') FROM json_each(?) WHERE json_extract(value,'$.kind')='statement' AND json_extract(value,'$.id')=statement_staging_objects.id AND json_extract(value,'$.userId')=statement_staging_objects.user_id AND json_extract(value,'$.newKey')=statement_staging_objects.object_key) WHERE EXISTS(SELECT 1 FROM json_each(?) WHERE json_extract(value,'$.kind')='statement' AND json_extract(value,'$.id')=statement_staging_objects.id AND json_extract(value,'$.userId')=statement_staging_objects.user_id AND json_extract(value,'$.newKey')=statement_staging_objects.object_key);
-- user-file-prefix-rollback-copy:end

-- erasure-selection-guard:start
INSERT INTO sql_assertions(scope,accepted) SELECT 'erasure_selection_cutover',CASE WHEN NOT EXISTS(SELECT 1 FROM erasure_chunk) AND NOT EXISTS(SELECT 1 FROM erasure_permits) THEN 1 ELSE 0 END ON CONFLICT(scope) DO UPDATE SET accepted=excluded.accepted;
-- erasure-selection-guard:end

-- erasure-selection-drop:start
DROP TABLE erasure_chunk;
-- erasure-selection-drop:end

-- erasure-selection-rollback:start
CREATE TABLE erasure_chunk (
  request_id TEXT NOT NULL REFERENCES erasure_requests(id),
  row_ref TEXT NOT NULL,
  PRIMARY KEY(request_id,row_ref)
) STRICT;
-- erasure-selection-rollback:end

-- release-smoke-ledger-guard:start
INSERT INTO sql_assertions(scope,accepted) SELECT 'release_smoke_ledger_cutover',CASE WHEN NOT EXISTS(SELECT 1 FROM release_smoke_probes WHERE expires_at_ms>?) THEN 1 ELSE 0 END ON CONFLICT(scope) DO UPDATE SET accepted=excluded.accepted;
-- release-smoke-ledger-guard:end

-- release-smoke-ledger-drop:start
DROP TABLE release_smoke_probes;
-- release-smoke-ledger-drop:end

-- release-smoke-ledger-rollback:start
CREATE TABLE release_smoke_probes (
  probe_id TEXT PRIMARY KEY NOT NULL CHECK (length(probe_id) = 32),
  git_revision TEXT NOT NULL CHECK (length(git_revision) = 40),
  expires_at_ms INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'queued', 'passed'))
) STRICT;
CREATE INDEX release_smoke_expiry ON release_smoke_probes(expires_at_ms);
-- release-smoke-ledger-rollback:end

-- release-smoke-ledger-rollback-copy:start
INSERT INTO release_smoke_probes(rowid,probe_id,git_revision,expires_at_ms,status) SELECT json_extract(value,'$.rowid'),json_extract(value,'$.probe_id'),json_extract(value,'$.git_revision'),json_extract(value,'$.expires_at_ms'),json_extract(value,'$.status') FROM json_each(?);
-- release-smoke-ledger-rollback-copy:end

-- whatsapp-recipient-guard:start
INSERT INTO sql_assertions(scope,accepted) SELECT 'recipient_route_count',count(*)=? FROM users WHERE route_portfolio_id IS NOT NULL;
INSERT INTO sql_assertions(scope,accepted) SELECT 'recipient_route_complete',NOT EXISTS(SELECT 1 FROM users WHERE ((route_portfolio_id IS NOT NULL)+(route_bsuid IS NOT NULL)+(route_phone_number_id IS NOT NULL)+(route_verified_at_ms IS NOT NULL)) NOT IN(0,4));
INSERT INTO sql_assertions(scope,accepted) SELECT 'recipient_route_association',NOT EXISTS(SELECT 1 FROM users WHERE route_portfolio_id IS NOT NULL AND (route_portfolio_id IS NOT whatsapp_portfolio_id OR route_bsuid IS NOT whatsapp_bsuid OR whatsapp_verified_at_ms IS NULL));
DELETE FROM sql_assertions WHERE scope IN('recipient_route_count','recipient_route_complete','recipient_route_association');
-- whatsapp-recipient-guard:end

-- whatsapp-recipient-copy:start
INSERT INTO whatsapp_recipients(rowid,user_id,portfolio_id,bsuid,business_phone_number_id,verified_at_ms) SELECT rowid,id,route_portfolio_id,route_bsuid,route_phone_number_id,route_verified_at_ms FROM users WHERE route_portfolio_id IS NOT NULL;
-- whatsapp-recipient-copy:end

-- whatsapp-recipient-drop:start
ALTER TABLE users DROP COLUMN route_verified_at_ms;
ALTER TABLE users DROP COLUMN route_phone_number_id;
ALTER TABLE users DROP COLUMN route_bsuid;
ALTER TABLE users DROP COLUMN route_portfolio_id;
-- whatsapp-recipient-drop:end

-- whatsapp-recipient-rollback-guard:start
INSERT INTO sql_assertions(scope,accepted) SELECT 'recipient_inverse_count',count(*)=? FROM whatsapp_recipients;
INSERT INTO sql_assertions(scope,accepted) SELECT 'recipient_inverse_association',NOT EXISTS(SELECT 1 FROM whatsapp_recipients r LEFT JOIN users u ON u.id=r.user_id WHERE u.id IS NULL OR r.rowid IS NOT u.rowid OR r.portfolio_id IS NOT u.whatsapp_portfolio_id OR r.bsuid IS NOT u.whatsapp_bsuid OR u.whatsapp_verified_at_ms IS NULL);
DELETE FROM sql_assertions WHERE scope IN('recipient_inverse_count','recipient_inverse_association');
-- whatsapp-recipient-rollback-guard:end

-- whatsapp-recipient-rollback-columns:start
ALTER TABLE users ADD COLUMN route_portfolio_id TEXT;
ALTER TABLE users ADD COLUMN route_bsuid TEXT;
ALTER TABLE users ADD COLUMN route_phone_number_id TEXT;
ALTER TABLE users ADD COLUMN route_verified_at_ms INTEGER CHECK((route_portfolio_id IS NULL AND route_bsuid IS NULL AND route_phone_number_id IS NULL AND route_verified_at_ms IS NULL) OR (route_portfolio_id IS NOT NULL AND route_bsuid IS NOT NULL AND route_phone_number_id IS NOT NULL AND route_verified_at_ms IS NOT NULL));
-- whatsapp-recipient-rollback-columns:end

-- whatsapp-recipient-rollback-copy:start
UPDATE users SET (route_portfolio_id,route_bsuid,route_phone_number_id,route_verified_at_ms)=(SELECT portfolio_id,bsuid,business_phone_number_id,verified_at_ms FROM whatsapp_recipients r WHERE r.user_id=users.id) WHERE EXISTS(SELECT 1 FROM whatsapp_recipients r WHERE r.user_id=users.id);
-- whatsapp-recipient-rollback-copy:end

-- full-delete-archive-retirement:start
INSERT INTO sql_assertions(scope,accepted) SELECT 'full_delete_archive_cutover',CASE WHEN NOT EXISTS(SELECT 1 FROM erasure_requests WHERE state<>'Complete') AND NOT EXISTS(SELECT 1 FROM erasure_archives) AND NOT EXISTS(SELECT 1 FROM erasure_objects) THEN 1 ELSE 0 END ON CONFLICT(scope) DO UPDATE SET accepted=excluded.accepted;
DROP TRIGGER budget_alert_occurrences_field_preserve_delete;
DROP TRIGGER budget_alert_occurrences_field_preserve_update;
DROP TRIGGER email_forwarding_addresses_field_preserve_delete;
DROP TRIGGER erasure_preserve_audit_entries_billing_transition;
DROP TRIGGER erasure_preserve_audit_entries_identity_read;
DROP TRIGGER erasure_preserve_audit_entries_insight_call;
DROP TRIGGER erasure_preserve_audit_entries_media_admission;
DROP TRIGGER erasure_preserve_audit_entries_publication;
DROP TRIGGER erasure_preserve_audit_entries_request_admission;
DROP TRIGGER erasure_preserve_audit_entries_security_mutation;
DROP TRIGGER erasure_preserve_audit_entries_session_call;
DROP TRIGGER erasure_preserve_audit_retention_permits_delete;
DROP TRIGGER erasure_preserve_billing_attempts_delete;
DROP TRIGGER erasure_preserve_billing_event_candidates_delete;
DROP TRIGGER erasure_preserve_billing_event_candidates_update;
DROP TRIGGER erasure_preserve_billing_price_notices_delete;
DROP TRIGGER erasure_preserve_billing_provider_transactions_delete;
DROP TRIGGER erasure_preserve_budget_crossing_publications_delete;
DROP TRIGGER erasure_preserve_budget_group_currencies_delete;
DROP TRIGGER erasure_preserve_budget_month_caps_delete;
DROP TRIGGER erasure_preserve_budget_month_latches_delete;
DROP TRIGGER erasure_preserve_budget_plan_months_delete;
DROP TRIGGER erasure_preserve_budget_reconciliation_work_delete;
DROP TRIGGER erasure_preserve_budget_threshold_alerts_delete;
DROP TRIGGER erasure_preserve_budget_user_versions_delete;
DROP TRIGGER erasure_preserve_budgets_delete;
DROP TRIGGER erasure_preserve_canonical_request_buckets_delete;
DROP TRIGGER erasure_preserve_canonical_request_leases_delete;
DROP TRIGGER erasure_preserve_canonical_request_replays_delete;
DROP TRIGGER erasure_preserve_card_enrollments_delete;
DROP TRIGGER erasure_preserve_commercial_allowance_consumptions_delete;
DROP TRIGGER erasure_preserve_connection_attempts_delete;
DROP TRIGGER erasure_preserve_connections_delete;
DROP TRIGGER erasure_preserve_consent_history_delete;
DROP TRIGGER erasure_preserve_dashboard_documents_delete;
DROP TRIGGER erasure_preserve_transaction_projection_bucket_delete;
DROP TRIGGER erasure_preserve_transaction_projection_digit_delete;
DROP TRIGGER erasure_preserve_transaction_projection_leaf_delete;
DROP TRIGGER erasure_preserve_transaction_projection_state_delete;
DROP TRIGGER erasure_preserve_forwarded_email_receipts_delete;
DROP TRIGGER erasure_preserve_hosted_agent_sessions_delete;
DROP TRIGGER erasure_preserve_hosted_compaction_attempts_delete;
DROP TRIGGER erasure_preserve_hosted_confirmations_delete;
DROP TRIGGER erasure_preserve_hosted_mutation_commits_delete;
DROP TRIGGER erasure_preserve_hosted_turns_delete;
DROP TRIGGER erasure_preserve_hosted_voice_refusals_delete;
DROP TRIGGER erasure_preserve_hosted_whatsapp_delivery_delete;
DROP TRIGGER erasure_preserve_hosted_whatsapp_delivery_events_delete;
DROP TRIGGER erasure_preserve_whatsapp_service_windows_delete;
DROP TRIGGER erasure_preserve_insight_events_delete;
DROP TRIGGER erasure_preserve_proactive_messages_delete;
DROP TRIGGER erasure_preserve_insight_whatsapp_claims_delete;
DROP TRIGGER erasure_preserve_keyword_rules_delete;
DROP TRIGGER erasure_preserve_media_submissions_delete;
DROP TRIGGER erasure_preserve_memories_delete;
DROP TRIGGER erasure_preserve_pending_consent_exchanges_delete;
DROP TRIGGER erasure_preserve_proactive_transcript_entries_delete;
DROP TRIGGER erasure_preserve_proactive_transcript_event_links_delete;
DROP TRIGGER erasure_preserve_proactive_transcript_event_links_delete_clear;
DROP TRIGGER erasure_preserve_proactivity_consent_offers_delete;
DROP TRIGGER erasure_preserve_proactivity_message_events_delete;
DROP TRIGGER erasure_preserve_proactivity_message_events_delete_clear;
DROP TRIGGER erasure_preserve_proactivity_offer_requests_delete;
DROP TRIGGER erasure_preserve_proactivity_whatsapp_claims_delete;
DROP TRIGGER erasure_preserve_recurring_digest_consumption_clear_shared;
DROP TRIGGER erasure_preserve_recurring_digest_consumption_delete_shared;
DROP TRIGGER erasure_preserve_recurring_digest_days_delete;
DROP TRIGGER erasure_preserve_recurring_digest_instructions_delete;
DROP TRIGGER erasure_preserve_recurring_digest_staging_clear_shared;
DROP TRIGGER erasure_preserve_recurring_digest_staging_delete_shared;
DROP TRIGGER erasure_preserve_recurring_dispatch_delete;
DROP TRIGGER erasure_preserve_recurring_facts_delete_typed;
DROP TRIGGER erasure_preserve_recurring_plan_documents_delete;
DROP TRIGGER erasure_preserve_recurring_progress_delete;
DROP TRIGGER erasure_preserve_recurring_proposals_delete_typed;
DROP TRIGGER erasure_preserve_recurring_series_delete;
DROP TRIGGER erasure_preserve_refund_attempts_delete;
DROP TRIGGER erasure_preserve_reminder_governors_delete;
DROP TRIGGER erasure_preserve_resource_admission_events_delete;
DROP TRIGGER erasure_preserve_schedule_executions_delete;
DROP TRIGGER erasure_preserve_schedule_revisions_delete;
DROP TRIGGER erasure_preserve_schedules_delete;
DROP TRIGGER erasure_preserve_source_attestations_delete;
DROP TRIGGER erasure_preserve_statement_materialization_parts_delete;
DROP TRIGGER erasure_preserve_statement_needs_review_delete;
DROP TRIGGER erasure_preserve_statement_record_outcomes_delete;
DROP TRIGGER erasure_preserve_statement_staging_objects_delete;
DROP TRIGGER erasure_preserve_statement_submissions_delete;
DROP TRIGGER erasure_preserve_subscription_cancellations_delete;
DROP TRIGGER erasure_preserve_subscriptions_delete;
DROP TRIGGER erasure_preserve_subscriptions_delete_clear;
DROP TRIGGER erasure_preserve_transaction_corrections_delete;
DROP TRIGGER erasure_preserve_transaction_reconciliation_decisions_delete;
DROP TRIGGER erasure_preserve_transaction_reconciliation_members_delete;
DROP TRIGGER erasure_preserve_transaction_reconciliation_members_update;
DROP TRIGGER erasure_preserve_transactions_delete;
DROP TRIGGER erasure_preserve_transcript_entries_delete;
DROP TRIGGER erasure_preserve_weekly_consent_offers_delete;
DROP TRIGGER erasure_preserve_weekly_governor_questions_delete;
DROP TRIGGER erasure_preserve_weekly_governors_delete;
DROP TRIGGER erasure_preserve_weekly_question_intents_delete;
DROP TRIGGER hosted_whatsapp_inbound_field_preserve_delete;
DROP TRIGGER hosted_whatsapp_inbound_field_preserve_update;
DROP TRIGGER insight_delivery_attempts_field_preserve_delete;
DROP TRIGGER insight_delivery_attempts_field_preserve_update;
DROP TRIGGER whatsapp_recipients_preserve_delete;
DROP TRIGGER recurring_opportunity_preserve_delete;
DROP TRIGGER recurring_opportunity_preserve_update;
DROP TRIGGER reminder_delivery_receipts_marker_preserve_delete;
DROP TRIGGER reminder_delivery_receipts_marker_preserve_update;
DROP TRIGGER statement_whatsapp_documents_field_preserve_delete;
DROP TRIGGER statement_whatsapp_documents_field_preserve_update;
DROP TRIGGER weekly_governor_deliveries_marker_preserve_delete;
DROP TRIGGER weekly_governor_deliveries_marker_preserve_update;
DROP TRIGGER erasure_preserve_subscription_identities_delete;
DROP TRIGGER erasure_preserve_payment_sources_delete;
DROP TRIGGER erasure_preserve_statement_materializations_delete;
DROP TRIGGER erasure_preserve_ingestion_review_item_workspace_update;
DROP TRIGGER erasure_preserve_ingestion_review_item_workspace_delete;
DROP TRIGGER erasure_preserve_ingestion_review_item_source_delete;
DROP TRIGGER statement_backfill_entitlements_field_preserve_delete;
DROP TRIGGER erasure_preserve_recurring_plans_delete;
DROP TRIGGER erasure_preserve_recurring_plan_revisions_delete;
DROP TRIGGER erasure_preserve_recurring_plan_exceptions_delete;
DROP TRIGGER erasure_preserve_recurring_plan_fulfillments_delete;
DROP TRIGGER reminder_control_preserve_delete;
DROP TRIGGER reminder_control_preserve_update;
DROP TABLE erasure_archives;
DROP TABLE erasure_objects;
ALTER TABLE erasure_requests DROP COLUMN restore_cursor;
ALTER TABLE erasure_requests DROP COLUMN restore_objects_done;
ALTER TABLE erasure_requests DROP COLUMN restore_records_cursor;
ALTER TABLE erasure_requests DROP COLUMN restore_records_done;
ALTER TABLE erasure_requests DROP COLUMN archive_generation;
ALTER TABLE erasure_requests DROP COLUMN objects_captured;
ALTER TABLE erasure_requests DROP COLUMN purge_pending;
ALTER TABLE erasure_requests DROP COLUMN purge_records_cursor;
ALTER TABLE erasure_steps DROP COLUMN archive_done;
-- full-delete-archive-retirement:end

-- erasure-step-classification:start
SELECT json(CASE WHEN NOT EXISTS(
  SELECT 1 FROM erasure_requests WHERE state<>'Complete'
) THEN 'true' ELSE '' END) AS accepted;
ALTER TABLE erasure_steps DROP COLUMN data_class;
-- erasure-step-classification:end

-- erasure-minimal-metadata:start
PRAGMA defer_foreign_keys=ON;

SELECT json(CASE WHEN
 NOT EXISTS(SELECT 1 FROM erasure_requests WHERE state<>'Complete' OR last_erased_at_ms IS NULL OR marker_written<>1 OR coordinator_cleared<>1)
 AND NOT EXISTS(SELECT 1 FROM erasure_custody_records WHERE custodian NOT IN('Cloudflare','Kapso','Meta','Resend','Wompi') OR state='Retained' OR (record_type='event' AND (json_valid(evidence_json)<>1 OR json_extract(evidence_json,'$.outcome.status')='Retained')))
 AND NOT EXISTS(SELECT 1 FROM erasure_requests q WHERE EXISTS(SELECT 1 FROM erasure_writers WHERE user_id=q.user_id)
 OR NOT EXISTS(SELECT 1 FROM erasure_steps WHERE request_id=q.id)
 OR EXISTS(SELECT 1 FROM erasure_steps WHERE request_id=q.id AND delete_done<>1)
 OR (SELECT count(*) FROM erasure_custody_records WHERE record_type='current' AND request_id=q.id AND state IN('Verified','NotApplicable'))<>5)
 THEN 'true' ELSE '' END) AS accepted;

CREATE TABLE cutover_erasure_requests (
  id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL UNIQUE,
  requested_at_ms INTEGER NOT NULL,
  restoring INTEGER NOT NULL DEFAULT 0 CHECK(restoring IN(0,1)),
  restore_generation TEXT,
  state TEXT NOT NULL CHECK(state IN ('Draining','Sealing','Erasing','ExternalPending','Complete')),
  last_erased_at_ms INTEGER,
  last_continued_at_ms INTEGER NOT NULL DEFAULT 0,
  next_continuation_at_ms INTEGER NOT NULL DEFAULT 0,
  connection_blocked INTEGER NOT NULL DEFAULT 0 CHECK(connection_blocked IN(0,1)),
  coordinator_cleared INTEGER NOT NULL DEFAULT 0 CHECK(coordinator_cleared IN (0,1)),
  marker_written INTEGER NOT NULL DEFAULT 0 CHECK(marker_written IN (0,1))
) STRICT;

INSERT INTO cutover_erasure_requests(rowid,id,user_id,requested_at_ms,restoring,restore_generation,state,last_erased_at_ms,last_continued_at_ms,next_continuation_at_ms,connection_blocked,coordinator_cleared,marker_written) SELECT rowid,id,user_id,requested_at_ms,restoring,restore_generation,state,last_erased_at_ms,last_continued_at_ms,next_continuation_at_ms,connection_blocked,coordinator_cleared,marker_written FROM erasure_requests;

DROP TABLE erasure_requests;

CREATE TABLE erasure_requests (
  id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL UNIQUE,
  requested_at_ms INTEGER NOT NULL,
  restoring INTEGER NOT NULL DEFAULT 0 CHECK(restoring IN(0,1)),
  restore_generation TEXT,
  state TEXT NOT NULL CHECK(state IN ('Draining','Sealing','Erasing','ExternalPending','Complete')),
  last_erased_at_ms INTEGER,
  last_continued_at_ms INTEGER NOT NULL DEFAULT 0,
  next_continuation_at_ms INTEGER NOT NULL DEFAULT 0,
  connection_blocked INTEGER NOT NULL DEFAULT 0 CHECK(connection_blocked IN(0,1)),
  coordinator_cleared INTEGER NOT NULL DEFAULT 0 CHECK(coordinator_cleared IN (0,1)),
  marker_written INTEGER NOT NULL DEFAULT 0 CHECK(marker_written IN (0,1))
) STRICT;

INSERT INTO erasure_requests(rowid,id,user_id,requested_at_ms,restoring,restore_generation,state,last_erased_at_ms,last_continued_at_ms,next_continuation_at_ms,connection_blocked,coordinator_cleared,marker_written) SELECT rowid,id,user_id,requested_at_ms,restoring,restore_generation,state,last_erased_at_ms,last_continued_at_ms,next_continuation_at_ms,connection_blocked,coordinator_cleared,marker_written FROM cutover_erasure_requests;

DROP TABLE cutover_erasure_requests;

CREATE TABLE cutover_erasure_custody_records (
 record_type TEXT NOT NULL CHECK(record_type IN ('current','event')),
 request_id TEXT NOT NULL REFERENCES erasure_requests(id),
 custodian TEXT NOT NULL,
 id TEXT,
 state TEXT,
 evidence_json TEXT CHECK(evidence_json IS NULL OR length(evidence_json)<=4096),
 recorded_at_ms INTEGER,
 operator_ref TEXT,
 current_event_id TEXT,
 event_identity TEXT GENERATED ALWAYS AS(CASE WHEN record_type='event' THEN id END) VIRTUAL UNIQUE,
 UNIQUE(request_id,custodian,event_identity),
 FOREIGN KEY(request_id,custodian,current_event_id) REFERENCES erasure_custody_records(request_id,custodian,event_identity),
 CHECK((record_type='current' AND id IS NULL AND state IS NOT NULL AND state IN ('Pending','Accepted','Verified','NotApplicable','Unresolved') AND custodian IN ('Cloudflare','Kapso','Meta','Resend','Wompi') AND evidence_json IS NULL AND recorded_at_ms IS NULL AND operator_ref IS NULL)
 OR(record_type='event' AND id IS NOT NULL AND state IS NULL AND evidence_json IS NOT NULL AND recorded_at_ms IS NOT NULL AND operator_ref IS NOT NULL AND current_event_id IS NULL))
) STRICT;

INSERT INTO cutover_erasure_custody_records(rowid,record_type,request_id,custodian,id,state,evidence_json,recorded_at_ms,operator_ref,current_event_id) SELECT rowid,record_type,request_id,custodian,id,state,evidence_json,recorded_at_ms,operator_ref,current_event_id FROM erasure_custody_records;

DROP TABLE erasure_custody_records;

CREATE TABLE erasure_custody_records (
 record_type TEXT NOT NULL CHECK(record_type IN ('current','event')),
 request_id TEXT NOT NULL REFERENCES erasure_requests(id),
 custodian TEXT NOT NULL,
 id TEXT,
 state TEXT,
 evidence_json TEXT CHECK(evidence_json IS NULL OR length(evidence_json)<=4096),
 recorded_at_ms INTEGER,
 operator_ref TEXT,
 current_event_id TEXT,
 event_identity TEXT GENERATED ALWAYS AS(CASE WHEN record_type='event' THEN id END) VIRTUAL UNIQUE,
 UNIQUE(request_id,custodian,event_identity),
 FOREIGN KEY(request_id,custodian,current_event_id) REFERENCES erasure_custody_records(request_id,custodian,event_identity),
 CHECK((record_type='current' AND id IS NULL AND state IS NOT NULL AND state IN ('Pending','Accepted','Verified','NotApplicable','Unresolved') AND custodian IN ('Cloudflare','Kapso','Meta','Resend','Wompi') AND evidence_json IS NULL AND recorded_at_ms IS NULL AND operator_ref IS NULL)
 OR(record_type='event' AND id IS NOT NULL AND state IS NULL AND evidence_json IS NOT NULL AND recorded_at_ms IS NOT NULL AND operator_ref IS NOT NULL AND current_event_id IS NULL))
) STRICT;

INSERT INTO erasure_custody_records(rowid,record_type,request_id,custodian,id,state,evidence_json,recorded_at_ms,operator_ref,current_event_id) SELECT rowid,record_type,request_id,custodian,id,state,evidence_json,recorded_at_ms,operator_ref,current_event_id FROM cutover_erasure_custody_records;

DROP TABLE cutover_erasure_custody_records;

CREATE UNIQUE INDEX custody_current_identity ON erasure_custody_records(request_id,custodian) WHERE record_type='current';

CREATE TRIGGER custody_record_identity_immutable BEFORE UPDATE ON erasure_custody_records WHEN NEW.record_type IS NOT OLD.record_type OR NEW.request_id IS NOT OLD.request_id OR NEW.custodian IS NOT OLD.custodian OR NEW.id IS NOT OLD.id BEGIN SELECT RAISE(ABORT,'custody_record_identity_immutable'); END;

SELECT json(CASE WHEN NOT EXISTS(SELECT 1 FROM pragma_foreign_key_check) THEN 'true' ELSE '' END) AS accepted;
-- erasure-minimal-metadata:end
