-- Retire superseded pre-User mailbox-code signup state.
DROP TABLE completed_email_enrollments;
DROP TABLE onboarding_email_outbox;
DROP TABLE pending_email_enrollments;
ALTER TABLE pending_consent_exchanges DROP COLUMN email_status_attempts;
ALTER TABLE pending_consent_exchanges DROP COLUMN email_status_last_ms;
ALTER TABLE pending_consent_exchanges DROP COLUMN email_preaccept_latest_occurred_ms;
