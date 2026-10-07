-- Historical snapshots without a captured Counterparty are permanently digest-ineligible.
-- Their immutable evidence is retained; no current label is substituted.
CREATE TABLE recurring_legacy_confirmations (
 user_id TEXT NOT NULL,
 confirmation_id TEXT NOT NULL,
 PRIMARY KEY(user_id,confirmation_id),
 FOREIGN KEY(user_id,confirmation_id) REFERENCES recurring_confirmations(user_id,id)
) STRICT;
INSERT INTO recurring_legacy_confirmations(user_id,confirmation_id)
 SELECT user_id,id FROM recurring_confirmations WHERE json_type(confirmation_json,'$.counterparty') IS NULL;
CREATE TRIGGER recurring_legacy_no_update BEFORE UPDATE ON recurring_legacy_confirmations
 BEGIN SELECT RAISE(ABORT,'recurring_legacy_immutable'); END;
CREATE TRIGGER recurring_legacy_no_delete BEFORE DELETE ON recurring_legacy_confirmations
 BEGIN SELECT RAISE(ABORT,'recurring_legacy_immutable'); END;
