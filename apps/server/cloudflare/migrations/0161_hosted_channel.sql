PRAGMA defer_foreign_keys=ON;

DROP TRIGGER statement_document_immutable;

DROP TRIGGER erasure_fence_statement_whatsapp_documents_insert;

DROP TRIGGER erasure_fence_statement_whatsapp_documents_update;

DROP TRIGGER erasure_fence_statement_whatsapp_documents_delete;

DROP TRIGGER erasure_preserve_statement_whatsapp_documents_delete;

DROP TRIGGER hosted_whatsapp_inbound_no_update;

DROP TRIGGER hosted_retention_channel_append;

DROP TRIGGER erasure_fence_hosted_whatsapp_inbound_insert;

DROP TRIGGER erasure_fence_hosted_whatsapp_inbound_update;

DROP TRIGGER erasure_fence_hosted_whatsapp_inbound_delete;

DROP TRIGGER erasure_preserve_hosted_whatsapp_inbound_delete;

DROP TRIGGER hosted_retention_transcript_remove;

DROP TRIGGER hosted_retention_mutation_remove;

DROP TRIGGER hosted_retention_channel_remove;

DROP TRIGGER statement_document_published;

DROP TRIGGER hosted_turns_terminal_evidence;

DROP TRIGGER hosted_whatsapp_inbound_companions_initial;

DROP TRIGGER erasure_fence_hosted_turns_update;

ALTER TABLE hosted_turns ADD COLUMN inbound_portfolio_id TEXT;

ALTER TABLE hosted_turns ADD COLUMN inbound_bsuid TEXT;

ALTER TABLE hosted_turns ADD COLUMN inbound_message_id TEXT;

ALTER TABLE hosted_turns ADD COLUMN inbound_business_phone_number_id TEXT;

ALTER TABLE hosted_turns ADD COLUMN inbound_occurred_at_ms INTEGER;

ALTER TABLE hosted_turns ADD COLUMN inbound_received_at_ms INTEGER;

ALTER TABLE hosted_turns ADD COLUMN inbound_reply_to_message_id TEXT;

ALTER TABLE hosted_turns ADD COLUMN inbound_sandbox_phone TEXT;

ALTER TABLE hosted_turns ADD COLUMN dispatch_user_id TEXT;

ALTER TABLE hosted_turns ADD COLUMN dispatch_offered_at_ms INTEGER;

ALTER TABLE hosted_turns ADD COLUMN dispatch_created_at_ms INTEGER CHECK((inbound_portfolio_id IS NULL AND inbound_bsuid IS NULL AND inbound_message_id IS NULL AND inbound_business_phone_number_id IS NULL AND inbound_occurred_at_ms IS NULL AND inbound_received_at_ms IS NULL AND inbound_reply_to_message_id IS NULL AND inbound_sandbox_phone IS NULL AND dispatch_user_id IS NULL AND dispatch_offered_at_ms IS NULL AND dispatch_created_at_ms IS NULL) OR (inbound_portfolio_id IS NOT NULL AND inbound_bsuid IS NOT NULL AND inbound_message_id IS NOT NULL AND inbound_business_phone_number_id IS NOT NULL AND inbound_occurred_at_ms IS NOT NULL AND inbound_received_at_ms IS NOT NULL)) CHECK(inbound_received_at_ms IS NULL OR inbound_received_at_ms>=inbound_occurred_at_ms-300000) CHECK((dispatch_created_at_ms IS NULL AND dispatch_user_id IS NULL AND dispatch_offered_at_ms IS NULL) OR (dispatch_created_at_ms IS NOT NULL AND dispatch_user_id=user_id));

ALTER TABLE hosted_turns ADD COLUMN document_media_id TEXT CHECK(document_media_id IS NULL OR length(document_media_id) BETWEEN 1 AND 256);

ALTER TABLE hosted_turns ADD COLUMN document_staging_id TEXT REFERENCES statement_staging_objects(id);

ALTER TABLE hosted_turns ADD COLUMN document_upload_grant_id TEXT CHECK(document_upload_grant_id IS NULL OR length(document_upload_grant_id) BETWEEN 1 AND 128);

ALTER TABLE hosted_turns ADD COLUMN document_upload_expires_at_ms INTEGER CHECK(document_upload_expires_at_ms IS NULL OR document_upload_expires_at_ms>=0);

ALTER TABLE hosted_turns ADD COLUMN document_reference_json TEXT CHECK(document_reference_json IS NULL OR (json_valid(document_reference_json) AND length(document_reference_json)<=4096));

ALTER TABLE hosted_turns ADD COLUMN document_created_at_ms INTEGER CHECK(document_created_at_ms IS NULL OR document_created_at_ms>=0) CHECK((document_media_id IS NULL AND document_staging_id IS NULL AND document_upload_grant_id IS NULL AND document_upload_expires_at_ms IS NULL AND document_reference_json IS NULL AND document_created_at_ms IS NULL) OR (document_media_id IS NOT NULL AND document_created_at_ms IS NOT NULL)) CHECK((document_upload_grant_id IS NULL)=(document_upload_expires_at_ms IS NULL)) CHECK((document_staging_id IS NULL)=(document_reference_json IS NULL));

ALTER TABLE hosted_turns ADD COLUMN inbound_turn_id TEXT GENERATED ALWAYS AS(CASE WHEN inbound_message_id IS NOT NULL THEN id END) VIRTUAL;

CREATE UNIQUE INDEX hosted_turns_inbound_turn ON hosted_turns(user_id,inbound_turn_id);

UPDATE hosted_turns SET (inbound_portfolio_id,inbound_bsuid,inbound_message_id,inbound_business_phone_number_id,inbound_occurred_at_ms,inbound_received_at_ms,inbound_reply_to_message_id,inbound_sandbox_phone,dispatch_user_id,dispatch_offered_at_ms,dispatch_created_at_ms)=(SELECT portfolio_id,bsuid,message_id,business_phone_number_id,occurred_at_ms,received_at_ms,reply_to_message_id,sandbox_phone,dispatch_user_id,dispatch_offered_at_ms,dispatch_created_at_ms FROM hosted_whatsapp_inbound WHERE turn_id=hosted_turns.id AND user_id=hosted_turns.user_id) WHERE EXISTS(SELECT 1 FROM hosted_whatsapp_inbound WHERE turn_id=hosted_turns.id AND user_id=hosted_turns.user_id);

INSERT INTO sql_assertions(scope,accepted) SELECT 'migration_hosted_whatsapp_inbound',(SELECT count(*) FROM hosted_whatsapp_inbound)=(SELECT count(*) FROM hosted_turns WHERE inbound_message_id IS NOT NULL) ON CONFLICT(scope) DO UPDATE SET accepted=excluded.accepted;

DROP TRIGGER hosted_whatsapp_delivery_identity_immutable;

DROP TRIGGER hosted_whatsapp_delivery_event_immutable;

DROP TRIGGER insight_whatsapp_claim_identity;

DROP TRIGGER proactivity_channel_frozen;

DROP TRIGGER erasure_fence_hosted_whatsapp_delivery_insert;

DROP TRIGGER erasure_fence_hosted_whatsapp_delivery_update;

DROP TRIGGER erasure_fence_hosted_whatsapp_delivery_delete;

DROP TRIGGER erasure_fence_insight_whatsapp_claims_insert;

DROP TRIGGER erasure_fence_insight_whatsapp_claims_update;

DROP TRIGGER erasure_fence_insight_whatsapp_claims_delete;

DROP TRIGGER erasure_fence_proactivity_whatsapp_claims_insert;

DROP TRIGGER erasure_fence_proactivity_whatsapp_claims_update;

DROP TRIGGER erasure_fence_proactivity_whatsapp_claims_delete;

DROP TRIGGER erasure_fence_hosted_whatsapp_delivery_events_insert;

DROP TRIGGER erasure_fence_hosted_whatsapp_delivery_events_update;

DROP TRIGGER erasure_fence_hosted_whatsapp_delivery_events_delete;

DROP TRIGGER erasure_preserve_hosted_whatsapp_delivery_delete;

DROP TRIGGER erasure_preserve_hosted_whatsapp_delivery_events_delete;

DROP TRIGGER erasure_preserve_insight_whatsapp_claims_delete;

DROP TRIGGER erasure_preserve_proactivity_whatsapp_claims_delete;

DROP TRIGGER erasure_fence_weekly_governor_questions_insert;

DROP TRIGGER erasure_fence_weekly_governor_questions_update;

DROP TRIGGER erasure_fence_weekly_governor_questions_delete;

DROP TRIGGER erasure_preserve_weekly_governor_questions_delete;

DROP TRIGGER whatsapp_delivery_kind_immutable;



CREATE TABLE hosted_delivery_events_copy AS SELECT rowid AS original_rowid,* FROM hosted_whatsapp_delivery_events;

DROP TABLE hosted_whatsapp_delivery_events;

CREATE TABLE whatsapp_deliveries_next (
 kind TEXT NOT NULL CHECK(kind IN ('insight','proactivity','weekly-question','hosted')),
 user_id TEXT NOT NULL REFERENCES users(id),
 insight_event_id TEXT,
 correlation_token TEXT NOT NULL,
 portfolio_id TEXT,
 bsuid TEXT,
 business_phone_number_id TEXT NOT NULL,
 summary_json TEXT,
 text TEXT,
 scheduled_at_ms INTEGER,
 expires_at_ms INTEGER,
 time_zone TEXT,
 state TEXT NOT NULL DEFAULT 'ready',
 send_started_at_ms INTEGER,
 provider_message_id TEXT,
 delivered_at_ms INTEGER,
 last_received_at_ms INTEGER,
 delivery_id TEXT,
 role TEXT,
 consent_grant_id TEXT,
 template_json TEXT,
 id TEXT,
 offer_id TEXT,
 grant_id TEXT,
 created_at_ms INTEGER,
 offer_json TEXT,
 last_attempt_at_ms INTEGER DEFAULT 0,
 turn_id TEXT,
 proposed_at_ms INTEGER,
 hosted_correlation_token TEXT GENERATED ALWAYS AS(CASE WHEN kind='hosted' THEN correlation_token END) VIRTUAL UNIQUE,
 FOREIGN KEY(user_id,insight_event_id) REFERENCES insight_events(user_id,id),
 FOREIGN KEY(offer_id) REFERENCES consent_offers(weekly_offer_id),
 FOREIGN KEY (user_id, turn_id) REFERENCES hosted_turns(user_id, inbound_turn_id),
 CHECK(kind<>'insight' OR coalesce((user_id IS NOT NULL AND insight_event_id IS NOT NULL AND correlation_token IS NOT NULL AND portfolio_id IS NOT NULL AND bsuid IS NOT NULL AND business_phone_number_id IS NOT NULL AND scheduled_at_ms IS NOT NULL AND expires_at_ms IS NOT NULL AND time_zone IS NOT NULL AND state IS NOT NULL) AND (state IN ('staged','sending','accepted','ambiguous','rejected','delivered','expired')) AND (expires_at_ms > scheduled_at_ms AND expires_at_ms <= scheduled_at_ms + 86400000) AND ((state IN ('staged','expired')) OR send_started_at_ms IS NOT NULL) AND (state <> 'delivered' OR (provider_message_id IS NOT NULL AND delivered_at_ms IS NOT NULL)),0)),
 CHECK(kind<>'proactivity' OR coalesce((user_id IS NOT NULL AND delivery_id IS NOT NULL AND role IS NOT NULL AND correlation_token IS NOT NULL AND portfolio_id IS NOT NULL AND bsuid IS NOT NULL AND business_phone_number_id IS NOT NULL AND scheduled_at_ms IS NOT NULL AND expires_at_ms IS NOT NULL AND time_zone IS NOT NULL AND state IS NOT NULL) AND (role IN ('budget-threshold','manual-entry-reminder','new-recurring-series','budget-offer','reminder-offer','recurring-offer','reminder-question')) AND (state IN ('staged','sending','accepted','ambiguous','rejected','delivered','expired')) AND ((role IN ('budget-offer','reminder-offer','recurring-offer') AND consent_grant_id IS NULL) OR (role IN ('budget-threshold','manual-entry-reminder','new-recurring-series','reminder-question') AND consent_grant_id IS NOT NULL)) AND (state NOT IN ('sending','accepted','ambiguous','rejected','delivered') OR send_started_at_ms IS NOT NULL) AND (state<>'delivered' OR (provider_message_id IS NOT NULL AND delivered_at_ms IS NOT NULL)),0)),
 CHECK(kind<>'weekly-question' OR coalesce((id IS NOT NULL AND user_id IS NOT NULL AND offer_id IS NOT NULL AND created_at_ms IS NOT NULL AND expires_at_ms IS NOT NULL AND state IS NOT NULL AND correlation_token IS NOT NULL AND portfolio_id IS NOT NULL AND bsuid IS NOT NULL AND business_phone_number_id IS NOT NULL AND time_zone IS NOT NULL AND last_attempt_at_ms IS NOT NULL) AND (state IN ('ready','sending','accepted','ambiguous','rejected','delivered','expired')) AND (offer_json IS NULL OR json_valid(offer_json)) AND (expires_at_ms > created_at_ms),0)),
 CHECK(kind<>'hosted' OR coalesce((turn_id IS NOT NULL AND user_id IS NOT NULL AND text IS NOT NULL AND correlation_token IS NOT NULL AND business_phone_number_id IS NOT NULL AND proposed_at_ms IS NOT NULL AND state IS NOT NULL) AND (length(text) > 0) AND (state IN ('sending','accepted','ambiguous','rejected','delivered','unconfirmed')) AND ((state = 'delivered' AND provider_message_id IS NOT NULL AND delivered_at_ms IS NOT NULL)
    OR (state <> 'delivered' AND delivered_at_ms IS NULL)),0))
) STRICT;

INSERT INTO whatsapp_deliveries_next(rowid,kind,user_id,insight_event_id,correlation_token,portfolio_id,bsuid,business_phone_number_id,summary_json,text,scheduled_at_ms,expires_at_ms,time_zone,state,send_started_at_ms,provider_message_id,delivered_at_ms,last_received_at_ms,delivery_id,role,consent_grant_id,template_json,id,offer_id,grant_id,created_at_ms,offer_json,last_attempt_at_ms,turn_id,proposed_at_ms) SELECT rowid,kind,user_id,insight_event_id,correlation_token,portfolio_id,bsuid,business_phone_number_id,summary_json,text,scheduled_at_ms,expires_at_ms,time_zone,state,send_started_at_ms,provider_message_id,delivered_at_ms,last_received_at_ms,delivery_id,role,consent_grant_id,template_json,id,offer_id,grant_id,created_at_ms,offer_json,last_attempt_at_ms,turn_id,proposed_at_ms FROM whatsapp_deliveries;

DROP TABLE whatsapp_deliveries;

ALTER TABLE whatsapp_deliveries_next RENAME TO whatsapp_deliveries;

CREATE UNIQUE INDEX insight_whatsapp_claims_identity ON whatsapp_deliveries(user_id,insight_event_id) WHERE kind='insight';

CREATE UNIQUE INDEX insight_provider_message_identity ON whatsapp_deliveries(provider_message_id) WHERE kind='insight';

CREATE UNIQUE INDEX insight_correlation_identity ON whatsapp_deliveries(correlation_token) WHERE kind='insight';

CREATE INDEX insight_whatsapp_verified ON whatsapp_deliveries(state,user_id,insight_event_id) WHERE kind='insight';

CREATE INDEX insight_sent_content_retention
  ON whatsapp_deliveries(send_started_at_ms)
  WHERE kind='insight' AND (text IS NOT NULL OR summary_json IS NOT NULL);

CREATE INDEX insight_staged_content_retention
  ON whatsapp_deliveries(state,expires_at_ms)
  WHERE kind='insight' AND (state='staged' AND (text IS NOT NULL OR summary_json IS NOT NULL));

CREATE INDEX insight_user_sent_content_retention
  ON whatsapp_deliveries(user_id,send_started_at_ms)
  WHERE kind='insight' AND (text IS NOT NULL OR summary_json IS NOT NULL);

CREATE INDEX insight_user_staged_content_retention
  ON whatsapp_deliveries(user_id,state,expires_at_ms)
  WHERE kind='insight' AND (state='staged' AND (text IS NOT NULL OR summary_json IS NOT NULL));

CREATE UNIQUE INDEX proactivity_whatsapp_claims_identity ON whatsapp_deliveries(user_id,delivery_id) WHERE kind='proactivity';

CREATE UNIQUE INDEX proactivity_provider_message_identity ON whatsapp_deliveries(user_id,provider_message_id) WHERE kind='proactivity';

CREATE UNIQUE INDEX proactivity_correlation_identity ON whatsapp_deliveries(correlation_token) WHERE kind='proactivity';

CREATE INDEX proactivity_channel_started ON whatsapp_deliveries(user_id,send_started_at_ms) WHERE kind='proactivity';

CREATE INDEX proactivity_sent_content_retention
  ON whatsapp_deliveries(send_started_at_ms)
  WHERE kind='proactivity' AND (text IS NOT NULL OR template_json IS NOT NULL);

CREATE INDEX proactivity_staged_content_retention
  ON whatsapp_deliveries(state,expires_at_ms)
  WHERE kind='proactivity' AND (state='staged' AND (text IS NOT NULL OR template_json IS NOT NULL));

CREATE UNIQUE INDEX weekly_governor_questions_identity ON whatsapp_deliveries(id) WHERE kind='weekly-question';

CREATE UNIQUE INDEX weekly_question_correlation_identity ON whatsapp_deliveries(correlation_token) WHERE kind='weekly-question';

CREATE UNIQUE INDEX weekly_question_provider_identity ON whatsapp_deliveries(user_id,provider_message_id) WHERE kind='weekly-question' AND (provider_message_id IS NOT NULL);

CREATE INDEX weekly_governor_questions_due ON whatsapp_deliveries(state,last_attempt_at_ms,created_at_ms) WHERE kind='weekly-question';

CREATE UNIQUE INDEX weekly_governor_questions_offer ON whatsapp_deliveries(user_id,offer_id) WHERE kind='weekly-question';

CREATE INDEX weekly_question_content_retention
  ON whatsapp_deliveries(created_at_ms,id)
  WHERE kind='weekly-question' AND (text IS NOT NULL OR offer_json IS NOT NULL);

CREATE INDEX weekly_question_ready_retention
  ON whatsapp_deliveries(state,expires_at_ms,id)
  WHERE kind='weekly-question' AND (state='ready' AND (text IS NOT NULL OR offer_json IS NOT NULL));

CREATE UNIQUE INDEX hosted_whatsapp_delivery_identity ON whatsapp_deliveries(turn_id) WHERE kind='hosted';

CREATE UNIQUE INDEX hosted_delivery_correlation_identity ON whatsapp_deliveries(correlation_token) WHERE kind='hosted';

CREATE INDEX hosted_whatsapp_delivery_retention_user ON whatsapp_deliveries(user_id, turn_id) WHERE kind='hosted';

CREATE TABLE "hosted_whatsapp_delivery_events" (
  correlation_token TEXT NOT NULL REFERENCES whatsapp_deliveries(hosted_correlation_token),
  provider_message_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('sent','delivered','failed')),
  occurred_at_ms INTEGER NOT NULL,
  received_at_ms INTEGER NOT NULL,
  PRIMARY KEY (correlation_token, provider_message_id, status, occurred_at_ms)
) STRICT;

INSERT INTO hosted_whatsapp_delivery_events(rowid,correlation_token,provider_message_id,status,occurred_at_ms,received_at_ms) SELECT original_rowid,correlation_token,provider_message_id,status,occurred_at_ms,received_at_ms FROM hosted_delivery_events_copy;

DROP TABLE hosted_delivery_events_copy;

CREATE TRIGGER hosted_whatsapp_delivery_identity_immutable BEFORE UPDATE ON whatsapp_deliveries
WHEN NEW.kind='hosted' AND (NEW.turn_id <> OLD.turn_id OR NEW.user_id <> OLD.user_id OR NEW.text <> OLD.text
  OR NEW.correlation_token <> OLD.correlation_token
  OR NEW.business_phone_number_id <> OLD.business_phone_number_id
  OR NEW.proposed_at_ms <> OLD.proposed_at_ms
  OR (OLD.provider_message_id IS NOT NULL AND NEW.provider_message_id IS NOT OLD.provider_message_id)
  OR OLD.state IN ('rejected','delivered','unconfirmed')
)
BEGIN SELECT RAISE(ABORT, 'hosted_whatsapp_delivery_immutable'); END;

CREATE TRIGGER hosted_whatsapp_delivery_event_immutable BEFORE UPDATE ON hosted_whatsapp_delivery_events
BEGIN SELECT RAISE(ABORT, 'hosted_whatsapp_event_immutable'); END;

CREATE TRIGGER insight_whatsapp_claim_identity BEFORE UPDATE ON whatsapp_deliveries
WHEN NEW.kind='insight' AND (NEW.user_id <> OLD.user_id OR NEW.insight_event_id <> OLD.insight_event_id
 OR NEW.correlation_token <> OLD.correlation_token OR NEW.portfolio_id <> OLD.portfolio_id
 OR NEW.bsuid <> OLD.bsuid OR NEW.business_phone_number_id <> OLD.business_phone_number_id
 OR NEW.scheduled_at_ms <> OLD.scheduled_at_ms OR NEW.expires_at_ms <> OLD.expires_at_ms
 OR NEW.time_zone <> OLD.time_zone
 OR (OLD.send_started_at_ms IS NOT NULL AND NEW.send_started_at_ms IS NOT OLD.send_started_at_ms)
 OR (OLD.provider_message_id IS NOT NULL AND NEW.provider_message_id IS NOT OLD.provider_message_id)
 OR (OLD.delivered_at_ms IS NOT NULL AND NEW.delivered_at_ms IS NOT OLD.delivered_at_ms)
 OR (OLD.state <> 'staged' AND NEW.state IN ('staged','expired'))
 OR (OLD.state = 'delivered' AND NEW.state <> 'delivered')
 OR (NEW.text IS NOT NULL AND NEW.text IS NOT OLD.text)
 OR (NEW.summary_json IS NOT NULL AND NEW.summary_json IS NOT OLD.summary_json)
)
BEGIN SELECT RAISE(ABORT,'insight_claim_invalid'); END;

CREATE TRIGGER proactivity_channel_frozen BEFORE UPDATE ON whatsapp_deliveries
WHEN NEW.kind='proactivity' AND (NEW.user_id IS NOT OLD.user_id OR NEW.delivery_id IS NOT OLD.delivery_id
 OR NEW.role IS NOT OLD.role OR NEW.consent_grant_id IS NOT OLD.consent_grant_id
 OR NEW.correlation_token IS NOT OLD.correlation_token OR NEW.portfolio_id IS NOT OLD.portfolio_id
 OR NEW.bsuid IS NOT OLD.bsuid OR NEW.business_phone_number_id IS NOT OLD.business_phone_number_id
 OR NEW.scheduled_at_ms IS NOT OLD.scheduled_at_ms OR NEW.expires_at_ms IS NOT OLD.expires_at_ms
 OR NEW.time_zone IS NOT OLD.time_zone
 OR (NEW.text IS NOT NULL AND NEW.text IS NOT OLD.text)
 OR (NEW.template_json IS NOT NULL AND NEW.template_json IS NOT OLD.template_json)
 OR (OLD.send_started_at_ms IS NOT NULL AND NEW.send_started_at_ms IS NOT OLD.send_started_at_ms)
 OR (OLD.provider_message_id IS NOT NULL AND NEW.provider_message_id IS NOT OLD.provider_message_id)
 OR (OLD.delivered_at_ms IS NOT NULL AND NEW.delivered_at_ms IS NOT OLD.delivered_at_ms)
)
BEGIN SELECT RAISE(ABORT,'proactivity_claim_frozen'); END;

CREATE TRIGGER erasure_fence_hosted_whatsapp_delivery_insert BEFORE INSERT ON whatsapp_deliveries
WHEN NEW.kind='hosted' AND (EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND (NEW.user_id=q.user_id) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='hosted_whatsapp_delivery'))
)
BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;

CREATE TRIGGER erasure_fence_hosted_whatsapp_delivery_update BEFORE UPDATE ON whatsapp_deliveries
WHEN NEW.kind='hosted' AND (EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND ((NEW.user_id=q.user_id) OR (OLD.user_id=q.user_id)) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='hosted_whatsapp_delivery'))
)
BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;

CREATE TRIGGER erasure_fence_hosted_whatsapp_delivery_delete BEFORE DELETE ON whatsapp_deliveries
WHEN OLD.kind='hosted' AND (EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND (OLD.user_id=q.user_id) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='hosted_whatsapp_delivery'))
)
BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;

CREATE TRIGGER erasure_fence_insight_whatsapp_claims_insert BEFORE INSERT ON whatsapp_deliveries
WHEN NEW.kind='insight' AND (EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND (NEW.user_id=q.user_id) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='insight_whatsapp_claims'))
)
BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;

CREATE TRIGGER erasure_fence_insight_whatsapp_claims_update BEFORE UPDATE ON whatsapp_deliveries
WHEN NEW.kind='insight' AND (EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND ((NEW.user_id=q.user_id) OR (OLD.user_id=q.user_id)) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='insight_whatsapp_claims'))
)
BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;

CREATE TRIGGER erasure_fence_insight_whatsapp_claims_delete BEFORE DELETE ON whatsapp_deliveries
WHEN OLD.kind='insight' AND (EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND (OLD.user_id=q.user_id) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='insight_whatsapp_claims'))
)
BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;

CREATE TRIGGER erasure_fence_proactivity_whatsapp_claims_insert BEFORE INSERT ON whatsapp_deliveries
WHEN NEW.kind='proactivity' AND (EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND (NEW.user_id=q.user_id) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='proactivity_whatsapp_claims'))
)
BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;

CREATE TRIGGER erasure_fence_proactivity_whatsapp_claims_update BEFORE UPDATE ON whatsapp_deliveries
WHEN NEW.kind='proactivity' AND (EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND ((NEW.user_id=q.user_id) OR (OLD.user_id=q.user_id)) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='proactivity_whatsapp_claims'))
)
BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;

CREATE TRIGGER erasure_fence_proactivity_whatsapp_claims_delete BEFORE DELETE ON whatsapp_deliveries
WHEN OLD.kind='proactivity' AND (EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND (OLD.user_id=q.user_id) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='proactivity_whatsapp_claims'))
)
BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;

CREATE TRIGGER erasure_fence_hosted_whatsapp_delivery_events_insert BEFORE INSERT ON hosted_whatsapp_delivery_events
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND (EXISTS(SELECT 1 FROM (SELECT rowid,* FROM whatsapp_deliveries WHERE kind='hosted') p WHERE p.correlation_token=NEW.correlation_token AND p.user_id=q.user_id)) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='hosted_whatsapp_delivery_events'))
BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;

CREATE TRIGGER erasure_fence_hosted_whatsapp_delivery_events_update BEFORE UPDATE ON hosted_whatsapp_delivery_events
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND ((EXISTS(SELECT 1 FROM (SELECT rowid,* FROM whatsapp_deliveries WHERE kind='hosted') p WHERE p.correlation_token=NEW.correlation_token AND p.user_id=q.user_id)) OR (EXISTS(SELECT 1 FROM (SELECT rowid,* FROM whatsapp_deliveries WHERE kind='hosted') p WHERE p.correlation_token=OLD.correlation_token AND p.user_id=q.user_id))) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='hosted_whatsapp_delivery_events'))
BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;

CREATE TRIGGER erasure_fence_hosted_whatsapp_delivery_events_delete BEFORE DELETE ON hosted_whatsapp_delivery_events
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND (EXISTS(SELECT 1 FROM (SELECT rowid,* FROM whatsapp_deliveries WHERE kind='hosted') p WHERE p.correlation_token=OLD.correlation_token AND p.user_id=q.user_id)) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='hosted_whatsapp_delivery_events'))
BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;

CREATE TRIGGER erasure_preserve_hosted_whatsapp_delivery_delete BEFORE DELETE ON whatsapp_deliveries
WHEN OLD.kind='hosted' AND (EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id)
  AND json_extract(q.decision_json,'$.dispositions.conversation.action')='Retain'
  AND json_extract(q.decision_json,'$.dispositions.conversation.retention.untilMs')>unixepoch('subsec')*1000)
)
BEGIN
  INSERT INTO erasure_archives(request_id,store_id,row_ref,body)
  SELECT q.id,'hosted_whatsapp_delivery','drain:'||lower(hex(randomblob(16))),json_object('turn_id',OLD."turn_id",'user_id',OLD."user_id",'text',OLD."text",'business_phone_number_id',OLD."business_phone_number_id",'proposed_at_ms',OLD."proposed_at_ms",'state',OLD."state",'provider_message_id',OLD."provider_message_id",'delivered_at_ms',OLD."delivered_at_ms",'send_started_at_ms',OLD."send_started_at_ms")
  FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id)
    AND json_extract(q.decision_json,'$.dispositions.conversation.action')='Retain'
    AND json_extract(q.decision_json,'$.dispositions.conversation.retention.untilMs')>unixepoch('subsec')*1000;
END;

CREATE TRIGGER erasure_preserve_hosted_whatsapp_delivery_events_delete BEFORE DELETE ON hosted_whatsapp_delivery_events
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state='Draining' AND (EXISTS(SELECT 1 FROM (SELECT rowid,* FROM whatsapp_deliveries WHERE kind='hosted') p WHERE p.correlation_token=OLD.correlation_token AND p.user_id=q.user_id))
  AND json_extract(q.decision_json,'$.dispositions.conversation.action')='Retain'
  AND json_extract(q.decision_json,'$.dispositions.conversation.retention.untilMs')>unixepoch('subsec')*1000)
BEGIN
  INSERT INTO erasure_archives(request_id,store_id,row_ref,body)
  SELECT q.id,'hosted_whatsapp_delivery_events','drain:'||lower(hex(randomblob(16))),json_object('provider_message_id',OLD."provider_message_id",'status',OLD."status",'occurred_at_ms',OLD."occurred_at_ms",'received_at_ms',OLD."received_at_ms")
  FROM erasure_requests q WHERE q.state='Draining' AND (EXISTS(SELECT 1 FROM (SELECT rowid,* FROM whatsapp_deliveries WHERE kind='hosted') p WHERE p.correlation_token=OLD.correlation_token AND p.user_id=q.user_id))
    AND json_extract(q.decision_json,'$.dispositions.conversation.action')='Retain'
    AND json_extract(q.decision_json,'$.dispositions.conversation.retention.untilMs')>unixepoch('subsec')*1000;
END;

CREATE TRIGGER erasure_preserve_insight_whatsapp_claims_delete BEFORE DELETE ON whatsapp_deliveries
WHEN OLD.kind='insight' AND (EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id)
  AND json_extract(q.decision_json,'$.dispositions.conversation.action')='Retain'
  AND json_extract(q.decision_json,'$.dispositions.conversation.retention.untilMs')>unixepoch('subsec')*1000)
)
BEGIN
  INSERT INTO erasure_archives(request_id,store_id,row_ref,body)
  SELECT q.id,'insight_whatsapp_claims','drain:'||lower(hex(randomblob(16))),json_object('user_id',OLD."user_id",'insight_event_id',OLD."insight_event_id",'portfolio_id',OLD."portfolio_id",'bsuid',OLD."bsuid",'business_phone_number_id',OLD."business_phone_number_id",'summary_json',OLD."summary_json",'text',OLD."text",'scheduled_at_ms',OLD."scheduled_at_ms",'expires_at_ms',OLD."expires_at_ms",'time_zone',OLD."time_zone",'state',OLD."state",'send_started_at_ms',OLD."send_started_at_ms",'provider_message_id',OLD."provider_message_id",'delivered_at_ms',OLD."delivered_at_ms",'last_received_at_ms',OLD."last_received_at_ms")
  FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id)
    AND json_extract(q.decision_json,'$.dispositions.conversation.action')='Retain'
    AND json_extract(q.decision_json,'$.dispositions.conversation.retention.untilMs')>unixepoch('subsec')*1000;
END;

CREATE TRIGGER erasure_preserve_proactivity_whatsapp_claims_delete BEFORE DELETE ON whatsapp_deliveries
WHEN OLD.kind='proactivity' AND (EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id)
  AND json_extract(q.decision_json,'$.dispositions.conversation.action')='Retain'
  AND json_extract(q.decision_json,'$.dispositions.conversation.retention.untilMs')>unixepoch('subsec')*1000)
)
BEGIN
  INSERT INTO erasure_archives(request_id,store_id,row_ref,body)
  SELECT q.id,'proactivity_whatsapp_claims','drain:'||lower(hex(randomblob(16))),json_object('user_id',OLD."user_id",'delivery_id',OLD."delivery_id",'role',OLD."role",'consent_grant_id',OLD."consent_grant_id",'portfolio_id',OLD."portfolio_id",'bsuid',OLD."bsuid",'business_phone_number_id',OLD."business_phone_number_id",'template_json',OLD."template_json",'text',OLD."text",'scheduled_at_ms',OLD."scheduled_at_ms",'expires_at_ms',OLD."expires_at_ms",'time_zone',OLD."time_zone",'state',OLD."state",'send_started_at_ms',OLD."send_started_at_ms",'provider_message_id',OLD."provider_message_id",'delivered_at_ms',OLD."delivered_at_ms")
  FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id)
    AND json_extract(q.decision_json,'$.dispositions.conversation.action')='Retain'
    AND json_extract(q.decision_json,'$.dispositions.conversation.retention.untilMs')>unixepoch('subsec')*1000;
END;

CREATE TRIGGER erasure_fence_weekly_governor_questions_insert BEFORE INSERT ON whatsapp_deliveries
WHEN NEW.kind='weekly-question' AND (EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND (NEW.user_id=q.user_id) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='weekly_governor_questions'))
)
BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;

CREATE TRIGGER erasure_fence_weekly_governor_questions_update BEFORE UPDATE ON whatsapp_deliveries
WHEN NEW.kind='weekly-question' AND (EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND ((NEW.user_id=q.user_id) OR (OLD.user_id=q.user_id)) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='weekly_governor_questions'))
)
BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;

CREATE TRIGGER erasure_fence_weekly_governor_questions_delete BEFORE DELETE ON whatsapp_deliveries
WHEN OLD.kind='weekly-question' AND (EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND (OLD.user_id=q.user_id) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='weekly_governor_questions'))
)
BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;

CREATE TRIGGER erasure_preserve_weekly_governor_questions_delete BEFORE DELETE ON whatsapp_deliveries
WHEN OLD.kind='weekly-question' AND (EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id)
  AND json_extract(q.decision_json,'$.dispositions.conversation.action')='Retain'
  AND json_extract(q.decision_json,'$.dispositions.conversation.retention.untilMs')>unixepoch('subsec')*1000)
)
BEGIN
  INSERT INTO erasure_archives(request_id,store_id,row_ref,body)
  SELECT q.id,'weekly_governor_questions','drain:'||lower(hex(randomblob(16))),json_object('id',OLD."id",'user_id',OLD."user_id",'offer_id',OLD."offer_id",'grant_id',OLD."grant_id",'created_at_ms',OLD."created_at_ms",'expires_at_ms',OLD."expires_at_ms",'state',OLD."state",'portfolio_id',OLD."portfolio_id",'bsuid',OLD."bsuid",'business_phone_number_id',OLD."business_phone_number_id",'text',OLD."text",'offer_json',OLD."offer_json",'time_zone',OLD."time_zone",'send_started_at_ms',OLD."send_started_at_ms",'provider_message_id',OLD."provider_message_id",'delivered_at_ms',OLD."delivered_at_ms",'last_attempt_at_ms',OLD."last_attempt_at_ms")
  FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id)
    AND json_extract(q.decision_json,'$.dispositions.conversation.action')='Retain'
    AND json_extract(q.decision_json,'$.dispositions.conversation.retention.untilMs')>unixepoch('subsec')*1000;
END;

CREATE TRIGGER whatsapp_delivery_kind_immutable BEFORE UPDATE OF kind ON whatsapp_deliveries WHEN NEW.kind<>OLD.kind BEGIN SELECT RAISE(ABORT,'whatsapp_delivery_kind_immutable'); END;

DROP TABLE hosted_whatsapp_inbound;

CREATE TRIGGER hosted_whatsapp_inbound_field_fence_insert BEFORE INSERT ON hosted_turns WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND NEW.user_id=q.user_id AND NEW.inbound_message_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='hosted_whatsapp_inbound')) BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;

CREATE TRIGGER hosted_whatsapp_inbound_field_fence_update BEFORE UPDATE ON hosted_turns WHEN (NEW.inbound_portfolio_id IS NOT OLD.inbound_portfolio_id OR NEW.inbound_bsuid IS NOT OLD.inbound_bsuid OR NEW.inbound_message_id IS NOT OLD.inbound_message_id OR NEW.inbound_business_phone_number_id IS NOT OLD.inbound_business_phone_number_id OR NEW.inbound_occurred_at_ms IS NOT OLD.inbound_occurred_at_ms OR NEW.inbound_received_at_ms IS NOT OLD.inbound_received_at_ms OR NEW.inbound_reply_to_message_id IS NOT OLD.inbound_reply_to_message_id OR NEW.inbound_sandbox_phone IS NOT OLD.inbound_sandbox_phone OR NEW.dispatch_user_id IS NOT OLD.dispatch_user_id OR NEW.dispatch_offered_at_ms IS NOT OLD.dispatch_offered_at_ms OR NEW.dispatch_created_at_ms IS NOT OLD.dispatch_created_at_ms) AND (EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND OLD.user_id=q.user_id AND OLD.inbound_message_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='hosted_whatsapp_inbound')) OR EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND NEW.user_id=q.user_id AND NEW.inbound_message_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='hosted_whatsapp_inbound'))) BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;

CREATE TRIGGER hosted_whatsapp_inbound_field_fence_delete BEFORE DELETE ON hosted_turns WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND OLD.user_id=q.user_id AND OLD.inbound_message_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='hosted_whatsapp_inbound')) BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;

CREATE TRIGGER hosted_whatsapp_inbound_field_preserve_update BEFORE UPDATE ON hosted_turns WHEN OLD.inbound_message_id IS NOT NULL AND NEW.inbound_message_id IS NULL AND EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state='Draining' AND OLD.user_id=q.user_id AND json_extract(q.decision_json,'$.dispositions.conversation.action')='Retain' AND json_extract(q.decision_json,'$.dispositions.conversation.retention.untilMs')>unixepoch('subsec')*1000) BEGIN INSERT INTO erasure_archives(request_id,store_id,row_ref,body) SELECT q.id,'hosted_whatsapp_inbound','drain:'||lower(hex(randomblob(16))),json_object('turn_id',OLD.id,'user_id',OLD.user_id,'portfolio_id',OLD.inbound_portfolio_id,'bsuid',OLD.inbound_bsuid,'message_id',OLD.inbound_message_id,'business_phone_number_id',OLD.inbound_business_phone_number_id,'occurred_at_ms',OLD.inbound_occurred_at_ms,'received_at_ms',OLD.inbound_received_at_ms,'reply_to_message_id',OLD.inbound_reply_to_message_id,'sandbox_phone',OLD.inbound_sandbox_phone,'dispatch_user_id',OLD.dispatch_user_id,'dispatch_offered_at_ms',OLD.dispatch_offered_at_ms,'dispatch_created_at_ms',OLD.dispatch_created_at_ms) FROM erasure_requests q WHERE q.state='Draining' AND OLD.user_id=q.user_id AND json_extract(q.decision_json,'$.dispositions.conversation.action')='Retain' AND json_extract(q.decision_json,'$.dispositions.conversation.retention.untilMs')>unixepoch('subsec')*1000; END;

CREATE TRIGGER hosted_whatsapp_inbound_field_preserve_delete BEFORE DELETE ON hosted_turns WHEN OLD.inbound_message_id IS NOT NULL AND EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state='Draining' AND OLD.user_id=q.user_id AND json_extract(q.decision_json,'$.dispositions.conversation.action')='Retain' AND json_extract(q.decision_json,'$.dispositions.conversation.retention.untilMs')>unixepoch('subsec')*1000) BEGIN INSERT INTO erasure_archives(request_id,store_id,row_ref,body) SELECT q.id,'hosted_whatsapp_inbound','drain:'||lower(hex(randomblob(16))),json_object('turn_id',OLD.id,'user_id',OLD.user_id,'portfolio_id',OLD.inbound_portfolio_id,'bsuid',OLD.inbound_bsuid,'message_id',OLD.inbound_message_id,'business_phone_number_id',OLD.inbound_business_phone_number_id,'occurred_at_ms',OLD.inbound_occurred_at_ms,'received_at_ms',OLD.inbound_received_at_ms,'reply_to_message_id',OLD.inbound_reply_to_message_id,'sandbox_phone',OLD.inbound_sandbox_phone,'dispatch_user_id',OLD.dispatch_user_id,'dispatch_offered_at_ms',OLD.dispatch_offered_at_ms,'dispatch_created_at_ms',OLD.dispatch_created_at_ms) FROM erasure_requests q WHERE q.state='Draining' AND OLD.user_id=q.user_id AND json_extract(q.decision_json,'$.dispositions.conversation.action')='Retain' AND json_extract(q.decision_json,'$.dispositions.conversation.retention.untilMs')>unixepoch('subsec')*1000; END;

CREATE TRIGGER hosted_whatsapp_inbound_immutable BEFORE UPDATE ON hosted_turns WHEN OLD.inbound_message_id IS NOT NULL AND NEW.inbound_message_id IS NOT NULL AND (NEW.id IS NOT OLD.id OR NEW.user_id IS NOT OLD.user_id OR NEW.inbound_portfolio_id IS NOT OLD.inbound_portfolio_id OR NEW.inbound_bsuid IS NOT OLD.inbound_bsuid OR NEW.inbound_message_id IS NOT OLD.inbound_message_id OR NEW.inbound_business_phone_number_id IS NOT OLD.inbound_business_phone_number_id OR NEW.inbound_occurred_at_ms IS NOT OLD.inbound_occurred_at_ms OR NEW.inbound_received_at_ms IS NOT OLD.inbound_received_at_ms OR NEW.inbound_reply_to_message_id IS NOT OLD.inbound_reply_to_message_id OR NEW.inbound_sandbox_phone IS NOT OLD.inbound_sandbox_phone) BEGIN SELECT RAISE(ABORT,'hosted_whatsapp_inbound_immutable'); END;

CREATE TRIGGER hosted_retention_channel_append AFTER UPDATE ON hosted_turns WHEN OLD.inbound_message_id IS NULL AND NEW.inbound_message_id IS NOT NULL
BEGIN
 UPDATE hosted_turns SET retention_user_id=incoming.user_id,retention_terminal_at_ms=incoming.terminal_at_ms FROM (SELECT id AS turn_id,user_id AS user_id,terminal_at_ms AS terminal_at_ms FROM hosted_turns
  WHERE id = NEW.id AND user_id = NEW.user_id AND status <> 'pending') AS incoming WHERE hosted_turns.id=incoming.turn_id AND hosted_turns.retention_terminal_at_ms IS NULL;
END;

CREATE TRIGGER hosted_retention_channel_remove AFTER UPDATE ON hosted_turns
WHEN OLD.inbound_message_id IS NOT NULL AND NEW.inbound_message_id IS NULL AND (NOT EXISTS (
  SELECT 1 FROM transcript_entries WHERE user_id = OLD.user_id AND turn_id = OLD.id
) AND NOT EXISTS (
  SELECT 1 FROM hosted_mutation_commits WHERE user_id = OLD.user_id AND turn_id = OLD.id
) AND NOT EXISTS (
  SELECT 1 FROM (SELECT rowid,id AS turn_id,user_id,inbound_portfolio_id AS portfolio_id,inbound_bsuid AS bsuid,inbound_message_id AS message_id,inbound_business_phone_number_id AS business_phone_number_id,inbound_occurred_at_ms AS occurred_at_ms,inbound_received_at_ms AS received_at_ms,inbound_reply_to_message_id AS reply_to_message_id,inbound_sandbox_phone AS sandbox_phone,dispatch_user_id,dispatch_offered_at_ms,dispatch_created_at_ms FROM hosted_turns WHERE inbound_message_id IS NOT NULL) WHERE user_id = OLD.user_id AND turn_id = OLD.id
))
AND NOT EXISTS(SELECT 1 FROM erasure_permits p JOIN erasure_requests q ON q.id=p.request_id WHERE q.state='Erasing' AND p.user_id=q.user_id AND p.store_id='hosted_whatsapp_inbound' AND (OLD.user_id=q.user_id))
BEGIN
 UPDATE hosted_turns AS hosted_turn_retention SET retention_user_id=NULL,retention_terminal_at_ms=NULL WHERE retention_terminal_at_ms IS NOT NULL AND id = OLD.id AND retention_user_id = OLD.user_id;
END;

UPDATE hosted_turns SET (document_media_id,document_staging_id,document_upload_grant_id,document_upload_expires_at_ms,document_reference_json,document_created_at_ms)=(SELECT media_id,staging_id,upload_grant_id,upload_expires_at_ms,reference_json,created_at_ms FROM statement_whatsapp_documents WHERE turn_id=hosted_turns.id AND user_id=hosted_turns.user_id) WHERE EXISTS(SELECT 1 FROM statement_whatsapp_documents WHERE turn_id=hosted_turns.id AND user_id=hosted_turns.user_id);

INSERT INTO sql_assertions(scope,accepted) SELECT 'migration_statement_whatsapp_documents',(SELECT count(*) FROM statement_whatsapp_documents)=(SELECT count(*) FROM hosted_turns WHERE document_media_id IS NOT NULL) ON CONFLICT(scope) DO UPDATE SET accepted=excluded.accepted;

DROP TABLE statement_whatsapp_documents;

CREATE TRIGGER statement_whatsapp_documents_field_fence_insert BEFORE INSERT ON hosted_turns WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND NEW.user_id=q.user_id AND NEW.document_media_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='statement_whatsapp_documents')) BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;

CREATE TRIGGER statement_whatsapp_documents_field_fence_update BEFORE UPDATE ON hosted_turns WHEN (NEW.document_media_id IS NOT OLD.document_media_id OR NEW.document_staging_id IS NOT OLD.document_staging_id OR NEW.document_upload_grant_id IS NOT OLD.document_upload_grant_id OR NEW.document_upload_expires_at_ms IS NOT OLD.document_upload_expires_at_ms OR NEW.document_reference_json IS NOT OLD.document_reference_json OR NEW.document_created_at_ms IS NOT OLD.document_created_at_ms) AND (EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND OLD.user_id=q.user_id AND OLD.document_media_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='statement_whatsapp_documents')) OR EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND NEW.user_id=q.user_id AND NEW.document_media_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='statement_whatsapp_documents'))) BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;

CREATE TRIGGER statement_whatsapp_documents_field_fence_delete BEFORE DELETE ON hosted_turns WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND OLD.user_id=q.user_id AND OLD.document_media_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='statement_whatsapp_documents')) BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;

CREATE TRIGGER statement_whatsapp_documents_field_preserve_update BEFORE UPDATE ON hosted_turns WHEN OLD.document_media_id IS NOT NULL AND NEW.document_media_id IS NULL AND EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state='Draining' AND OLD.user_id=q.user_id AND json_extract(q.decision_json,'$.dispositions.ingestion.action')='Retain' AND json_extract(q.decision_json,'$.dispositions.ingestion.retention.untilMs')>unixepoch('subsec')*1000) BEGIN INSERT INTO erasure_archives(request_id,store_id,row_ref,body) SELECT q.id,'statement_whatsapp_documents','drain:'||lower(hex(randomblob(16))),json_object('turn_id',OLD.id,'user_id',OLD.user_id,'media_id',OLD.document_media_id,'staging_id',OLD.document_staging_id,'upload_grant_id',OLD.document_upload_grant_id,'upload_expires_at_ms',OLD.document_upload_expires_at_ms,'reference_json',OLD.document_reference_json,'created_at_ms',OLD.document_created_at_ms) FROM erasure_requests q WHERE q.state='Draining' AND OLD.user_id=q.user_id AND json_extract(q.decision_json,'$.dispositions.ingestion.action')='Retain' AND json_extract(q.decision_json,'$.dispositions.ingestion.retention.untilMs')>unixepoch('subsec')*1000; END;

CREATE TRIGGER statement_whatsapp_documents_field_preserve_delete BEFORE DELETE ON hosted_turns WHEN OLD.document_media_id IS NOT NULL AND EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state='Draining' AND OLD.user_id=q.user_id AND json_extract(q.decision_json,'$.dispositions.ingestion.action')='Retain' AND json_extract(q.decision_json,'$.dispositions.ingestion.retention.untilMs')>unixepoch('subsec')*1000) BEGIN INSERT INTO erasure_archives(request_id,store_id,row_ref,body) SELECT q.id,'statement_whatsapp_documents','drain:'||lower(hex(randomblob(16))),json_object('turn_id',OLD.id,'user_id',OLD.user_id,'media_id',OLD.document_media_id,'staging_id',OLD.document_staging_id,'upload_grant_id',OLD.document_upload_grant_id,'upload_expires_at_ms',OLD.document_upload_expires_at_ms,'reference_json',OLD.document_reference_json,'created_at_ms',OLD.document_created_at_ms) FROM erasure_requests q WHERE q.state='Draining' AND OLD.user_id=q.user_id AND json_extract(q.decision_json,'$.dispositions.ingestion.action')='Retain' AND json_extract(q.decision_json,'$.dispositions.ingestion.retention.untilMs')>unixepoch('subsec')*1000; END;

CREATE TRIGGER statement_document_staging_deleted AFTER DELETE ON statement_staging_objects BEGIN UPDATE hosted_turns SET document_media_id=NULL,document_staging_id=NULL,document_upload_grant_id=NULL,document_upload_expires_at_ms=NULL,document_reference_json=NULL,document_created_at_ms=NULL WHERE document_staging_id=OLD.id; END;

CREATE TRIGGER statement_document_immutable BEFORE UPDATE ON hosted_turns WHEN OLD.document_media_id IS NOT NULL AND NOT((NEW.id IS OLD.id AND NEW.user_id IS OLD.user_id AND NEW.document_media_id IS OLD.document_media_id AND NEW.document_created_at_ms IS OLD.document_created_at_ms) AND (OLD.document_staging_id IS NULL OR (NEW.document_staging_id IS OLD.document_staging_id AND NEW.document_reference_json IS OLD.document_reference_json))) AND NOT(NEW.document_media_id IS NULL AND NEW.document_staging_id IS NULL AND NEW.document_upload_grant_id IS NULL AND NEW.document_upload_expires_at_ms IS NULL AND NEW.document_reference_json IS NULL AND NEW.document_created_at_ms IS NULL) BEGIN SELECT RAISE(ABORT,'statement_document_immutable'); END;

CREATE TRIGGER statement_document_same_user BEFORE UPDATE ON hosted_turns WHEN NEW.document_staging_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM statement_staging_objects WHERE id=NEW.document_staging_id AND user_id=NEW.user_id) BEGIN SELECT RAISE(ABORT,'statement_document_immutable'); END;

CREATE UNIQUE INDEX hosted_turns_inbound_identity ON hosted_turns(inbound_portfolio_id,inbound_message_id) WHERE inbound_message_id IS NOT NULL;

CREATE INDEX hosted_whatsapp_outbox_offer ON hosted_turns(dispatch_offered_at_ms,dispatch_created_at_ms) WHERE dispatch_created_at_ms IS NOT NULL;

CREATE INDEX hosted_turns_document_staging ON hosted_turns(document_staging_id) WHERE document_staging_id IS NOT NULL;

CREATE TRIGGER erasure_fence_hosted_turns_update BEFORE UPDATE ON hosted_turns
WHEN (NEW.id IS NOT OLD.id OR NEW.user_id IS NOT OLD.user_id OR NEW.hosted_session_id IS NOT OLD.hosted_session_id OR NEW.started_at_ms IS NOT OLD.started_at_ms OR NEW.terminal_at_ms IS NOT OLD.terminal_at_ms OR NEW.status IS NOT OLD.status OR NEW.failure_reason IS NOT OLD.failure_reason OR NEW.proposal_user_id IS NOT OLD.proposal_user_id OR NEW.proposal_receipt_digest IS NOT OLD.proposal_receipt_digest OR NEW.proposed_at_ms IS NOT OLD.proposed_at_ms OR NEW.proposal_text IS NOT OLD.proposal_text OR NEW.retention_user_id IS NOT OLD.retention_user_id OR NEW.retention_terminal_at_ms IS NOT OLD.retention_terminal_at_ms) AND EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND ((NEW.user_id=q.user_id) OR (OLD.user_id=q.user_id)) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='hosted_turns'))
BEGIN
 SELECT RAISE(ABORT,'erasure_fenced');
END;

CREATE TRIGGER hosted_retention_transcript_remove AFTER DELETE ON transcript_entries
WHEN (NOT EXISTS (
  SELECT 1 FROM transcript_entries WHERE user_id = OLD.user_id AND turn_id = OLD.turn_id
) AND NOT EXISTS (
  SELECT 1 FROM hosted_mutation_commits WHERE user_id = OLD.user_id AND turn_id = OLD.turn_id
) AND NOT EXISTS (
  SELECT 1 FROM (SELECT rowid,id AS turn_id,user_id,inbound_portfolio_id AS portfolio_id,inbound_bsuid AS bsuid,inbound_message_id AS message_id,inbound_business_phone_number_id AS business_phone_number_id,inbound_occurred_at_ms AS occurred_at_ms,inbound_received_at_ms AS received_at_ms,inbound_reply_to_message_id AS reply_to_message_id,inbound_sandbox_phone AS sandbox_phone,dispatch_user_id,dispatch_offered_at_ms,dispatch_created_at_ms FROM hosted_turns WHERE inbound_message_id IS NOT NULL) WHERE user_id = OLD.user_id AND turn_id = OLD.turn_id
))
AND NOT EXISTS(SELECT 1 FROM erasure_permits p JOIN erasure_requests q ON q.id=p.request_id WHERE q.state='Erasing' AND p.user_id=q.user_id AND p.store_id='transcript_entries' AND (OLD.user_id=q.user_id))
BEGIN
 UPDATE hosted_turns AS hosted_turn_retention SET retention_user_id=NULL,retention_terminal_at_ms=NULL WHERE retention_terminal_at_ms IS NOT NULL AND id = OLD.turn_id AND retention_user_id = OLD.user_id;
END;

CREATE TRIGGER hosted_retention_mutation_remove AFTER DELETE ON hosted_mutation_commits
WHEN (NOT EXISTS (
  SELECT 1 FROM transcript_entries WHERE user_id = OLD.user_id AND turn_id = OLD.turn_id
) AND NOT EXISTS (
  SELECT 1 FROM hosted_mutation_commits WHERE user_id = OLD.user_id AND turn_id = OLD.turn_id
) AND NOT EXISTS (
  SELECT 1 FROM (SELECT rowid,id AS turn_id,user_id,inbound_portfolio_id AS portfolio_id,inbound_bsuid AS bsuid,inbound_message_id AS message_id,inbound_business_phone_number_id AS business_phone_number_id,inbound_occurred_at_ms AS occurred_at_ms,inbound_received_at_ms AS received_at_ms,inbound_reply_to_message_id AS reply_to_message_id,inbound_sandbox_phone AS sandbox_phone,dispatch_user_id,dispatch_offered_at_ms,dispatch_created_at_ms FROM hosted_turns WHERE inbound_message_id IS NOT NULL) WHERE user_id = OLD.user_id AND turn_id = OLD.turn_id
))
AND NOT EXISTS(SELECT 1 FROM erasure_permits p JOIN erasure_requests q ON q.id=p.request_id WHERE q.state='Erasing' AND p.user_id=q.user_id AND p.store_id='hosted_mutation_commits' AND (OLD.user_id=q.user_id))
BEGIN
 UPDATE hosted_turns AS hosted_turn_retention SET retention_user_id=NULL,retention_terminal_at_ms=NULL WHERE retention_terminal_at_ms IS NOT NULL AND id = OLD.turn_id AND retention_user_id = OLD.user_id;
END;

CREATE TRIGGER statement_document_published AFTER UPDATE OF hosted_session_id ON statement_submissions
WHEN OLD.hosted_session_id IS NULL AND NEW.hosted_session_id IS NOT NULL
BEGIN
 UPDATE hosted_turns SET document_media_id=NULL,document_staging_id=NULL,document_upload_grant_id=NULL,document_upload_expires_at_ms=NULL,document_reference_json=NULL,document_created_at_ms=NULL WHERE id=NEW.hosted_turn_id AND user_id=NEW.user_id;
END;

CREATE TRIGGER hosted_turns_terminal_evidence BEFORE UPDATE OF status,terminal_at_ms,failure_reason ON hosted_turns
WHEN NOT EXISTS (SELECT 1 FROM transcript_entries WHERE turn_id = NEW.id AND user_id = NEW.user_id
  AND occurred_at_ms = NEW.terminal_at_ms
  AND kind = CASE NEW.status WHEN 'completed' THEN 'assistant' ELSE NEW.status END
  AND (NEW.status <> 'failed' OR failure_reason = NEW.failure_reason)
  AND (NEW.status <> 'completed' OR
    (text = (SELECT text FROM (SELECT rowid,id AS turn_id,proposal_user_id AS user_id,proposal_receipt_digest AS receipt_digest,proposed_at_ms,proposal_text AS text FROM hosted_turns WHERE proposed_at_ms IS NOT NULL) AS hosted_delivery_proposals
      WHERE turn_id = NEW.id AND user_id = NEW.user_id)
      AND NOT EXISTS (SELECT 1 FROM (SELECT rowid,id AS turn_id,user_id,inbound_portfolio_id AS portfolio_id,inbound_bsuid AS bsuid,inbound_message_id AS message_id,inbound_business_phone_number_id AS business_phone_number_id,inbound_occurred_at_ms AS occurred_at_ms,inbound_received_at_ms AS received_at_ms,inbound_reply_to_message_id AS reply_to_message_id,inbound_sandbox_phone AS sandbox_phone,dispatch_user_id,dispatch_offered_at_ms,dispatch_created_at_ms FROM hosted_turns WHERE inbound_message_id IS NOT NULL) WHERE turn_id = NEW.id))
    OR (text = (SELECT text FROM (SELECT rowid,* FROM whatsapp_deliveries WHERE kind='hosted') AS hosted_whatsapp_delivery
      WHERE turn_id = NEW.id AND user_id = NEW.user_id AND state = 'delivered'))))
BEGIN
 SELECT RAISE(ABORT, 'hosted_turn_terminal_evidence_required');
END;

CREATE TRIGGER hosted_inbound_dispatch_initial BEFORE UPDATE ON hosted_turns
WHEN OLD.inbound_message_id IS NULL AND NEW.inbound_message_id IS NOT NULL
 AND (NEW.dispatch_user_id IS NOT NULL OR NEW.dispatch_offered_at_ms IS NOT NULL OR NEW.dispatch_created_at_ms IS NOT NULL)
BEGIN SELECT RAISE(ABORT,'hosted_whatsapp_inbound_companions_initial'); END;
