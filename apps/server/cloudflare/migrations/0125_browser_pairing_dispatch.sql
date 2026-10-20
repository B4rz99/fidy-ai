-- The current email proof owns its Queue identity and dispatch cooldown.
-- Superseded outbox identities have no delivery authority and need no retained row.
ALTER TABLE browser_pairing_email_proofs ADD COLUMN dispatch_attempted_at_ms INTEGER;

UPDATE browser_pairing_email_proofs SET dispatch_attempted_at_ms=(SELECT last_attempt_at_ms FROM browser_pairing_email_outbox WHERE id=browser_pairing_email_proofs.work_id);

DROP TRIGGER IF EXISTS erasure_fence_browser_pairing_email_outbox_insert;

DROP TRIGGER IF EXISTS erasure_fence_browser_pairing_email_outbox_update;

DROP TRIGGER IF EXISTS erasure_fence_browser_pairing_email_outbox_delete;

DROP TABLE browser_pairing_email_outbox;

CREATE INDEX browser_pairing_dispatch_due ON browser_pairing_email_proofs(dispatch_attempted_at_ms,last_requested_at_ms,work_id) WHERE state='awaiting_delivery';
