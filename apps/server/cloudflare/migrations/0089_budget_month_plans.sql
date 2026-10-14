-- Monthly plans are frozen only by an explicit canonical mutation, never by a query.
ALTER TABLE budgets ADD COLUMN group_name TEXT;
ALTER TABLE budgets ADD COLUMN starts_month TEXT;
CREATE TABLE budget_plan_months (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  month TEXT NOT NULL,
  PRIMARY KEY(user_id, month)
) STRICT;
CREATE TABLE budget_month_caps (
  user_id TEXT NOT NULL,
  budget_id TEXT NOT NULL,
  month TEXT NOT NULL,
  cap TEXT NOT NULL,
  PRIMARY KEY(user_id, budget_id, month),
  FOREIGN KEY(user_id, budget_id) REFERENCES budgets(user_id, id) ON DELETE CASCADE
) STRICT;
