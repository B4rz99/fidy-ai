-- A group's currency applies from its selected planning month; prior versions remain intact.
CREATE TABLE budget_group_currencies (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  group_name TEXT NOT NULL,
  month TEXT NOT NULL,
  currency TEXT NOT NULL,
  PRIMARY KEY(user_id, group_name, month)
) STRICT;
CREATE TRIGGER budget_group_currency_version_insert AFTER INSERT ON budget_group_currencies
BEGIN
  INSERT INTO budget_user_versions(user_id, revision) VALUES (NEW.user_id, 1)
  ON CONFLICT(user_id) DO UPDATE SET revision=revision+1;
END;
CREATE TRIGGER budget_group_currency_version_update AFTER UPDATE ON budget_group_currencies
BEGIN
  INSERT INTO budget_user_versions(user_id, revision) VALUES (NEW.user_id, 1)
  ON CONFLICT(user_id) DO UPDATE SET revision=revision+1;
END;
