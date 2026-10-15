CREATE TRIGGER erasure_preserve_canonical_user_reads_delete BEFORE DELETE ON canonical_user_reads
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id)
  AND json_extract(q.decision_json,'$.dispositions.schedules.action')='Retain'
  AND json_extract(q.decision_json,'$.dispositions.schedules.retention.untilMs')>unixepoch('subsec')*1000)
BEGIN
  INSERT INTO erasure_archives(request_id,store_id,row_ref,body)
  SELECT q.id,'canonical_user_reads','drain:'||lower(hex(randomblob(16))),json_object('id',OLD."id",'user_id',OLD."user_id",'session_id',OLD."session_id",'occurred_at_ms',OLD."occurred_at_ms")
  FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id)
    AND json_extract(q.decision_json,'$.dispositions.schedules.action')='Retain'
    AND json_extract(q.decision_json,'$.dispositions.schedules.retention.untilMs')>unixepoch('subsec')*1000;
END;

CREATE TRIGGER erasure_preserve_resource_admission_events_delete BEFORE DELETE ON resource_admission_events
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state='Draining' AND (OLD.scope_key=q.user_id)
  AND json_extract(q.decision_json,'$.dispositions.schedules.action')='Retain'
  AND json_extract(q.decision_json,'$.dispositions.schedules.retention.untilMs')>unixepoch('subsec')*1000)
BEGIN
  INSERT INTO erasure_archives(request_id,store_id,row_ref,body)
  SELECT q.id,'resource_admission_events','drain:'||lower(hex(randomblob(16))),json_object('grant_id',OLD."grant_id",'policy_key',OLD."policy_key",'dimension',OLD."dimension",'scope_key',OLD."scope_key",'policy_kind',OLD."policy_kind",'units',OLD."units",'admitted_at_epoch_ms',OLD."admitted_at_epoch_ms",'window_start_epoch_ms',OLD."window_start_epoch_ms",'expires_at_epoch_ms',OLD."expires_at_epoch_ms",'released_at_epoch_ms',OLD."released_at_epoch_ms")
  FROM erasure_requests q WHERE q.state='Draining' AND (OLD.scope_key=q.user_id)
    AND json_extract(q.decision_json,'$.dispositions.schedules.action')='Retain'
    AND json_extract(q.decision_json,'$.dispositions.schedules.retention.untilMs')>unixepoch('subsec')*1000;
END;

CREATE TRIGGER erasure_preserve_hosted_agent_sessions_delete BEFORE DELETE ON hosted_agent_sessions
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id)
  AND json_extract(q.decision_json,'$.dispositions.conversation.action')='Retain'
  AND json_extract(q.decision_json,'$.dispositions.conversation.retention.untilMs')>unixepoch('subsec')*1000)
BEGIN
  INSERT INTO erasure_archives(request_id,store_id,row_ref,body)
  SELECT q.id,'hosted_agent_sessions','drain:'||lower(hex(randomblob(16))),json_object('id',OLD."id",'user_id',OLD."user_id",'consent_basis_json',OLD."consent_basis_json",'started_at_ms',OLD."started_at_ms",'last_activity_at_ms',OLD."last_activity_at_ms",'status',OLD."status")
  FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id)
    AND json_extract(q.decision_json,'$.dispositions.conversation.action')='Retain'
    AND json_extract(q.decision_json,'$.dispositions.conversation.retention.untilMs')>unixepoch('subsec')*1000;
END;

CREATE TRIGGER erasure_preserve_hosted_compacted_conversations_delete BEFORE DELETE ON hosted_compacted_conversations
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id)
  AND json_extract(q.decision_json,'$.dispositions.conversation.action')='Retain'
  AND json_extract(q.decision_json,'$.dispositions.conversation.retention.untilMs')>unixepoch('subsec')*1000)
BEGIN
  INSERT INTO erasure_archives(request_id,store_id,row_ref,body)
  SELECT q.id,'hosted_compacted_conversations','drain:'||lower(hex(randomblob(16))),json_object('user_id',OLD."user_id",'hosted_session_id',OLD."hosted_session_id",'text',OLD."text",'through_sequence',OLD."through_sequence",'revision',OLD."revision",'updated_at_ms',OLD."updated_at_ms")
  FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id)
    AND json_extract(q.decision_json,'$.dispositions.conversation.action')='Retain'
    AND json_extract(q.decision_json,'$.dispositions.conversation.retention.untilMs')>unixepoch('subsec')*1000;
END;

CREATE TRIGGER erasure_preserve_hosted_compaction_attempts_delete BEFORE DELETE ON hosted_compaction_attempts
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id)
  AND json_extract(q.decision_json,'$.dispositions.conversation.action')='Retain'
  AND json_extract(q.decision_json,'$.dispositions.conversation.retention.untilMs')>unixepoch('subsec')*1000)
BEGIN
  INSERT INTO erasure_archives(request_id,store_id,row_ref,body)
  SELECT q.id,'hosted_compaction_attempts','drain:'||lower(hex(randomblob(16))),json_object('user_id',OLD."user_id",'day_ms',OLD."day_ms",'used',OLD."used")
  FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id)
    AND json_extract(q.decision_json,'$.dispositions.conversation.action')='Retain'
    AND json_extract(q.decision_json,'$.dispositions.conversation.retention.untilMs')>unixepoch('subsec')*1000;
END;

CREATE TRIGGER erasure_preserve_hosted_confirmations_delete BEFORE DELETE ON hosted_confirmations
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id)
  AND json_extract(q.decision_json,'$.dispositions.conversation.action')='Retain'
  AND json_extract(q.decision_json,'$.dispositions.conversation.retention.untilMs')>unixepoch('subsec')*1000)
BEGIN
  INSERT INTO erasure_archives(request_id,store_id,row_ref,body)
  SELECT q.id,'hosted_confirmations','drain:'||lower(hex(randomblob(16))),json_object('id',OLD."id",'user_id',OLD."user_id",'issued_turn_id',OLD."issued_turn_id",'operation',OLD."operation",'input_json',OLD."input_json",'command',OLD."command",'issued_at_ms',OLD."issued_at_ms",'expires_at_ms',OLD."expires_at_ms",'consumed_turn_id',OLD."consumed_turn_id",'consumed_at_ms',OLD."consumed_at_ms")
  FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id)
    AND json_extract(q.decision_json,'$.dispositions.conversation.action')='Retain'
    AND json_extract(q.decision_json,'$.dispositions.conversation.retention.untilMs')>unixepoch('subsec')*1000;
END;

CREATE TRIGGER erasure_preserve_hosted_delivery_proposals_delete BEFORE DELETE ON hosted_delivery_proposals
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id)
  AND json_extract(q.decision_json,'$.dispositions.conversation.action')='Retain'
  AND json_extract(q.decision_json,'$.dispositions.conversation.retention.untilMs')>unixepoch('subsec')*1000)
BEGIN
  INSERT INTO erasure_archives(request_id,store_id,row_ref,body)
  SELECT q.id,'hosted_delivery_proposals','drain:'||lower(hex(randomblob(16))),json_object('turn_id',OLD."turn_id",'user_id',OLD."user_id",'proposed_at_ms',OLD."proposed_at_ms",'text',OLD."text")
  FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id)
    AND json_extract(q.decision_json,'$.dispositions.conversation.action')='Retain'
    AND json_extract(q.decision_json,'$.dispositions.conversation.retention.untilMs')>unixepoch('subsec')*1000;
END;

CREATE TRIGGER erasure_preserve_hosted_mutation_commits_delete BEFORE DELETE ON hosted_mutation_commits
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id)
  AND json_extract(q.decision_json,'$.dispositions.conversation.action')='Retain'
  AND json_extract(q.decision_json,'$.dispositions.conversation.retention.untilMs')>unixepoch('subsec')*1000)
BEGIN
  INSERT INTO erasure_archives(request_id,store_id,row_ref,body)
  SELECT q.id,'hosted_mutation_commits','drain:'||lower(hex(randomblob(16))),json_object('turn_id',OLD."turn_id",'tool_call_id',OLD."tool_call_id",'user_id',OLD."user_id",'committed_at_ms',OLD."committed_at_ms",'valid',OLD."valid")
  FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id)
    AND json_extract(q.decision_json,'$.dispositions.conversation.action')='Retain'
    AND json_extract(q.decision_json,'$.dispositions.conversation.retention.untilMs')>unixepoch('subsec')*1000;
END;

CREATE TRIGGER erasure_preserve_hosted_turn_retention_delete BEFORE DELETE ON hosted_turn_retention
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id)
  AND json_extract(q.decision_json,'$.dispositions.conversation.action')='Retain'
  AND json_extract(q.decision_json,'$.dispositions.conversation.retention.untilMs')>unixepoch('subsec')*1000)
BEGIN
  INSERT INTO erasure_archives(request_id,store_id,row_ref,body)
  SELECT q.id,'hosted_turn_retention','drain:'||lower(hex(randomblob(16))),json_object('turn_id',OLD."turn_id",'user_id',OLD."user_id",'terminal_at_ms',OLD."terminal_at_ms")
  FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id)
    AND json_extract(q.decision_json,'$.dispositions.conversation.action')='Retain'
    AND json_extract(q.decision_json,'$.dispositions.conversation.retention.untilMs')>unixepoch('subsec')*1000;
END;

CREATE TRIGGER erasure_preserve_hosted_turns_delete BEFORE DELETE ON hosted_turns
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id)
  AND json_extract(q.decision_json,'$.dispositions.conversation.action')='Retain'
  AND json_extract(q.decision_json,'$.dispositions.conversation.retention.untilMs')>unixepoch('subsec')*1000)
BEGIN
  INSERT INTO erasure_archives(request_id,store_id,row_ref,body)
  SELECT q.id,'hosted_turns','drain:'||lower(hex(randomblob(16))),json_object('id',OLD."id",'user_id',OLD."user_id",'hosted_session_id',OLD."hosted_session_id",'started_at_ms',OLD."started_at_ms",'terminal_at_ms',OLD."terminal_at_ms",'status',OLD."status",'failure_reason',OLD."failure_reason")
  FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id)
    AND json_extract(q.decision_json,'$.dispositions.conversation.action')='Retain'
    AND json_extract(q.decision_json,'$.dispositions.conversation.retention.untilMs')>unixepoch('subsec')*1000;
END;

CREATE TRIGGER erasure_preserve_proactive_message_transcript_entries_delete BEFORE DELETE ON proactive_message_transcript_entries
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id)
  AND json_extract(q.decision_json,'$.dispositions.conversation.action')='Retain'
  AND json_extract(q.decision_json,'$.dispositions.conversation.retention.untilMs')>unixepoch('subsec')*1000)
BEGIN
  INSERT INTO erasure_archives(request_id,store_id,row_ref,body)
  SELECT q.id,'proactive_message_transcript_entries','drain:'||lower(hex(randomblob(16))),json_object('id',OLD."id",'user_id',OLD."user_id",'delivery_id',OLD."delivery_id",'role',OLD."role",'occurred_at_ms',OLD."occurred_at_ms",'text',OLD."text",'expires_at_ms',OLD."expires_at_ms")
  FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id)
    AND json_extract(q.decision_json,'$.dispositions.conversation.action')='Retain'
    AND json_extract(q.decision_json,'$.dispositions.conversation.retention.untilMs')>unixepoch('subsec')*1000;
END;

CREATE TRIGGER erasure_preserve_proactive_transcript_entries_delete BEFORE DELETE ON proactive_transcript_entries
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id)
  AND json_extract(q.decision_json,'$.dispositions.conversation.action')='Retain'
  AND json_extract(q.decision_json,'$.dispositions.conversation.retention.untilMs')>unixepoch('subsec')*1000)
BEGIN
  INSERT INTO erasure_archives(request_id,store_id,row_ref,body)
  SELECT q.id,'proactive_transcript_entries','drain:'||lower(hex(randomblob(16))),json_object('sequence',OLD."sequence",'id',OLD."id",'user_id',OLD."user_id",'insight_event_id',OLD."insight_event_id",'occurred_at_ms',OLD."occurred_at_ms",'text',OLD."text",'expires_at_ms',OLD."expires_at_ms")
  FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id)
    AND json_extract(q.decision_json,'$.dispositions.conversation.action')='Retain'
    AND json_extract(q.decision_json,'$.dispositions.conversation.retention.untilMs')>unixepoch('subsec')*1000;
END;

CREATE TRIGGER erasure_preserve_proactive_transcript_event_links_delete BEFORE DELETE ON proactive_transcript_event_links
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id)
  AND json_extract(q.decision_json,'$.dispositions.conversation.action')='Retain'
  AND json_extract(q.decision_json,'$.dispositions.conversation.retention.untilMs')>unixepoch('subsec')*1000)
BEGIN
  INSERT INTO erasure_archives(request_id,store_id,row_ref,body)
  SELECT q.id,'proactive_transcript_event_links','drain:'||lower(hex(randomblob(16))),json_object('user_id',OLD."user_id",'transcript_id',OLD."transcript_id",'insight_event_id',OLD."insight_event_id")
  FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id)
    AND json_extract(q.decision_json,'$.dispositions.conversation.action')='Retain'
    AND json_extract(q.decision_json,'$.dispositions.conversation.retention.untilMs')>unixepoch('subsec')*1000;
END;

CREATE TRIGGER erasure_preserve_transcript_entries_delete BEFORE DELETE ON transcript_entries
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id)
  AND json_extract(q.decision_json,'$.dispositions.conversation.action')='Retain'
  AND json_extract(q.decision_json,'$.dispositions.conversation.retention.untilMs')>unixepoch('subsec')*1000)
BEGIN
  INSERT INTO erasure_archives(request_id,store_id,row_ref,body)
  SELECT q.id,'transcript_entries','drain:'||lower(hex(randomblob(16))),json_object('sequence',OLD."sequence",'id',OLD."id",'user_id',OLD."user_id",'hosted_session_id',OLD."hosted_session_id",'turn_id',OLD."turn_id",'kind',OLD."kind",'occurred_at_ms',OLD."occurred_at_ms",'text',OLD."text",'failure_reason',OLD."failure_reason",'iteration',OLD."iteration",'tool_call_id',OLD."tool_call_id",'operation',OLD."operation",'input_json',OLD."input_json",'outcome_json',OLD."outcome_json")
  FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id)
    AND json_extract(q.decision_json,'$.dispositions.conversation.action')='Retain'
    AND json_extract(q.decision_json,'$.dispositions.conversation.retention.untilMs')>unixepoch('subsec')*1000;
END;

CREATE TRIGGER erasure_preserve_billing_access_adjustments_delete BEFORE DELETE ON billing_access_adjustments
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state='Draining' AND (EXISTS(SELECT 1 FROM refund_attempts p WHERE p.id=OLD.refund_id AND p.user_id=q.user_id))
  AND json_extract(q.decision_json,'$.dispositions.billing.action')='Retain'
  AND json_extract(q.decision_json,'$.dispositions.billing.retention.untilMs')>unixepoch('subsec')*1000)
BEGIN
  INSERT INTO erasure_archives(request_id,store_id,row_ref,body)
  SELECT q.id,'billing_access_adjustments','drain:'||lower(hex(randomblob(16))),json_object('refund_id',OLD."refund_id",'attempt_id',OLD."attempt_id",'ends_at_ms',OLD."ends_at_ms")
  FROM erasure_requests q WHERE q.state='Draining' AND (EXISTS(SELECT 1 FROM refund_attempts p WHERE p.id=OLD.refund_id AND p.user_id=q.user_id))
    AND json_extract(q.decision_json,'$.dispositions.billing.action')='Retain'
    AND json_extract(q.decision_json,'$.dispositions.billing.retention.untilMs')>unixepoch('subsec')*1000;
END;

CREATE TRIGGER erasure_preserve_billing_collection_arms_delete BEFORE DELETE ON billing_collection_arms
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state='Draining' AND (EXISTS(SELECT 1 FROM billing_attempts p WHERE p.id=OLD.attempt_id AND p.user_id=q.user_id))
  AND json_extract(q.decision_json,'$.dispositions.billing.action')='Retain'
  AND json_extract(q.decision_json,'$.dispositions.billing.retention.untilMs')>unixepoch('subsec')*1000)
BEGIN
  INSERT INTO erasure_archives(request_id,store_id,row_ref,body)
  SELECT q.id,'billing_collection_arms','drain:'||lower(hex(randomblob(16))),json_object('attempt_id',OLD."attempt_id",'state',OLD."state",'sent_at_ms',OLD."sent_at_ms")
  FROM erasure_requests q WHERE q.state='Draining' AND (EXISTS(SELECT 1 FROM billing_attempts p WHERE p.id=OLD.attempt_id AND p.user_id=q.user_id))
    AND json_extract(q.decision_json,'$.dispositions.billing.action')='Retain'
    AND json_extract(q.decision_json,'$.dispositions.billing.retention.untilMs')>unixepoch('subsec')*1000;
END;

CREATE TRIGGER erasure_preserve_billing_collection_outbox_delete BEFORE DELETE ON billing_collection_outbox
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state='Draining' AND (EXISTS(SELECT 1 FROM billing_attempts p WHERE p.id=OLD.attempt_id AND p.user_id=q.user_id))
  AND json_extract(q.decision_json,'$.dispositions.billing.action')='Retain'
  AND json_extract(q.decision_json,'$.dispositions.billing.retention.untilMs')>unixepoch('subsec')*1000)
BEGIN
  INSERT INTO erasure_archives(request_id,store_id,row_ref,body)
  SELECT q.id,'billing_collection_outbox','drain:'||lower(hex(randomblob(16))),json_object('attempt_id',OLD."attempt_id",'version',OLD."version",'last_attempt_at_ms',OLD."last_attempt_at_ms",'published_at_ms',OLD."published_at_ms")
  FROM erasure_requests q WHERE q.state='Draining' AND (EXISTS(SELECT 1 FROM billing_attempts p WHERE p.id=OLD.attempt_id AND p.user_id=q.user_id))
    AND json_extract(q.decision_json,'$.dispositions.billing.action')='Retain'
    AND json_extract(q.decision_json,'$.dispositions.billing.retention.untilMs')>unixepoch('subsec')*1000;
END;

CREATE TRIGGER erasure_preserve_billing_event_candidates_delete BEFORE DELETE ON billing_event_candidates
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state='Draining' AND (EXISTS(SELECT 1 FROM billing_transaction_evidence p JOIN billing_attempts a ON a.id=p.attempt_id WHERE p.transaction_id=OLD.transaction_id AND a.user_id=q.user_id))
  AND json_extract(q.decision_json,'$.dispositions.billing.action')='Retain'
  AND json_extract(q.decision_json,'$.dispositions.billing.retention.untilMs')>unixepoch('subsec')*1000)
BEGIN
  INSERT INTO erasure_archives(request_id,store_id,row_ref,body)
  SELECT q.id,'billing_event_candidates','drain:'||lower(hex(randomblob(16))),json_object('transaction_id',OLD."transaction_id",'received_at_ms',OLD."received_at_ms",'signed_at',OLD."signed_at",'signed_status',OLD."signed_status",'lookup_attempts',OLD."lookup_attempts",'last_checked_at_ms',OLD."last_checked_at_ms",'resolved_at_ms',OLD."resolved_at_ms")
  FROM erasure_requests q WHERE q.state='Draining' AND (EXISTS(SELECT 1 FROM billing_transaction_evidence p JOIN billing_attempts a ON a.id=p.attempt_id WHERE p.transaction_id=OLD.transaction_id AND a.user_id=q.user_id))
    AND json_extract(q.decision_json,'$.dispositions.billing.action')='Retain'
    AND json_extract(q.decision_json,'$.dispositions.billing.retention.untilMs')>unixepoch('subsec')*1000;
END;

CREATE TRIGGER erasure_preserve_billing_followup_outbox_delete BEFORE DELETE ON billing_followup_outbox
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state='Draining' AND (EXISTS(SELECT 1 FROM billing_attempts p WHERE p.id=OLD.attempt_id AND p.user_id=q.user_id))
  AND json_extract(q.decision_json,'$.dispositions.billing.action')='Retain'
  AND json_extract(q.decision_json,'$.dispositions.billing.retention.untilMs')>unixepoch('subsec')*1000)
BEGIN
  INSERT INTO erasure_archives(request_id,store_id,row_ref,body)
  SELECT q.id,'billing_followup_outbox','drain:'||lower(hex(randomblob(16))),json_object('attempt_id',OLD."attempt_id",'kind',OLD."kind",'due_at_ms',OLD."due_at_ms")
  FROM erasure_requests q WHERE q.state='Draining' AND (EXISTS(SELECT 1 FROM billing_attempts p WHERE p.id=OLD.attempt_id AND p.user_id=q.user_id))
    AND json_extract(q.decision_json,'$.dispositions.billing.action')='Retain'
    AND json_extract(q.decision_json,'$.dispositions.billing.retention.untilMs')>unixepoch('subsec')*1000;
END;

CREATE TRIGGER erasure_preserve_billing_no_charge_confirmations_delete BEFORE DELETE ON billing_no_charge_confirmations
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state='Draining' AND (EXISTS(SELECT 1 FROM billing_attempts p WHERE p.id=OLD.attempt_id AND p.user_id=q.user_id))
  AND json_extract(q.decision_json,'$.dispositions.billing.action')='Retain'
  AND json_extract(q.decision_json,'$.dispositions.billing.retention.untilMs')>unixepoch('subsec')*1000)
BEGIN
  INSERT INTO erasure_archives(request_id,store_id,row_ref,body)
  SELECT q.id,'billing_no_charge_confirmations','drain:'||lower(hex(randomblob(16))),json_object('attempt_id',OLD."attempt_id",'wompi_reference',OLD."wompi_reference",'wompi_environment',OLD."wompi_environment",'provider_case_id',OLD."provider_case_id",'operator_id',OLD."operator_id",'confirmed_at_ms',OLD."confirmed_at_ms")
  FROM erasure_requests q WHERE q.state='Draining' AND (EXISTS(SELECT 1 FROM billing_attempts p WHERE p.id=OLD.attempt_id AND p.user_id=q.user_id))
    AND json_extract(q.decision_json,'$.dispositions.billing.action')='Retain'
    AND json_extract(q.decision_json,'$.dispositions.billing.retention.untilMs')>unixepoch('subsec')*1000;
END;

CREATE TRIGGER erasure_preserve_billing_price_notices_delete BEFORE DELETE ON billing_price_notices
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id)
  AND json_extract(q.decision_json,'$.dispositions.billing.action')='Retain'
  AND json_extract(q.decision_json,'$.dispositions.billing.retention.untilMs')>unixepoch('subsec')*1000)
BEGIN
  INSERT INTO erasure_archives(request_id,store_id,row_ref,body)
  SELECT q.id,'billing_price_notices','drain:'||lower(hex(randomblob(16))),json_object('user_id',OLD."user_id",'price_id',OLD."price_id",'created_at_ms',OLD."created_at_ms",'last_offered_at_ms',OLD."last_offered_at_ms",'send_started_at_ms',OLD."send_started_at_ms",'accepted_at_ms',OLD."accepted_at_ms")
  FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id)
    AND json_extract(q.decision_json,'$.dispositions.billing.action')='Retain'
    AND json_extract(q.decision_json,'$.dispositions.billing.retention.untilMs')>unixepoch('subsec')*1000;
END;

CREATE TRIGGER erasure_preserve_billing_recovery_reviews_delete BEFORE DELETE ON billing_recovery_reviews
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state='Draining' AND (EXISTS(SELECT 1 FROM billing_attempts p WHERE p.id=OLD.attempt_id AND p.user_id=q.user_id))
  AND json_extract(q.decision_json,'$.dispositions.billing.action')='Retain'
  AND json_extract(q.decision_json,'$.dispositions.billing.retention.untilMs')>unixepoch('subsec')*1000)
BEGIN
  INSERT INTO erasure_archives(request_id,store_id,row_ref,body)
  SELECT q.id,'billing_recovery_reviews','drain:'||lower(hex(randomblob(16))),json_object('attempt_id',OLD."attempt_id",'provider_case_id',OLD."provider_case_id",'occurred_at_ms',OLD."occurred_at_ms")
  FROM erasure_requests q WHERE q.state='Draining' AND (EXISTS(SELECT 1 FROM billing_attempts p WHERE p.id=OLD.attempt_id AND p.user_id=q.user_id))
    AND json_extract(q.decision_json,'$.dispositions.billing.action')='Retain'
    AND json_extract(q.decision_json,'$.dispositions.billing.retention.untilMs')>unixepoch('subsec')*1000;
END;

CREATE TRIGGER erasure_preserve_billing_transaction_candidates_delete BEFORE DELETE ON billing_transaction_candidates
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state='Draining' AND (EXISTS(SELECT 1 FROM billing_attempts p WHERE p.id=OLD.attempt_id AND p.user_id=q.user_id))
  AND json_extract(q.decision_json,'$.dispositions.billing.action')='Retain'
  AND json_extract(q.decision_json,'$.dispositions.billing.retention.untilMs')>unixepoch('subsec')*1000)
BEGIN
  INSERT INTO erasure_archives(request_id,store_id,row_ref,body)
  SELECT q.id,'billing_transaction_candidates','drain:'||lower(hex(randomblob(16))),json_object('transaction_id',OLD."transaction_id",'attempt_id',OLD."attempt_id",'lookup_attempts',OLD."lookup_attempts",'last_checked_at_ms',OLD."last_checked_at_ms")
  FROM erasure_requests q WHERE q.state='Draining' AND (EXISTS(SELECT 1 FROM billing_attempts p WHERE p.id=OLD.attempt_id AND p.user_id=q.user_id))
    AND json_extract(q.decision_json,'$.dispositions.billing.action')='Retain'
    AND json_extract(q.decision_json,'$.dispositions.billing.retention.untilMs')>unixepoch('subsec')*1000;
END;

CREATE TRIGGER erasure_preserve_billing_transaction_evidence_delete BEFORE DELETE ON billing_transaction_evidence
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state='Draining' AND (EXISTS(SELECT 1 FROM billing_attempts p WHERE p.id=OLD.attempt_id AND p.user_id=q.user_id))
  AND json_extract(q.decision_json,'$.dispositions.billing.action')='Retain'
  AND json_extract(q.decision_json,'$.dispositions.billing.retention.untilMs')>unixepoch('subsec')*1000)
BEGIN
  INSERT INTO erasure_archives(request_id,store_id,row_ref,body)
  SELECT q.id,'billing_transaction_evidence','drain:'||lower(hex(randomblob(16))),json_object('transaction_id',OLD."transaction_id",'attempt_id',OLD."attempt_id",'status',OLD."status",'first_observed_at_ms',OLD."first_observed_at_ms",'negative_observed_at_ms',OLD."negative_observed_at_ms",'finalized_at_ms',OLD."finalized_at_ms")
  FROM erasure_requests q WHERE q.state='Draining' AND (EXISTS(SELECT 1 FROM billing_attempts p WHERE p.id=OLD.attempt_id AND p.user_id=q.user_id))
    AND json_extract(q.decision_json,'$.dispositions.billing.action')='Retain'
    AND json_extract(q.decision_json,'$.dispositions.billing.retention.untilMs')>unixepoch('subsec')*1000;
END;

CREATE TRIGGER erasure_preserve_card_enrollments_delete BEFORE DELETE ON card_enrollments
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id)
  AND json_extract(q.decision_json,'$.dispositions.billing.action')='Retain'
  AND json_extract(q.decision_json,'$.dispositions.billing.retention.untilMs')>unixepoch('subsec')*1000)
BEGIN
  INSERT INTO erasure_archives(request_id,store_id,row_ref,body)
  SELECT q.id,'card_enrollments','drain:'||lower(hex(randomblob(16))),json_object('id',OLD."id",'user_id',OLD."user_id",'price_id',OLD."price_id",'billing_email',OLD."billing_email",'status',OLD."status",'payment_source_mode',OLD."payment_source_mode",'contracts_json',OLD."contracts_json",'disclosure_json',OLD."disclosure_json",'prepared_at_ms',OLD."prepared_at_ms",'expires_at_ms',OLD."expires_at_ms",'accepted_at_ms',OLD."accepted_at_ms",'payment_request_id',OLD."payment_request_id",'wompi_candidate_source_id',OLD."wompi_candidate_source_id",'verification_attempts',OLD."verification_attempts",'last_verification_at_ms',OLD."last_verification_at_ms",'refusal_reason',OLD."refusal_reason",'method',OLD."method",'wompi_environment',OLD."wompi_environment")
  FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id)
    AND json_extract(q.decision_json,'$.dispositions.billing.action')='Retain'
    AND json_extract(q.decision_json,'$.dispositions.billing.retention.untilMs')>unixepoch('subsec')*1000;
END;

CREATE TRIGGER erasure_preserve_card_payment_sources_delete BEFORE DELETE ON card_payment_sources
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id)
  AND json_extract(q.decision_json,'$.dispositions.billing.action')='Retain'
  AND json_extract(q.decision_json,'$.dispositions.billing.retention.untilMs')>unixepoch('subsec')*1000)
BEGIN
  INSERT INTO erasure_archives(request_id,store_id,row_ref,body)
  SELECT q.id,'card_payment_sources','drain:'||lower(hex(randomblob(16))),json_object('id',OLD."id",'user_id',OLD."user_id",'enrollment_id',OLD."enrollment_id",'wompi_source_id',OLD."wompi_source_id",'billing_email',OLD."billing_email",'created_at_ms',OLD."created_at_ms",'method',OLD."method")
  FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id)
    AND json_extract(q.decision_json,'$.dispositions.billing.action')='Retain'
    AND json_extract(q.decision_json,'$.dispositions.billing.retention.untilMs')>unixepoch('subsec')*1000;
END;

CREATE TRIGGER erasure_preserve_payment_commit_guards_delete BEFORE DELETE ON payment_commit_guards
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state='Draining' AND (EXISTS(SELECT 1 FROM card_enrollments p WHERE p.id=OLD.enrollment_id AND p.user_id=q.user_id))
  AND json_extract(q.decision_json,'$.dispositions.billing.action')='Retain'
  AND json_extract(q.decision_json,'$.dispositions.billing.retention.untilMs')>unixepoch('subsec')*1000)
BEGIN
  INSERT INTO erasure_archives(request_id,store_id,row_ref,body)
  SELECT q.id,'payment_commit_guards','drain:'||lower(hex(randomblob(16))),json_object('enrollment_id',OLD."enrollment_id",'allowed',OLD."allowed")
  FROM erasure_requests q WHERE q.state='Draining' AND (EXISTS(SELECT 1 FROM card_enrollments p WHERE p.id=OLD.enrollment_id AND p.user_id=q.user_id))
    AND json_extract(q.decision_json,'$.dispositions.billing.action')='Retain'
    AND json_extract(q.decision_json,'$.dispositions.billing.retention.untilMs')>unixepoch('subsec')*1000;
END;

CREATE TRIGGER erasure_preserve_refund_attempts_delete BEFORE DELETE ON refund_attempts
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id)
  AND json_extract(q.decision_json,'$.dispositions.billing.action')='Retain'
  AND json_extract(q.decision_json,'$.dispositions.billing.retention.untilMs')>unixepoch('subsec')*1000)
BEGIN
  INSERT INTO erasure_archives(request_id,store_id,row_ref,body)
  SELECT q.id,'refund_attempts','drain:'||lower(hex(randomblob(16))),json_object('id',OLD."id",'user_id',OLD."user_id",'subscription_id',OLD."subscription_id",'billing_attempt_id',OLD."billing_attempt_id",'transaction_id',OLD."transaction_id",'request_id',OLD."request_id",'intent_json',OLD."intent_json",'snapshot_json',OLD."snapshot_json",'amount_in_cents',OLD."amount_in_cents",'original_cents',OLD."original_cents",'kind',OLD."kind",'operator_id',OLD."operator_id",'created_at_ms',OLD."created_at_ms",'status',OLD."status",'progress',OLD."progress",'finalized_at_ms',OLD."finalized_at_ms",'failure',OLD."failure")
  FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id)
    AND json_extract(q.decision_json,'$.dispositions.billing.action')='Retain'
    AND json_extract(q.decision_json,'$.dispositions.billing.retention.untilMs')>unixepoch('subsec')*1000;
END;

CREATE TRIGGER erasure_preserve_refund_outbox_delete BEFORE DELETE ON refund_outbox
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state='Draining' AND (EXISTS(SELECT 1 FROM refund_attempts p WHERE p.id=OLD.refund_id AND p.user_id=q.user_id))
  AND json_extract(q.decision_json,'$.dispositions.billing.action')='Retain'
  AND json_extract(q.decision_json,'$.dispositions.billing.retention.untilMs')>unixepoch('subsec')*1000)
BEGIN
  INSERT INTO erasure_archives(request_id,store_id,row_ref,body)
  SELECT q.id,'refund_outbox','drain:'||lower(hex(randomblob(16))),json_object('refund_id',OLD."refund_id",'version',OLD."version",'last_attempt_at_ms',OLD."last_attempt_at_ms",'published_at_ms',OLD."published_at_ms",'verification_attempts',OLD."verification_attempts",'last_verification_at_ms',OLD."last_verification_at_ms")
  FROM erasure_requests q WHERE q.state='Draining' AND (EXISTS(SELECT 1 FROM refund_attempts p WHERE p.id=OLD.refund_id AND p.user_id=q.user_id))
    AND json_extract(q.decision_json,'$.dispositions.billing.action')='Retain'
    AND json_extract(q.decision_json,'$.dispositions.billing.retention.untilMs')>unixepoch('subsec')*1000;
END;

CREATE TRIGGER erasure_preserve_refund_outcome_evidence_delete BEFORE DELETE ON refund_outcome_evidence
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state='Draining' AND (EXISTS(SELECT 1 FROM refund_attempts p WHERE p.id=OLD.refund_id AND p.user_id=q.user_id))
  AND json_extract(q.decision_json,'$.dispositions.billing.action')='Retain'
  AND json_extract(q.decision_json,'$.dispositions.billing.retention.untilMs')>unixepoch('subsec')*1000)
BEGIN
  INSERT INTO erasure_archives(request_id,store_id,row_ref,body)
  SELECT q.id,'refund_outcome_evidence','drain:'||lower(hex(randomblob(16))),json_object('refund_id',OLD."refund_id",'provider_id',OLD."provider_id",'verified_status',OLD."verified_status",'observed_at_ms',OLD."observed_at_ms")
  FROM erasure_requests q WHERE q.state='Draining' AND (EXISTS(SELECT 1 FROM refund_attempts p WHERE p.id=OLD.refund_id AND p.user_id=q.user_id))
    AND json_extract(q.decision_json,'$.dispositions.billing.action')='Retain'
    AND json_extract(q.decision_json,'$.dispositions.billing.retention.untilMs')>unixepoch('subsec')*1000;
END;

CREATE TRIGGER erasure_preserve_refund_submission_claims_delete BEFORE DELETE ON refund_submission_claims
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state='Draining' AND (EXISTS(SELECT 1 FROM refund_attempts p WHERE p.id=OLD.refund_id AND p.user_id=q.user_id))
  AND json_extract(q.decision_json,'$.dispositions.billing.action')='Retain'
  AND json_extract(q.decision_json,'$.dispositions.billing.retention.untilMs')>unixepoch('subsec')*1000)
BEGIN
  INSERT INTO erasure_archives(request_id,store_id,row_ref,body)
  SELECT q.id,'refund_submission_claims','drain:'||lower(hex(randomblob(16))),json_object('refund_id',OLD."refund_id",'claimed_at_ms',OLD."claimed_at_ms")
  FROM erasure_requests q WHERE q.state='Draining' AND (EXISTS(SELECT 1 FROM refund_attempts p WHERE p.id=OLD.refund_id AND p.user_id=q.user_id))
    AND json_extract(q.decision_json,'$.dispositions.billing.action')='Retain'
    AND json_extract(q.decision_json,'$.dispositions.billing.retention.untilMs')>unixepoch('subsec')*1000;
END;

CREATE TRIGGER erasure_preserve_subscription_cancellations_delete BEFORE DELETE ON subscription_cancellations
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id)
  AND json_extract(q.decision_json,'$.dispositions.billing.action')='Retain'
  AND json_extract(q.decision_json,'$.dispositions.billing.retention.untilMs')>unixepoch('subsec')*1000)
BEGIN
  INSERT INTO erasure_archives(request_id,store_id,row_ref,body)
  SELECT q.id,'subscription_cancellations','drain:'||lower(hex(randomblob(16))),json_object('user_id',OLD."user_id",'paid_attempt_id',OLD."paid_attempt_id",'payment_source_id',OLD."payment_source_id",'cancelled_at_ms',OLD."cancelled_at_ms",'paid_through_ms',OLD."paid_through_ms",'source_cancellation',OLD."source_cancellation",'void_started_at_ms',OLD."void_started_at_ms",'void_verified_at_ms',OLD."void_verified_at_ms",'verification_count',OLD."verification_count",'last_offered_at_ms',OLD."last_offered_at_ms")
  FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id)
    AND json_extract(q.decision_json,'$.dispositions.billing.action')='Retain'
    AND json_extract(q.decision_json,'$.dispositions.billing.retention.untilMs')>unixepoch('subsec')*1000;
END;

CREATE TRIGGER erasure_preserve_subscription_identities_delete BEFORE DELETE ON subscription_identities
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id)
  AND json_extract(q.decision_json,'$.dispositions.billing.action')='Retain'
  AND json_extract(q.decision_json,'$.dispositions.billing.retention.untilMs')>unixepoch('subsec')*1000)
BEGIN
  INSERT INTO erasure_archives(request_id,store_id,row_ref,body)
  SELECT q.id,'subscription_identities','drain:'||lower(hex(randomblob(16))),json_object('user_id',OLD."user_id",'id',OLD."id")
  FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id)
    AND json_extract(q.decision_json,'$.dispositions.billing.action')='Retain'
    AND json_extract(q.decision_json,'$.dispositions.billing.retention.untilMs')>unixepoch('subsec')*1000;
END;

CREATE TRIGGER erasure_preserve_subscription_renewal_stops_delete BEFORE DELETE ON subscription_renewal_stops
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id)
  AND json_extract(q.decision_json,'$.dispositions.billing.action')='Retain'
  AND json_extract(q.decision_json,'$.dispositions.billing.retention.untilMs')>unixepoch('subsec')*1000)
BEGIN
  INSERT INTO erasure_archives(request_id,store_id,row_ref,body)
  SELECT q.id,'subscription_renewal_stops','drain:'||lower(hex(randomblob(16))),json_object('refund_id',OLD."refund_id",'user_id',OLD."user_id",'stopped_at_ms',OLD."stopped_at_ms")
  FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id)
    AND json_extract(q.decision_json,'$.dispositions.billing.action')='Retain'
    AND json_extract(q.decision_json,'$.dispositions.billing.retention.untilMs')>unixepoch('subsec')*1000;
END;

CREATE TRIGGER erasure_preserve_subscriptions_delete BEFORE DELETE ON subscriptions
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id)
  AND json_extract(q.decision_json,'$.dispositions.billing.action')='Retain'
  AND json_extract(q.decision_json,'$.dispositions.billing.retention.untilMs')>unixepoch('subsec')*1000)
BEGIN
  INSERT INTO erasure_archives(request_id,store_id,row_ref,body)
  SELECT q.id,'subscriptions','drain:'||lower(hex(randomblob(16))),json_object('user_id',OLD."user_id",'attempt_id',OLD."attempt_id",'price_id',OLD."price_id",'paid_period_ends_at_ms',OLD."paid_period_ends_at_ms",'renewal_anchor_ms',OLD."renewal_anchor_ms")
  FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id)
    AND json_extract(q.decision_json,'$.dispositions.billing.action')='Retain'
    AND json_extract(q.decision_json,'$.dispositions.billing.retention.untilMs')>unixepoch('subsec')*1000;
END;

CREATE TRIGGER erasure_preserve_billing_attempts_delete BEFORE DELETE ON billing_attempts
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id)
  AND json_extract(q.decision_json,'$.dispositions.billing.action')='Retain'
  AND json_extract(q.decision_json,'$.dispositions.billing.retention.untilMs')>unixepoch('subsec')*1000)
BEGIN
  INSERT INTO erasure_archives(request_id,store_id,row_ref,body)
  SELECT q.id,'billing_history','drain:'||lower(hex(randomblob(16))),json_object('id',OLD."id",'user_id',OLD."user_id",'enrollment_id',OLD."enrollment_id",'payment_request_id',OLD."payment_request_id",'payment_source_id',OLD."payment_source_id",'price_id',OLD."price_id",'amount',OLD."amount",'currency',OLD."currency",'billing_period',OLD."billing_period",'service_market',OLD."service_market",'tax_treatment',OLD."tax_treatment",'time_zone',OLD."time_zone",'wompi_environment',OLD."wompi_environment",'wompi_reference',OLD."wompi_reference",'status',OLD."status",'created_at_ms',OLD."created_at_ms",'finalized_at_ms',OLD."finalized_at_ms",'previous_paid_attempt_id',OLD."previous_paid_attempt_id",'period_starts_at_ms',OLD."period_starts_at_ms",'period_ends_at_ms',OLD."period_ends_at_ms",'attempt_number',OLD."attempt_number",'calendar_anchor_ms',OLD."calendar_anchor_ms",'renewal_attempt_number',OLD."renewal_attempt_number")
  FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id)
    AND json_extract(q.decision_json,'$.dispositions.billing.action')='Retain'
    AND json_extract(q.decision_json,'$.dispositions.billing.retention.untilMs')>unixepoch('subsec')*1000;
END;

CREATE TRIGGER erasure_preserve_billing_paid_periods_delete BEFORE DELETE ON billing_paid_periods
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state='Draining' AND (EXISTS(SELECT 1 FROM billing_attempts p WHERE p.id=OLD.attempt_id AND p.user_id=q.user_id))
  AND json_extract(q.decision_json,'$.dispositions.billing.action')='Retain'
  AND json_extract(q.decision_json,'$.dispositions.billing.retention.untilMs')>unixepoch('subsec')*1000)
BEGIN
  INSERT INTO erasure_archives(request_id,store_id,row_ref,body)
  SELECT q.id,'billing_history','drain:'||lower(hex(randomblob(16))),json_object('attempt_id',OLD."attempt_id",'starts_at_ms',OLD."starts_at_ms",'ends_at_ms',OLD."ends_at_ms",'renewal_anchor_ms',OLD."renewal_anchor_ms")
  FROM erasure_requests q WHERE q.state='Draining' AND (EXISTS(SELECT 1 FROM billing_attempts p WHERE p.id=OLD.attempt_id AND p.user_id=q.user_id))
    AND json_extract(q.decision_json,'$.dispositions.billing.action')='Retain'
    AND json_extract(q.decision_json,'$.dispositions.billing.retention.untilMs')>unixepoch('subsec')*1000;
END;

CREATE TRIGGER erasure_preserve_dashboard_documents_delete BEFORE DELETE ON dashboard_documents
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id)
  AND json_extract(q.decision_json,'$.dispositions.projections.action')='Retain'
  AND json_extract(q.decision_json,'$.dispositions.projections.retention.untilMs')>unixepoch('subsec')*1000)
BEGIN
  INSERT INTO erasure_archives(request_id,store_id,row_ref,body)
  SELECT q.id,'dashboard_documents','drain:'||lower(hex(randomblob(16))),json_object('user_id',OLD."user_id",'document_json',OLD."document_json",'revision',OLD."revision")
  FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id)
    AND json_extract(q.decision_json,'$.dispositions.projections.action')='Retain'
    AND json_extract(q.decision_json,'$.dispositions.projections.retention.untilMs')>unixepoch('subsec')*1000;
END;

CREATE TRIGGER erasure_preserve_connection_attempts_delete BEFORE DELETE ON connection_attempts
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id)
  AND json_extract(q.decision_json,'$.dispositions.projections.action')='Retain'
  AND json_extract(q.decision_json,'$.dispositions.projections.retention.untilMs')>unixepoch('subsec')*1000)
BEGIN
  INSERT INTO erasure_archives(request_id,store_id,row_ref,body)
  SELECT q.id,'connection_attempts','drain:'||lower(hex(randomblob(16))),json_object('id',OLD."id",'user_id',OLD."user_id",'connection_id',OLD."connection_id",'institution_id',OLD."institution_id",'public_reference',OLD."public_reference",'status',OLD."status",'created_at_ms',OLD."created_at_ms",'expires_at_ms',OLD."expires_at_ms",'consumed_at_ms',OLD."consumed_at_ms")
  FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id)
    AND json_extract(q.decision_json,'$.dispositions.projections.action')='Retain'
    AND json_extract(q.decision_json,'$.dispositions.projections.retention.untilMs')>unixepoch('subsec')*1000;
END;

CREATE TRIGGER erasure_preserve_connection_authorization_executions_delete BEFORE DELETE ON connection_authorization_executions
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state='Draining' AND (EXISTS(SELECT 1 FROM web_sessions p WHERE p.id=OLD.session_id AND p.user_id=q.user_id))
  AND json_extract(q.decision_json,'$.dispositions.projections.action')='Retain'
  AND json_extract(q.decision_json,'$.dispositions.projections.retention.untilMs')>unixepoch('subsec')*1000)
BEGIN
  INSERT INTO erasure_archives(request_id,store_id,row_ref,body)
  SELECT q.id,'connection_authorization_executions','drain:'||lower(hex(randomblob(16))),json_object('attempt_id',OLD."attempt_id",'session_id',OLD."session_id",'prepared_at_ms',OLD."prepared_at_ms")
  FROM erasure_requests q WHERE q.state='Draining' AND (EXISTS(SELECT 1 FROM web_sessions p WHERE p.id=OLD.session_id AND p.user_id=q.user_id))
    AND json_extract(q.decision_json,'$.dispositions.projections.action')='Retain'
    AND json_extract(q.decision_json,'$.dispositions.projections.retention.untilMs')>unixepoch('subsec')*1000;
END;

CREATE TRIGGER erasure_preserve_connections_delete BEFORE DELETE ON connections
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id)
  AND json_extract(q.decision_json,'$.dispositions.projections.action')='Retain'
  AND json_extract(q.decision_json,'$.dispositions.projections.retention.untilMs')>unixepoch('subsec')*1000)
BEGIN
  INSERT INTO erasure_archives(request_id,store_id,row_ref,body)
  SELECT q.id,'connections','drain:'||lower(hex(randomblob(16))),json_object('id',OLD."id",'user_id',OLD."user_id",'institution_id',OLD."institution_id",'state',OLD."state",'created_at_ms',OLD."created_at_ms",'updated_at_ms',OLD."updated_at_ms")
  FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id)
    AND json_extract(q.decision_json,'$.dispositions.projections.action')='Retain'
    AND json_extract(q.decision_json,'$.dispositions.projections.retention.untilMs')>unixepoch('subsec')*1000;
END;

CREATE TRIGGER erasure_preserve_dashboard_projection_bucket_delete BEFORE DELETE ON dashboard_projection_bucket
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id)
  AND json_extract(q.decision_json,'$.dispositions.projections.action')='Retain'
  AND json_extract(q.decision_json,'$.dispositions.projections.retention.untilMs')>unixepoch('subsec')*1000)
BEGIN
  INSERT INTO erasure_archives(request_id,store_id,row_ref,body)
  SELECT q.id,'dashboard_projection_bucket','drain:'||lower(hex(randomblob(16))),json_object('user_id',OLD."user_id",'size_seconds',OLD."size_seconds",'bucket',OLD."bucket",'currency',OLD."currency",'direction',OLD."direction",'category_id',OLD."category_id",'count',OLD."count",'maximum',OLD."maximum",'max_minor',OLD."max_minor")
  FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id)
    AND json_extract(q.decision_json,'$.dispositions.projections.action')='Retain'
    AND json_extract(q.decision_json,'$.dispositions.projections.retention.untilMs')>unixepoch('subsec')*1000;
END;

CREATE TRIGGER erasure_preserve_dashboard_projection_digit_delete BEFORE DELETE ON dashboard_projection_digit
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id)
  AND json_extract(q.decision_json,'$.dispositions.projections.action')='Retain'
  AND json_extract(q.decision_json,'$.dispositions.projections.retention.untilMs')>unixepoch('subsec')*1000)
BEGIN
  INSERT INTO erasure_archives(request_id,store_id,row_ref,body)
  SELECT q.id,'dashboard_projection_digit','drain:'||lower(hex(randomblob(16))),json_object('user_id',OLD."user_id",'size_seconds',OLD."size_seconds",'bucket',OLD."bucket",'currency',OLD."currency",'direction',OLD."direction",'category_id',OLD."category_id",'position',OLD."position",'digit_sum',OLD."digit_sum")
  FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id)
    AND json_extract(q.decision_json,'$.dispositions.projections.action')='Retain'
    AND json_extract(q.decision_json,'$.dispositions.projections.retention.untilMs')>unixepoch('subsec')*1000;
END;

CREATE TRIGGER erasure_preserve_dashboard_projection_leaf_delete BEFORE DELETE ON dashboard_projection_leaf
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id)
  AND json_extract(q.decision_json,'$.dispositions.projections.action')='Retain'
  AND json_extract(q.decision_json,'$.dispositions.projections.retention.untilMs')>unixepoch('subsec')*1000)
BEGIN
  INSERT INTO erasure_archives(request_id,store_id,row_ref,body)
  SELECT q.id,'dashboard_projection_leaf','drain:'||lower(hex(randomblob(16))),json_object('user_id',OLD."user_id",'id',OLD."id",'amount',OLD."amount",'currency',OLD."currency",'direction',OLD."direction",'category_id',OLD."category_id",'counterparty',OLD."counterparty",'notes',OLD."notes",'occurred_at',OLD."occurred_at",'created_at',OLD."created_at",'revision',OLD."revision")
  FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id)
    AND json_extract(q.decision_json,'$.dispositions.projections.action')='Retain'
    AND json_extract(q.decision_json,'$.dispositions.projections.retention.untilMs')>unixepoch('subsec')*1000;
END;

CREATE TRIGGER erasure_preserve_dashboard_projection_state_delete BEFORE DELETE ON dashboard_projection_state
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id)
  AND json_extract(q.decision_json,'$.dispositions.projections.action')='Retain'
  AND json_extract(q.decision_json,'$.dispositions.projections.retention.untilMs')>unixepoch('subsec')*1000)
BEGIN
  INSERT INTO erasure_archives(request_id,store_id,row_ref,body)
  SELECT q.id,'dashboard_projection_state','drain:'||lower(hex(randomblob(16))),json_object('user_id',OLD."user_id",'version',OLD."version",'readiness',OLD."readiness",'cursor_id',OLD."cursor_id",'attempted_at_ms',OLD."attempted_at_ms")
  FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id)
    AND json_extract(q.decision_json,'$.dispositions.projections.action')='Retain'
    AND json_extract(q.decision_json,'$.dispositions.projections.retention.untilMs')>unixepoch('subsec')*1000;
END;

CREATE TRIGGER erasure_preserve_source_attestations_delete BEFORE DELETE ON source_attestations
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id)
  AND json_extract(q.decision_json,'$.dispositions.transactions.action')='Retain'
  AND json_extract(q.decision_json,'$.dispositions.transactions.retention.untilMs')>unixepoch('subsec')*1000)
BEGIN
  INSERT INTO erasure_archives(request_id,store_id,row_ref,body)
  SELECT q.id,'source_attestations','drain:'||lower(hex(randomblob(16))),json_object('id',OLD."id",'user_id',OLD."user_id",'transaction_id',OLD."transaction_id",'kind',OLD."kind",'service_market',OLD."service_market",'locale',OLD."locale",'time_zone',OLD."time_zone",'interpretation_revision',OLD."interpretation_revision",'created_at',OLD."created_at",'statement_submission_id',OLD."statement_submission_id",'statement_record_number',OLD."statement_record_number",'statement_content_hash',OLD."statement_content_hash",'source_format',OLD."source_format",'received_email_id',OLD."received_email_id",'message_content_sha256',OLD."message_content_sha256",'message_evidence',OLD."message_evidence",'deterministic_interpretation',OLD."deterministic_interpretation",'extractor_revision',OLD."extractor_revision")
  FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id)
    AND json_extract(q.decision_json,'$.dispositions.transactions.action')='Retain'
    AND json_extract(q.decision_json,'$.dispositions.transactions.retention.untilMs')>unixepoch('subsec')*1000;
END;

CREATE TRIGGER erasure_preserve_transaction_corrections_delete BEFORE DELETE ON transaction_corrections
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id)
  AND json_extract(q.decision_json,'$.dispositions.transactions.action')='Retain'
  AND json_extract(q.decision_json,'$.dispositions.transactions.retention.untilMs')>unixepoch('subsec')*1000)
BEGIN
  INSERT INTO erasure_archives(request_id,store_id,row_ref,body)
  SELECT q.id,'transaction_corrections','drain:'||lower(hex(randomblob(16))),json_object('id',OLD."id",'user_id',OLD."user_id",'transaction_id',OLD."transaction_id",'previous_revision',OLD."previous_revision",'changed_fields',OLD."changed_fields",'before_facts',OLD."before_facts",'after_facts',OLD."after_facts",'corrected_at',OLD."corrected_at")
  FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id)
    AND json_extract(q.decision_json,'$.dispositions.transactions.action')='Retain'
    AND json_extract(q.decision_json,'$.dispositions.transactions.retention.untilMs')>unixepoch('subsec')*1000;
END;

CREATE TRIGGER erasure_preserve_transaction_fact_state_delete BEFORE DELETE ON transaction_fact_state
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id)
  AND json_extract(q.decision_json,'$.dispositions.projections.action')='Retain'
  AND json_extract(q.decision_json,'$.dispositions.projections.retention.untilMs')>unixepoch('subsec')*1000)
BEGIN
  INSERT INTO erasure_archives(request_id,store_id,row_ref,body)
  SELECT q.id,'transaction_fact_state','drain:'||lower(hex(randomblob(16))),json_object('user_id',OLD."user_id",'revision',OLD."revision",'first_captured_at',OLD."first_captured_at",'time_zone',OLD."time_zone")
  FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id)
    AND json_extract(q.decision_json,'$.dispositions.projections.action')='Retain'
    AND json_extract(q.decision_json,'$.dispositions.projections.retention.untilMs')>unixepoch('subsec')*1000;
END;

CREATE TRIGGER erasure_preserve_transaction_reconciliation_decisions_delete BEFORE DELETE ON transaction_reconciliation_decisions
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id)
  AND json_extract(q.decision_json,'$.dispositions.projections.action')='Retain'
  AND json_extract(q.decision_json,'$.dispositions.projections.retention.untilMs')>unixepoch('subsec')*1000)
BEGIN
  INSERT INTO erasure_archives(request_id,store_id,row_ref,body)
  SELECT q.id,'transaction_reconciliation_decisions','drain:'||lower(hex(randomblob(16))),json_object('user_id',OLD."user_id",'first_transaction_id',OLD."first_transaction_id",'second_transaction_id',OLD."second_transaction_id",'state',OLD."state",'visible_transaction_id',OLD."visible_transaction_id",'decided_at',OLD."decided_at")
  FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id)
    AND json_extract(q.decision_json,'$.dispositions.projections.action')='Retain'
    AND json_extract(q.decision_json,'$.dispositions.projections.retention.untilMs')>unixepoch('subsec')*1000;
END;

CREATE TRIGGER erasure_preserve_transaction_reconciliation_members_delete BEFORE DELETE ON transaction_reconciliation_members
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id)
  AND json_extract(q.decision_json,'$.dispositions.projections.action')='Retain'
  AND json_extract(q.decision_json,'$.dispositions.projections.retention.untilMs')>unixepoch('subsec')*1000)
BEGIN
  INSERT INTO erasure_archives(request_id,store_id,row_ref,body)
  SELECT q.id,'transaction_reconciliation_members','drain:'||lower(hex(randomblob(16))),json_object('user_id',OLD."user_id",'transaction_id',OLD."transaction_id",'first_transaction_id',OLD."first_transaction_id",'second_transaction_id',OLD."second_transaction_id")
  FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id)
    AND json_extract(q.decision_json,'$.dispositions.projections.action')='Retain'
    AND json_extract(q.decision_json,'$.dispositions.projections.retention.untilMs')>unixepoch('subsec')*1000;
END;

CREATE TRIGGER erasure_preserve_transactions_delete BEFORE DELETE ON transactions
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id)
  AND json_extract(q.decision_json,'$.dispositions.transactions.action')='Retain'
  AND json_extract(q.decision_json,'$.dispositions.transactions.retention.untilMs')>unixepoch('subsec')*1000)
BEGIN
  INSERT INTO erasure_archives(request_id,store_id,row_ref,body)
  SELECT q.id,'transactions','drain:'||lower(hex(randomblob(16))),json_object('id',OLD."id",'user_id',OLD."user_id",'amount',OLD."amount",'currency',OLD."currency",'direction',OLD."direction",'counterparty',OLD."counterparty",'category_id',OLD."category_id",'notes',OLD."notes",'occurred_at',OLD."occurred_at",'created_at',OLD."created_at",'revision',OLD."revision",'user_decisions',OLD."user_decisions",'deleted_at_ms',OLD."deleted_at_ms")
  FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id)
    AND json_extract(q.decision_json,'$.dispositions.transactions.action')='Retain'
    AND json_extract(q.decision_json,'$.dispositions.transactions.retention.untilMs')>unixepoch('subsec')*1000;
END;

CREATE TRIGGER erasure_preserve_consent_user_revocations_delete BEFORE DELETE ON consent_user_revocations
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id)
  AND json_extract(q.decision_json,'$.dispositions.consent.action')='Retain'
  AND json_extract(q.decision_json,'$.dispositions.consent.retention.untilMs')>unixepoch('subsec')*1000)
BEGIN
  INSERT INTO erasure_archives(request_id,store_id,row_ref,body)
  SELECT q.id,'consent_user_revocations','drain:'||lower(hex(randomblob(16))),json_object('id',OLD."id",'user_id',OLD."user_id",'grant_record_id',OLD."grant_record_id",'session_id',OLD."session_id",'occurred_at_ms',OLD."occurred_at_ms")
  FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id)
    AND json_extract(q.decision_json,'$.dispositions.consent.action')='Retain'
    AND json_extract(q.decision_json,'$.dispositions.consent.retention.untilMs')>unixepoch('subsec')*1000;
END;

CREATE TRIGGER erasure_preserve_oauth_grant_consents_delete BEFORE DELETE ON oauth_grant_consents
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id)
  AND json_extract(q.decision_json,'$.dispositions.consent.action')='Retain'
  AND json_extract(q.decision_json,'$.dispositions.consent.retention.untilMs')>unixepoch('subsec')*1000)
BEGIN
  INSERT INTO erasure_archives(request_id,store_id,row_ref,body)
  SELECT q.id,'oauth_grant_consents','drain:'||lower(hex(randomblob(16))),json_object('id',OLD."id",'connection_id',OLD."connection_id",'user_id',OLD."user_id",'session_id',OLD."session_id",'disclosure_revision',OLD."disclosure_revision",'disclosure_text',OLD."disclosure_text",'accepted_at_ms',OLD."accepted_at_ms")
  FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id)
    AND json_extract(q.decision_json,'$.dispositions.consent.action')='Retain'
    AND json_extract(q.decision_json,'$.dispositions.consent.retention.untilMs')>unixepoch('subsec')*1000;
END;

CREATE TRIGGER erasure_preserve_oauth_revocation_consents_delete BEFORE DELETE ON oauth_revocation_consents
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id)
  AND json_extract(q.decision_json,'$.dispositions.consent.action')='Retain'
  AND json_extract(q.decision_json,'$.dispositions.consent.retention.untilMs')>unixepoch('subsec')*1000)
BEGIN
  INSERT INTO erasure_archives(request_id,store_id,row_ref,body)
  SELECT q.id,'oauth_revocation_consents','drain:'||lower(hex(randomblob(16))),json_object('id',OLD."id",'user_id',OLD."user_id",'connection_id',OLD."connection_id",'reason',OLD."reason",'occurred_at_ms',OLD."occurred_at_ms")
  FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id)
    AND json_extract(q.decision_json,'$.dispositions.consent.action')='Retain'
    AND json_extract(q.decision_json,'$.dispositions.consent.retention.untilMs')>unixepoch('subsec')*1000;
END;

CREATE TRIGGER erasure_preserve_oauth_user_revocation_consents_delete BEFORE DELETE ON oauth_user_revocation_consents
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id)
  AND json_extract(q.decision_json,'$.dispositions.consent.action')='Retain'
  AND json_extract(q.decision_json,'$.dispositions.consent.retention.untilMs')>unixepoch('subsec')*1000)
BEGIN
  INSERT INTO erasure_archives(request_id,store_id,row_ref,body)
  SELECT q.id,'oauth_user_revocation_consents','drain:'||lower(hex(randomblob(16))),json_object('connection_id',OLD."connection_id",'user_id',OLD."user_id",'session_id',OLD."session_id",'reason',OLD."reason",'disclosure_revision',OLD."disclosure_revision",'disclosure_text',OLD."disclosure_text",'occurred_at_ms',OLD."occurred_at_ms")
  FROM erasure_requests q WHERE q.state='Draining' AND (OLD.user_id=q.user_id)
    AND json_extract(q.decision_json,'$.dispositions.consent.action')='Retain'
    AND json_extract(q.decision_json,'$.dispositions.consent.retention.untilMs')>unixepoch('subsec')*1000;
END;
