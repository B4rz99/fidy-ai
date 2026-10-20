PRAGMA defer_foreign_keys=ON;

DROP TRIGGER hosted_whatsapp_delivery_identity_immutable;

DROP TRIGGER hosted_whatsapp_delivery_event_immutable;

DROP TRIGGER hosted_turns_terminal_evidence;

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

CREATE TABLE whatsapp_deliveries (
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
 FOREIGN KEY (user_id, turn_id) REFERENCES hosted_whatsapp_inbound(user_id, turn_id),
 CHECK(kind<>'insight' OR coalesce((user_id IS NOT NULL AND insight_event_id IS NOT NULL AND correlation_token IS NOT NULL AND portfolio_id IS NOT NULL AND bsuid IS NOT NULL AND business_phone_number_id IS NOT NULL AND scheduled_at_ms IS NOT NULL AND expires_at_ms IS NOT NULL AND time_zone IS NOT NULL AND state IS NOT NULL) AND (state IN ('staged','sending','accepted','ambiguous','rejected','delivered','expired')) AND (expires_at_ms > scheduled_at_ms AND expires_at_ms <= scheduled_at_ms + 86400000) AND ((state IN ('staged','expired')) OR send_started_at_ms IS NOT NULL) AND (state <> 'delivered' OR (provider_message_id IS NOT NULL AND delivered_at_ms IS NOT NULL)),0)),
 CHECK(kind<>'proactivity' OR coalesce((user_id IS NOT NULL AND delivery_id IS NOT NULL AND role IS NOT NULL AND correlation_token IS NOT NULL AND portfolio_id IS NOT NULL AND bsuid IS NOT NULL AND business_phone_number_id IS NOT NULL AND scheduled_at_ms IS NOT NULL AND expires_at_ms IS NOT NULL AND time_zone IS NOT NULL AND state IS NOT NULL) AND (role IN ('budget-threshold','manual-entry-reminder','new-recurring-series','budget-offer','reminder-offer','recurring-offer','reminder-question')) AND (state IN ('staged','sending','accepted','ambiguous','rejected','delivered','expired')) AND ((role IN ('budget-offer','reminder-offer','recurring-offer') AND consent_grant_id IS NULL) OR (role IN ('budget-threshold','manual-entry-reminder','new-recurring-series','reminder-question') AND consent_grant_id IS NOT NULL)) AND (state NOT IN ('sending','accepted','ambiguous','rejected','delivered') OR send_started_at_ms IS NOT NULL) AND (state<>'delivered' OR (provider_message_id IS NOT NULL AND delivered_at_ms IS NOT NULL)),0)),
 CHECK(kind<>'weekly-question' OR coalesce((id IS NOT NULL AND user_id IS NOT NULL AND offer_id IS NOT NULL AND created_at_ms IS NOT NULL AND expires_at_ms IS NOT NULL AND state IS NOT NULL AND correlation_token IS NOT NULL AND portfolio_id IS NOT NULL AND bsuid IS NOT NULL AND business_phone_number_id IS NOT NULL AND time_zone IS NOT NULL AND last_attempt_at_ms IS NOT NULL) AND (state IN ('ready','sending','accepted','ambiguous','rejected','delivered','expired')) AND (offer_json IS NULL OR json_valid(offer_json)) AND (expires_at_ms > created_at_ms),0)),
 CHECK(kind<>'hosted' OR coalesce((turn_id IS NOT NULL AND user_id IS NOT NULL AND text IS NOT NULL AND correlation_token IS NOT NULL AND business_phone_number_id IS NOT NULL AND proposed_at_ms IS NOT NULL AND state IS NOT NULL) AND (length(text) > 0) AND (state IN ('sending','accepted','ambiguous','rejected','delivered','unconfirmed')) AND ((state = 'delivered' AND provider_message_id IS NOT NULL AND delivered_at_ms IS NOT NULL)
    OR (state <> 'delivered' AND delivered_at_ms IS NULL)),0))
) STRICT;

INSERT INTO whatsapp_deliveries(kind,user_id,insight_event_id,correlation_token,portfolio_id,bsuid,business_phone_number_id,summary_json,text,scheduled_at_ms,expires_at_ms,time_zone,state,send_started_at_ms,provider_message_id,delivered_at_ms,last_received_at_ms) SELECT 'insight',user_id,insight_event_id,correlation_token,portfolio_id,bsuid,business_phone_number_id,summary_json,text,scheduled_at_ms,expires_at_ms,time_zone,state,send_started_at_ms,provider_message_id,delivered_at_ms,last_received_at_ms FROM insight_whatsapp_claims;

INSERT INTO whatsapp_deliveries(kind,user_id,delivery_id,role,consent_grant_id,correlation_token,portfolio_id,bsuid,business_phone_number_id,template_json,text,scheduled_at_ms,expires_at_ms,time_zone,state,send_started_at_ms,provider_message_id,delivered_at_ms) SELECT 'proactivity',user_id,delivery_id,role,consent_grant_id,correlation_token,portfolio_id,bsuid,business_phone_number_id,template_json,text,scheduled_at_ms,expires_at_ms,time_zone,state,send_started_at_ms,provider_message_id,delivered_at_ms FROM proactivity_whatsapp_claims;

INSERT INTO whatsapp_deliveries(kind,id,user_id,offer_id,grant_id,created_at_ms,expires_at_ms,state,correlation_token,portfolio_id,bsuid,business_phone_number_id,text,offer_json,time_zone,send_started_at_ms,provider_message_id,delivered_at_ms,last_attempt_at_ms) SELECT 'weekly-question',id,user_id,offer_id,grant_id,created_at_ms,expires_at_ms,state,correlation_token,portfolio_id,bsuid,business_phone_number_id,text,offer_json,time_zone,send_started_at_ms,provider_message_id,delivered_at_ms,last_attempt_at_ms FROM weekly_governor_questions;

INSERT INTO whatsapp_deliveries(kind,turn_id,user_id,text,correlation_token,business_phone_number_id,proposed_at_ms,state,provider_message_id,delivered_at_ms,send_started_at_ms) SELECT 'hosted',turn_id,user_id,text,correlation_token,business_phone_number_id,proposed_at_ms,state,provider_message_id,delivered_at_ms,send_started_at_ms FROM hosted_whatsapp_delivery;

CREATE TABLE hosted_whatsapp_delivery_events_consolidated (
  correlation_token TEXT NOT NULL REFERENCES whatsapp_deliveries(hosted_correlation_token),
  provider_message_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('sent','delivered','failed')),
  occurred_at_ms INTEGER NOT NULL,
  received_at_ms INTEGER NOT NULL,
  PRIMARY KEY (correlation_token, provider_message_id, status, occurred_at_ms)
) STRICT;

INSERT INTO hosted_whatsapp_delivery_events_consolidated SELECT * FROM hosted_whatsapp_delivery_events;

DROP TABLE hosted_whatsapp_delivery_events;

ALTER TABLE hosted_whatsapp_delivery_events_consolidated RENAME TO hosted_whatsapp_delivery_events;

DROP TABLE insight_whatsapp_claims;

DROP TABLE proactivity_whatsapp_claims;

DROP TABLE weekly_governor_questions;

DROP TABLE hosted_whatsapp_delivery;

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

CREATE TRIGGER hosted_turns_terminal_evidence BEFORE UPDATE ON hosted_turns
WHEN NOT EXISTS (SELECT 1 FROM transcript_entries WHERE turn_id = NEW.id AND user_id = NEW.user_id
  AND occurred_at_ms = NEW.terminal_at_ms
  AND kind = CASE NEW.status WHEN 'completed' THEN 'assistant' ELSE NEW.status END
  AND (NEW.status <> 'failed' OR failure_reason = NEW.failure_reason)
  AND (NEW.status <> 'completed' OR
    (text = (SELECT text FROM hosted_delivery_proposals
      WHERE turn_id = NEW.id AND user_id = NEW.user_id)
      AND NOT EXISTS (SELECT 1 FROM hosted_whatsapp_inbound WHERE turn_id = NEW.id))
    OR (text = (SELECT text FROM (SELECT rowid,* FROM whatsapp_deliveries WHERE kind='hosted') AS hosted_whatsapp_delivery
      WHERE turn_id = NEW.id AND user_id = NEW.user_id AND state = 'delivered'))))
BEGIN SELECT RAISE(ABORT, 'hosted_turn_terminal_evidence_required'); END;

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

INSERT INTO sql_assertions(scope,accepted) SELECT 'migration_whatsapp_deliveries',NOT EXISTS(SELECT 1 FROM pragma_foreign_key_check);

DELETE FROM sql_assertions WHERE scope='migration_whatsapp_deliveries';

PRAGMA defer_foreign_keys=OFF;
