CREATE TRIGGER erasure_preserve_budget_alert_occurrences_delete BEFORE DELETE ON budget_alert_occurrences
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id)
  AND json_extract(q.decision_json,'$.dispositions.schedules.action')='Retain'
  AND json_extract(q.decision_json,'$.dispositions.schedules.retention.untilMs')>unixepoch('subsec')*1000)
BEGIN
  INSERT INTO erasure_archives(request_id,store_id,row_ref,body)
  SELECT q.id,'budget_alert_occurrences','drain:'||lower(hex(randomblob(16))),json_object('user_id',OLD."user_id",'delivery_group_id',OLD."delivery_group_id",'threshold',OLD."threshold",'insight_event_id',OLD."insight_event_id",'crossing_json',OLD."crossing_json")
  FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id)
    AND json_extract(q.decision_json,'$.dispositions.schedules.action')='Retain'
    AND json_extract(q.decision_json,'$.dispositions.schedules.retention.untilMs')>unixepoch('subsec')*1000;
END;

CREATE TRIGGER erasure_preserve_insight_delivery_attempts_delete BEFORE DELETE ON insight_delivery_attempts
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id)
  AND json_extract(q.decision_json,'$.dispositions.schedules.action')='Retain'
  AND json_extract(q.decision_json,'$.dispositions.schedules.retention.untilMs')>unixepoch('subsec')*1000)
BEGIN
  INSERT INTO erasure_archives(request_id,store_id,row_ref,body)
  SELECT q.id,'insight_delivery_attempts','drain:'||lower(hex(randomblob(16))),json_object('id',OLD."id",'user_id',OLD."user_id",'insight_event_id',OLD."insight_event_id",'sent_at',OLD."sent_at",'channel',OLD."channel",'provider',OLD."provider",'provider_message_id',OLD."provider_message_id")
  FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id)
    AND json_extract(q.decision_json,'$.dispositions.schedules.action')='Retain'
    AND json_extract(q.decision_json,'$.dispositions.schedules.retention.untilMs')>unixepoch('subsec')*1000;
END;

CREATE TRIGGER erasure_preserve_insight_events_delete BEFORE DELETE ON insight_events
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id)
  AND json_extract(q.decision_json,'$.dispositions.schedules.action')='Retain'
  AND json_extract(q.decision_json,'$.dispositions.schedules.retention.untilMs')>unixepoch('subsec')*1000)
BEGIN
  INSERT INTO erasure_archives(request_id,store_id,row_ref,body)
  SELECT q.id,'insight_events','drain:'||lower(hex(randomblob(16))),json_object('id',OLD."id",'user_id',OLD."user_id",'kind',OLD."kind",'schedule_id',OLD."schedule_id",'schedule_version',OLD."schedule_version",'service_market',OLD."service_market",'locale',OLD."locale",'time_zone',OLD."time_zone",'scheduled_at',OLD."scheduled_at",'money_groups_json',OLD."money_groups_json",'lifecycle_state',OLD."lifecycle_state")
  FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id)
    AND json_extract(q.decision_json,'$.dispositions.schedules.action')='Retain'
    AND json_extract(q.decision_json,'$.dispositions.schedules.retention.untilMs')>unixepoch('subsec')*1000;
END;

CREATE TRIGGER erasure_preserve_proactivity_message_events_delete BEFORE DELETE ON proactivity_message_events
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id)
  AND json_extract(q.decision_json,'$.dispositions.schedules.action')='Retain'
  AND json_extract(q.decision_json,'$.dispositions.schedules.retention.untilMs')>unixepoch('subsec')*1000)
BEGIN
  INSERT INTO erasure_archives(request_id,store_id,row_ref,body)
  SELECT q.id,'proactivity_message_events','drain:'||lower(hex(randomblob(16))),json_object('user_id',OLD."user_id",'delivery_id',OLD."delivery_id",'insight_event_id',OLD."insight_event_id")
  FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id)
    AND json_extract(q.decision_json,'$.dispositions.schedules.action')='Retain'
    AND json_extract(q.decision_json,'$.dispositions.schedules.retention.untilMs')>unixepoch('subsec')*1000;
END;

CREATE TRIGGER erasure_preserve_proactivity_offer_requests_delete BEFORE DELETE ON proactivity_offer_requests
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id)
  AND json_extract(q.decision_json,'$.dispositions.schedules.action')='Retain'
  AND json_extract(q.decision_json,'$.dispositions.schedules.retention.untilMs')>unixepoch('subsec')*1000)
BEGIN
  INSERT INTO erasure_archives(request_id,store_id,row_ref,body)
  SELECT q.id,'proactivity_offer_requests','drain:'||lower(hex(randomblob(16))),json_object('id',OLD."id",'user_id',OLD."user_id",'kind',OLD."kind",'request_message_id',OLD."request_message_id",'created_at_ms',OLD."created_at_ms",'materialized_at_ms',OLD."materialized_at_ms",'last_evaluated_at_ms',OLD."last_evaluated_at_ms",'delivery_id',OLD."delivery_id")
  FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id)
    AND json_extract(q.decision_json,'$.dispositions.schedules.action')='Retain'
    AND json_extract(q.decision_json,'$.dispositions.schedules.retention.untilMs')>unixepoch('subsec')*1000;
END;

CREATE TRIGGER erasure_preserve_proactivity_outbox_delete BEFORE DELETE ON proactivity_outbox
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id)
  AND json_extract(q.decision_json,'$.dispositions.schedules.action')='Retain'
  AND json_extract(q.decision_json,'$.dispositions.schedules.retention.untilMs')>unixepoch('subsec')*1000)
BEGIN
  INSERT INTO erasure_archives(request_id,store_id,row_ref,body)
  SELECT q.id,'proactivity_outbox','drain:'||lower(hex(randomblob(16))),json_object('user_id',OLD."user_id",'delivery_id',OLD."delivery_id",'created_at_ms',OLD."created_at_ms",'state',OLD."state",'last_attempt_at_ms',OLD."last_attempt_at_ms",'restart_attempts',OLD."restart_attempts")
  FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id)
    AND json_extract(q.decision_json,'$.dispositions.schedules.action')='Retain'
    AND json_extract(q.decision_json,'$.dispositions.schedules.retention.untilMs')>unixepoch('subsec')*1000;
END;

CREATE TRIGGER erasure_preserve_proactivity_reports_delete BEFORE DELETE ON proactivity_reports
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id)
  AND json_extract(q.decision_json,'$.dispositions.schedules.action')='Retain'
  AND json_extract(q.decision_json,'$.dispositions.schedules.retention.untilMs')>unixepoch('subsec')*1000)
BEGIN
  INSERT INTO erasure_archives(request_id,store_id,row_ref,body)
  SELECT q.id,'proactivity_reports','drain:'||lower(hex(randomblob(16))),json_object('delivery_id',OLD."delivery_id",'user_id',OLD."user_id",'role',OLD."role",'consent_grant_id',OLD."consent_grant_id",'offer_id',OLD."offer_id",'text',OLD."text",'scheduled_at_ms',OLD."scheduled_at_ms",'expires_at_ms',OLD."expires_at_ms",'time_zone',OLD."time_zone",'created_at_ms',OLD."created_at_ms")
  FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id)
    AND json_extract(q.decision_json,'$.dispositions.schedules.action')='Retain'
    AND json_extract(q.decision_json,'$.dispositions.schedules.retention.untilMs')>unixepoch('subsec')*1000;
END;

CREATE TRIGGER erasure_preserve_recurring_digest_consumption_delete BEFORE DELETE ON recurring_digest_consumption
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id)
  AND json_extract(q.decision_json,'$.dispositions.schedules.action')='Retain'
  AND json_extract(q.decision_json,'$.dispositions.schedules.retention.untilMs')>unixepoch('subsec')*1000)
BEGIN
  INSERT INTO erasure_archives(request_id,store_id,row_ref,body)
  SELECT q.id,'recurring_digest_consumption','drain:'||lower(hex(randomblob(16))),json_object('user_id',OLD."user_id",'confirmation_id',OLD."confirmation_id",'disposition',OLD."disposition")
  FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id)
    AND json_extract(q.decision_json,'$.dispositions.schedules.action')='Retain'
    AND json_extract(q.decision_json,'$.dispositions.schedules.retention.untilMs')>unixepoch('subsec')*1000;
END;

CREATE TRIGGER erasure_preserve_recurring_digest_days_delete BEFORE DELETE ON recurring_digest_days
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id)
  AND json_extract(q.decision_json,'$.dispositions.schedules.action')='Retain'
  AND json_extract(q.decision_json,'$.dispositions.schedules.retention.untilMs')>unixepoch('subsec')*1000)
BEGIN
  INSERT INTO erasure_archives(request_id,store_id,row_ref,body)
  SELECT q.id,'recurring_digest_days','drain:'||lower(hex(randomblob(16))),json_object('user_id',OLD."user_id",'local_date',OLD."local_date",'day_from_ms',OLD."day_from_ms",'day_to_ms',OLD."day_to_ms",'insight_event_id',OLD."insight_event_id")
  FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id)
    AND json_extract(q.decision_json,'$.dispositions.schedules.action')='Retain'
    AND json_extract(q.decision_json,'$.dispositions.schedules.retention.untilMs')>unixepoch('subsec')*1000;
END;

CREATE TRIGGER erasure_preserve_recurring_digest_instructions_delete BEFORE DELETE ON recurring_digest_instructions
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id)
  AND json_extract(q.decision_json,'$.dispositions.schedules.action')='Retain'
  AND json_extract(q.decision_json,'$.dispositions.schedules.retention.untilMs')>unixepoch('subsec')*1000)
BEGIN
  INSERT INTO erasure_archives(request_id,store_id,row_ref,body)
  SELECT q.id,'recurring_digest_instructions','drain:'||lower(hex(randomblob(16))),json_object('user_id',OLD."user_id",'id',OLD."id",'version',OLD."version",'enabled',OLD."enabled",'grant_id',OLD."grant_id",'context_json',OLD."context_json",'acceptance_from_ms',OLD."acceptance_from_ms",'accepted_at_ms',OLD."accepted_at_ms",'last_source_identity',OLD."last_source_identity",'next_closed_at_ms',OLD."next_closed_at_ms",'last_evaluated_at_ms',OLD."last_evaluated_at_ms")
  FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id)
    AND json_extract(q.decision_json,'$.dispositions.schedules.action')='Retain'
    AND json_extract(q.decision_json,'$.dispositions.schedules.retention.untilMs')>unixepoch('subsec')*1000;
END;

CREATE TRIGGER erasure_preserve_recurring_digest_opportunities_delete BEFORE DELETE ON recurring_digest_opportunities
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id)
  AND json_extract(q.decision_json,'$.dispositions.schedules.action')='Retain'
  AND json_extract(q.decision_json,'$.dispositions.schedules.retention.untilMs')>unixepoch('subsec')*1000)
BEGIN
  INSERT INTO erasure_archives(request_id,store_id,row_ref,body)
  SELECT q.id,'recurring_digest_opportunities','drain:'||lower(hex(randomblob(16))),json_object('user_id',OLD."user_id",'request_id',OLD."request_id")
  FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id)
    AND json_extract(q.decision_json,'$.dispositions.schedules.action')='Retain'
    AND json_extract(q.decision_json,'$.dispositions.schedules.retention.untilMs')>unixepoch('subsec')*1000;
END;

CREATE TRIGGER erasure_preserve_recurring_digest_reports_delete BEFORE DELETE ON recurring_digest_reports
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id)
  AND json_extract(q.decision_json,'$.dispositions.schedules.action')='Retain'
  AND json_extract(q.decision_json,'$.dispositions.schedules.retention.untilMs')>unixepoch('subsec')*1000)
BEGIN
  INSERT INTO erasure_archives(request_id,store_id,row_ref,body)
  SELECT q.id,'recurring_digest_reports','drain:'||lower(hex(randomblob(16))),json_object('user_id',OLD."user_id",'insight_event_id',OLD."insight_event_id",'instruction_id',OLD."instruction_id",'instruction_version',OLD."instruction_version",'grant_id',OLD."grant_id",'local_date',OLD."local_date",'day_from_ms',OLD."day_from_ms",'day_to_ms',OLD."day_to_ms",'report_json',OLD."report_json")
  FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id)
    AND json_extract(q.decision_json,'$.dispositions.schedules.action')='Retain'
    AND json_extract(q.decision_json,'$.dispositions.schedules.retention.untilMs')>unixepoch('subsec')*1000;
END;

CREATE TRIGGER erasure_preserve_recurring_digest_scans_delete BEFORE DELETE ON recurring_digest_scans
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id)
  AND json_extract(q.decision_json,'$.dispositions.schedules.action')='Retain'
  AND json_extract(q.decision_json,'$.dispositions.schedules.retention.untilMs')>unixepoch('subsec')*1000)
BEGIN
  INSERT INTO erasure_archives(request_id,store_id,row_ref,body)
  SELECT q.id,'recurring_digest_scans','drain:'||lower(hex(randomblob(16))),json_object('user_id',OLD."user_id",'checkpoint',OLD."checkpoint",'cursor',OLD."cursor",'cutoff_at_ms',OLD."cutoff_at_ms",'complete',OLD."complete")
  FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id)
    AND json_extract(q.decision_json,'$.dispositions.schedules.action')='Retain'
    AND json_extract(q.decision_json,'$.dispositions.schedules.retention.untilMs')>unixepoch('subsec')*1000;
END;

CREATE TRIGGER erasure_preserve_recurring_digest_staging_delete BEFORE DELETE ON recurring_digest_staging
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id)
  AND json_extract(q.decision_json,'$.dispositions.schedules.action')='Retain'
  AND json_extract(q.decision_json,'$.dispositions.schedules.retention.untilMs')>unixepoch('subsec')*1000)
BEGIN
  INSERT INTO erasure_archives(request_id,store_id,row_ref,body)
  SELECT q.id,'recurring_digest_staging','drain:'||lower(hex(randomblob(16))),json_object('user_id',OLD."user_id",'confirmation_id',OLD."confirmation_id",'confirmed_at_ms',OLD."confirmed_at_ms",'context_json',OLD."context_json",'item_json',OLD."item_json",'eligible',OLD."eligible")
  FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id)
    AND json_extract(q.decision_json,'$.dispositions.schedules.action')='Retain'
    AND json_extract(q.decision_json,'$.dispositions.schedules.retention.untilMs')>unixepoch('subsec')*1000;
END;

CREATE TRIGGER erasure_preserve_reminder_control_receipts_delete BEFORE DELETE ON reminder_control_receipts
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id)
  AND json_extract(q.decision_json,'$.dispositions.schedules.action')='Retain'
  AND json_extract(q.decision_json,'$.dispositions.schedules.retention.untilMs')>unixepoch('subsec')*1000)
BEGIN
  INSERT INTO erasure_archives(request_id,store_id,row_ref,body)
  SELECT q.id,'reminder_control_receipts','drain:'||lower(hex(randomblob(16))),json_object('user_id',OLD."user_id",'message_id',OLD."message_id",'choice',OLD."choice")
  FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id)
    AND json_extract(q.decision_json,'$.dispositions.schedules.action')='Retain'
    AND json_extract(q.decision_json,'$.dispositions.schedules.retention.untilMs')>unixepoch('subsec')*1000;
END;

CREATE TRIGGER erasure_preserve_reminder_delivery_receipts_delete BEFORE DELETE ON reminder_delivery_receipts
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id)
  AND json_extract(q.decision_json,'$.dispositions.schedules.action')='Retain'
  AND json_extract(q.decision_json,'$.dispositions.schedules.retention.untilMs')>unixepoch('subsec')*1000)
BEGIN
  INSERT INTO erasure_archives(request_id,store_id,row_ref,body)
  SELECT q.id,'reminder_delivery_receipts','drain:'||lower(hex(randomblob(16))),json_object('user_id',OLD."user_id",'delivery_id',OLD."delivery_id")
  FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id)
    AND json_extract(q.decision_json,'$.dispositions.schedules.action')='Retain'
    AND json_extract(q.decision_json,'$.dispositions.schedules.retention.untilMs')>unixepoch('subsec')*1000;
END;

CREATE TRIGGER erasure_preserve_reminder_governors_delete BEFORE DELETE ON reminder_governors
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id)
  AND json_extract(q.decision_json,'$.dispositions.schedules.action')='Retain'
  AND json_extract(q.decision_json,'$.dispositions.schedules.retention.untilMs')>unixepoch('subsec')*1000)
BEGIN
  INSERT INTO erasure_archives(request_id,store_id,row_ref,body)
  SELECT q.id,'reminder_governors','drain:'||lower(hex(randomblob(16))),json_object('user_id',OLD."user_id",'standing_json',OLD."standing_json",'last_reply_at_ms',OLD."last_reply_at_ms",'question_id',OLD."question_id",'question_delivered_at_ms',OLD."question_delivered_at_ms",'notice_turn_id',OLD."notice_turn_id",'notice_completed',OLD."notice_completed")
  FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id)
    AND json_extract(q.decision_json,'$.dispositions.schedules.action')='Retain'
    AND json_extract(q.decision_json,'$.dispositions.schedules.retention.untilMs')>unixepoch('subsec')*1000;
END;

CREATE TRIGGER erasure_preserve_reminder_occurrence_reports_delete BEFORE DELETE ON reminder_occurrence_reports
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id)
  AND json_extract(q.decision_json,'$.dispositions.schedules.action')='Retain'
  AND json_extract(q.decision_json,'$.dispositions.schedules.retention.untilMs')>unixepoch('subsec')*1000)
BEGIN
  INSERT INTO erasure_archives(request_id,store_id,row_ref,body)
  SELECT q.id,'reminder_occurrence_reports','drain:'||lower(hex(randomblob(16))),json_object('user_id',OLD."user_id",'insight_event_id',OLD."insight_event_id",'consent_grant_id',OLD."consent_grant_id",'expires_at_ms',OLD."expires_at_ms")
  FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id)
    AND json_extract(q.decision_json,'$.dispositions.schedules.action')='Retain'
    AND json_extract(q.decision_json,'$.dispositions.schedules.retention.untilMs')>unixepoch('subsec')*1000;
END;

CREATE TRIGGER erasure_preserve_reminder_schedule_executions_delete BEFORE DELETE ON reminder_schedule_executions
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id)
  AND json_extract(q.decision_json,'$.dispositions.schedules.action')='Retain'
  AND json_extract(q.decision_json,'$.dispositions.schedules.retention.untilMs')>unixepoch('subsec')*1000)
BEGIN
  INSERT INTO erasure_archives(request_id,store_id,row_ref,body)
  SELECT q.id,'reminder_schedule_executions','drain:'||lower(hex(randomblob(16))),json_object('user_id',OLD."user_id",'schedule_id',OLD."schedule_id",'schedule_version',OLD."schedule_version",'scheduled_at',OLD."scheduled_at",'outcome',OLD."outcome")
  FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id)
    AND json_extract(q.decision_json,'$.dispositions.schedules.action')='Retain'
    AND json_extract(q.decision_json,'$.dispositions.schedules.retention.untilMs')>unixepoch('subsec')*1000;
END;

CREATE TRIGGER erasure_preserve_reminder_schedule_revisions_delete BEFORE DELETE ON reminder_schedule_revisions
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id)
  AND json_extract(q.decision_json,'$.dispositions.schedules.action')='Retain'
  AND json_extract(q.decision_json,'$.dispositions.schedules.retention.untilMs')>unixepoch('subsec')*1000)
BEGIN
  INSERT INTO erasure_archives(request_id,store_id,row_ref,body)
  SELECT q.id,'reminder_schedule_revisions','drain:'||lower(hex(randomblob(16))),json_object('user_id',OLD."user_id",'schedule_id',OLD."schedule_id",'version',OLD."version",'snapshot_json',OLD."snapshot_json")
  FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id)
    AND json_extract(q.decision_json,'$.dispositions.schedules.action')='Retain'
    AND json_extract(q.decision_json,'$.dispositions.schedules.retention.untilMs')>unixepoch('subsec')*1000;
END;

CREATE TRIGGER erasure_preserve_reminder_schedules_delete BEFORE DELETE ON reminder_schedules
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id)
  AND json_extract(q.decision_json,'$.dispositions.schedules.action')='Retain'
  AND json_extract(q.decision_json,'$.dispositions.schedules.retention.untilMs')>unixepoch('subsec')*1000)
BEGIN
  INSERT INTO erasure_archives(request_id,store_id,row_ref,body)
  SELECT q.id,'reminder_schedules','drain:'||lower(hex(randomblob(16))),json_object('id',OLD."id",'user_id',OLD."user_id",'version',OLD."version",'enabled',OLD."enabled",'snapshot_json',OLD."snapshot_json",'next_scheduled_at',OLD."next_scheduled_at",'consent_grant_id',OLD."consent_grant_id",'last_evaluated_at_ms',OLD."last_evaluated_at_ms")
  FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id)
    AND json_extract(q.decision_json,'$.dispositions.schedules.action')='Retain'
    AND json_extract(q.decision_json,'$.dispositions.schedules.retention.untilMs')>unixepoch('subsec')*1000;
END;

CREATE TRIGGER erasure_preserve_weekly_governor_deliveries_delete BEFORE DELETE ON weekly_governor_deliveries
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id)
  AND json_extract(q.decision_json,'$.dispositions.schedules.action')='Retain'
  AND json_extract(q.decision_json,'$.dispositions.schedules.retention.untilMs')>unixepoch('subsec')*1000)
BEGIN
  INSERT INTO erasure_archives(request_id,store_id,row_ref,body)
  SELECT q.id,'weekly_governor_deliveries','drain:'||lower(hex(randomblob(16))),json_object('user_id',OLD."user_id",'insight_event_id',OLD."insight_event_id")
  FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id)
    AND json_extract(q.decision_json,'$.dispositions.schedules.action')='Retain'
    AND json_extract(q.decision_json,'$.dispositions.schedules.retention.untilMs')>unixepoch('subsec')*1000;
END;

CREATE TRIGGER erasure_preserve_weekly_governors_delete BEFORE DELETE ON weekly_governors
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id)
  AND json_extract(q.decision_json,'$.dispositions.schedules.action')='Retain'
  AND json_extract(q.decision_json,'$.dispositions.schedules.retention.untilMs')>unixepoch('subsec')*1000)
BEGIN
  INSERT INTO erasure_archives(request_id,store_id,row_ref,body)
  SELECT q.id,'weekly_governors','drain:'||lower(hex(randomblob(16))),json_object('user_id',OLD."user_id",'unanswered',OLD."unanswered",'last_reply_at_ms',OLD."last_reply_at_ms",'question_needed',OLD."question_needed",'question_delivered',OLD."question_delivered",'question_delivered_at_ms',OLD."question_delivered_at_ms",'question_event_id',OLD."question_event_id",'paused_at_ms',OLD."paused_at_ms",'notice_session_id',OLD."notice_session_id",'notice_turn_id',OLD."notice_turn_id",'notice_completed',OLD."notice_completed")
  FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id)
    AND json_extract(q.decision_json,'$.dispositions.schedules.action')='Retain'
    AND json_extract(q.decision_json,'$.dispositions.schedules.retention.untilMs')>unixepoch('subsec')*1000;
END;

CREATE TRIGGER erasure_preserve_weekly_question_intents_delete BEFORE DELETE ON weekly_question_intents
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id)
  AND json_extract(q.decision_json,'$.dispositions.schedules.action')='Retain'
  AND json_extract(q.decision_json,'$.dispositions.schedules.retention.untilMs')>unixepoch('subsec')*1000)
BEGIN
  INSERT INTO erasure_archives(request_id,store_id,row_ref,body)
  SELECT q.id,'weekly_question_intents','drain:'||lower(hex(randomblob(16))),json_object('id',OLD."id",'user_id',OLD."user_id",'origin',OLD."origin",'request_message_id',OLD."request_message_id",'rejection_offer_id',OLD."rejection_offer_id",'state',OLD."state",'created_at_ms',OLD."created_at_ms",'last_attempt_at_ms',OLD."last_attempt_at_ms",'restart_attempts',OLD."restart_attempts")
  FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id)
    AND json_extract(q.decision_json,'$.dispositions.schedules.action')='Retain'
    AND json_extract(q.decision_json,'$.dispositions.schedules.retention.untilMs')>unixepoch('subsec')*1000;
END;

CREATE TRIGGER erasure_preserve_weekly_schedule_executions_delete BEFORE DELETE ON weekly_schedule_executions
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id)
  AND json_extract(q.decision_json,'$.dispositions.schedules.action')='Retain'
  AND json_extract(q.decision_json,'$.dispositions.schedules.retention.untilMs')>unixepoch('subsec')*1000)
BEGIN
  INSERT INTO erasure_archives(request_id,store_id,row_ref,body)
  SELECT q.id,'weekly_schedule_executions','drain:'||lower(hex(randomblob(16))),json_object('user_id',OLD."user_id",'schedule_id',OLD."schedule_id",'schedule_version',OLD."schedule_version",'scheduled_at',OLD."scheduled_at",'outcome',OLD."outcome")
  FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id)
    AND json_extract(q.decision_json,'$.dispositions.schedules.action')='Retain'
    AND json_extract(q.decision_json,'$.dispositions.schedules.retention.untilMs')>unixepoch('subsec')*1000;
END;

CREATE TRIGGER erasure_preserve_weekly_schedule_revisions_delete BEFORE DELETE ON weekly_schedule_revisions
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id)
  AND json_extract(q.decision_json,'$.dispositions.schedules.action')='Retain'
  AND json_extract(q.decision_json,'$.dispositions.schedules.retention.untilMs')>unixepoch('subsec')*1000)
BEGIN
  INSERT INTO erasure_archives(request_id,store_id,row_ref,body)
  SELECT q.id,'weekly_schedule_revisions','drain:'||lower(hex(randomblob(16))),json_object('user_id',OLD."user_id",'schedule_id',OLD."schedule_id",'version',OLD."version",'snapshot_json',OLD."snapshot_json")
  FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id)
    AND json_extract(q.decision_json,'$.dispositions.schedules.action')='Retain'
    AND json_extract(q.decision_json,'$.dispositions.schedules.retention.untilMs')>unixepoch('subsec')*1000;
END;

CREATE TRIGGER erasure_preserve_weekly_schedules_delete BEFORE DELETE ON weekly_schedules
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id)
  AND json_extract(q.decision_json,'$.dispositions.schedules.action')='Retain'
  AND json_extract(q.decision_json,'$.dispositions.schedules.retention.untilMs')>unixepoch('subsec')*1000)
BEGIN
  INSERT INTO erasure_archives(request_id,store_id,row_ref,body)
  SELECT q.id,'weekly_schedules','drain:'||lower(hex(randomblob(16))),json_object('id',OLD."id",'user_id',OLD."user_id",'version',OLD."version",'enabled',OLD."enabled",'weekday',OLD."weekday",'hour',OLD."hour",'minute',OLD."minute",'time_zone',OLD."time_zone",'service_market',OLD."service_market",'locale',OLD."locale",'next_scheduled_at',OLD."next_scheduled_at",'consent_grant_id',OLD."consent_grant_id",'last_evaluated_at_ms',OLD."last_evaluated_at_ms")
  FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id)
    AND json_extract(q.decision_json,'$.dispositions.schedules.action')='Retain'
    AND json_extract(q.decision_json,'$.dispositions.schedules.retention.untilMs')>unixepoch('subsec')*1000;
END;

CREATE TRIGGER erasure_preserve_weekly_summary_outbox_delete BEFORE DELETE ON weekly_summary_outbox
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id)
  AND json_extract(q.decision_json,'$.dispositions.schedules.action')='Retain'
  AND json_extract(q.decision_json,'$.dispositions.schedules.retention.untilMs')>unixepoch('subsec')*1000)
BEGIN
  INSERT INTO erasure_archives(request_id,store_id,row_ref,body)
  SELECT q.id,'weekly_summary_outbox','drain:'||lower(hex(randomblob(16))),json_object('user_id',OLD."user_id",'insight_event_id',OLD."insight_event_id",'state',OLD."state",'created_at_ms',OLD."created_at_ms",'last_attempt_at_ms',OLD."last_attempt_at_ms",'restart_attempts',OLD."restart_attempts")
  FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id)
    AND json_extract(q.decision_json,'$.dispositions.schedules.action')='Retain'
    AND json_extract(q.decision_json,'$.dispositions.schedules.retention.untilMs')>unixepoch('subsec')*1000;
END;

CREATE TRIGGER erasure_preserve_weekly_summary_reports_delete BEFORE DELETE ON weekly_summary_reports
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id)
  AND json_extract(q.decision_json,'$.dispositions.schedules.action')='Retain'
  AND json_extract(q.decision_json,'$.dispositions.schedules.retention.untilMs')>unixepoch('subsec')*1000)
BEGIN
  INSERT INTO erasure_archives(request_id,store_id,row_ref,body)
  SELECT q.id,'weekly_summary_reports','drain:'||lower(hex(randomblob(16))),json_object('user_id',OLD."user_id",'insight_event_id',OLD."insight_event_id",'consent_grant_id',OLD."consent_grant_id",'payload_json',OLD."payload_json",'presentation_json',OLD."presentation_json",'scheduled_at_ms',OLD."scheduled_at_ms",'expires_at_ms',OLD."expires_at_ms")
  FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id)
    AND json_extract(q.decision_json,'$.dispositions.schedules.action')='Retain'
    AND json_extract(q.decision_json,'$.dispositions.schedules.retention.untilMs')>unixepoch('subsec')*1000;
END;

CREATE TRIGGER erasure_preserve_email_forwarding_addresses_delete BEFORE DELETE ON email_forwarding_addresses
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id)
  AND json_extract(q.decision_json,'$.dispositions.ingestion.action')='Retain'
  AND json_extract(q.decision_json,'$.dispositions.ingestion.retention.untilMs')>unixepoch('subsec')*1000)
BEGIN
  INSERT INTO erasure_archives(request_id,store_id,row_ref,body)
  SELECT q.id,'email_forwarding_addresses','drain:'||lower(hex(randomblob(16))),json_object('id',OLD."id",'user_id',OLD."user_id",'local_part',OLD."local_part",'created_at_ms',OLD."created_at_ms")
  FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id)
    AND json_extract(q.decision_json,'$.dispositions.ingestion.action')='Retain'
    AND json_extract(q.decision_json,'$.dispositions.ingestion.retention.untilMs')>unixepoch('subsec')*1000;
END;

CREATE TRIGGER erasure_preserve_forwarded_email_deferrals_delete BEFORE DELETE ON forwarded_email_deferrals
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id)
  AND json_extract(q.decision_json,'$.dispositions.ingestion.action')='Retain'
  AND json_extract(q.decision_json,'$.dispositions.ingestion.retention.untilMs')>unixepoch('subsec')*1000)
BEGIN
  INSERT INTO erasure_archives(request_id,store_id,row_ref,body)
  SELECT q.id,'forwarded_email_deferrals','drain:'||lower(hex(randomblob(16))),json_object('receipt_id',OLD."receipt_id",'user_id',OLD."user_id",'resume_at_ms',OLD."resume_at_ms",'checked_at_ms',OLD."checked_at_ms")
  FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id)
    AND json_extract(q.decision_json,'$.dispositions.ingestion.action')='Retain'
    AND json_extract(q.decision_json,'$.dispositions.ingestion.retention.untilMs')>unixepoch('subsec')*1000;
END;

CREATE TRIGGER erasure_preserve_forwarded_email_needs_review_delete BEFORE DELETE ON forwarded_email_needs_review
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id)
  AND json_extract(q.decision_json,'$.dispositions.ingestion.action')='Retain'
  AND json_extract(q.decision_json,'$.dispositions.ingestion.retention.untilMs')>unixepoch('subsec')*1000)
BEGIN
  INSERT INTO erasure_archives(request_id,store_id,row_ref,body)
  SELECT q.id,'forwarded_email_needs_review','drain:'||lower(hex(randomblob(16))),json_object('id',OLD."id",'receipt_id',OLD."receipt_id",'user_id',OLD."user_id",'reason',OLD."reason",'created_at_ms',OLD."created_at_ms",'evidence_expires_at_ms',OLD."evidence_expires_at_ms")
  FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id)
    AND json_extract(q.decision_json,'$.dispositions.ingestion.action')='Retain'
    AND json_extract(q.decision_json,'$.dispositions.ingestion.retention.untilMs')>unixepoch('subsec')*1000;
END;

CREATE TRIGGER erasure_preserve_forwarded_email_outbox_delete BEFORE DELETE ON forwarded_email_outbox
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id)
  AND json_extract(q.decision_json,'$.dispositions.ingestion.action')='Retain'
  AND json_extract(q.decision_json,'$.dispositions.ingestion.retention.untilMs')>unixepoch('subsec')*1000)
BEGIN
  INSERT INTO erasure_archives(request_id,store_id,row_ref,body)
  SELECT q.id,'forwarded_email_outbox','drain:'||lower(hex(randomblob(16))),json_object('receipt_id',OLD."receipt_id",'user_id',OLD."user_id",'sent_at_ms',OLD."sent_at_ms")
  FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id)
    AND json_extract(q.decision_json,'$.dispositions.ingestion.action')='Retain'
    AND json_extract(q.decision_json,'$.dispositions.ingestion.retention.untilMs')>unixepoch('subsec')*1000;
END;

CREATE TRIGGER erasure_preserve_forwarded_email_outcomes_delete BEFORE DELETE ON forwarded_email_outcomes
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id)
  AND json_extract(q.decision_json,'$.dispositions.ingestion.action')='Retain'
  AND json_extract(q.decision_json,'$.dispositions.ingestion.retention.untilMs')>unixepoch('subsec')*1000)
BEGIN
  INSERT INTO erasure_archives(request_id,store_id,row_ref,body)
  SELECT q.id,'forwarded_email_outcomes','drain:'||lower(hex(randomblob(16))),json_object('receipt_id',OLD."receipt_id",'user_id',OLD."user_id",'outcome',OLD."outcome",'transaction_id',OLD."transaction_id",'review_id',OLD."review_id",'completed_at_ms',OLD."completed_at_ms")
  FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id)
    AND json_extract(q.decision_json,'$.dispositions.ingestion.action')='Retain'
    AND json_extract(q.decision_json,'$.dispositions.ingestion.retention.untilMs')>unixepoch('subsec')*1000;
END;

CREATE TRIGGER erasure_preserve_forwarded_email_receipts_delete BEFORE DELETE ON forwarded_email_receipts
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id)
  AND json_extract(q.decision_json,'$.dispositions.ingestion.action')='Retain'
  AND json_extract(q.decision_json,'$.dispositions.ingestion.retention.untilMs')>unixepoch('subsec')*1000)
BEGIN
  INSERT INTO erasure_archives(request_id,store_id,row_ref,body)
  SELECT q.id,'forwarded_email_receipts','drain:'||lower(hex(randomblob(16))),json_object('id',OLD."id",'user_id',OLD."user_id",'object_key',OLD."object_key",'byte_length',OLD."byte_length",'state',OLD."state",'received_at_ms',OLD."received_at_ms",'expires_at_ms',OLD."expires_at_ms",'time_zone',OLD."time_zone")
  FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id)
    AND json_extract(q.decision_json,'$.dispositions.ingestion.action')='Retain'
    AND json_extract(q.decision_json,'$.dispositions.ingestion.retention.untilMs')>unixepoch('subsec')*1000;
END;

CREATE TRIGGER erasure_preserve_media_needs_review_delete BEFORE DELETE ON media_needs_review
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id)
  AND json_extract(q.decision_json,'$.dispositions.ingestion.action')='Retain'
  AND json_extract(q.decision_json,'$.dispositions.ingestion.retention.untilMs')>unixepoch('subsec')*1000)
BEGIN
  INSERT INTO erasure_archives(request_id,store_id,row_ref,body)
  SELECT q.id,'media_needs_review','drain:'||lower(hex(randomblob(16))),json_object('id',OLD."id",'user_id',OLD."user_id",'reason',OLD."reason",'created_at_ms',OLD."created_at_ms")
  FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id)
    AND json_extract(q.decision_json,'$.dispositions.ingestion.action')='Retain'
    AND json_extract(q.decision_json,'$.dispositions.ingestion.retention.untilMs')>unixepoch('subsec')*1000;
END;

CREATE TRIGGER erasure_preserve_media_submission_outbox_delete BEFORE DELETE ON media_submission_outbox
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id)
  AND json_extract(q.decision_json,'$.dispositions.ingestion.action')='Retain'
  AND json_extract(q.decision_json,'$.dispositions.ingestion.retention.untilMs')>unixepoch('subsec')*1000)
BEGIN
  INSERT INTO erasure_archives(request_id,store_id,row_ref,body)
  SELECT q.id,'media_submission_outbox','drain:'||lower(hex(randomblob(16))),json_object('submission_id',OLD."submission_id",'user_id',OLD."user_id",'created_at_ms',OLD."created_at_ms")
  FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id)
    AND json_extract(q.decision_json,'$.dispositions.ingestion.action')='Retain'
    AND json_extract(q.decision_json,'$.dispositions.ingestion.retention.untilMs')>unixepoch('subsec')*1000;
END;

CREATE TRIGGER erasure_preserve_media_submissions_delete BEFORE DELETE ON media_submissions
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id)
  AND json_extract(q.decision_json,'$.dispositions.ingestion.action')='Retain'
  AND json_extract(q.decision_json,'$.dispositions.ingestion.retention.untilMs')>unixepoch('subsec')*1000)
BEGIN
  INSERT INTO erasure_archives(request_id,store_id,row_ref,body)
  SELECT q.id,'media_submissions','drain:'||lower(hex(randomblob(16))),json_object('id',OLD."id",'user_id',OLD."user_id",'portfolio_id',OLD."portfolio_id",'bsuid',OLD."bsuid",'message_id',OLD."message_id",'media_id',OLD."media_id",'caption',OLD."caption",'accepted_at_ms',OLD."accepted_at_ms",'expires_at_ms',OLD."expires_at_ms",'service_market',OLD."service_market",'locale',OLD."locale",'time_zone',OLD."time_zone")
  FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id)
    AND json_extract(q.decision_json,'$.dispositions.ingestion.action')='Retain'
    AND json_extract(q.decision_json,'$.dispositions.ingestion.retention.untilMs')>unixepoch('subsec')*1000;
END;

CREATE TRIGGER erasure_preserve_statement_backfill_entitlements_delete BEFORE DELETE ON statement_backfill_entitlements
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id)
  AND json_extract(q.decision_json,'$.dispositions.ingestion.action')='Retain'
  AND json_extract(q.decision_json,'$.dispositions.ingestion.retention.untilMs')>unixepoch('subsec')*1000)
BEGIN
  INSERT INTO erasure_archives(request_id,store_id,row_ref,body)
  SELECT q.id,'statement_backfill_entitlements','drain:'||lower(hex(randomblob(16))),json_object('user_id',OLD."user_id",'submission_id',OLD."submission_id",'consumed_at_ms',OLD."consumed_at_ms")
  FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id)
    AND json_extract(q.decision_json,'$.dispositions.ingestion.action')='Retain'
    AND json_extract(q.decision_json,'$.dispositions.ingestion.retention.untilMs')>unixepoch('subsec')*1000;
END;

CREATE TRIGGER erasure_preserve_statement_clarifications_delete BEFORE DELETE ON statement_clarifications
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id)
  AND json_extract(q.decision_json,'$.dispositions.ingestion.action')='Retain'
  AND json_extract(q.decision_json,'$.dispositions.ingestion.retention.untilMs')>unixepoch('subsec')*1000)
BEGIN
  INSERT INTO erasure_archives(request_id,store_id,row_ref,body)
  SELECT q.id,'statement_clarifications','drain:'||lower(hex(randomblob(16))),json_object('submission_id',OLD."submission_id",'user_id',OLD."user_id",'state',OLD."state",'expires_at_ms',OLD."expires_at_ms",'ended_at_ms',OLD."ended_at_ms")
  FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id)
    AND json_extract(q.decision_json,'$.dispositions.ingestion.action')='Retain'
    AND json_extract(q.decision_json,'$.dispositions.ingestion.retention.untilMs')>unixepoch('subsec')*1000;
END;

CREATE TRIGGER erasure_preserve_statement_hosted_origins_delete BEFORE DELETE ON statement_hosted_origins
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id)
  AND json_extract(q.decision_json,'$.dispositions.ingestion.action')='Retain'
  AND json_extract(q.decision_json,'$.dispositions.ingestion.retention.untilMs')>unixepoch('subsec')*1000)
BEGIN
  INSERT INTO erasure_archives(request_id,store_id,row_ref,body)
  SELECT q.id,'statement_hosted_origins','drain:'||lower(hex(randomblob(16))),json_object('submission_id',OLD."submission_id",'user_id',OLD."user_id",'session_id',OLD."session_id",'turn_id',OLD."turn_id",'expires_at_ms',OLD."expires_at_ms",'abandoned_at_ms',OLD."abandoned_at_ms")
  FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id)
    AND json_extract(q.decision_json,'$.dispositions.ingestion.action')='Retain'
    AND json_extract(q.decision_json,'$.dispositions.ingestion.retention.untilMs')>unixepoch('subsec')*1000;
END;

CREATE TRIGGER erasure_preserve_statement_ingestion_outbox_delete BEFORE DELETE ON statement_ingestion_outbox
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id)
  AND json_extract(q.decision_json,'$.dispositions.ingestion.action')='Retain'
  AND json_extract(q.decision_json,'$.dispositions.ingestion.retention.untilMs')>unixepoch('subsec')*1000)
BEGIN
  INSERT INTO erasure_archives(request_id,store_id,row_ref,body)
  SELECT q.id,'statement_ingestion_outbox','drain:'||lower(hex(randomblob(16))),json_object('submission_id',OLD."submission_id",'user_id',OLD."user_id",'revision',OLD."revision",'published_at_ms',OLD."published_at_ms",'last_attempt_at_ms',OLD."last_attempt_at_ms",'last_reconciled_at_ms',OLD."last_reconciled_at_ms")
  FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id)
    AND json_extract(q.decision_json,'$.dispositions.ingestion.action')='Retain'
    AND json_extract(q.decision_json,'$.dispositions.ingestion.retention.untilMs')>unixepoch('subsec')*1000;
END;

CREATE TRIGGER erasure_preserve_statement_materialization_parts_delete BEFORE DELETE ON statement_materialization_parts
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state='Draining' AND (EXISTS(SELECT 1 FROM statement_materializations p WHERE p.submission_id=OLD.submission_id AND p.user_id=q.user_id))
  AND json_extract(q.decision_json,'$.dispositions.ingestion.action')='Retain'
  AND json_extract(q.decision_json,'$.dispositions.ingestion.retention.untilMs')>unixepoch('subsec')*1000)
BEGIN
  INSERT INTO erasure_archives(request_id,store_id,row_ref,body)
  SELECT q.id,'statement_materialization_parts','drain:'||lower(hex(randomblob(16))),json_object('submission_id',OLD."submission_id",'chunk_index',OLD."chunk_index",'part_index',OLD."part_index",'body',OLD."body",'sha256',OLD."sha256")
  FROM erasure_requests q WHERE q.state='Draining' AND (EXISTS(SELECT 1 FROM statement_materializations p WHERE p.submission_id=OLD.submission_id AND p.user_id=q.user_id))
    AND json_extract(q.decision_json,'$.dispositions.ingestion.action')='Retain'
    AND json_extract(q.decision_json,'$.dispositions.ingestion.retention.untilMs')>unixepoch('subsec')*1000;
END;

CREATE TRIGGER erasure_preserve_statement_materializations_delete BEFORE DELETE ON statement_materializations
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id)
  AND json_extract(q.decision_json,'$.dispositions.ingestion.action')='Retain'
  AND json_extract(q.decision_json,'$.dispositions.ingestion.retention.untilMs')>unixepoch('subsec')*1000)
BEGIN
  INSERT INTO erasure_archives(request_id,store_id,row_ref,body)
  SELECT q.id,'statement_materializations','drain:'||lower(hex(randomblob(16))),json_object('submission_id',OLD."submission_id",'user_id',OLD."user_id",'source_sha256',OLD."source_sha256",'parts_sha256',OLD."parts_sha256",'parser_revision',OLD."parser_revision",'source_format',OLD."source_format",'representation_revision',OLD."representation_revision",'service_market',OLD."service_market",'locale',OLD."locale",'time_zone',OLD."time_zone",'expires_at_ms',OLD."expires_at_ms",'headers_json',OLD."headers_json",'row_count',OLD."row_count",'part_count',OLD."part_count",'byte_length',OLD."byte_length",'state',OLD."state")
  FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id)
    AND json_extract(q.decision_json,'$.dispositions.ingestion.action')='Retain'
    AND json_extract(q.decision_json,'$.dispositions.ingestion.retention.untilMs')>unixepoch('subsec')*1000;
END;

CREATE TRIGGER erasure_preserve_statement_needs_review_delete BEFORE DELETE ON statement_needs_review
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id)
  AND json_extract(q.decision_json,'$.dispositions.ingestion.action')='Retain'
  AND json_extract(q.decision_json,'$.dispositions.ingestion.retention.untilMs')>unixepoch('subsec')*1000)
BEGIN
  INSERT INTO erasure_archives(request_id,store_id,row_ref,body)
  SELECT q.id,'statement_needs_review','drain:'||lower(hex(randomblob(16))),json_object('id',OLD."id",'user_id',OLD."user_id",'submission_id',OLD."submission_id",'record_number',OLD."record_number",'reason',OLD."reason",'original_evidence',OLD."original_evidence",'known_money',OLD."known_money",'issues',OLD."issues",'status',OLD."status",'evidence_expires_at_ms',OLD."evidence_expires_at_ms",'created_at_ms',OLD."created_at_ms",'service_market',OLD."service_market",'locale',OLD."locale",'time_zone',OLD."time_zone",'source_format',OLD."source_format",'parser_revision',OLD."parser_revision",'extractor_revision',OLD."extractor_revision")
  FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id)
    AND json_extract(q.decision_json,'$.dispositions.ingestion.action')='Retain'
    AND json_extract(q.decision_json,'$.dispositions.ingestion.retention.untilMs')>unixepoch('subsec')*1000;
END;

CREATE TRIGGER erasure_preserve_statement_record_outcomes_delete BEFORE DELETE ON statement_record_outcomes
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id)
  AND json_extract(q.decision_json,'$.dispositions.ingestion.action')='Retain'
  AND json_extract(q.decision_json,'$.dispositions.ingestion.retention.untilMs')>unixepoch('subsec')*1000)
BEGIN
  INSERT INTO erasure_archives(request_id,store_id,row_ref,body)
  SELECT q.id,'statement_record_outcomes','drain:'||lower(hex(randomblob(16))),json_object('user_id',OLD."user_id",'submission_id',OLD."submission_id",'record_number',OLD."record_number",'outcome',OLD."outcome",'transaction_id',OLD."transaction_id")
  FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id)
    AND json_extract(q.decision_json,'$.dispositions.ingestion.action')='Retain'
    AND json_extract(q.decision_json,'$.dispositions.ingestion.retention.untilMs')>unixepoch('subsec')*1000;
END;

CREATE TRIGGER erasure_preserve_statement_review_decisions_delete BEFORE DELETE ON statement_review_decisions
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id)
  AND json_extract(q.decision_json,'$.dispositions.ingestion.action')='Retain'
  AND json_extract(q.decision_json,'$.dispositions.ingestion.retention.untilMs')>unixepoch('subsec')*1000)
BEGIN
  INSERT INTO erasure_archives(request_id,store_id,row_ref,body)
  SELECT q.id,'statement_review_decisions','drain:'||lower(hex(randomblob(16))),json_object('review_id',OLD."review_id",'submission_id',OLD."submission_id",'user_id',OLD."user_id",'decision',OLD."decision",'transaction_id',OLD."transaction_id",'decided_at_ms',OLD."decided_at_ms")
  FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id)
    AND json_extract(q.decision_json,'$.dispositions.ingestion.action')='Retain'
    AND json_extract(q.decision_json,'$.dispositions.ingestion.retention.untilMs')>unixepoch('subsec')*1000;
END;

CREATE TRIGGER erasure_preserve_statement_staging_objects_delete BEFORE DELETE ON statement_staging_objects
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id)
  AND json_extract(q.decision_json,'$.dispositions.ingestion.action')='Retain'
  AND json_extract(q.decision_json,'$.dispositions.ingestion.retention.untilMs')>unixepoch('subsec')*1000)
BEGIN
  INSERT INTO erasure_archives(request_id,store_id,row_ref,body)
  SELECT q.id,'statement_staging_objects','drain:'||lower(hex(randomblob(16))),json_object('id',OLD."id",'user_id',OLD."user_id",'object_key',OLD."object_key",'byte_length',OLD."byte_length",'sha256',OLD."sha256",'status',OLD."status",'created_at_ms',OLD."created_at_ms",'expires_at_ms',OLD."expires_at_ms",'published_submission_id',OLD."published_submission_id",'source_format',OLD."source_format",'object_deleted_at_ms',OLD."object_deleted_at_ms")
  FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id)
    AND json_extract(q.decision_json,'$.dispositions.ingestion.action')='Retain'
    AND json_extract(q.decision_json,'$.dispositions.ingestion.retention.untilMs')>unixepoch('subsec')*1000;
END;

CREATE TRIGGER erasure_preserve_statement_submissions_delete BEFORE DELETE ON statement_submissions
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id)
  AND json_extract(q.decision_json,'$.dispositions.ingestion.action')='Retain'
  AND json_extract(q.decision_json,'$.dispositions.ingestion.retention.untilMs')>unixepoch('subsec')*1000)
BEGIN
  INSERT INTO erasure_archives(request_id,store_id,row_ref,body)
  SELECT q.id,'statement_submissions','drain:'||lower(hex(randomblob(16))),json_object('id',OLD."id",'user_id',OLD."user_id",'idempotency_key',OLD."idempotency_key",'staging_id',OLD."staging_id",'submitted_at_ms',OLD."submitted_at_ms",'source_format',OLD."source_format",'parser_revision',OLD."parser_revision",'service_market',OLD."service_market",'locale',OLD."locale",'time_zone',OLD."time_zone",'status',OLD."status",'started_at_ms',OLD."started_at_ms",'completed_at_ms',OLD."completed_at_ms",'legacy_failure_reason',OLD."legacy_failure_reason",'input_rows',OLD."input_rows",'accepted_rows',OLD."accepted_rows",'needs_review_rows',OLD."needs_review_rows",'retention_expires_at_ms',OLD."retention_expires_at_ms",'failure_reason',OLD."failure_reason",'source_parse_attempts',OLD."source_parse_attempts",'processed_rows',OLD."processed_rows",'processed_accepted_rows',OLD."processed_accepted_rows",'processed_review_rows',OLD."processed_review_rows")
  FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id)
    AND json_extract(q.decision_json,'$.dispositions.ingestion.action')='Retain'
    AND json_extract(q.decision_json,'$.dispositions.ingestion.retention.untilMs')>unixepoch('subsec')*1000;
END;

CREATE TRIGGER erasure_preserve_statement_whatsapp_documents_delete BEFORE DELETE ON statement_whatsapp_documents
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id)
  AND json_extract(q.decision_json,'$.dispositions.ingestion.action')='Retain'
  AND json_extract(q.decision_json,'$.dispositions.ingestion.retention.untilMs')>unixepoch('subsec')*1000)
BEGIN
  INSERT INTO erasure_archives(request_id,store_id,row_ref,body)
  SELECT q.id,'statement_whatsapp_documents','drain:'||lower(hex(randomblob(16))),json_object('turn_id',OLD."turn_id",'user_id',OLD."user_id",'media_id',OLD."media_id",'staging_id',OLD."staging_id",'upload_grant_id',OLD."upload_grant_id",'upload_expires_at_ms',OLD."upload_expires_at_ms",'reference_json',OLD."reference_json",'created_at_ms',OLD."created_at_ms")
  FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id)
    AND json_extract(q.decision_json,'$.dispositions.ingestion.action')='Retain'
    AND json_extract(q.decision_json,'$.dispositions.ingestion.retention.untilMs')>unixepoch('subsec')*1000;
END;

CREATE TRIGGER erasure_preserve_memories_delete BEFORE DELETE ON memories
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id)
  AND json_extract(q.decision_json,'$.dispositions.memory.action')='Retain'
  AND json_extract(q.decision_json,'$.dispositions.memory.retention.untilMs')>unixepoch('subsec')*1000)
BEGIN
  INSERT INTO erasure_archives(request_id,store_id,row_ref,body)
  SELECT q.id,'memories','drain:'||lower(hex(randomblob(16))),json_object('id',OLD."id",'user_id',OLD."user_id",'text',OLD."text",'created_at',OLD."created_at",'updated_at',OLD."updated_at")
  FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id)
    AND json_extract(q.decision_json,'$.dispositions.memory.action')='Retain'
    AND json_extract(q.decision_json,'$.dispositions.memory.retention.untilMs')>unixepoch('subsec')*1000;
END;

CREATE TRIGGER erasure_preserve_commercial_allowance_consumptions_delete BEFORE DELETE ON commercial_allowance_consumptions
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id)
  AND json_extract(q.decision_json,'$.dispositions.projections.action')='Retain'
  AND json_extract(q.decision_json,'$.dispositions.projections.retention.untilMs')>unixepoch('subsec')*1000)
BEGIN
  INSERT INTO erasure_archives(request_id,store_id,row_ref,body)
  SELECT q.id,'commercial_allowance_consumptions','drain:'||lower(hex(randomblob(16))),json_object('user_id',OLD."user_id",'allowance',OLD."allowance",'identity',OLD."identity",'period_start_ms',OLD."period_start_ms",'accepted_at_ms',OLD."accepted_at_ms",'units',OLD."units")
  FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id)
    AND json_extract(q.decision_json,'$.dispositions.projections.action')='Retain'
    AND json_extract(q.decision_json,'$.dispositions.projections.retention.untilMs')>unixepoch('subsec')*1000;
END;

CREATE TRIGGER erasure_preserve_canonical_request_acceptances_delete BEFORE DELETE ON canonical_request_acceptances
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id)
  AND json_extract(q.decision_json,'$.dispositions.schedules.action')='Retain'
  AND json_extract(q.decision_json,'$.dispositions.schedules.retention.untilMs')>unixepoch('subsec')*1000)
BEGIN
  INSERT INTO erasure_archives(request_id,store_id,row_ref,body)
  SELECT q.id,'canonical_request_acceptances','drain:'||lower(hex(randomblob(16))),json_object('id',OLD."id",'user_id',OLD."user_id",'pat_id',OLD."pat_id",'operation',OLD."operation",'accepted_at_ms',OLD."accepted_at_ms")
  FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id)
    AND json_extract(q.decision_json,'$.dispositions.schedules.action')='Retain'
    AND json_extract(q.decision_json,'$.dispositions.schedules.retention.untilMs')>unixepoch('subsec')*1000;
END;

CREATE TRIGGER erasure_preserve_canonical_request_buckets_delete BEFORE DELETE ON canonical_request_buckets
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state='Draining' AND (OLD.subject='user:'||q.user_id)
  AND json_extract(q.decision_json,'$.dispositions.schedules.action')='Retain'
  AND json_extract(q.decision_json,'$.dispositions.schedules.retention.untilMs')>unixepoch('subsec')*1000)
BEGIN
  INSERT INTO erasure_archives(request_id,store_id,row_ref,body)
  SELECT q.id,'canonical_request_buckets','drain:'||lower(hex(randomblob(16))),json_object('subject',OLD."subject",'virtual_at_ms',OLD."virtual_at_ms")
  FROM erasure_requests q WHERE q.state='Draining' AND (OLD.subject='user:'||q.user_id)
    AND json_extract(q.decision_json,'$.dispositions.schedules.action')='Retain'
    AND json_extract(q.decision_json,'$.dispositions.schedules.retention.untilMs')>unixepoch('subsec')*1000;
END;

CREATE TRIGGER erasure_preserve_canonical_request_leases_delete BEFORE DELETE ON canonical_request_leases
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id)
  AND json_extract(q.decision_json,'$.dispositions.schedules.action')='Retain'
  AND json_extract(q.decision_json,'$.dispositions.schedules.retention.untilMs')>unixepoch('subsec')*1000)
BEGIN
  INSERT INTO erasure_archives(request_id,store_id,row_ref,body)
  SELECT q.id,'canonical_request_leases','drain:'||lower(hex(randomblob(16))),json_object('id',OLD."id",'user_id',OLD."user_id",'expires_at_ms',OLD."expires_at_ms")
  FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id)
    AND json_extract(q.decision_json,'$.dispositions.schedules.action')='Retain'
    AND json_extract(q.decision_json,'$.dispositions.schedules.retention.untilMs')>unixepoch('subsec')*1000;
END;

CREATE TRIGGER erasure_preserve_canonical_request_replays_delete BEFORE DELETE ON canonical_request_replays
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id)
  AND json_extract(q.decision_json,'$.dispositions.schedules.action')='Retain'
  AND json_extract(q.decision_json,'$.dispositions.schedules.retention.untilMs')>unixepoch('subsec')*1000)
BEGIN
  INSERT INTO erasure_archives(request_id,store_id,row_ref,body)
  SELECT q.id,'canonical_request_replays','drain:'||lower(hex(randomblob(16))),json_object('user_id',OLD."user_id",'operation',OLD."operation",'identity',OLD."identity",'accepted_at_ms',OLD."accepted_at_ms",'expires_at_ms',OLD."expires_at_ms",'state',OLD."state",'status',OLD."status",'body',OLD."body",'content_type',OLD."content_type")
  FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id)
    AND json_extract(q.decision_json,'$.dispositions.schedules.action')='Retain'
    AND json_extract(q.decision_json,'$.dispositions.schedules.retention.untilMs')>unixepoch('subsec')*1000;
END;

CREATE TRIGGER erasure_preserve_canonical_security_mutations_delete BEFORE DELETE ON canonical_security_mutations
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id)
  AND json_extract(q.decision_json,'$.dispositions.schedules.action')='Retain'
  AND json_extract(q.decision_json,'$.dispositions.schedules.retention.untilMs')>unixepoch('subsec')*1000)
BEGIN
  INSERT INTO erasure_archives(request_id,store_id,row_ref,body)
  SELECT q.id,'canonical_security_mutations','drain:'||lower(hex(randomblob(16))),json_object('id',OLD."id",'user_id',OLD."user_id",'session_id',OLD."session_id",'operation',OLD."operation",'occurred_at_ms',OLD."occurred_at_ms")
  FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id)
    AND json_extract(q.decision_json,'$.dispositions.schedules.action')='Retain'
    AND json_extract(q.decision_json,'$.dispositions.schedules.retention.untilMs')>unixepoch('subsec')*1000;
END;
