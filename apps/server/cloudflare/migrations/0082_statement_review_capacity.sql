-- The evidence capacity is global. Maintain its exact count in the same D1 commit as each
-- review lifecycle transition, rather than rescanning every pending row for each input row.
CREATE TABLE statement_review_capacity (
  id INTEGER PRIMARY KEY NOT NULL CHECK (id = 1),
  pending_count INTEGER NOT NULL CHECK (pending_count BETWEEN 0 AND 5000)
) STRICT;
INSERT INTO statement_review_capacity SELECT 1, count(*) FROM statement_needs_review WHERE status = 'pending';

DROP TRIGGER statement_review_pending_cap;
CREATE TRIGGER statement_review_pending_cap BEFORE INSERT ON statement_needs_review
WHEN NEW.status = 'pending' AND
  COALESCE((SELECT pending_count FROM statement_review_capacity WHERE id = 1), 5000) >= 5000
BEGIN SELECT RAISE(ABORT, 'statement_review_capacity'); END;

CREATE TRIGGER statement_review_capacity_insert AFTER INSERT ON statement_needs_review
WHEN NEW.status = 'pending'
BEGIN UPDATE statement_review_capacity SET pending_count = pending_count + 1 WHERE id = 1; END;
CREATE TRIGGER statement_review_capacity_settlement AFTER UPDATE OF status ON statement_needs_review
WHEN OLD.status = 'pending' AND NEW.status != 'pending'
BEGIN UPDATE statement_review_capacity SET pending_count = pending_count - 1 WHERE id = 1; END;
CREATE TRIGGER statement_review_capacity_delete AFTER DELETE ON statement_needs_review
WHEN OLD.status = 'pending'
BEGIN UPDATE statement_review_capacity SET pending_count = pending_count - 1 WHERE id = 1; END;
