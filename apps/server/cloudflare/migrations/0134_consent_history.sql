-- One typed append-only Consent history; permissions and current standing remain distinct.

PRAGMA defer_foreign_keys=ON;

DROP VIEW IF EXISTS "proactivity_delivery_metadata";

DROP TRIGGER IF EXISTS "provider_completion_requires_proof";

DROP TRIGGER IF EXISTS "erasure_preserve_processing_consent_renewals_delete";

DROP TRIGGER IF EXISTS "erasure_fence_processing_consent_renewals_delete";

DROP TRIGGER IF EXISTS "erasure_fence_processing_consent_renewals_update";

DROP TRIGGER IF EXISTS "erasure_fence_processing_consent_renewals_insert";

DROP TRIGGER IF EXISTS "processing_consent_renewals_no_delete";

DROP TRIGGER IF EXISTS "erasure_preserve_processing_consent_withdrawal_records_delete";

DROP TRIGGER IF EXISTS "erasure_fence_processing_consent_withdrawal_records_delete";

DROP TRIGGER IF EXISTS "erasure_fence_processing_consent_withdrawal_records_update";

DROP TRIGGER IF EXISTS "erasure_fence_processing_consent_withdrawal_records_insert";

DROP TRIGGER IF EXISTS "processing_consent_withdrawal_no_delete";

DROP TRIGGER IF EXISTS "consent_user_revocations_requires_renewal";

DROP TRIGGER IF EXISTS "erasure_preserve_weekly_consent_revocation_records_delete";

DROP TRIGGER IF EXISTS "erasure_preserve_weekly_consent_rejections_delete";

DROP TRIGGER IF EXISTS "erasure_preserve_weekly_consent_records_delete";

DROP TRIGGER IF EXISTS "erasure_preserve_proactivity_consent_records_delete";

DROP TRIGGER IF EXISTS "erasure_preserve_pat_revocation_consents_delete";

DROP TRIGGER IF EXISTS "erasure_preserve_pat_grant_consents_delete";

DROP TRIGGER IF EXISTS "erasure_preserve_onboarding_consent_records_delete";

DROP TRIGGER IF EXISTS "erasure_preserve_oauth_user_revocation_consents_delete";

DROP TRIGGER IF EXISTS "erasure_preserve_oauth_revocation_consents_delete";

DROP TRIGGER IF EXISTS "erasure_preserve_oauth_grant_consents_delete";

DROP TRIGGER IF EXISTS "erasure_preserve_consent_user_revocations_delete";

DROP TRIGGER IF EXISTS "erasure_preserve_reminder_schedules_delete";

DROP TRIGGER IF EXISTS "erasure_preserve_reminder_occurrence_reports_delete";

DROP TRIGGER IF EXISTS "erasure_preserve_recurring_digest_instructions_delete";

DROP TRIGGER IF EXISTS "erasure_preserve_proactivity_reports_delete";

DROP TRIGGER IF EXISTS "erasure_fence_weekly_consent_revocation_records_delete";

DROP TRIGGER IF EXISTS "erasure_fence_weekly_consent_revocation_records_update";

DROP TRIGGER IF EXISTS "erasure_fence_weekly_consent_revocation_records_insert";

DROP TRIGGER IF EXISTS "erasure_fence_weekly_consent_rejections_delete";

DROP TRIGGER IF EXISTS "erasure_fence_weekly_consent_rejections_update";

DROP TRIGGER IF EXISTS "erasure_fence_weekly_consent_rejections_insert";

DROP TRIGGER IF EXISTS "erasure_fence_weekly_consent_records_delete";

DROP TRIGGER IF EXISTS "erasure_fence_weekly_consent_records_update";

DROP TRIGGER IF EXISTS "erasure_fence_weekly_consent_records_insert";

DROP TRIGGER IF EXISTS "erasure_fence_reminder_schedules_delete";

DROP TRIGGER IF EXISTS "erasure_fence_reminder_schedules_update";

DROP TRIGGER IF EXISTS "erasure_fence_reminder_schedules_insert";

DROP TRIGGER IF EXISTS "erasure_fence_reminder_occurrence_reports_delete";

DROP TRIGGER IF EXISTS "erasure_fence_reminder_occurrence_reports_update";

DROP TRIGGER IF EXISTS "erasure_fence_reminder_occurrence_reports_insert";

DROP TRIGGER IF EXISTS "erasure_fence_recurring_digest_instructions_delete";

DROP TRIGGER IF EXISTS "erasure_fence_recurring_digest_instructions_update";

DROP TRIGGER IF EXISTS "erasure_fence_recurring_digest_instructions_insert";

DROP TRIGGER IF EXISTS "erasure_fence_proactivity_reports_delete";

DROP TRIGGER IF EXISTS "erasure_fence_proactivity_reports_update";

DROP TRIGGER IF EXISTS "erasure_fence_proactivity_reports_insert";

DROP TRIGGER IF EXISTS "erasure_fence_proactivity_consent_records_delete";

DROP TRIGGER IF EXISTS "erasure_fence_proactivity_consent_records_update";

DROP TRIGGER IF EXISTS "erasure_fence_proactivity_consent_records_insert";

DROP TRIGGER IF EXISTS "erasure_fence_pat_revocation_consents_delete";

DROP TRIGGER IF EXISTS "erasure_fence_pat_revocation_consents_update";

DROP TRIGGER IF EXISTS "erasure_fence_pat_revocation_consents_insert";

DROP TRIGGER IF EXISTS "erasure_fence_pat_grant_consents_delete";

DROP TRIGGER IF EXISTS "erasure_fence_pat_grant_consents_update";

DROP TRIGGER IF EXISTS "erasure_fence_pat_grant_consents_insert";

DROP TRIGGER IF EXISTS "erasure_fence_onboarding_consent_records_delete";

DROP TRIGGER IF EXISTS "erasure_fence_onboarding_consent_records_update";

DROP TRIGGER IF EXISTS "erasure_fence_onboarding_consent_records_insert";

DROP TRIGGER IF EXISTS "erasure_fence_oauth_user_revocation_consents_delete";

DROP TRIGGER IF EXISTS "erasure_fence_oauth_user_revocation_consents_update";

DROP TRIGGER IF EXISTS "erasure_fence_oauth_user_revocation_consents_insert";

DROP TRIGGER IF EXISTS "erasure_fence_oauth_revocation_consents_delete";

DROP TRIGGER IF EXISTS "erasure_fence_oauth_revocation_consents_update";

DROP TRIGGER IF EXISTS "erasure_fence_oauth_revocation_consents_insert";

DROP TRIGGER IF EXISTS "erasure_fence_oauth_grant_consents_delete";

DROP TRIGGER IF EXISTS "erasure_fence_oauth_grant_consents_update";

DROP TRIGGER IF EXISTS "erasure_fence_oauth_grant_consents_insert";

DROP TRIGGER IF EXISTS "erasure_fence_consent_user_revocations_delete";

DROP TRIGGER IF EXISTS "erasure_fence_consent_user_revocations_update";

DROP TRIGGER IF EXISTS "erasure_fence_consent_user_revocations_insert";

DROP TRIGGER IF EXISTS "proactivity_consent_records_no_delete";

DROP TRIGGER IF EXISTS "weekly_consent_rejections_no_delete";

DROP TRIGGER IF EXISTS "weekly_consent_revocations_no_delete";

DROP TRIGGER IF EXISTS "oauth_user_revocation_no_delete";

DROP TRIGGER IF EXISTS "oauth_revocation_consents_no_delete";

DROP TRIGGER IF EXISTS "oauth_grant_consents_no_delete";

DROP TRIGGER IF EXISTS "weekly_consent_records_no_delete";

DROP TRIGGER IF EXISTS "pat_revocation_consents_no_delete";

DROP TRIGGER IF EXISTS "pat_grant_consents_no_delete";

DROP TRIGGER IF EXISTS "processing_consent_renewals_no_update";

DROP TRIGGER IF EXISTS "processing_consent_renewal_requires_authority";

DROP TRIGGER IF EXISTS "processing_consent_withdrawal_history";

DROP TRIGGER IF EXISTS "processing_consent_withdrawal_no_update";

DROP TRIGGER IF EXISTS "forwarded_email_outcome_consent";

DROP TRIGGER IF EXISTS "forwarded_email_publication_authority";

DROP TRIGGER IF EXISTS "proactivity_report_immutable";

DROP TRIGGER IF EXISTS "proactivity_consent_records_no_update";

DROP TRIGGER IF EXISTS "reminder_report_no_update";

DROP TRIGGER IF EXISTS "weekly_consent_rejections_no_update";

DROP TRIGGER IF EXISTS "weekly_consent_revocations_no_update";

DROP TRIGGER IF EXISTS "oauth_user_revocation_no_update";

DROP TRIGGER IF EXISTS "oauth_revocation_consents_no_update";

DROP TRIGGER IF EXISTS "oauth_grant_consents_no_update";

DROP TRIGGER IF EXISTS "weekly_consent_records_no_update";

DROP TRIGGER IF EXISTS "hosted_turn_requires_consent";

DROP TRIGGER IF EXISTS "forwarded_email_authority";

DROP TRIGGER IF EXISTS "issue_forwarding_address";

DROP TRIGGER IF EXISTS "consent_user_revocations_no_update";

DROP TRIGGER IF EXISTS "consent_user_revocation_requires_grant";

DROP TRIGGER IF EXISTS "pat_revocation_consents_no_update";

DROP TRIGGER IF EXISTS "pat_grant_consents_no_update";

CREATE TABLE consent_history (
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
 FOREIGN KEY (weekly_offer_reference) REFERENCES weekly_consent_offers(id),
 FOREIGN KEY (proactivity_offer_reference) REFERENCES proactivity_consent_offers(id)
) STRICT;

INSERT INTO consent_history(record_type,sequence,id,user_id,offer_id,decision_message_id,decision) SELECT 'weekly_rejection',sequence,id,user_id,offer_id,decision_message_id,decision FROM weekly_consent_rejections;

UPDATE sqlite_sequence SET seq=max(seq,coalesce((SELECT seq FROM sqlite_sequence WHERE name='weekly_consent_rejections'),0)) WHERE name='consent_history';

INSERT INTO consent_history(record_type,id,user_id,disclosure_json,disclosure_message_id,decision_message_id,decision_received_at_ms,accepted_at_ms) SELECT 'processing_grant',id,user_id,disclosure_json,disclosure_message_id,decision_message_id,decision_received_at_ms,accepted_at_ms FROM onboarding_consent_records;

INSERT INTO consent_history(record_type,id,user_id,grant_record_id,session_id,occurred_at_ms) SELECT 'processing_withdrawal',id,user_id,grant_record_id,session_id,occurred_at_ms FROM processing_consent_withdrawal_records;

INSERT INTO consent_history(record_type,id,user_id,withdrawal_id,grant_record_id,session_id,disclosure_json,accepted_at_ms) SELECT 'processing_renewal',id,user_id,withdrawal_id,grant_record_id,session_id,disclosure_json,accepted_at_ms FROM processing_consent_renewals;

INSERT INTO consent_history(record_type,id,user_id,grant_id,offer_id,record_json,occurred_at_ms) SELECT 'weekly_grant',id,user_id,grant_id,offer_id,record_json,occurred_at_ms FROM weekly_consent_records;

INSERT INTO consent_history(record_type,id,user_id,grant_id,offer_id,decision_message_id,decision,record_json,occurred_at_ms) SELECT 'weekly_revocation',id,user_id,grant_id,offer_id,decision_message_id,decision,record_json,occurred_at_ms FROM weekly_consent_revocation_records;

INSERT INTO consent_history(record_type,id,user_id,kind,grant_id,offer_id,decision_message_id,record_json,occurred_at_ms) SELECT 'proactivity_grant',id,user_id,kind,grant_id,offer_id,decision_message_id,record_json,occurred_at_ms FROM proactivity_consent_records;

INSERT INTO consent_history(record_type,id,user_id,session_id,pairing_id,request_id,disclosure_revision,disclosure_text,accepted_at_ms) SELECT 'pat_grant',id,user_id,session_id,pairing_id,request_id,disclosure_revision,disclosure_text,accepted_at_ms FROM pat_grant_consents;

INSERT INTO consent_history(record_type,id,grant_consent_id,user_id,pat_id,pairing_id,session_id,policy_reason,disclosure_revision,disclosure_text,occurred_at_ms) SELECT 'pat_revocation',id,grant_consent_id,user_id,pat_id,pairing_id,session_id,policy_reason,disclosure_revision,disclosure_text,occurred_at_ms FROM pat_revocation_consents;

INSERT INTO consent_history(record_type,id,connection_id,user_id,session_id,disclosure_revision,disclosure_text,accepted_at_ms) SELECT 'oauth_grant',id,connection_id,user_id,session_id,disclosure_revision,disclosure_text,accepted_at_ms FROM oauth_grant_consents;

INSERT INTO consent_history(record_type,id,user_id,connection_id,reason,occurred_at_ms) SELECT 'oauth_replay_revocation',id,user_id,connection_id,reason,occurred_at_ms FROM oauth_revocation_consents;

INSERT INTO consent_history(record_type,connection_id,user_id,session_id,reason,disclosure_revision,disclosure_text,occurred_at_ms) SELECT 'oauth_user_revocation',connection_id,user_id,session_id,reason,disclosure_revision,disclosure_text,occurred_at_ms FROM oauth_user_revocation_consents;

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

CREATE TABLE consent_user_revocations_next (
  id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL UNIQUE REFERENCES users(id),
  grant_record_id TEXT NOT NULL,
  session_id TEXT NOT NULL REFERENCES web_sessions(id),
  occurred_at_ms INTEGER NOT NULL,
 grant_record_id_history_type TEXT GENERATED ALWAYS AS ('processing_grant') VIRTUAL,
 FOREIGN KEY(user_id,grant_record_id_history_type,grant_record_id) REFERENCES consent_history(user_id,record_type,id)) STRICT;

INSERT INTO consent_user_revocations_next(id,user_id,grant_record_id,session_id,occurred_at_ms) SELECT id,user_id,grant_record_id,session_id,occurred_at_ms FROM consent_user_revocations;

DROP TABLE consent_user_revocations;

ALTER TABLE consent_user_revocations_next RENAME TO consent_user_revocations;

CREATE TABLE proactivity_reports_next (
 delivery_id TEXT PRIMARY KEY NOT NULL,
 user_id TEXT NOT NULL REFERENCES users(id),
 role TEXT NOT NULL CHECK(role IN ('budget-threshold','manual-entry-reminder','new-recurring-series','budget-offer','reminder-offer','recurring-offer','reminder-question')),
 consent_grant_id TEXT,
 offer_id TEXT,
 text TEXT,
 scheduled_at_ms INTEGER NOT NULL,
 expires_at_ms INTEGER NOT NULL,
 time_zone TEXT NOT NULL,
 created_at_ms INTEGER NOT NULL,
 consent_grant_id_history_type TEXT GENERATED ALWAYS AS ('proactivity_grant') VIRTUAL,
 UNIQUE(user_id,delivery_id),
 CHECK((role IN ('budget-offer','reminder-offer','recurring-offer') AND consent_grant_id IS NULL AND offer_id IS NOT NULL) OR (role NOT IN ('budget-offer','reminder-offer','recurring-offer') AND consent_grant_id IS NOT NULL AND offer_id IS NULL)),
 FOREIGN KEY(user_id,consent_grant_id_history_type,consent_grant_id) REFERENCES consent_history(user_id,record_type,id)) STRICT;

INSERT INTO proactivity_reports_next(delivery_id,user_id,role,consent_grant_id,offer_id,text,scheduled_at_ms,expires_at_ms,time_zone,created_at_ms) SELECT delivery_id,user_id,role,consent_grant_id,offer_id,text,scheduled_at_ms,expires_at_ms,time_zone,created_at_ms FROM proactivity_reports;

DROP TABLE proactivity_reports;

ALTER TABLE proactivity_reports_next RENAME TO proactivity_reports;

CREATE TABLE recurring_digest_instructions_next (
 user_id TEXT PRIMARY KEY NOT NULL REFERENCES users(id),
 id TEXT NOT NULL UNIQUE,
 version INTEGER NOT NULL CHECK(version>0),
 enabled INTEGER NOT NULL CHECK(enabled IN (0,1)),
 grant_id TEXT NOT NULL,
 context_json TEXT NOT NULL CHECK(json_valid(context_json)),
 acceptance_from_ms INTEGER NOT NULL,
 accepted_at_ms INTEGER NOT NULL,
 last_source_identity TEXT,
 next_closed_at_ms INTEGER,
 last_evaluated_at_ms INTEGER NOT NULL DEFAULT 0,
 grant_id_history_type TEXT GENERATED ALWAYS AS ('proactivity_grant') VIRTUAL,
 FOREIGN KEY(user_id,grant_id_history_type,grant_id) REFERENCES consent_history(user_id,record_type,id)) STRICT;

INSERT INTO recurring_digest_instructions_next(user_id,id,version,enabled,grant_id,context_json,acceptance_from_ms,accepted_at_ms,last_source_identity,next_closed_at_ms,last_evaluated_at_ms) SELECT user_id,id,version,enabled,grant_id,context_json,acceptance_from_ms,accepted_at_ms,last_source_identity,next_closed_at_ms,last_evaluated_at_ms FROM recurring_digest_instructions;

DROP TABLE recurring_digest_instructions;

ALTER TABLE recurring_digest_instructions_next RENAME TO recurring_digest_instructions;

CREATE TABLE reminder_occurrence_reports_next (
 user_id TEXT NOT NULL,
 insight_event_id TEXT NOT NULL,
 consent_grant_id TEXT NOT NULL,
 expires_at_ms INTEGER NOT NULL,
 consent_grant_id_history_type TEXT GENERATED ALWAYS AS ('proactivity_grant') VIRTUAL,
 PRIMARY KEY(user_id,insight_event_id),
 FOREIGN KEY(user_id,insight_event_id) REFERENCES insight_events(user_id,id),
 FOREIGN KEY(user_id,consent_grant_id_history_type,consent_grant_id) REFERENCES consent_history(user_id,record_type,id)) STRICT;

INSERT INTO reminder_occurrence_reports_next(user_id,insight_event_id,consent_grant_id,expires_at_ms) SELECT user_id,insight_event_id,consent_grant_id,expires_at_ms FROM reminder_occurrence_reports;

DROP TABLE reminder_occurrence_reports;

ALTER TABLE reminder_occurrence_reports_next RENAME TO reminder_occurrence_reports;

CREATE TABLE reminder_schedules_next (
 id TEXT PRIMARY KEY NOT NULL,
 user_id TEXT NOT NULL UNIQUE REFERENCES users(id),
 version INTEGER NOT NULL CHECK(version>0),
 enabled INTEGER NOT NULL CHECK(enabled IN (0,1)),
 snapshot_json TEXT NOT NULL CHECK(json_valid(snapshot_json)),
 next_scheduled_at TEXT NOT NULL,
 consent_grant_id TEXT NOT NULL,
 last_evaluated_at_ms INTEGER NOT NULL DEFAULT 0,
 consent_grant_id_history_type TEXT GENERATED ALWAYS AS ('proactivity_grant') VIRTUAL,
 UNIQUE(user_id,id),
 FOREIGN KEY(user_id,consent_grant_id_history_type,consent_grant_id) REFERENCES consent_history(user_id,record_type,id)) STRICT;

INSERT INTO reminder_schedules_next(id,user_id,version,enabled,snapshot_json,next_scheduled_at,consent_grant_id,last_evaluated_at_ms) SELECT id,user_id,version,enabled,snapshot_json,next_scheduled_at,consent_grant_id,last_evaluated_at_ms FROM reminder_schedules;

DROP TABLE reminder_schedules;

ALTER TABLE reminder_schedules_next RENAME TO reminder_schedules;

CREATE INDEX reminder_schedules_due ON reminder_schedules(enabled,last_evaluated_at_ms,next_scheduled_at);

DROP TABLE oauth_user_revocation_consents;

DROP TABLE oauth_revocation_consents;

DROP TABLE oauth_grant_consents;

DROP TABLE pat_revocation_consents;

DROP TABLE pat_grant_consents;

DROP TABLE proactivity_consent_records;

DROP TABLE weekly_consent_revocation_records;

DROP TABLE weekly_consent_rejections;

DROP TABLE weekly_consent_records;

DROP TABLE processing_consent_renewals;

DROP TABLE processing_consent_withdrawal_records;

DROP TABLE onboarding_consent_records;

CREATE TRIGGER consent_user_revocation_requires_grant BEFORE INSERT ON consent_user_revocations
WHEN NOT EXISTS (
  SELECT 1 FROM (SELECT * FROM consent_history WHERE record_type='processing_grant') AS g
  JOIN web_sessions AS w ON w.user_id = g.user_id
  WHERE g.id = NEW.grant_record_id AND g.user_id = NEW.user_id
    AND w.id = NEW.session_id AND w.revoked_at_ms IS NULL
    AND w.idle_expires_at_ms > NEW.occurred_at_ms AND w.hard_expires_at_ms > NEW.occurred_at_ms
)
BEGIN SELECT RAISE(ABORT, 'consent_revocation_requires_user_session'); END;

CREATE TRIGGER consent_user_revocations_no_update BEFORE UPDATE ON consent_user_revocations
BEGIN SELECT RAISE(ABORT, 'consent_append_only'); END;

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

CREATE TRIGGER forwarded_email_authority BEFORE INSERT ON forwarded_email_receipts
WHEN NOT EXISTS (SELECT 1 FROM (SELECT * FROM consent_history WHERE record_type='processing_grant') AS onboarding_consent_records WHERE user_id = NEW.user_id)
  OR EXISTS (SELECT 1 FROM consent_user_revocations WHERE user_id = NEW.user_id)
BEGIN SELECT RAISE(ABORT, 'forwarded_email_consent'); END;

CREATE TRIGGER hosted_turn_requires_consent BEFORE INSERT ON hosted_turns
WHEN NOT EXISTS (SELECT 1 FROM (SELECT * FROM consent_history WHERE record_type='processing_grant') AS onboarding_consent_records WHERE user_id = NEW.user_id)
  OR EXISTS (SELECT 1 FROM consent_user_revocations WHERE user_id = NEW.user_id)
BEGIN SELECT RAISE(ABORT, 'hosted_turn_consent_required'); END;

CREATE TRIGGER reminder_report_no_update BEFORE UPDATE ON reminder_occurrence_reports
BEGIN SELECT RAISE(ABORT,'reminder_occurrence_immutable'); END;

CREATE TRIGGER proactivity_report_immutable BEFORE UPDATE ON proactivity_reports
WHEN NOT (OLD.text IS NOT NULL AND NEW.text IS NULL AND NEW.delivery_id=OLD.delivery_id AND NEW.user_id=OLD.user_id AND NEW.role=OLD.role AND NEW.consent_grant_id IS OLD.consent_grant_id AND NEW.offer_id IS OLD.offer_id AND NEW.scheduled_at_ms=OLD.scheduled_at_ms AND NEW.expires_at_ms=OLD.expires_at_ms AND NEW.time_zone=OLD.time_zone AND NEW.created_at_ms=OLD.created_at_ms)
BEGIN SELECT RAISE(ABORT,'proactivity_report_immutable'); END;

CREATE TRIGGER forwarded_email_publication_authority BEFORE UPDATE OF state ON forwarded_email_receipts
WHEN NEW.state = 'queued' AND (
  NOT EXISTS (SELECT 1 FROM (SELECT * FROM consent_history WHERE record_type='processing_grant') AS onboarding_consent_records WHERE user_id = NEW.user_id)
  OR (OLD.state <> 'queued' AND EXISTS
    (SELECT 1 FROM consent_user_revocations WHERE user_id = NEW.user_id)))
BEGIN SELECT RAISE(ABORT, 'forwarded_email_consent'); END;

CREATE TRIGGER forwarded_email_outcome_consent BEFORE INSERT ON forwarded_email_outcomes
WHEN (NEW.outcome <> 'needs-review' OR NOT EXISTS
    (SELECT 1 FROM forwarded_email_needs_review e WHERE e.id = NEW.review_id
      AND e.reason = 'consent-revoked')) AND (
  NOT EXISTS (SELECT 1 FROM (SELECT * FROM consent_history WHERE record_type='processing_grant') AS onboarding_consent_records WHERE user_id = NEW.user_id)
  OR (EXISTS (SELECT 1 FROM consent_user_revocations WHERE user_id = NEW.user_id)
    AND NOT EXISTS (SELECT 1 FROM forwarded_email_receipts
      WHERE id = NEW.receipt_id AND user_id = NEW.user_id AND state = 'queued'
        AND expires_at_ms > NEW.completed_at_ms)))
  OR (EXISTS (SELECT 1 FROM forwarded_email_needs_review e
    WHERE e.id = NEW.review_id AND e.reason = 'consent-revoked')
    AND NOT EXISTS (SELECT 1 FROM consent_user_revocations WHERE user_id = NEW.user_id))
  OR NOT EXISTS (SELECT 1 FROM forwarded_email_receipts
    WHERE id = NEW.receipt_id AND user_id = NEW.user_id
      AND (state = 'queued' OR (state = 'storing' AND NEW.outcome = 'needs-review'))
      AND (expires_at_ms > NEW.completed_at_ms OR (NEW.outcome = 'needs-review'
        AND EXISTS (SELECT 1 FROM forwarded_email_needs_review e
          WHERE e.id = NEW.review_id AND e.reason IN ('processing-interrupted', 'consent-revoked')))))
BEGIN SELECT RAISE(ABORT, 'forwarded_email_authority'); END;

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

CREATE TRIGGER erasure_fence_consent_user_revocations_insert BEFORE INSERT ON consent_user_revocations
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND (NEW.user_id=q.user_id) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='consent_user_revocations'))
BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;

CREATE TRIGGER erasure_fence_consent_user_revocations_update BEFORE UPDATE ON consent_user_revocations
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND ((NEW.user_id=q.user_id) OR (OLD.user_id=q.user_id)) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='consent_user_revocations'))
BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;

CREATE TRIGGER erasure_fence_consent_user_revocations_delete BEFORE DELETE ON consent_user_revocations
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND (OLD.user_id=q.user_id) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='consent_user_revocations'))
BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;

CREATE TRIGGER erasure_fence_proactivity_reports_insert BEFORE INSERT ON proactivity_reports
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND (NEW.user_id=q.user_id) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='proactivity_reports'))
BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;

CREATE TRIGGER erasure_fence_proactivity_reports_update BEFORE UPDATE ON proactivity_reports
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND ((NEW.user_id=q.user_id) OR (OLD.user_id=q.user_id)) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='proactivity_reports'))
BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;

CREATE TRIGGER erasure_fence_proactivity_reports_delete BEFORE DELETE ON proactivity_reports
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND (OLD.user_id=q.user_id) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='proactivity_reports'))
BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;

CREATE TRIGGER erasure_fence_recurring_digest_instructions_insert BEFORE INSERT ON recurring_digest_instructions
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND (NEW.user_id=q.user_id) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='recurring_digest_instructions'))
BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;

CREATE TRIGGER erasure_fence_recurring_digest_instructions_update BEFORE UPDATE ON recurring_digest_instructions
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND ((NEW.user_id=q.user_id) OR (OLD.user_id=q.user_id)) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='recurring_digest_instructions'))
BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;

CREATE TRIGGER erasure_fence_recurring_digest_instructions_delete BEFORE DELETE ON recurring_digest_instructions
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND (OLD.user_id=q.user_id) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='recurring_digest_instructions'))
BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;

CREATE TRIGGER erasure_fence_reminder_occurrence_reports_insert BEFORE INSERT ON reminder_occurrence_reports
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND (NEW.user_id=q.user_id) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='reminder_occurrence_reports'))
BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;

CREATE TRIGGER erasure_fence_reminder_occurrence_reports_update BEFORE UPDATE ON reminder_occurrence_reports
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND ((NEW.user_id=q.user_id) OR (OLD.user_id=q.user_id)) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='reminder_occurrence_reports'))
BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;

CREATE TRIGGER erasure_fence_reminder_occurrence_reports_delete BEFORE DELETE ON reminder_occurrence_reports
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND (OLD.user_id=q.user_id) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='reminder_occurrence_reports'))
BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;

CREATE TRIGGER erasure_fence_reminder_schedules_insert BEFORE INSERT ON reminder_schedules
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND (NEW.user_id=q.user_id) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='reminder_schedules'))
BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;

CREATE TRIGGER erasure_fence_reminder_schedules_update BEFORE UPDATE ON reminder_schedules
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND ((NEW.user_id=q.user_id) OR (OLD.user_id=q.user_id)) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='reminder_schedules'))
BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;

CREATE TRIGGER erasure_fence_reminder_schedules_delete BEFORE DELETE ON reminder_schedules
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND (OLD.user_id=q.user_id) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='reminder_schedules'))
BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;

CREATE TRIGGER erasure_preserve_proactivity_reports_delete BEFORE DELETE ON proactivity_reports
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id)
  AND json_extract(q.decision_json,'$.dispositions.schedules.action')='Retain'
  AND json_extract(q.decision_json,'$.dispositions.schedules.retention.untilMs')>unixepoch('subsec')*1000)
BEGIN
  INSERT INTO erasure_archives(request_id,store_id,row_ref,body)
  SELECT q.id,'proactivity_reports','drain:'||lower(hex(randomblob(16))),json_object('delivery_id',OLD."delivery_id",'user_id',OLD."user_id",'role',OLD."role",'consent_grant_id',OLD."consent_grant_id",'offer_id',OLD."offer_id",'text',OLD."text",'scheduled_at_ms',OLD."scheduled_at_ms",'expires_at_ms',OLD."expires_at_ms",'time_zone',OLD."time_zone",'created_at_ms',OLD."created_at_ms")
  FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id)
    AND json_extract(q.decision_json,'$.dispositions.schedules.action')='Retain'
    AND json_extract(q.decision_json,'$.dispositions.schedules.retention.untilMs')>unixepoch('subsec')*1000;
END;

CREATE TRIGGER erasure_preserve_recurring_digest_instructions_delete BEFORE DELETE ON recurring_digest_instructions
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id)
  AND json_extract(q.decision_json,'$.dispositions.schedules.action')='Retain'
  AND json_extract(q.decision_json,'$.dispositions.schedules.retention.untilMs')>unixepoch('subsec')*1000)
BEGIN
  INSERT INTO erasure_archives(request_id,store_id,row_ref,body)
  SELECT q.id,'recurring_digest_instructions','drain:'||lower(hex(randomblob(16))),json_object('user_id',OLD."user_id",'id',OLD."id",'version',OLD."version",'enabled',OLD."enabled",'grant_id',OLD."grant_id",'context_json',OLD."context_json",'acceptance_from_ms',OLD."acceptance_from_ms",'accepted_at_ms',OLD."accepted_at_ms",'last_source_identity',OLD."last_source_identity",'next_closed_at_ms',OLD."next_closed_at_ms",'last_evaluated_at_ms',OLD."last_evaluated_at_ms")
  FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id)
    AND json_extract(q.decision_json,'$.dispositions.schedules.action')='Retain'
    AND json_extract(q.decision_json,'$.dispositions.schedules.retention.untilMs')>unixepoch('subsec')*1000;
END;

CREATE TRIGGER erasure_preserve_reminder_occurrence_reports_delete BEFORE DELETE ON reminder_occurrence_reports
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id)
  AND json_extract(q.decision_json,'$.dispositions.schedules.action')='Retain'
  AND json_extract(q.decision_json,'$.dispositions.schedules.retention.untilMs')>unixepoch('subsec')*1000)
BEGIN
  INSERT INTO erasure_archives(request_id,store_id,row_ref,body)
  SELECT q.id,'reminder_occurrence_reports','drain:'||lower(hex(randomblob(16))),json_object('user_id',OLD."user_id",'insight_event_id',OLD."insight_event_id",'consent_grant_id',OLD."consent_grant_id",'expires_at_ms',OLD."expires_at_ms")
  FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id)
    AND json_extract(q.decision_json,'$.dispositions.schedules.action')='Retain'
    AND json_extract(q.decision_json,'$.dispositions.schedules.retention.untilMs')>unixepoch('subsec')*1000;
END;

CREATE TRIGGER erasure_preserve_reminder_schedules_delete BEFORE DELETE ON reminder_schedules
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id)
  AND json_extract(q.decision_json,'$.dispositions.schedules.action')='Retain'
  AND json_extract(q.decision_json,'$.dispositions.schedules.retention.untilMs')>unixepoch('subsec')*1000)
BEGIN
  INSERT INTO erasure_archives(request_id,store_id,row_ref,body)
  SELECT q.id,'reminder_schedules','drain:'||lower(hex(randomblob(16))),json_object('id',OLD."id",'user_id',OLD."user_id",'version',OLD."version",'enabled',OLD."enabled",'snapshot_json',OLD."snapshot_json",'next_scheduled_at',OLD."next_scheduled_at",'consent_grant_id',OLD."consent_grant_id",'last_evaluated_at_ms',OLD."last_evaluated_at_ms")
  FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id)
    AND json_extract(q.decision_json,'$.dispositions.schedules.action')='Retain'
    AND json_extract(q.decision_json,'$.dispositions.schedules.retention.untilMs')>unixepoch('subsec')*1000;
END;

CREATE TRIGGER erasure_preserve_consent_user_revocations_delete BEFORE DELETE ON consent_user_revocations
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id)
  AND json_extract(q.decision_json,'$.dispositions.consent.action')='Retain'
  AND json_extract(q.decision_json,'$.dispositions.consent.retention.untilMs')>unixepoch('subsec')*1000)
BEGIN
  INSERT INTO erasure_archives(request_id,store_id,row_ref,body)
  SELECT q.id,'consent_user_revocations','drain:'||lower(hex(randomblob(16))),json_object('id',OLD."id",'user_id',OLD."user_id",'grant_record_id',OLD."grant_record_id",'session_id',OLD."session_id",'occurred_at_ms',OLD."occurred_at_ms")
  FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id)
    AND json_extract(q.decision_json,'$.dispositions.consent.action')='Retain'
    AND json_extract(q.decision_json,'$.dispositions.consent.retention.untilMs')>unixepoch('subsec')*1000;
END;

CREATE TRIGGER consent_user_revocations_requires_renewal BEFORE DELETE ON consent_user_revocations
WHEN NOT EXISTS (SELECT 1 FROM (SELECT * FROM consent_history WHERE record_type='processing_renewal') n WHERE n.withdrawal_id=OLD.id AND n.user_id=OLD.user_id AND n.grant_record_id=OLD.grant_record_id)
AND NOT EXISTS(SELECT 1 FROM erasure_permits p JOIN erasure_requests q ON q.id=p.request_id WHERE p.store_id='consent_user_revocations' AND p.user_id=q.user_id AND q.state='Erasing' AND OLD.user_id=p.user_id)
BEGIN SELECT RAISE(ABORT,'consent_renewal_required'); END;

CREATE TRIGGER provider_completion_requires_proof BEFORE INSERT ON completed_provider_authentications
WHEN NOT EXISTS (
 SELECT 1 FROM provider_authentication_attempts a
 JOIN provider_credentials c ON c.issuer=a.issuer AND c.subject=a.subject AND c.user_id=NEW.user_id
 JOIN browser_login_pairings p ON p.id=a.pairing_id AND p.state='ready' AND p.user_id=NEW.user_id
 WHERE a.id=NEW.attempt_id AND a.state='verified'
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

CREATE VIEW proactivity_delivery_metadata AS
 SELECT o.user_id,o.kind,o.delivery_id,o.state,o.created_at_ms,o.last_attempt_at_ms,o.restart_attempts,
   r.expires_at_ms,1 AS content_available
 FROM proactivity_delivery_outbox o JOIN weekly_summary_reports r ON r.user_id=o.user_id AND r.insight_event_id=o.delivery_id
 WHERE o.kind='weekly-summary'
 UNION ALL
 SELECT o.user_id,o.kind,o.delivery_id,o.state,o.created_at_ms,o.last_attempt_at_ms,o.restart_attempts,
   r.expires_at_ms,(r.text IS NOT NULL) AS content_available
 FROM proactivity_delivery_outbox o JOIN proactivity_reports r ON r.user_id=o.user_id AND r.delivery_id=o.delivery_id
 WHERE o.kind='proactivity-delivery';

CREATE TRIGGER consent_history_no_update BEFORE UPDATE ON consent_history BEGIN SELECT RAISE(ABORT,'consent_history_immutable'); END;

CREATE TRIGGER consent_history_no_delete BEFORE DELETE ON consent_history WHEN NOT EXISTS(SELECT 1 FROM erasure_permits p JOIN erasure_requests q ON q.id=p.request_id WHERE p.user_id=OLD.user_id AND q.user_id=OLD.user_id AND q.state='Erasing' AND p.store_id=(CASE OLD.record_type WHEN 'processing_grant' THEN 'onboarding_consent_records' WHEN 'processing_withdrawal' THEN 'processing_consent_withdrawal_records' WHEN 'processing_renewal' THEN 'processing_consent_renewals' WHEN 'weekly_grant' THEN 'weekly_consent_records' WHEN 'weekly_rejection' THEN 'weekly_consent_rejections' WHEN 'weekly_revocation' THEN 'weekly_consent_revocation_records' WHEN 'proactivity_grant' THEN 'proactivity_consent_records' WHEN 'pat_grant' THEN 'pat_grant_consents' WHEN 'pat_revocation' THEN 'pat_revocation_consents' WHEN 'oauth_grant' THEN 'oauth_grant_consents' WHEN 'oauth_replay_revocation' THEN 'oauth_revocation_consents' WHEN 'oauth_user_revocation' THEN 'oauth_user_revocation_consents' END)) BEGIN SELECT RAISE(ABORT,'consent_history_retention_required'); END;

CREATE TRIGGER erasure_fence_consent_history_insert BEFORE INSERT ON consent_history WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE (q.state NOT IN('AwaitingReview','Draining') OR (NEW.record_type='processing_renewal' AND q.state='Draining')) AND NEW.user_id=q.user_id AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.request_id=q.id AND p.user_id=q.user_id AND p.store_id=(CASE NEW.record_type WHEN 'processing_grant' THEN 'onboarding_consent_records' WHEN 'processing_withdrawal' THEN 'processing_consent_withdrawal_records' WHEN 'processing_renewal' THEN 'processing_consent_renewals' WHEN 'weekly_grant' THEN 'weekly_consent_records' WHEN 'weekly_rejection' THEN 'weekly_consent_rejections' WHEN 'weekly_revocation' THEN 'weekly_consent_revocation_records' WHEN 'proactivity_grant' THEN 'proactivity_consent_records' WHEN 'pat_grant' THEN 'pat_grant_consents' WHEN 'pat_revocation' THEN 'pat_revocation_consents' WHEN 'oauth_grant' THEN 'oauth_grant_consents' WHEN 'oauth_replay_revocation' THEN 'oauth_revocation_consents' WHEN 'oauth_user_revocation' THEN 'oauth_user_revocation_consents' END))) BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;

CREATE TRIGGER erasure_fence_consent_history_update BEFORE UPDATE ON consent_history WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND (NEW.user_id=q.user_id OR OLD.user_id=q.user_id) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.request_id=q.id AND p.user_id=q.user_id AND p.store_id=(CASE NEW.record_type WHEN 'processing_grant' THEN 'onboarding_consent_records' WHEN 'processing_withdrawal' THEN 'processing_consent_withdrawal_records' WHEN 'processing_renewal' THEN 'processing_consent_renewals' WHEN 'weekly_grant' THEN 'weekly_consent_records' WHEN 'weekly_rejection' THEN 'weekly_consent_rejections' WHEN 'weekly_revocation' THEN 'weekly_consent_revocation_records' WHEN 'proactivity_grant' THEN 'proactivity_consent_records' WHEN 'pat_grant' THEN 'pat_grant_consents' WHEN 'pat_revocation' THEN 'pat_revocation_consents' WHEN 'oauth_grant' THEN 'oauth_grant_consents' WHEN 'oauth_replay_revocation' THEN 'oauth_revocation_consents' WHEN 'oauth_user_revocation' THEN 'oauth_user_revocation_consents' END))) BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;

CREATE TRIGGER erasure_fence_consent_history_delete BEFORE DELETE ON consent_history WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND OLD.user_id=q.user_id AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.request_id=q.id AND p.user_id=q.user_id AND p.store_id=(CASE OLD.record_type WHEN 'processing_grant' THEN 'onboarding_consent_records' WHEN 'processing_withdrawal' THEN 'processing_consent_withdrawal_records' WHEN 'processing_renewal' THEN 'processing_consent_renewals' WHEN 'weekly_grant' THEN 'weekly_consent_records' WHEN 'weekly_rejection' THEN 'weekly_consent_rejections' WHEN 'weekly_revocation' THEN 'weekly_consent_revocation_records' WHEN 'proactivity_grant' THEN 'proactivity_consent_records' WHEN 'pat_grant' THEN 'pat_grant_consents' WHEN 'pat_revocation' THEN 'pat_revocation_consents' WHEN 'oauth_grant' THEN 'oauth_grant_consents' WHEN 'oauth_replay_revocation' THEN 'oauth_revocation_consents' WHEN 'oauth_user_revocation' THEN 'oauth_user_revocation_consents' END))) BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;

CREATE TRIGGER erasure_preserve_consent_history_delete BEFORE DELETE ON consent_history WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state='Draining' AND q.user_id=OLD.user_id AND json_extract(q.decision_json,'$.dispositions.consent.action')='Retain' AND json_extract(q.decision_json,'$.dispositions.consent.retention.untilMs')>unixepoch('subsec')*1000) BEGIN INSERT INTO erasure_archives(request_id,store_id,row_ref,body) SELECT q.id,CASE OLD.record_type WHEN 'processing_grant' THEN 'onboarding_consent_records' WHEN 'processing_withdrawal' THEN 'processing_consent_withdrawal_records' WHEN 'processing_renewal' THEN 'processing_consent_renewals' WHEN 'weekly_grant' THEN 'weekly_consent_records' WHEN 'weekly_rejection' THEN 'weekly_consent_rejections' WHEN 'weekly_revocation' THEN 'weekly_consent_revocation_records' WHEN 'proactivity_grant' THEN 'proactivity_consent_records' WHEN 'pat_grant' THEN 'pat_grant_consents' WHEN 'pat_revocation' THEN 'pat_revocation_consents' WHEN 'oauth_grant' THEN 'oauth_grant_consents' WHEN 'oauth_replay_revocation' THEN 'oauth_revocation_consents' WHEN 'oauth_user_revocation' THEN 'oauth_user_revocation_consents' END,'drain:'||lower(hex(randomblob(16))),CASE OLD.record_type WHEN 'processing_grant' THEN json_object('id',OLD."id",'user_id',OLD."user_id",'disclosure_json',OLD."disclosure_json",'disclosure_message_id',OLD."disclosure_message_id",'decision_message_id',OLD."decision_message_id",'decision_received_at_ms',OLD."decision_received_at_ms",'accepted_at_ms',OLD."accepted_at_ms") WHEN 'processing_withdrawal' THEN json_object('id',OLD."id",'user_id',OLD."user_id",'grant_record_id',OLD."grant_record_id",'session_id',OLD."session_id",'occurred_at_ms',OLD."occurred_at_ms") WHEN 'processing_renewal' THEN json_object('id',OLD."id",'user_id',OLD."user_id",'withdrawal_id',OLD."withdrawal_id",'grant_record_id',OLD."grant_record_id",'session_id',OLD."session_id",'disclosure_json',OLD."disclosure_json",'accepted_at_ms',OLD."accepted_at_ms") WHEN 'weekly_grant' THEN json_object('id',OLD."id",'user_id',OLD."user_id",'grant_id',OLD."grant_id",'offer_id',OLD."offer_id",'record_json',OLD."record_json",'occurred_at_ms',OLD."occurred_at_ms") WHEN 'weekly_rejection' THEN json_object('sequence',OLD."sequence",'id',OLD."id",'user_id',OLD."user_id",'offer_id',OLD."offer_id",'decision_message_id',OLD."decision_message_id",'decision',OLD."decision") WHEN 'weekly_revocation' THEN json_object('id',OLD."id",'user_id',OLD."user_id",'grant_id',OLD."grant_id",'offer_id',OLD."offer_id",'decision_message_id',OLD."decision_message_id",'decision',OLD."decision",'record_json',OLD."record_json",'occurred_at_ms',OLD."occurred_at_ms") WHEN 'proactivity_grant' THEN json_object('id',OLD."id",'user_id',OLD."user_id",'kind',OLD."kind",'grant_id',OLD."grant_id",'offer_id',OLD."offer_id",'decision_message_id',OLD."decision_message_id",'record_json',OLD."record_json",'occurred_at_ms',OLD."occurred_at_ms") WHEN 'pat_grant' THEN json_object('id',OLD."id",'user_id',OLD."user_id",'session_id',OLD."session_id",'pairing_id',OLD."pairing_id",'request_id',OLD."request_id",'disclosure_revision',OLD."disclosure_revision",'disclosure_text',OLD."disclosure_text",'accepted_at_ms',OLD."accepted_at_ms") WHEN 'pat_revocation' THEN json_object('id',OLD."id",'grant_consent_id',OLD."grant_consent_id",'user_id',OLD."user_id",'pat_id',OLD."pat_id",'pairing_id',OLD."pairing_id",'session_id',OLD."session_id",'policy_reason',OLD."policy_reason",'disclosure_revision',OLD."disclosure_revision",'disclosure_text',OLD."disclosure_text",'occurred_at_ms',OLD."occurred_at_ms") WHEN 'oauth_grant' THEN json_object('id',OLD."id",'connection_id',OLD."connection_id",'user_id',OLD."user_id",'session_id',OLD."session_id",'disclosure_revision',OLD."disclosure_revision",'disclosure_text',OLD."disclosure_text",'accepted_at_ms',OLD."accepted_at_ms") WHEN 'oauth_replay_revocation' THEN json_object('id',OLD."id",'user_id',OLD."user_id",'connection_id',OLD."connection_id",'reason',OLD."reason",'occurred_at_ms',OLD."occurred_at_ms") WHEN 'oauth_user_revocation' THEN json_object('connection_id',OLD."connection_id",'user_id',OLD."user_id",'session_id',OLD."session_id",'reason',OLD."reason",'disclosure_revision',OLD."disclosure_revision",'disclosure_text',OLD."disclosure_text",'occurred_at_ms',OLD."occurred_at_ms") END FROM erasure_requests q WHERE q.state='Draining' AND q.user_id=OLD.user_id AND json_extract(q.decision_json,'$.dispositions.consent.action')='Retain' AND json_extract(q.decision_json,'$.dispositions.consent.retention.untilMs')>unixepoch('subsec')*1000; END;

-- Rebuilt relations must satisfy every retained foreign key before deferred counters reset.
INSERT INTO sql_assertions(scope,accepted)
SELECT 'migration_consent_history',NOT EXISTS(SELECT 1 FROM pragma_foreign_key_check);

DELETE FROM sql_assertions WHERE scope='migration_consent_history';

PRAGMA defer_foreign_keys=OFF;
