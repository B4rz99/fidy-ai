-- Health reads only a bounded oldest identity sample; terminal history cannot amplify scans.
CREATE INDEX weekly_summary_outbox_health ON weekly_summary_outbox(created_at_ms, user_id, insight_event_id)
WHERE state IN ('ready', 'started');
CREATE INDEX weekly_question_intents_health ON weekly_question_intents(created_at_ms, user_id, id)
WHERE state='ready';
CREATE INDEX proactivity_outbox_health ON proactivity_outbox(created_at_ms, user_id, delivery_id)
WHERE state IN ('ready', 'started');
