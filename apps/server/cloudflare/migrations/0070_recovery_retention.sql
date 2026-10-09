-- Keep the fixed-size terminal evidence sweep independent of total retained case volume.
CREATE INDEX support_recovery_cases_retention ON support_recovery_cases(closed_at_ms, id);
CREATE INDEX support_recovery_operator_limits_retention ON support_recovery_operator_limits(window_started_at_ms);
