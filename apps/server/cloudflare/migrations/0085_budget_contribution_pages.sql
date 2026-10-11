-- Seek exact Budget contribution pages without rescanning earlier equal-time Transactions.
CREATE INDEX dashboard_projection_leaf_budget_page ON dashboard_projection_leaf
  (user_id, category_id, currency, direction, occurred_at, id);
