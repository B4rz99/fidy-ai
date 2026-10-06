-- Rotate retained reconciliation identities fairly through existing bounded Maintenance discovery.
ALTER TABLE budget_reconciliation_work ADD COLUMN last_evaluated_at_ms INTEGER NOT NULL DEFAULT 0;
