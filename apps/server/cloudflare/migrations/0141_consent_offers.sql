PRAGMA defer_foreign_keys=ON;

DROP TRIGGER weekly_consent_offer_immutable;

DROP TRIGGER weekly_consent_source_immutable;

DROP TRIGGER proactivity_offer_immutable;

DROP TRIGGER proactivity_offer_replacement_immutable;

DROP TRIGGER erasure_fence_proactivity_consent_offers_insert;

DROP TRIGGER erasure_fence_proactivity_consent_offers_update;

DROP TRIGGER erasure_fence_proactivity_consent_offers_delete;

DROP TRIGGER erasure_fence_weekly_consent_offers_insert;

DROP TRIGGER erasure_fence_weekly_consent_offers_update;

DROP TRIGGER erasure_fence_weekly_consent_offers_delete;

DROP TRIGGER erasure_fence_weekly_governor_questions_insert;

DROP TRIGGER erasure_fence_weekly_governor_questions_update;

DROP TRIGGER erasure_fence_weekly_governor_questions_delete;

DROP TRIGGER erasure_preserve_proactivity_consent_offers_delete;

DROP TRIGGER erasure_preserve_weekly_consent_offers_delete;

DROP TRIGGER erasure_preserve_weekly_governor_questions_delete;

DROP TRIGGER consent_user_revocation_requires_grant;

DROP TRIGGER issue_forwarding_address;

DROP TRIGGER hosted_turn_requires_consent;

DROP TRIGGER processing_consent_withdrawal_history;

DROP TRIGGER processing_consent_renewal_requires_authority;

DROP TRIGGER consent_user_revocations_requires_renewal;

DROP TRIGGER consent_history_no_update;

DROP TRIGGER consent_history_no_delete;

DROP TRIGGER erasure_fence_consent_history_insert;

DROP TRIGGER erasure_fence_consent_history_update;

DROP TRIGGER erasure_fence_consent_history_delete;

DROP TRIGGER erasure_preserve_consent_history_delete;

DROP TRIGGER provider_completion_requires_proof;

DROP TRIGGER forwarded_email_authority;

DROP TRIGGER forwarded_email_publication_authority;

DROP TRIGGER forwarded_email_outcome_consent;

CREATE TABLE consent_offers (
 id TEXT NOT NULL,user_id TEXT NOT NULL REFERENCES users(id),
 kind TEXT NOT NULL DEFAULT 'weekly-summary' CHECK(kind IN ('weekly-summary','budget-threshold','manual-entry-reminder','new-recurring-series')),
 portfolio_id TEXT NOT NULL,bsuid TEXT NOT NULL,disclosure_json TEXT NOT NULL,created_at_ms INTEGER NOT NULL,expires_at_ms INTEGER NOT NULL,
 disclosure_message_id TEXT,disclosed_at_ms INTEGER,decision_message_id TEXT,decision TEXT CHECK(decision IN ('accept','decline','revoke')),
 source_id TEXT,rejection_id TEXT,replaces_offer_id TEXT,
 weekly_offer_id TEXT GENERATED ALWAYS AS(CASE WHEN kind='weekly-summary' THEN id END) VIRTUAL UNIQUE,
 proactivity_offer_id TEXT GENERATED ALWAYS AS(CASE WHEN kind<>'weekly-summary' THEN id END) VIRTUAL UNIQUE,
 PRIMARY KEY(kind,id),UNIQUE(user_id,kind,id),
 CHECK((decision IS NULL)=(decision_message_id IS NULL)),
 CHECK((kind='weekly-summary' AND ((disclosure_message_id IS NULL)=(disclosed_at_ms IS NULL)) AND replaces_offer_id IS NULL)
 OR(kind<>'weekly-summary' AND json_valid(disclosure_json) AND expires_at_ms>created_at_ms AND disclosed_at_ms IS NULL AND source_id IS NULL AND rejection_id IS NULL))
) STRICT;

INSERT INTO consent_offers(id,user_id,portfolio_id,bsuid,disclosure_json,created_at_ms,expires_at_ms,disclosure_message_id,disclosed_at_ms,decision_message_id,decision,source_id,rejection_id) SELECT id,user_id,portfolio_id,bsuid,disclosure_json,created_at_ms,expires_at_ms,disclosure_message_id,disclosed_at_ms,decision_message_id,decision,source_id,rejection_id FROM weekly_consent_offers;

INSERT INTO consent_offers(id,user_id,kind,portfolio_id,bsuid,disclosure_json,created_at_ms,expires_at_ms,disclosure_message_id,decision_message_id,decision,replaces_offer_id) SELECT id,user_id,kind,portfolio_id,bsuid,disclosure_json,created_at_ms,expires_at_ms,disclosure_message_id,decision_message_id,decision,replaces_offer_id FROM proactivity_consent_offers;

CREATE TABLE consent_history_consolidated (
 sequence INTEGER PRIMARY KEY AUTOINCREMENT,
 record_type TEXT NOT NULL CHECK(record_type IN ('processing_grant','processing_withdrawal','processing_renewal','weekly_grant','weekly_rejection','weekly_revocation','proactivity_grant','pat_grant','pat_revocation','oauth_grant','oauth_replay_revocation','oauth_user_revocation')),
 id TEXT,
 user_id TEXT NOT NULL,
 disclosure_json TEXT,
 disclosure_message_id TEXT,
 decision_message_id TEXT,
 decision_received_at_ms INTEGER,
 accepted_at_ms INTEGER,
 grant_record_id TEXT,
 session_id TEXT,
 occurred_at_ms INTEGER,
 withdrawal_id TEXT,
 grant_id TEXT,
 offer_id TEXT,
 record_json TEXT,
 decision TEXT,
 kind TEXT,
 pairing_id TEXT,
 request_id TEXT,
 disclosure_revision TEXT,
 disclosure_text TEXT,
 grant_consent_id TEXT,
 pat_id TEXT,
 policy_reason TEXT,
 connection_id TEXT,
 reason TEXT,
 processing_parent_type TEXT GENERATED ALWAYS AS (CASE WHEN grant_record_id IS NOT NULL THEN 'processing_grant' END) VIRTUAL,
 withdrawal_parent_type TEXT GENERATED ALWAYS AS (CASE WHEN withdrawal_id IS NOT NULL THEN 'processing_withdrawal' END) VIRTUAL,
 pat_parent_type TEXT GENERATED ALWAYS AS (CASE WHEN grant_consent_id IS NOT NULL THEN 'pat_grant' END) VIRTUAL,
 grant_parent_type TEXT GENERATED ALWAYS AS (CASE WHEN grant_id IS NOT NULL THEN CASE WHEN record_type IN ('weekly_grant','weekly_revocation') THEN 'weekly_grant' WHEN record_type='proactivity_grant' THEN 'proactivity_grant' END END) VIRTUAL,
 weekly_offer_reference TEXT GENERATED ALWAYS AS (CASE WHEN record_type IN ('weekly_grant','weekly_rejection','weekly_revocation') THEN offer_id END) VIRTUAL,
 proactivity_offer_reference TEXT GENERATED ALWAYS AS (CASE WHEN record_type='proactivity_grant' THEN offer_id END) VIRTUAL,
 UNIQUE(record_type,id),
 UNIQUE(user_id,record_type,id),
 CHECK(record_type<>'processing_grant' OR (id IS NOT NULL AND user_id IS NOT NULL AND disclosure_json IS NOT NULL AND disclosure_message_id IS NOT NULL AND decision_message_id IS NOT NULL AND decision_received_at_ms IS NOT NULL AND accepted_at_ms IS NOT NULL AND grant_record_id IS NULL AND session_id IS NULL AND occurred_at_ms IS NULL AND withdrawal_id IS NULL AND grant_id IS NULL AND offer_id IS NULL AND record_json IS NULL AND decision IS NULL AND kind IS NULL AND pairing_id IS NULL AND request_id IS NULL AND disclosure_revision IS NULL AND disclosure_text IS NULL AND grant_consent_id IS NULL AND pat_id IS NULL AND policy_reason IS NULL AND connection_id IS NULL AND reason IS NULL)),
 CHECK(record_type<>'processing_withdrawal' OR (id IS NOT NULL AND user_id IS NOT NULL AND grant_record_id IS NOT NULL AND session_id IS NOT NULL AND occurred_at_ms IS NOT NULL AND disclosure_json IS NULL AND disclosure_message_id IS NULL AND decision_message_id IS NULL AND decision_received_at_ms IS NULL AND accepted_at_ms IS NULL AND withdrawal_id IS NULL AND grant_id IS NULL AND offer_id IS NULL AND record_json IS NULL AND decision IS NULL AND kind IS NULL AND pairing_id IS NULL AND request_id IS NULL AND disclosure_revision IS NULL AND disclosure_text IS NULL AND grant_consent_id IS NULL AND pat_id IS NULL AND policy_reason IS NULL AND connection_id IS NULL AND reason IS NULL)),
 CHECK(record_type<>'processing_renewal' OR (id IS NOT NULL AND user_id IS NOT NULL AND withdrawal_id IS NOT NULL AND grant_record_id IS NOT NULL AND session_id IS NOT NULL AND disclosure_json IS NOT NULL AND accepted_at_ms IS NOT NULL AND disclosure_message_id IS NULL AND decision_message_id IS NULL AND decision_received_at_ms IS NULL AND occurred_at_ms IS NULL AND grant_id IS NULL AND offer_id IS NULL AND record_json IS NULL AND decision IS NULL AND kind IS NULL AND pairing_id IS NULL AND request_id IS NULL AND disclosure_revision IS NULL AND disclosure_text IS NULL AND grant_consent_id IS NULL AND pat_id IS NULL AND policy_reason IS NULL AND connection_id IS NULL AND reason IS NULL AND (json_valid(disclosure_json)))),
 CHECK(record_type<>'weekly_grant' OR (id IS NOT NULL AND user_id IS NOT NULL AND offer_id IS NOT NULL AND record_json IS NOT NULL AND occurred_at_ms IS NOT NULL AND disclosure_json IS NULL AND disclosure_message_id IS NULL AND decision_message_id IS NULL AND decision_received_at_ms IS NULL AND accepted_at_ms IS NULL AND grant_record_id IS NULL AND session_id IS NULL AND withdrawal_id IS NULL AND decision IS NULL AND kind IS NULL AND pairing_id IS NULL AND request_id IS NULL AND disclosure_revision IS NULL AND disclosure_text IS NULL AND grant_consent_id IS NULL AND pat_id IS NULL AND policy_reason IS NULL AND connection_id IS NULL AND reason IS NULL)),
 CHECK(record_type<>'weekly_rejection' OR (id IS NOT NULL AND user_id IS NOT NULL AND offer_id IS NOT NULL AND decision_message_id IS NOT NULL AND decision IS NOT NULL AND disclosure_json IS NULL AND disclosure_message_id IS NULL AND decision_received_at_ms IS NULL AND accepted_at_ms IS NULL AND grant_record_id IS NULL AND session_id IS NULL AND occurred_at_ms IS NULL AND withdrawal_id IS NULL AND grant_id IS NULL AND record_json IS NULL AND kind IS NULL AND pairing_id IS NULL AND request_id IS NULL AND disclosure_revision IS NULL AND disclosure_text IS NULL AND grant_consent_id IS NULL AND pat_id IS NULL AND policy_reason IS NULL AND connection_id IS NULL AND reason IS NULL AND (decision IN ('decline','revoke')))),
 CHECK(record_type<>'weekly_revocation' OR (id IS NOT NULL AND user_id IS NOT NULL AND grant_id IS NOT NULL AND offer_id IS NOT NULL AND decision_message_id IS NOT NULL AND decision IS NOT NULL AND record_json IS NOT NULL AND occurred_at_ms IS NOT NULL AND disclosure_json IS NULL AND disclosure_message_id IS NULL AND decision_received_at_ms IS NULL AND accepted_at_ms IS NULL AND grant_record_id IS NULL AND session_id IS NULL AND withdrawal_id IS NULL AND kind IS NULL AND pairing_id IS NULL AND request_id IS NULL AND disclosure_revision IS NULL AND disclosure_text IS NULL AND grant_consent_id IS NULL AND pat_id IS NULL AND policy_reason IS NULL AND connection_id IS NULL AND reason IS NULL AND (decision IN ('decline','revoke')) AND (json_valid(record_json)))),
 CHECK(record_type<>'proactivity_grant' OR (id IS NOT NULL AND user_id IS NOT NULL AND kind IS NOT NULL AND offer_id IS NOT NULL AND decision_message_id IS NOT NULL AND record_json IS NOT NULL AND occurred_at_ms IS NOT NULL AND disclosure_json IS NULL AND disclosure_message_id IS NULL AND decision_received_at_ms IS NULL AND accepted_at_ms IS NULL AND grant_record_id IS NULL AND session_id IS NULL AND withdrawal_id IS NULL AND decision IS NULL AND pairing_id IS NULL AND request_id IS NULL AND disclosure_revision IS NULL AND disclosure_text IS NULL AND grant_consent_id IS NULL AND pat_id IS NULL AND policy_reason IS NULL AND connection_id IS NULL AND reason IS NULL AND (kind IN ('budget-threshold','manual-entry-reminder','new-recurring-series')) AND (json_valid(record_json)))),
 CHECK(record_type<>'pat_grant' OR (id IS NOT NULL AND user_id IS NOT NULL AND session_id IS NOT NULL AND disclosure_revision IS NOT NULL AND disclosure_text IS NOT NULL AND accepted_at_ms IS NOT NULL AND disclosure_json IS NULL AND disclosure_message_id IS NULL AND decision_message_id IS NULL AND decision_received_at_ms IS NULL AND grant_record_id IS NULL AND occurred_at_ms IS NULL AND withdrawal_id IS NULL AND grant_id IS NULL AND offer_id IS NULL AND record_json IS NULL AND decision IS NULL AND kind IS NULL AND grant_consent_id IS NULL AND pat_id IS NULL AND policy_reason IS NULL AND connection_id IS NULL AND reason IS NULL AND ((pairing_id IS NULL) <> (request_id IS NULL)))),
 CHECK(record_type<>'pat_revocation' OR (id IS NOT NULL AND grant_consent_id IS NOT NULL AND user_id IS NOT NULL AND disclosure_revision IS NOT NULL AND disclosure_text IS NOT NULL AND occurred_at_ms IS NOT NULL AND disclosure_json IS NULL AND disclosure_message_id IS NULL AND decision_message_id IS NULL AND decision_received_at_ms IS NULL AND accepted_at_ms IS NULL AND grant_record_id IS NULL AND withdrawal_id IS NULL AND grant_id IS NULL AND offer_id IS NULL AND record_json IS NULL AND decision IS NULL AND kind IS NULL AND request_id IS NULL AND connection_id IS NULL AND reason IS NULL AND (policy_reason IN ('pat-approved-unclaimed-expiry','pat-fixed-lifetime-expiry')) AND ((pat_id IS NULL) <> (pairing_id IS NULL)) AND ((session_id IS NULL) <> (policy_reason IS NULL)))),
 CHECK(record_type<>'oauth_grant' OR (id IS NOT NULL AND connection_id IS NOT NULL AND user_id IS NOT NULL AND session_id IS NOT NULL AND disclosure_revision IS NOT NULL AND disclosure_text IS NOT NULL AND accepted_at_ms IS NOT NULL AND disclosure_json IS NULL AND disclosure_message_id IS NULL AND decision_message_id IS NULL AND decision_received_at_ms IS NULL AND grant_record_id IS NULL AND occurred_at_ms IS NULL AND withdrawal_id IS NULL AND grant_id IS NULL AND offer_id IS NULL AND record_json IS NULL AND decision IS NULL AND kind IS NULL AND pairing_id IS NULL AND request_id IS NULL AND grant_consent_id IS NULL AND pat_id IS NULL AND policy_reason IS NULL AND reason IS NULL)),
 CHECK(record_type<>'oauth_replay_revocation' OR (id IS NOT NULL AND user_id IS NOT NULL AND connection_id IS NOT NULL AND reason IS NOT NULL AND occurred_at_ms IS NOT NULL AND disclosure_json IS NULL AND disclosure_message_id IS NULL AND decision_message_id IS NULL AND decision_received_at_ms IS NULL AND accepted_at_ms IS NULL AND grant_record_id IS NULL AND session_id IS NULL AND withdrawal_id IS NULL AND grant_id IS NULL AND offer_id IS NULL AND record_json IS NULL AND decision IS NULL AND kind IS NULL AND pairing_id IS NULL AND request_id IS NULL AND disclosure_revision IS NULL AND disclosure_text IS NULL AND grant_consent_id IS NULL AND pat_id IS NULL AND policy_reason IS NULL AND (reason = 'refresh_replay'))),
 CHECK(record_type<>'oauth_user_revocation' OR (connection_id IS NOT NULL AND user_id IS NOT NULL AND session_id IS NOT NULL AND reason IS NOT NULL AND disclosure_revision IS NOT NULL AND disclosure_text IS NOT NULL AND occurred_at_ms IS NOT NULL AND id IS NULL AND disclosure_json IS NULL AND disclosure_message_id IS NULL AND decision_message_id IS NULL AND decision_received_at_ms IS NULL AND accepted_at_ms IS NULL AND grant_record_id IS NULL AND withdrawal_id IS NULL AND grant_id IS NULL AND offer_id IS NULL AND record_json IS NULL AND decision IS NULL AND kind IS NULL AND pairing_id IS NULL AND request_id IS NULL AND grant_consent_id IS NULL AND pat_id IS NULL AND policy_reason IS NULL AND (reason IN ('user_one','user_all')))),
 FOREIGN KEY(user_id) REFERENCES users(id),
 FOREIGN KEY(session_id) REFERENCES web_sessions(id),
 FOREIGN KEY(pairing_id) REFERENCES pat_pairings(id),
 FOREIGN KEY(pat_id) REFERENCES pats(id),
 FOREIGN KEY(connection_id) REFERENCES oauth_connections(id),
 FOREIGN KEY (user_id,processing_parent_type,grant_record_id) REFERENCES consent_history(user_id,record_type,id),
 FOREIGN KEY (user_id,withdrawal_parent_type,withdrawal_id) REFERENCES consent_history(user_id,record_type,id),
 FOREIGN KEY (user_id,pat_parent_type,grant_consent_id) REFERENCES consent_history(user_id,record_type,id),
 FOREIGN KEY (user_id,grant_parent_type,grant_id) REFERENCES consent_history(user_id,record_type,id),
 FOREIGN KEY (weekly_offer_reference) REFERENCES consent_offers(weekly_offer_id),
 FOREIGN KEY (proactivity_offer_reference) REFERENCES consent_offers(proactivity_offer_id)
) STRICT;

INSERT INTO consent_history_consolidated("sequence","record_type","id","user_id","disclosure_json","disclosure_message_id","decision_message_id","decision_received_at_ms","accepted_at_ms","grant_record_id","session_id","occurred_at_ms","withdrawal_id","grant_id","offer_id","record_json","decision","kind","pairing_id","request_id","disclosure_revision","disclosure_text","grant_consent_id","pat_id","policy_reason","connection_id","reason") SELECT "sequence","record_type","id","user_id","disclosure_json","disclosure_message_id","decision_message_id","decision_received_at_ms","accepted_at_ms","grant_record_id","session_id","occurred_at_ms","withdrawal_id","grant_id","offer_id","record_json","decision","kind","pairing_id","request_id","disclosure_revision","disclosure_text","grant_consent_id","pat_id","policy_reason","connection_id","reason" FROM consent_history;

DROP TABLE consent_history;

ALTER TABLE consent_history_consolidated RENAME TO consent_history;

CREATE UNIQUE INDEX consent_history_processing_grant_unique_0 ON consent_history(user_id) WHERE record_type='processing_grant';

CREATE UNIQUE INDEX consent_history_processing_renewal_unique_0 ON consent_history(withdrawal_id) WHERE record_type='processing_renewal';

CREATE UNIQUE INDEX consent_history_weekly_grant_unique_0 ON consent_history(grant_id) WHERE record_type='weekly_grant' AND ( grant_id IS NOT NULL);

CREATE UNIQUE INDEX consent_history_weekly_grant_unique_2 ON consent_history(offer_id) WHERE record_type='weekly_grant';

CREATE UNIQUE INDEX consent_history_weekly_rejection_unique_1 ON consent_history(decision_message_id) WHERE record_type='weekly_rejection';

CREATE UNIQUE INDEX consent_history_weekly_revocation_unique_0 ON consent_history(decision_message_id) WHERE record_type='weekly_revocation';

CREATE UNIQUE INDEX consent_history_weekly_revocation_unique_1 ON consent_history(grant_id) WHERE record_type='weekly_revocation';

CREATE UNIQUE INDEX consent_history_proactivity_grant_unique_1 ON consent_history(user_id,kind,id) WHERE record_type='proactivity_grant';

CREATE UNIQUE INDEX consent_history_proactivity_grant_unique_2 ON consent_history(decision_message_id) WHERE record_type='proactivity_grant';

CREATE UNIQUE INDEX consent_history_proactivity_grant_unique_3 ON consent_history(grant_id) WHERE record_type='proactivity_grant';

CREATE UNIQUE INDEX consent_history_pat_grant_unique_0 ON consent_history(request_id) WHERE record_type='pat_grant';

CREATE UNIQUE INDEX consent_history_pat_grant_unique_1 ON consent_history(pairing_id) WHERE record_type='pat_grant';

CREATE UNIQUE INDEX consent_history_pat_revocation_unique_1 ON consent_history(pairing_id) WHERE record_type='pat_revocation';

CREATE UNIQUE INDEX consent_history_pat_revocation_unique_2 ON consent_history(pat_id) WHERE record_type='pat_revocation';

CREATE UNIQUE INDEX consent_history_pat_revocation_unique_3 ON consent_history(grant_consent_id) WHERE record_type='pat_revocation';

CREATE UNIQUE INDEX consent_history_oauth_grant_unique_0 ON consent_history(connection_id) WHERE record_type='oauth_grant';

CREATE UNIQUE INDEX consent_history_oauth_replay_revocation_unique_0 ON consent_history(connection_id) WHERE record_type='oauth_replay_revocation';

CREATE UNIQUE INDEX consent_history_oauth_user_revocation_unique_0 ON consent_history(connection_id) WHERE record_type='oauth_user_revocation';

CREATE INDEX consent_history_user_time ON consent_history(user_id,record_type,occurred_at_ms,sequence);

CREATE INDEX consent_history_user_grant ON consent_history(user_id,record_type,kind,grant_id);

CREATE INDEX consent_history_offer ON consent_history(record_type,offer_id);

CREATE INDEX consent_history_rejection_sequence ON consent_history(user_id,sequence) WHERE record_type='weekly_rejection';

CREATE TABLE weekly_governor_questions_consolidated (
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
 FOREIGN KEY(offer_id) REFERENCES consent_offers(weekly_offer_id),
 CHECK(expires_at_ms > created_at_ms)
) STRICT;

INSERT INTO weekly_governor_questions_consolidated("id","user_id","offer_id","grant_id","created_at_ms","expires_at_ms","state","correlation_token","portfolio_id","bsuid","business_phone_number_id","text","offer_json","time_zone","send_started_at_ms","provider_message_id","delivered_at_ms","last_attempt_at_ms") SELECT "id","user_id","offer_id","grant_id","created_at_ms","expires_at_ms","state","correlation_token","portfolio_id","bsuid","business_phone_number_id","text","offer_json","time_zone","send_started_at_ms","provider_message_id","delivered_at_ms","last_attempt_at_ms" FROM weekly_governor_questions;

DROP TABLE weekly_governor_questions;

ALTER TABLE weekly_governor_questions_consolidated RENAME TO weekly_governor_questions;

CREATE UNIQUE INDEX weekly_question_provider_identity ON weekly_governor_questions(user_id,provider_message_id) WHERE provider_message_id IS NOT NULL;

CREATE INDEX weekly_governor_questions_due ON weekly_governor_questions(state,last_attempt_at_ms,created_at_ms);

CREATE UNIQUE INDEX weekly_governor_questions_offer ON weekly_governor_questions(user_id,offer_id);

CREATE INDEX weekly_question_content_retention
  ON weekly_governor_questions(created_at_ms,id)
  WHERE text IS NOT NULL OR offer_json IS NOT NULL;

CREATE INDEX weekly_question_ready_retention
  ON weekly_governor_questions(state,expires_at_ms,id)
  WHERE state='ready' AND (text IS NOT NULL OR offer_json IS NOT NULL);

DROP TABLE weekly_consent_offers;

DROP TABLE proactivity_consent_offers;

CREATE TRIGGER weekly_consent_offer_immutable BEFORE UPDATE ON consent_offers
WHEN NEW.kind='weekly-summary' AND (NEW.id <> OLD.id OR NEW.user_id <> OLD.user_id OR NEW.portfolio_id <> OLD.portfolio_id
 OR NEW.bsuid <> OLD.bsuid OR NEW.disclosure_json <> OLD.disclosure_json
 OR NEW.created_at_ms <> OLD.created_at_ms OR NEW.expires_at_ms <> OLD.expires_at_ms
 OR (OLD.disclosure_message_id IS NOT NULL AND (NEW.disclosure_message_id IS NOT OLD.disclosure_message_id OR NEW.disclosed_at_ms IS NOT OLD.disclosed_at_ms))
 OR (OLD.decision_message_id IS NOT NULL AND (NEW.decision_message_id IS NOT OLD.decision_message_id OR NEW.decision IS NOT OLD.decision))
)
BEGIN SELECT RAISE(ABORT,'weekly_disclosure_immutable'); END;

CREATE TRIGGER weekly_consent_source_immutable BEFORE UPDATE ON consent_offers WHEN NEW.kind='weekly-summary' AND (NEW.source_id IS NOT OLD.source_id OR NEW.rejection_id IS NOT OLD.rejection_id )
BEGIN SELECT RAISE(ABORT,'weekly_disclosure_immutable'); END;

CREATE TRIGGER proactivity_offer_immutable BEFORE UPDATE ON consent_offers
WHEN NEW.kind<>'weekly-summary' AND (NEW.id IS NOT OLD.id OR NEW.user_id IS NOT OLD.user_id OR NEW.kind IS NOT OLD.kind
 OR NEW.portfolio_id IS NOT OLD.portfolio_id OR NEW.bsuid IS NOT OLD.bsuid
 OR NEW.disclosure_json IS NOT OLD.disclosure_json OR NEW.created_at_ms IS NOT OLD.created_at_ms
 OR NEW.expires_at_ms IS NOT OLD.expires_at_ms
 OR (OLD.disclosure_message_id IS NOT NULL AND NEW.disclosure_message_id IS NOT OLD.disclosure_message_id)
 OR (OLD.decision_message_id IS NOT NULL AND (NEW.decision_message_id IS NOT OLD.decision_message_id OR NEW.decision IS NOT OLD.decision))
)
BEGIN SELECT RAISE(ABORT,'consent_offer_immutable'); END;

CREATE TRIGGER proactivity_offer_replacement_immutable BEFORE UPDATE ON consent_offers
 WHEN NEW.kind<>'weekly-summary' AND (NEW.replaces_offer_id IS NOT OLD.replaces_offer_id
 )
BEGIN SELECT RAISE(ABORT,'consent_offer_replacement_immutable'); END;

CREATE TRIGGER erasure_fence_proactivity_consent_offers_insert BEFORE INSERT ON consent_offers
WHEN NEW.kind<>'weekly-summary' AND (EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND (NEW.user_id=q.user_id) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='proactivity_consent_offers'))
)
BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;

CREATE TRIGGER erasure_fence_proactivity_consent_offers_update BEFORE UPDATE ON consent_offers
WHEN NEW.kind<>'weekly-summary' AND (EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND ((NEW.user_id=q.user_id) OR (OLD.user_id=q.user_id)) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='proactivity_consent_offers'))
)
BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;

CREATE TRIGGER erasure_fence_proactivity_consent_offers_delete BEFORE DELETE ON consent_offers
WHEN OLD.kind<>'weekly-summary' AND (EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND (OLD.user_id=q.user_id) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='proactivity_consent_offers'))
)
BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;

CREATE TRIGGER erasure_fence_weekly_consent_offers_insert BEFORE INSERT ON consent_offers
WHEN NEW.kind='weekly-summary' AND (EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND (NEW.user_id=q.user_id) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='weekly_consent_offers'))
)
BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;

CREATE TRIGGER erasure_fence_weekly_consent_offers_update BEFORE UPDATE ON consent_offers
WHEN NEW.kind='weekly-summary' AND (EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND ((NEW.user_id=q.user_id) OR (OLD.user_id=q.user_id)) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='weekly_consent_offers'))
)
BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;

CREATE TRIGGER erasure_fence_weekly_consent_offers_delete BEFORE DELETE ON consent_offers
WHEN OLD.kind='weekly-summary' AND (EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND (OLD.user_id=q.user_id) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='weekly_consent_offers'))
)
BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;

CREATE TRIGGER erasure_fence_weekly_governor_questions_insert BEFORE INSERT ON weekly_governor_questions
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND (NEW.user_id=q.user_id) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='weekly_governor_questions'))
BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;

CREATE TRIGGER erasure_fence_weekly_governor_questions_update BEFORE UPDATE ON weekly_governor_questions
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND ((NEW.user_id=q.user_id) OR (OLD.user_id=q.user_id)) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='weekly_governor_questions'))
BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;

CREATE TRIGGER erasure_fence_weekly_governor_questions_delete BEFORE DELETE ON weekly_governor_questions
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND (OLD.user_id=q.user_id) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='weekly_governor_questions'))
BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;

CREATE TRIGGER erasure_preserve_proactivity_consent_offers_delete BEFORE DELETE ON consent_offers
WHEN OLD.kind<>'weekly-summary' AND (EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id)
  AND json_extract(q.decision_json,'$.dispositions.consent.action')='Retain'
  AND json_extract(q.decision_json,'$.dispositions.consent.retention.untilMs')>unixepoch('subsec')*1000)
)
BEGIN
  INSERT INTO erasure_archives(request_id,store_id,row_ref,body)
  SELECT q.id,'proactivity_consent_offers','drain:'||lower(hex(randomblob(16))),json_object('id',OLD."id",'user_id',OLD."user_id",'kind',OLD."kind",'portfolio_id',OLD."portfolio_id",'bsuid',OLD."bsuid",'disclosure_json',OLD."disclosure_json",'created_at_ms',OLD."created_at_ms",'expires_at_ms',OLD."expires_at_ms",'disclosure_message_id',OLD."disclosure_message_id",'decision_message_id',OLD."decision_message_id",'decision',OLD."decision",'replaces_offer_id',OLD."replaces_offer_id")
  FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id)
    AND json_extract(q.decision_json,'$.dispositions.consent.action')='Retain'
    AND json_extract(q.decision_json,'$.dispositions.consent.retention.untilMs')>unixepoch('subsec')*1000;
END;

CREATE TRIGGER erasure_preserve_weekly_consent_offers_delete BEFORE DELETE ON consent_offers
WHEN OLD.kind='weekly-summary' AND (EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id)
  AND json_extract(q.decision_json,'$.dispositions.consent.action')='Retain'
  AND json_extract(q.decision_json,'$.dispositions.consent.retention.untilMs')>unixepoch('subsec')*1000)
)
BEGIN
  INSERT INTO erasure_archives(request_id,store_id,row_ref,body)
  SELECT q.id,'weekly_consent_offers','drain:'||lower(hex(randomblob(16))),json_object('id',OLD."id",'user_id',OLD."user_id",'portfolio_id',OLD."portfolio_id",'bsuid',OLD."bsuid",'disclosure_json',OLD."disclosure_json",'created_at_ms',OLD."created_at_ms",'expires_at_ms',OLD."expires_at_ms",'disclosure_message_id',OLD."disclosure_message_id",'disclosed_at_ms',OLD."disclosed_at_ms",'decision_message_id',OLD."decision_message_id",'decision',OLD."decision",'source_id',OLD."source_id",'rejection_id',OLD."rejection_id")
  FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id)
    AND json_extract(q.decision_json,'$.dispositions.consent.action')='Retain'
    AND json_extract(q.decision_json,'$.dispositions.consent.retention.untilMs')>unixepoch('subsec')*1000;
END;

CREATE TRIGGER erasure_preserve_weekly_governor_questions_delete BEFORE DELETE ON weekly_governor_questions
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id)
  AND json_extract(q.decision_json,'$.dispositions.conversation.action')='Retain'
  AND json_extract(q.decision_json,'$.dispositions.conversation.retention.untilMs')>unixepoch('subsec')*1000)
BEGIN
  INSERT INTO erasure_archives(request_id,store_id,row_ref,body)
  SELECT q.id,'weekly_governor_questions','drain:'||lower(hex(randomblob(16))),json_object('id',OLD."id",'user_id',OLD."user_id",'offer_id',OLD."offer_id",'grant_id',OLD."grant_id",'created_at_ms',OLD."created_at_ms",'expires_at_ms',OLD."expires_at_ms",'state',OLD."state",'portfolio_id',OLD."portfolio_id",'bsuid',OLD."bsuid",'business_phone_number_id',OLD."business_phone_number_id",'text',OLD."text",'offer_json',OLD."offer_json",'time_zone',OLD."time_zone",'send_started_at_ms',OLD."send_started_at_ms",'provider_message_id',OLD."provider_message_id",'delivered_at_ms',OLD."delivered_at_ms",'last_attempt_at_ms',OLD."last_attempt_at_ms")
  FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id)
    AND json_extract(q.decision_json,'$.dispositions.conversation.action')='Retain'
    AND json_extract(q.decision_json,'$.dispositions.conversation.retention.untilMs')>unixepoch('subsec')*1000;
END;

CREATE TRIGGER consent_user_revocation_requires_grant BEFORE INSERT ON consent_user_revocations
WHEN NOT EXISTS (
  SELECT 1 FROM (SELECT * FROM consent_history WHERE record_type='processing_grant') AS g
  JOIN web_sessions AS w ON w.user_id = g.user_id
  WHERE g.id = NEW.grant_record_id AND g.user_id = NEW.user_id
    AND w.id = NEW.session_id AND w.revoked_at_ms IS NULL
    AND w.idle_expires_at_ms > NEW.occurred_at_ms AND w.hard_expires_at_ms > NEW.occurred_at_ms
)
BEGIN SELECT RAISE(ABORT, 'consent_revocation_requires_user_session'); END;

CREATE TRIGGER issue_forwarding_address AFTER INSERT ON consent_history
WHEN NEW.record_type='processing_grant' BEGIN
  INSERT INTO email_forwarding_addresses (id, user_id, local_part, created_at_ms)
  VALUES (
    lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' ||
    substr(lower(hex(randomblob(2))), 2, 3) || '-8' ||
    substr(lower(hex(randomblob(2))), 2, 3) || '-' || lower(hex(randomblob(6))),
    NEW.user_id, lower(hex(randomblob(24))), NEW.accepted_at_ms
  );
END;

CREATE TRIGGER hosted_turn_requires_consent BEFORE INSERT ON hosted_turns
WHEN NOT EXISTS (SELECT 1 FROM (SELECT * FROM consent_history WHERE record_type='processing_grant') AS onboarding_consent_records WHERE user_id = NEW.user_id)
  OR EXISTS (SELECT 1 FROM consent_user_revocations WHERE user_id = NEW.user_id)
BEGIN SELECT RAISE(ABORT, 'hosted_turn_consent_required'); END;

CREATE TRIGGER processing_consent_withdrawal_history AFTER INSERT ON consent_user_revocations
BEGIN INSERT INTO consent_history (record_type,id,user_id,grant_record_id,session_id,occurred_at_ms) VALUES ('processing_withdrawal',NEW.id,NEW.user_id,NEW.grant_record_id,NEW.session_id,NEW.occurred_at_ms); END;

CREATE TRIGGER processing_consent_renewal_requires_authority BEFORE INSERT ON consent_history
WHEN NEW.record_type='processing_renewal' AND ( NOT EXISTS (
  SELECT 1 FROM consent_user_revocations r JOIN (SELECT * FROM consent_history WHERE record_type='processing_grant') g ON g.id=r.grant_record_id
  JOIN web_sessions w ON w.user_id=r.user_id
  WHERE r.id=NEW.withdrawal_id AND r.user_id=NEW.user_id AND g.user_id=NEW.user_id
    AND g.id=NEW.grant_record_id AND g.disclosure_json=NEW.disclosure_json
    AND r.occurred_at_ms<=NEW.accepted_at_ms AND w.id=NEW.session_id AND w.revoked_at_ms IS NULL
    AND w.fresh_until_ms>NEW.accepted_at_ms AND w.idle_expires_at_ms>NEW.accepted_at_ms
    AND w.hard_expires_at_ms>NEW.accepted_at_ms
)
) BEGIN SELECT RAISE(ABORT,'consent_renewal_requires_authority'); END;

CREATE TRIGGER consent_user_revocations_requires_renewal BEFORE DELETE ON consent_user_revocations
WHEN NOT EXISTS (SELECT 1 FROM (SELECT * FROM consent_history WHERE record_type='processing_renewal') n WHERE n.withdrawal_id=OLD.id AND n.user_id=OLD.user_id AND n.grant_record_id=OLD.grant_record_id)
AND NOT EXISTS(SELECT 1 FROM erasure_permits p JOIN erasure_requests q ON q.id=p.request_id WHERE p.store_id='consent_user_revocations' AND p.user_id=q.user_id AND q.state='Erasing' AND OLD.user_id=p.user_id)
BEGIN SELECT RAISE(ABORT,'consent_renewal_required'); END;

CREATE TRIGGER consent_history_no_update BEFORE UPDATE ON consent_history BEGIN SELECT RAISE(ABORT,'consent_history_immutable'); END;

CREATE TRIGGER consent_history_no_delete BEFORE DELETE ON consent_history WHEN NOT EXISTS(SELECT 1 FROM erasure_permits p JOIN erasure_requests q ON q.id=p.request_id WHERE p.user_id=OLD.user_id AND q.user_id=OLD.user_id AND q.state='Erasing' AND p.store_id=(CASE OLD.record_type WHEN 'processing_grant' THEN 'onboarding_consent_records' WHEN 'processing_withdrawal' THEN 'processing_consent_withdrawal_records' WHEN 'processing_renewal' THEN 'processing_consent_renewals' WHEN 'weekly_grant' THEN 'weekly_consent_records' WHEN 'weekly_rejection' THEN 'weekly_consent_rejections' WHEN 'weekly_revocation' THEN 'weekly_consent_revocation_records' WHEN 'proactivity_grant' THEN 'proactivity_consent_records' WHEN 'pat_grant' THEN 'pat_grant_consents' WHEN 'pat_revocation' THEN 'pat_revocation_consents' WHEN 'oauth_grant' THEN 'oauth_grant_consents' WHEN 'oauth_replay_revocation' THEN 'oauth_revocation_consents' WHEN 'oauth_user_revocation' THEN 'oauth_user_revocation_consents' END)) BEGIN SELECT RAISE(ABORT,'consent_history_retention_required'); END;

CREATE TRIGGER erasure_fence_consent_history_insert BEFORE INSERT ON consent_history WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE (q.state NOT IN('AwaitingReview','Draining') OR (NEW.record_type='processing_renewal' AND q.state='Draining')) AND NEW.user_id=q.user_id AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.request_id=q.id AND p.user_id=q.user_id AND p.store_id=(CASE NEW.record_type WHEN 'processing_grant' THEN 'onboarding_consent_records' WHEN 'processing_withdrawal' THEN 'processing_consent_withdrawal_records' WHEN 'processing_renewal' THEN 'processing_consent_renewals' WHEN 'weekly_grant' THEN 'weekly_consent_records' WHEN 'weekly_rejection' THEN 'weekly_consent_rejections' WHEN 'weekly_revocation' THEN 'weekly_consent_revocation_records' WHEN 'proactivity_grant' THEN 'proactivity_consent_records' WHEN 'pat_grant' THEN 'pat_grant_consents' WHEN 'pat_revocation' THEN 'pat_revocation_consents' WHEN 'oauth_grant' THEN 'oauth_grant_consents' WHEN 'oauth_replay_revocation' THEN 'oauth_revocation_consents' WHEN 'oauth_user_revocation' THEN 'oauth_user_revocation_consents' END))) BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;

CREATE TRIGGER erasure_fence_consent_history_update BEFORE UPDATE ON consent_history WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND (NEW.user_id=q.user_id OR OLD.user_id=q.user_id) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.request_id=q.id AND p.user_id=q.user_id AND p.store_id=(CASE NEW.record_type WHEN 'processing_grant' THEN 'onboarding_consent_records' WHEN 'processing_withdrawal' THEN 'processing_consent_withdrawal_records' WHEN 'processing_renewal' THEN 'processing_consent_renewals' WHEN 'weekly_grant' THEN 'weekly_consent_records' WHEN 'weekly_rejection' THEN 'weekly_consent_rejections' WHEN 'weekly_revocation' THEN 'weekly_consent_revocation_records' WHEN 'proactivity_grant' THEN 'proactivity_consent_records' WHEN 'pat_grant' THEN 'pat_grant_consents' WHEN 'pat_revocation' THEN 'pat_revocation_consents' WHEN 'oauth_grant' THEN 'oauth_grant_consents' WHEN 'oauth_replay_revocation' THEN 'oauth_revocation_consents' WHEN 'oauth_user_revocation' THEN 'oauth_user_revocation_consents' END))) BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;

CREATE TRIGGER erasure_fence_consent_history_delete BEFORE DELETE ON consent_history WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND OLD.user_id=q.user_id AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.request_id=q.id AND p.user_id=q.user_id AND p.store_id=(CASE OLD.record_type WHEN 'processing_grant' THEN 'onboarding_consent_records' WHEN 'processing_withdrawal' THEN 'processing_consent_withdrawal_records' WHEN 'processing_renewal' THEN 'processing_consent_renewals' WHEN 'weekly_grant' THEN 'weekly_consent_records' WHEN 'weekly_rejection' THEN 'weekly_consent_rejections' WHEN 'weekly_revocation' THEN 'weekly_consent_revocation_records' WHEN 'proactivity_grant' THEN 'proactivity_consent_records' WHEN 'pat_grant' THEN 'pat_grant_consents' WHEN 'pat_revocation' THEN 'pat_revocation_consents' WHEN 'oauth_grant' THEN 'oauth_grant_consents' WHEN 'oauth_replay_revocation' THEN 'oauth_revocation_consents' WHEN 'oauth_user_revocation' THEN 'oauth_user_revocation_consents' END))) BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;

CREATE TRIGGER erasure_preserve_consent_history_delete BEFORE DELETE ON consent_history WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state='Draining' AND q.user_id=OLD.user_id AND json_extract(q.decision_json,'$.dispositions.consent.action')='Retain' AND json_extract(q.decision_json,'$.dispositions.consent.retention.untilMs')>unixepoch('subsec')*1000) BEGIN INSERT INTO erasure_archives(request_id,store_id,row_ref,body) SELECT q.id,CASE OLD.record_type WHEN 'processing_grant' THEN 'onboarding_consent_records' WHEN 'processing_withdrawal' THEN 'processing_consent_withdrawal_records' WHEN 'processing_renewal' THEN 'processing_consent_renewals' WHEN 'weekly_grant' THEN 'weekly_consent_records' WHEN 'weekly_rejection' THEN 'weekly_consent_rejections' WHEN 'weekly_revocation' THEN 'weekly_consent_revocation_records' WHEN 'proactivity_grant' THEN 'proactivity_consent_records' WHEN 'pat_grant' THEN 'pat_grant_consents' WHEN 'pat_revocation' THEN 'pat_revocation_consents' WHEN 'oauth_grant' THEN 'oauth_grant_consents' WHEN 'oauth_replay_revocation' THEN 'oauth_revocation_consents' WHEN 'oauth_user_revocation' THEN 'oauth_user_revocation_consents' END,'drain:'||lower(hex(randomblob(16))),CASE OLD.record_type WHEN 'processing_grant' THEN json_object('id',OLD."id",'user_id',OLD."user_id",'disclosure_json',OLD."disclosure_json",'disclosure_message_id',OLD."disclosure_message_id",'decision_message_id',OLD."decision_message_id",'decision_received_at_ms',OLD."decision_received_at_ms",'accepted_at_ms',OLD."accepted_at_ms") WHEN 'processing_withdrawal' THEN json_object('id',OLD."id",'user_id',OLD."user_id",'grant_record_id',OLD."grant_record_id",'session_id',OLD."session_id",'occurred_at_ms',OLD."occurred_at_ms") WHEN 'processing_renewal' THEN json_object('id',OLD."id",'user_id',OLD."user_id",'withdrawal_id',OLD."withdrawal_id",'grant_record_id',OLD."grant_record_id",'session_id',OLD."session_id",'disclosure_json',OLD."disclosure_json",'accepted_at_ms',OLD."accepted_at_ms") WHEN 'weekly_grant' THEN json_object('id',OLD."id",'user_id',OLD."user_id",'grant_id',OLD."grant_id",'offer_id',OLD."offer_id",'record_json',OLD."record_json",'occurred_at_ms',OLD."occurred_at_ms") WHEN 'weekly_rejection' THEN json_object('sequence',OLD."sequence",'id',OLD."id",'user_id',OLD."user_id",'offer_id',OLD."offer_id",'decision_message_id',OLD."decision_message_id",'decision',OLD."decision") WHEN 'weekly_revocation' THEN json_object('id',OLD."id",'user_id',OLD."user_id",'grant_id',OLD."grant_id",'offer_id',OLD."offer_id",'decision_message_id',OLD."decision_message_id",'decision',OLD."decision",'record_json',OLD."record_json",'occurred_at_ms',OLD."occurred_at_ms") WHEN 'proactivity_grant' THEN json_object('id',OLD."id",'user_id',OLD."user_id",'kind',OLD."kind",'grant_id',OLD."grant_id",'offer_id',OLD."offer_id",'decision_message_id',OLD."decision_message_id",'record_json',OLD."record_json",'occurred_at_ms',OLD."occurred_at_ms") WHEN 'pat_grant' THEN json_object('id',OLD."id",'user_id',OLD."user_id",'session_id',OLD."session_id",'pairing_id',OLD."pairing_id",'request_id',OLD."request_id",'disclosure_revision',OLD."disclosure_revision",'disclosure_text',OLD."disclosure_text",'accepted_at_ms',OLD."accepted_at_ms") WHEN 'pat_revocation' THEN json_object('id',OLD."id",'grant_consent_id',OLD."grant_consent_id",'user_id',OLD."user_id",'pat_id',OLD."pat_id",'pairing_id',OLD."pairing_id",'session_id',OLD."session_id",'policy_reason',OLD."policy_reason",'disclosure_revision',OLD."disclosure_revision",'disclosure_text',OLD."disclosure_text",'occurred_at_ms',OLD."occurred_at_ms") WHEN 'oauth_grant' THEN json_object('id',OLD."id",'connection_id',OLD."connection_id",'user_id',OLD."user_id",'session_id',OLD."session_id",'disclosure_revision',OLD."disclosure_revision",'disclosure_text',OLD."disclosure_text",'accepted_at_ms',OLD."accepted_at_ms") WHEN 'oauth_replay_revocation' THEN json_object('id',OLD."id",'user_id',OLD."user_id",'connection_id',OLD."connection_id",'reason',OLD."reason",'occurred_at_ms',OLD."occurred_at_ms") WHEN 'oauth_user_revocation' THEN json_object('connection_id',OLD."connection_id",'user_id',OLD."user_id",'session_id',OLD."session_id",'reason',OLD."reason",'disclosure_revision',OLD."disclosure_revision",'disclosure_text',OLD."disclosure_text",'occurred_at_ms',OLD."occurred_at_ms") END FROM erasure_requests q WHERE q.state='Draining' AND q.user_id=OLD.user_id AND json_extract(q.decision_json,'$.dispositions.consent.action')='Retain' AND json_extract(q.decision_json,'$.dispositions.consent.retention.untilMs')>unixepoch('subsec')*1000; END;

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

CREATE TRIGGER forwarded_email_authority BEFORE INSERT ON forwarded_email_receipts
WHEN NOT EXISTS (SELECT 1 FROM (SELECT * FROM consent_history WHERE record_type='processing_grant') AS onboarding_consent_records WHERE user_id = NEW.user_id)
  OR EXISTS (SELECT 1 FROM consent_user_revocations WHERE user_id = NEW.user_id)
BEGIN SELECT RAISE(ABORT, 'forwarded_email_consent'); END;

CREATE TRIGGER forwarded_email_publication_authority BEFORE UPDATE OF state ON forwarded_email_receipts
WHEN NEW.state = 'queued' AND (
  NOT EXISTS (SELECT 1 FROM (SELECT * FROM consent_history WHERE record_type='processing_grant') AS onboarding_consent_records WHERE user_id = NEW.user_id)
  OR (OLD.state <> 'queued' AND EXISTS
    (SELECT 1 FROM consent_user_revocations WHERE user_id = NEW.user_id)))
BEGIN SELECT RAISE(ABORT, 'forwarded_email_consent'); END;

CREATE TRIGGER forwarded_email_outcome_consent BEFORE UPDATE OF outcome ON forwarded_email_receipts
WHEN OLD.outcome IS NULL AND NEW.outcome IS NOT NULL AND ((NEW.outcome <> 'needs-review' OR NOT (NEW.review_id=NEW.outcome_review_id AND NEW.review_reason='consent-revoked')) AND (
  NOT EXISTS (SELECT 1 FROM (SELECT * FROM consent_history WHERE record_type='processing_grant') AS onboarding_consent_records WHERE user_id = NEW.user_id)
  OR (EXISTS (SELECT 1 FROM consent_user_revocations WHERE user_id = NEW.user_id)
    AND NOT EXISTS (SELECT 1 FROM forwarded_email_receipts
      WHERE id = NEW.id AND user_id = NEW.user_id AND state = 'queued'
        AND expires_at_ms > NEW.outcome_completed_at_ms)))
  OR ((NEW.review_id=NEW.outcome_review_id AND NEW.review_reason='consent-revoked')
    AND NOT EXISTS (SELECT 1 FROM consent_user_revocations WHERE user_id = NEW.user_id))
  OR NOT EXISTS (SELECT 1 FROM forwarded_email_receipts
    WHERE id = NEW.id AND user_id = NEW.user_id
      AND (state = 'queued' OR (state = 'storing' AND NEW.outcome = 'needs-review'))
      AND (expires_at_ms > NEW.outcome_completed_at_ms OR (NEW.outcome = 'needs-review'
        AND (NEW.review_id=NEW.outcome_review_id AND NEW.review_reason IN ('processing-interrupted','consent-revoked')))))
)
BEGIN SELECT RAISE(ABORT, 'forwarded_email_authority'); END;

CREATE TRIGGER consent_offer_kind_immutable BEFORE UPDATE OF kind ON consent_offers WHEN NEW.kind<>OLD.kind BEGIN SELECT RAISE(ABORT,'consent_offer_kind_immutable'); END;

CREATE INDEX consent_offers_user ON consent_offers(user_id,kind,created_at_ms);

CREATE UNIQUE INDEX weekly_consent_offer_source ON consent_offers(user_id,source_id) WHERE kind='weekly-summary' AND source_id IS NOT NULL;

CREATE UNIQUE INDEX consent_offer_replacement ON consent_offers(replaces_offer_id) WHERE kind<>'weekly-summary' AND replaces_offer_id IS NOT NULL;

CREATE UNIQUE INDEX consent_offer_decision_message ON consent_offers((kind='weekly-summary'),decision_message_id) WHERE decision_message_id IS NOT NULL;

CREATE UNIQUE INDEX consent_offer_weekly_disclosure ON consent_offers(disclosure_message_id) WHERE kind='weekly-summary' AND disclosure_message_id IS NOT NULL;

INSERT INTO sql_assertions(scope,accepted) SELECT 'migration_consent_offers',NOT EXISTS(SELECT 1 FROM pragma_foreign_key_check);

DELETE FROM sql_assertions WHERE scope='migration_consent_offers';

PRAGMA defer_foreign_keys=OFF;
