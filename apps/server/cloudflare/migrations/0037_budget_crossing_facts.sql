-- Existing latch-only rows have no reconstructable historical financial facts.
-- Leave them NULL rather than inventing a crossing from current Budget/Transaction state.
ALTER TABLE budget_threshold_alerts ADD COLUMN crossing_json TEXT
  CHECK(crossing_json IS NULL OR json_valid(crossing_json));
CREATE TRIGGER budget_crossing_facts_immutable BEFORE UPDATE ON budget_threshold_alerts
WHEN NEW.crossing_json IS NOT OLD.crossing_json
BEGIN SELECT RAISE(ABORT, 'budget_crossing_immutable'); END;
