-- The replacement candidate owns its current Queue identity and dispatch cooldown.
ALTER TABLE email_replacements ADD COLUMN dispatch_attempted_at_ms INTEGER;

UPDATE email_replacements SET dispatch_attempted_at_ms=(SELECT last_attempt_at_ms FROM email_replacement_outbox WHERE id=email_replacements.work_id);

DROP TRIGGER IF EXISTS erasure_fence_email_replacement_outbox_insert;

DROP TRIGGER IF EXISTS erasure_fence_email_replacement_outbox_update;

DROP TRIGGER IF EXISTS erasure_fence_email_replacement_outbox_delete;

DROP TABLE email_replacement_outbox;

CREATE INDEX email_replacement_dispatch_due ON email_replacements(dispatch_attempted_at_ms,created_at_ms,work_id) WHERE state='awaiting_delivery';
