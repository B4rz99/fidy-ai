ALTER TABLE hosted_whatsapp_inbound ADD COLUMN reply_to_message_id TEXT;
ALTER TABLE weekly_consent_offers ADD COLUMN source_id TEXT;
ALTER TABLE weekly_consent_offers ADD COLUMN rejection_id TEXT;
CREATE UNIQUE INDEX weekly_consent_offer_source ON weekly_consent_offers(user_id,source_id) WHERE source_id IS NOT NULL;
CREATE TRIGGER weekly_consent_source_immutable BEFORE UPDATE ON weekly_consent_offers WHEN NEW.source_id IS NOT OLD.source_id OR NEW.rejection_id IS NOT OLD.rejection_id BEGIN SELECT RAISE(ABORT,'weekly_disclosure_immutable'); END;
-- Governor standing is product execution policy, not Consent authority.
-- Revocation is a new privacy decision, not a rewrite of an already accepted offer.
CREATE TABLE weekly_consent_revocation_records (
 id TEXT PRIMARY KEY NOT NULL,
 user_id TEXT NOT NULL REFERENCES users(id),
 grant_id TEXT NOT NULL UNIQUE REFERENCES weekly_consent_records(id),
 offer_id TEXT NOT NULL REFERENCES weekly_consent_offers(id),
 decision_message_id TEXT NOT NULL UNIQUE,
 decision TEXT NOT NULL CHECK(decision IN ('decline','revoke')),
 record_json TEXT NOT NULL CHECK(json_valid(record_json)),
 occurred_at_ms INTEGER NOT NULL
) STRICT;
CREATE TRIGGER weekly_consent_revocations_no_update BEFORE UPDATE ON weekly_consent_revocation_records
BEGIN SELECT RAISE(ABORT,'consent_append_only'); END;
CREATE TRIGGER weekly_consent_revocations_no_delete BEFORE DELETE ON weekly_consent_revocation_records
BEGIN SELECT RAISE(ABORT,'consent_append_only'); END;
-- Sequence, rather than wall-clock precision, orders rejections and requested re-enablement.
CREATE TABLE weekly_consent_rejections (
 sequence INTEGER PRIMARY KEY AUTOINCREMENT,
 id TEXT NOT NULL UNIQUE,
 user_id TEXT NOT NULL REFERENCES users(id),
 offer_id TEXT NOT NULL REFERENCES weekly_consent_offers(id),
 decision_message_id TEXT NOT NULL UNIQUE,
 decision TEXT NOT NULL CHECK(decision IN ('decline','revoke'))
) STRICT;
INSERT INTO weekly_consent_rejections(id,user_id,offer_id,decision_message_id,decision)
 SELECT id,user_id,id,decision_message_id,decision FROM weekly_consent_offers
 WHERE decision IN ('decline','revoke') ORDER BY created_at_ms,rowid;
CREATE INDEX weekly_consent_rejections_user ON weekly_consent_rejections(user_id,sequence);
CREATE TRIGGER weekly_consent_rejections_no_update BEFORE UPDATE ON weekly_consent_rejections
BEGIN SELECT RAISE(ABORT,'consent_append_only'); END;
CREATE TRIGGER weekly_consent_rejections_no_delete BEFORE DELETE ON weekly_consent_rejections
BEGIN SELECT RAISE(ABORT,'consent_append_only'); END;
CREATE TABLE weekly_governors (
 user_id TEXT PRIMARY KEY NOT NULL REFERENCES users(id),
 unanswered INTEGER NOT NULL DEFAULT 0 CHECK(unanswered BETWEEN 0 AND 200),
 last_reply_at_ms INTEGER NOT NULL DEFAULT 0,
 question_needed INTEGER NOT NULL DEFAULT 0 CHECK(question_needed IN (0,1)),
 question_delivered INTEGER NOT NULL DEFAULT 0 CHECK(question_delivered IN (0,1)),
 question_delivered_at_ms INTEGER,
 question_event_id TEXT,
 paused_at_ms INTEGER,
 notice_session_id TEXT,
 notice_turn_id TEXT,
 notice_completed INTEGER NOT NULL DEFAULT 0 CHECK(notice_completed IN (0,1)),
 CHECK((question_delivered=0)=(question_delivered_at_ms IS NULL)),
 CHECK(question_delivered<=question_needed),
 CHECK(question_needed=0 OR question_event_id IS NOT NULL)
) STRICT;
CREATE TABLE weekly_governor_deliveries (
 user_id TEXT NOT NULL, insight_event_id TEXT NOT NULL,
 PRIMARY KEY(user_id,insight_event_id),
 FOREIGN KEY(user_id,insight_event_id) REFERENCES insight_events(user_id,id)
) STRICT;
CREATE TABLE weekly_question_intents (
 id TEXT PRIMARY KEY NOT NULL,
 user_id TEXT NOT NULL REFERENCES users(id),
 origin TEXT NOT NULL CHECK(origin IN ('proactive','requested')),
 request_message_id TEXT,
 rejection_offer_id TEXT,
 state TEXT NOT NULL DEFAULT 'ready' CHECK(state IN ('ready','settled','expired','refused')),
 created_at_ms INTEGER NOT NULL,
 last_attempt_at_ms INTEGER NOT NULL DEFAULT 0,
 UNIQUE(user_id,id)
) STRICT;
CREATE UNIQUE INDEX weekly_question_request ON weekly_question_intents(user_id,request_message_id) WHERE request_message_id IS NOT NULL;
CREATE INDEX weekly_question_intents_due ON weekly_question_intents(state,last_attempt_at_ms,created_at_ms);
ALTER TABLE weekly_summary_outbox ADD COLUMN restart_attempts INTEGER NOT NULL DEFAULT 0 CHECK(restart_attempts BETWEEN 0 AND 3);
ALTER TABLE weekly_question_intents ADD COLUMN restart_attempts INTEGER NOT NULL DEFAULT 0 CHECK(restart_attempts BETWEEN 0 AND 3);
CREATE INDEX weekly_question_intents_expiry ON weekly_question_intents(state,created_at_ms);
-- Questions are separate from InsightEvents and never count as unanswered summaries.
CREATE TABLE weekly_governor_questions (
 id TEXT PRIMARY KEY NOT NULL,
 user_id TEXT NOT NULL REFERENCES users(id),
 offer_id TEXT NOT NULL,
 grant_id TEXT,
 created_at_ms INTEGER NOT NULL,
 expires_at_ms INTEGER NOT NULL,
 state TEXT NOT NULL DEFAULT 'ready' CHECK(state IN ('ready','sending','accepted','ambiguous','rejected','delivered','expired')),
 correlation_token TEXT NOT NULL UNIQUE,
 portfolio_id TEXT NOT NULL,
 bsuid TEXT NOT NULL,
 business_phone_number_id TEXT NOT NULL,
 text TEXT,
 offer_json TEXT CHECK(offer_json IS NULL OR json_valid(offer_json)),
 time_zone TEXT NOT NULL,
 send_started_at_ms INTEGER,
 provider_message_id TEXT,
 delivered_at_ms INTEGER,
 last_attempt_at_ms INTEGER NOT NULL DEFAULT 0,
 FOREIGN KEY(offer_id) REFERENCES weekly_consent_offers(id),
 CHECK(expires_at_ms > created_at_ms)
) STRICT;
CREATE UNIQUE INDEX weekly_question_provider_identity ON weekly_governor_questions(user_id,provider_message_id) WHERE provider_message_id IS NOT NULL;
CREATE INDEX weekly_governor_questions_due ON weekly_governor_questions(state,last_attempt_at_ms,created_at_ms);
CREATE UNIQUE INDEX weekly_governor_questions_offer ON weekly_governor_questions(user_id,offer_id);
