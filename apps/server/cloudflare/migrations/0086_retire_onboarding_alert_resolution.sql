DELETE FROM operational_alerts
WHERE kind = 'inspection_unavailable' AND owner = 'onboarding' AND state = 'resolved';
