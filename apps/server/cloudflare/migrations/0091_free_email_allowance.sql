DROP TRIGGER commercial_allowance_capacity;
CREATE TRIGGER commercial_allowance_capacity BEFORE INSERT ON commercial_allowance_consumptions
WHEN NEW.units = 1 AND NOT EXISTS (
  SELECT 1 FROM commercial_allowance_consumptions WHERE user_id = NEW.user_id AND allowance = NEW.allowance AND identity = NEW.identity
) AND (SELECT coalesce(sum(units),0) FROM commercial_allowance_consumptions
 WHERE user_id = NEW.user_id AND allowance = NEW.allowance AND period_start_ms = NEW.period_start_ms) >=
 CASE NEW.allowance WHEN 'forwarded_email' THEN 30 WHEN 'media_submission' THEN 2 WHEN 'hosted_history_turn' THEN 2 WHEN 'canonical_call' THEN 50 END
BEGIN SELECT RAISE(ABORT, 'commercial_quota_exhausted'); END;
