DROP TRIGGER budget_correction_work;
--> statement-breakpoint

CREATE TRIGGER budget_correction_work AFTER UPDATE ON transactions
-- Linked correction recency can change selected movement facts even for a descriptive correction.
WHEN (NEW.id IS NOT OLD.id OR NEW.user_id IS NOT OLD.user_id OR NEW.amount IS NOT OLD.amount OR NEW.currency IS NOT OLD.currency OR NEW.direction IS NOT OLD.direction OR NEW.category_id IS NOT OLD.category_id OR NEW.occurred_at_ms IS NOT OLD.occurred_at_ms OR NEW.created_at_ms IS NOT OLD.created_at_ms OR NEW.deleted_at_ms IS NOT OLD.deleted_at_ms OR (NEW.reconciliation_first_id IS NOT NULL AND (NEW.counterparty IS NOT OLD.counterparty OR NEW.notes IS NOT OLD.notes OR NEW.revision IS NOT OLD.revision OR NEW.user_decisions IS NOT OLD.user_decisions))) AND EXISTS (SELECT 1 FROM budgets WHERE user_id = NEW.user_id)
BEGIN INSERT INTO budget_evaluation_work(user_id,occurred_at_ms) VALUES(NEW.user_id,NEW.occurred_at_ms)
  ON CONFLICT(user_id,occurred_at_ms) DO UPDATE SET version = version + 1;
  INSERT INTO budget_evaluation_work(user_id,occurred_at_ms) VALUES(OLD.user_id,OLD.occurred_at_ms)
  ON CONFLICT(user_id,occurred_at_ms) DO UPDATE SET version = version + 1; END;

--> statement-breakpoint

DROP TRIGGER transaction_projection_corrected_source;
--> statement-breakpoint

CREATE TRIGGER transaction_projection_corrected_source AFTER INSERT ON transaction_corrections
WHEN EXISTS (SELECT 1 FROM transactions
  WHERE user_id = NEW.user_id AND id = NEW.transaction_id AND reconciliation_first_id IS NOT NULL)
BEGIN
  DELETE FROM transaction_projection_leaf WHERE user_id = NEW.user_id
    AND id IN (NEW.transaction_id, (SELECT decision.visible_transaction_id
      FROM reconciled_transactions member
      JOIN transaction_reconciliation_decisions decision
        ON decision.user_id = member.user_id
        AND decision.first_transaction_id = member.first_transaction_id
        AND decision.second_transaction_id = member.second_transaction_id
      WHERE member.user_id = NEW.user_id AND member.transaction_id = NEW.transaction_id));
  INSERT INTO transaction_projection_leaf
    (user_id, id, amount, currency, direction, category_id, counterparty, notes,
      occurred_at_ms, created_at_ms, revision)
  SELECT user_id, id, amount, currency, direction, category_id, counterparty, notes,
    occurred_at_ms, created_at_ms, revision
    FROM transaction_effective_source WHERE user_id = NEW.user_id
      AND id IN (NEW.transaction_id, (SELECT decision.visible_transaction_id
        FROM reconciled_transactions member
        JOIN transaction_reconciliation_decisions decision
          ON decision.user_id = member.user_id
          AND decision.first_transaction_id = member.first_transaction_id
          AND decision.second_transaction_id = member.second_transaction_id
        WHERE member.user_id = NEW.user_id AND member.transaction_id = NEW.transaction_id));
END;

--> statement-breakpoint

DROP TRIGGER transaction_projection_corrected_transaction;
--> statement-breakpoint

CREATE TRIGGER transaction_projection_corrected_transaction AFTER UPDATE ON transactions
WHEN (NEW.id IS NOT OLD.id OR NEW.user_id IS NOT OLD.user_id OR NEW.amount IS NOT OLD.amount OR NEW.currency IS NOT OLD.currency OR NEW.direction IS NOT OLD.direction OR NEW.counterparty IS NOT OLD.counterparty OR NEW.category_id IS NOT OLD.category_id OR NEW.notes IS NOT OLD.notes OR NEW.occurred_at_ms IS NOT OLD.occurred_at_ms OR NEW.created_at_ms IS NOT OLD.created_at_ms OR NEW.revision IS NOT OLD.revision OR NEW.user_decisions IS NOT OLD.user_decisions OR NEW.deleted_at_ms IS NOT OLD.deleted_at_ms)
BEGIN
  DELETE FROM transaction_projection_leaf WHERE user_id = NEW.user_id
    AND id IN (NEW.id, (SELECT decision.visible_transaction_id
      FROM reconciled_transactions member
      JOIN transaction_reconciliation_decisions decision
        ON decision.user_id = member.user_id
        AND decision.first_transaction_id = member.first_transaction_id
        AND decision.second_transaction_id = member.second_transaction_id
      WHERE member.user_id = NEW.user_id AND member.transaction_id = NEW.id))
    AND NOT (
      NEW.reconciliation_first_id IS NULL
      AND OLD.reconciliation_first_id IS NULL
      AND NEW.deleted_at_ms IS NULL
      AND OLD.deleted_at_ms IS NULL
      AND NEW.id IS OLD.id
      AND NEW.user_id IS OLD.user_id
      AND NEW.amount IS OLD.amount
      AND NEW.currency IS OLD.currency
      AND NEW.direction IS OLD.direction
      AND NEW.category_id IS OLD.category_id
      AND NEW.occurred_at_ms IS OLD.occurred_at_ms
      AND NEW.created_at_ms IS OLD.created_at_ms
      AND transaction_projection_leaf.amount IS OLD.amount
      AND transaction_projection_leaf.currency IS OLD.currency
      AND transaction_projection_leaf.direction IS OLD.direction
      AND transaction_projection_leaf.category_id IS OLD.category_id
      AND transaction_projection_leaf.occurred_at_ms IS OLD.occurred_at_ms
      AND transaction_projection_leaf.created_at_ms IS OLD.created_at_ms);
  INSERT INTO transaction_projection_leaf
    (user_id, id, amount, currency, direction, category_id, counterparty, notes,
      occurred_at_ms, created_at_ms, revision)
  SELECT user_id, id, amount, currency, direction, category_id, counterparty, notes,
    occurred_at_ms, created_at_ms, revision
    FROM transaction_effective_source WHERE user_id = NEW.user_id
      AND id IN (NEW.id, (SELECT decision.visible_transaction_id
        FROM reconciled_transactions member
        JOIN transaction_reconciliation_decisions decision
          ON decision.user_id = member.user_id
          AND decision.first_transaction_id = member.first_transaction_id
          AND decision.second_transaction_id = member.second_transaction_id
        WHERE member.user_id = NEW.user_id AND member.transaction_id = NEW.id))
  ON CONFLICT(user_id, id) DO UPDATE SET
    counterparty = excluded.counterparty, notes = excluded.notes, revision = excluded.revision;
END;
