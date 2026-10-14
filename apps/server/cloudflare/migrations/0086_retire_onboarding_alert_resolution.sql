-- Migration 0069 retired email-code signup and its onboarding health owner.
-- A resolved alert for that owner cannot be delivered by the current closed alert schema.
-- Preserve active alerts and all current owners; retire only this obsolete resolution metadata.
DELETE FROM operational_alerts
WHERE kind = 'inspection_unavailable' AND owner = 'onboarding' AND state = 'resolved';
