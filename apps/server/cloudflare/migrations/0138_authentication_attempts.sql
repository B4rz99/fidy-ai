PRAGMA defer_foreign_keys=ON;

DROP TRIGGER connection_attempt_transition;

DROP TRIGGER connection_execution_binding;

DROP TRIGGER connection_execution_immutable;

DROP TRIGGER provider_completion_consumes_proof;

DROP TRIGGER whatsapp_provider_completion_requires_confirmation;

DROP TRIGGER whatsapp_provider_completion_consumes_confirmation;

DROP TRIGGER provider_attempt_requires_handoff;

DROP TRIGGER erasure_fence_completed_provider_authentications_insert;

DROP TRIGGER erasure_fence_completed_provider_authentications_update;

DROP TRIGGER erasure_fence_completed_provider_authentications_delete;

DROP TRIGGER erasure_fence_connection_attempts_insert;

DROP TRIGGER erasure_fence_connection_attempts_update;

DROP TRIGGER erasure_fence_connection_attempts_delete;

DROP TRIGGER erasure_fence_provider_authentication_attempts_insert;

DROP TRIGGER erasure_fence_provider_authentication_attempts_update;

DROP TRIGGER erasure_fence_provider_authentication_attempts_delete;

DROP TRIGGER erasure_fence_connection_authorization_executions_insert;

DROP TRIGGER erasure_fence_connection_authorization_executions_update;

DROP TRIGGER erasure_fence_connection_authorization_executions_delete;

DROP TRIGGER erasure_preserve_connection_attempts_delete;

DROP TRIGGER erasure_preserve_connection_authorization_executions_delete;

DROP TRIGGER provider_completion_requires_proof;

ALTER TABLE connection_attempts ADD COLUMN prepared_session_id TEXT REFERENCES web_sessions(id);

ALTER TABLE connection_attempts ADD COLUMN prepared_at_ms INTEGER CHECK((prepared_session_id IS NULL)=(prepared_at_ms IS NULL) AND (prepared_session_id IS NULL OR (status='consumed' AND consumed_at_ms=prepared_at_ms)));

ALTER TABLE provider_authentication_attempts ADD COLUMN completed_at_ms INTEGER;

ALTER TABLE provider_authentication_attempts ADD COLUMN created_user INTEGER CHECK((completed_at_ms IS NULL)=(created_user IS NULL) AND (created_user IS NULL OR created_user IN (0,1)));

UPDATE connection_attempts SET prepared_session_id=(SELECT session_id FROM connection_authorization_executions WHERE attempt_id=connection_attempts.id),prepared_at_ms=(SELECT prepared_at_ms FROM connection_authorization_executions WHERE attempt_id=connection_attempts.id);

UPDATE provider_authentication_attempts SET completed_at_ms=(SELECT completed_at_ms FROM completed_provider_authentications WHERE attempt_id=provider_authentication_attempts.id),created_user=(SELECT created_user FROM completed_provider_authentications WHERE attempt_id=provider_authentication_attempts.id);

DROP TABLE connection_authorization_executions;

DROP TABLE completed_provider_authentications;

CREATE TRIGGER connection_attempt_transition BEFORE UPDATE ON connection_attempts
WHEN OLD.status != 'pending' OR NEW.status = 'pending'
  OR NEW.id != OLD.id OR NEW.user_id != OLD.user_id OR NEW.connection_id != OLD.connection_id
  OR NEW.institution_id != OLD.institution_id OR NEW.public_reference != OLD.public_reference
  OR NEW.created_at_ms != OLD.created_at_ms OR NEW.expires_at_ms != OLD.expires_at_ms
BEGIN SELECT RAISE(ABORT, 'connection_attempt_transition'); END;

CREATE TRIGGER provider_attempt_requires_handoff BEFORE INSERT ON provider_authentication_attempts
WHEN NEW.handoff_id IS NOT NULL AND NOT EXISTS(
 SELECT 1 FROM whatsapp_provider_handoffs h JOIN pending_consent_exchanges e ON e.id=h.exchange_id
 WHERE h.id=NEW.handoff_id AND h.pairing_id=NEW.pairing_id AND h.expires_at_ms>NEW.created_at_ms
 AND h.consumed_at_ms IS NULL AND h.decision IS NULL AND e.state='accepted' AND e.expires_at_ms>NEW.created_at_ms
)
BEGIN SELECT RAISE(ABORT,'provider_handoff_invalid'); END;

CREATE TRIGGER erasure_fence_connection_attempts_insert BEFORE INSERT ON connection_attempts
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND (NEW.user_id=q.user_id) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='connection_attempts'))
BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;

CREATE TRIGGER erasure_fence_connection_attempts_update BEFORE UPDATE ON connection_attempts
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND ((NEW.user_id=q.user_id) OR (OLD.user_id=q.user_id)) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='connection_attempts'))
BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;

CREATE TRIGGER erasure_fence_connection_attempts_delete BEFORE DELETE ON connection_attempts
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND (OLD.user_id=q.user_id) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='connection_attempts'))
BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;

CREATE TRIGGER erasure_fence_provider_authentication_attempts_insert BEFORE INSERT ON provider_authentication_attempts
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND (NEW.user_id=q.user_id) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='provider_authentication_attempts'))
BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;

CREATE TRIGGER erasure_fence_provider_authentication_attempts_update BEFORE UPDATE ON provider_authentication_attempts
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND ((NEW.user_id=q.user_id) OR (OLD.user_id=q.user_id)) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='provider_authentication_attempts'))
BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;

CREATE TRIGGER erasure_fence_provider_authentication_attempts_delete BEFORE DELETE ON provider_authentication_attempts
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND (OLD.user_id=q.user_id) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='provider_authentication_attempts'))
BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;

CREATE TRIGGER erasure_preserve_connection_attempts_delete BEFORE DELETE ON connection_attempts
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id)
  AND json_extract(q.decision_json,'$.dispositions.projections.action')='Retain'
  AND json_extract(q.decision_json,'$.dispositions.projections.retention.untilMs')>unixepoch('subsec')*1000)
BEGIN
  INSERT INTO erasure_archives(request_id,store_id,row_ref,body)
  SELECT q.id,'connection_attempts','drain:'||lower(hex(randomblob(16))),json_object('id',OLD."id",'user_id',OLD."user_id",'connection_id',OLD."connection_id",'institution_id',OLD."institution_id",'public_reference',OLD."public_reference",'status',OLD."status",'created_at_ms',OLD."created_at_ms",'expires_at_ms',OLD."expires_at_ms",'consumed_at_ms',OLD."consumed_at_ms",'prepared_session_id',OLD.prepared_session_id,'prepared_at_ms',OLD.prepared_at_ms)
  FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id)
    AND json_extract(q.decision_json,'$.dispositions.projections.action')='Retain'
    AND json_extract(q.decision_json,'$.dispositions.projections.retention.untilMs')>unixepoch('subsec')*1000;
END;

CREATE TRIGGER connection_preparation_binding BEFORE UPDATE ON connection_attempts
WHEN NEW.prepared_session_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM web_sessions s WHERE s.id=NEW.prepared_session_id AND s.user_id=NEW.user_id AND NEW.status='consumed' AND NEW.prepared_at_ms=NEW.consumed_at_ms)
BEGIN SELECT RAISE(ABORT,'connection_execution_binding'); END;

CREATE TRIGGER whatsapp_provider_completion_requires_confirmation BEFORE UPDATE OF completed_at_ms ON provider_authentication_attempts
WHEN OLD.completed_at_ms IS NULL AND NEW.completed_at_ms IS NOT NULL AND EXISTS(SELECT 1 FROM provider_authentication_attempts WHERE id=NEW.id AND handoff_id IS NOT NULL)
AND NOT EXISTS(
 SELECT 1 FROM provider_authentication_attempts a
 JOIN whatsapp_provider_handoffs h ON h.id=a.handoff_id AND h.pairing_id=a.pairing_id
 JOIN pending_consent_exchanges e ON e.id=h.exchange_id
 JOIN whatsapp_identities w ON w.user_id=NEW.user_id AND w.portfolio_id=e.portfolio_id AND w.bsuid=e.bsuid
 WHERE a.id=NEW.id AND h.decision='confirmed' AND h.review_message_id IS NOT NULL
 AND h.decision_message_id IS NOT NULL AND h.confirmed_at_ms IS NOT NULL AND h.consumed_at_ms IS NULL
 AND h.expires_at_ms>NEW.completed_at_ms AND e.expires_at_ms>NEW.completed_at_ms AND e.state='accepted'
)
BEGIN SELECT RAISE(ABORT,'whatsapp_provider_confirmation_invalid'); END;

CREATE TRIGGER whatsapp_provider_completion_consumes_confirmation AFTER UPDATE OF completed_at_ms ON provider_authentication_attempts
WHEN OLD.completed_at_ms IS NULL AND NEW.completed_at_ms IS NOT NULL
BEGIN
 UPDATE whatsapp_provider_handoffs SET consumed_at_ms=NEW.completed_at_ms WHERE id=(SELECT handoff_id FROM provider_authentication_attempts WHERE id=NEW.id);
END;

CREATE TRIGGER provider_completion_requires_proof BEFORE UPDATE OF completed_at_ms ON provider_authentication_attempts
WHEN OLD.completed_at_ms IS NULL AND NEW.completed_at_ms IS NOT NULL AND NOT EXISTS (
 SELECT 1 FROM provider_authentication_attempts a
 JOIN provider_credentials c ON c.issuer=a.issuer AND c.subject=a.subject AND c.user_id=NEW.user_id
 JOIN browser_login_pairings p ON p.id=a.pairing_id AND p.state='ready' AND p.user_id=NEW.user_id
 WHERE a.id=NEW.id AND a.state='verified'
 AND a.expires_at_ms>NEW.completed_at_ms AND p.expires_at_ms>NEW.completed_at_ms AND p.wrong_attempts<5
 AND (NEW.created_user=0 OR (
 a.intent='signup' AND EXISTS(SELECT 1 FROM (SELECT * FROM consent_history WHERE record_type='processing_grant') g WHERE g.user_id=NEW.user_id
 AND ((a.handoff_id IS NULL AND g.id=a.id AND g.disclosure_json=a.disclosure_json)
 OR (a.handoff_id IS NOT NULL AND g.id=(SELECT exchange_id FROM whatsapp_provider_handoffs WHERE id=a.handoff_id))))
 AND EXISTS(SELECT 1 FROM users t WHERE t.id=NEW.user_id AND t.trial_started_at_ms=NEW.completed_at_ms)
 AND EXISTS(SELECT 1 FROM backup_recovery_credentials r WHERE r.user_id=NEW.user_id AND r.created_at_ms=NEW.completed_at_ms)
 ))
)
BEGIN SELECT RAISE(ABORT,'provider_completion_invalid'); END;

CREATE TRIGGER provider_completion_immutable BEFORE UPDATE ON provider_authentication_attempts
WHEN (OLD.completed_at_ms IS NOT NULL AND (NEW.completed_at_ms IS NOT OLD.completed_at_ms OR NEW.created_user IS NOT OLD.created_user OR NEW.user_id IS NOT OLD.user_id OR NEW.state<>'completed'))
 OR (NEW.completed_at_ms IS NOT OLD.completed_at_ms AND NOT(OLD.completed_at_ms IS NULL AND OLD.state='verified' AND NEW.state='completed' AND NEW.user_id IS NOT NULL AND NEW.cookie_digest=zeroblob(32) AND NEW.nonce='' AND NEW.contact_email IS NULL))
BEGIN SELECT RAISE(ABORT,'provider_completion_invalid'); END;

CREATE TRIGGER connection_preparation_immutable BEFORE UPDATE ON connection_attempts
WHEN OLD.prepared_session_id IS NOT NULL AND (NEW.id IS NOT OLD.id OR NEW.user_id IS NOT OLD.user_id OR NEW.prepared_session_id IS NOT OLD.prepared_session_id OR NEW.prepared_at_ms IS NOT OLD.prepared_at_ms)
BEGIN SELECT RAISE(ABORT,'connection_execution_immutable'); END;

CREATE TRIGGER connection_preparation_initial BEFORE INSERT ON connection_attempts
WHEN NEW.prepared_session_id IS NOT NULL OR NEW.prepared_at_ms IS NOT NULL
BEGIN SELECT RAISE(ABORT,'connection_execution_binding'); END;

CREATE TRIGGER provider_completion_initial BEFORE INSERT ON provider_authentication_attempts
WHEN NEW.completed_at_ms IS NOT NULL OR NEW.created_user IS NOT NULL
BEGIN SELECT RAISE(ABORT,'provider_completion_invalid'); END;

INSERT INTO sql_assertions(scope,accepted) SELECT 'migration_authentication_attempts',NOT EXISTS(SELECT 1 FROM pragma_foreign_key_check);

DELETE FROM sql_assertions WHERE scope='migration_authentication_attempts';

PRAGMA defer_foreign_keys=OFF;
