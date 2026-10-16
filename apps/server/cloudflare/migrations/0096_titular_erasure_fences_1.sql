DROP TRIGGER pat_grant_consents_no_delete;
CREATE TRIGGER pat_grant_consents_no_delete BEFORE DELETE ON pat_grant_consents
WHEN NOT EXISTS(SELECT 1 FROM erasure_permits erasurePermit JOIN erasure_requests q ON q.id=erasurePermit.request_id WHERE erasurePermit.store_id='pat_grant_consents' AND erasurePermit.user_id=q.user_id AND q.state='Erasing' AND (OLD.user_id=erasurePermit.user_id))
BEGIN SELECT RAISE(ABORT,'consent_append_only'); END;

DROP TRIGGER pat_revocation_consents_no_delete;
CREATE TRIGGER pat_revocation_consents_no_delete BEFORE DELETE ON pat_revocation_consents
WHEN NOT EXISTS(SELECT 1 FROM erasure_permits erasurePermit JOIN erasure_requests q ON q.id=erasurePermit.request_id WHERE erasurePermit.store_id='pat_revocation_consents' AND erasurePermit.user_id=q.user_id AND q.state='Erasing' AND (OLD.user_id=erasurePermit.user_id))
BEGIN SELECT RAISE(ABORT,'consent_append_only'); END;

DROP TRIGGER transaction_correction_no_delete;
CREATE TRIGGER transaction_correction_no_delete BEFORE DELETE ON transaction_corrections
WHEN NOT EXISTS(SELECT 1 FROM erasure_permits erasurePermit JOIN erasure_requests q ON q.id=erasurePermit.request_id WHERE erasurePermit.store_id='transaction_corrections' AND erasurePermit.user_id=q.user_id AND q.state='Erasing' AND (OLD.user_id=erasurePermit.user_id))
BEGIN SELECT RAISE(ABORT, 'correction_append_only'); END;

DROP TRIGGER billing_no_charge_immutable_delete;
CREATE TRIGGER billing_no_charge_immutable_delete BEFORE DELETE ON billing_no_charge_confirmations
WHEN NOT EXISTS(SELECT 1 FROM erasure_permits erasurePermit JOIN erasure_requests q ON q.id=erasurePermit.request_id WHERE erasurePermit.store_id='billing_no_charge_confirmations' AND erasurePermit.user_id=q.user_id AND q.state='Erasing' AND (EXISTS(SELECT 1 FROM billing_attempts p WHERE p.id=OLD.attempt_id AND p.user_id=erasurePermit.user_id)))
BEGIN SELECT RAISE(ABORT, 'billing_no_charge_immutable'); END;

DROP TRIGGER statement_record_outcome_no_delete;
CREATE TRIGGER statement_record_outcome_no_delete BEFORE DELETE ON statement_record_outcomes
WHEN NOT EXISTS(SELECT 1 FROM erasure_permits erasurePermit JOIN erasure_requests q ON q.id=erasurePermit.request_id WHERE erasurePermit.store_id='statement_record_outcomes' AND erasurePermit.user_id=q.user_id AND q.state='Erasing' AND (OLD.user_id=erasurePermit.user_id))
BEGIN SELECT RAISE(ABORT, 'statement_outcome_append_only'); END;

DROP TRIGGER trial_period_immutable_delete;
CREATE TRIGGER trial_period_immutable_delete BEFORE DELETE ON trial_periods
WHEN NOT EXISTS(SELECT 1 FROM erasure_permits erasurePermit JOIN erasure_requests q ON q.id=erasurePermit.request_id WHERE erasurePermit.store_id='trial_periods' AND erasurePermit.user_id=q.user_id AND q.state='Erasing' AND (OLD.user_id=erasurePermit.user_id))
BEGIN SELECT RAISE(ABORT, 'trial_period_immutable'); END;

DROP TRIGGER billing_paid_period_immutable_delete;
CREATE TRIGGER billing_paid_period_immutable_delete BEFORE DELETE ON billing_paid_periods
WHEN NOT EXISTS(SELECT 1 FROM erasure_permits erasurePermit JOIN erasure_requests q ON q.id=erasurePermit.request_id WHERE erasurePermit.store_id='billing_history' AND erasurePermit.user_id=q.user_id AND q.state='Erasing' AND (EXISTS(SELECT 1 FROM billing_attempts p WHERE p.id=OLD.attempt_id AND p.user_id=erasurePermit.user_id)))
BEGIN SELECT RAISE(ABORT, 'billing_paid_period_immutable'); END;

DROP TRIGGER forwarded_email_outcome_no_delete;
CREATE TRIGGER forwarded_email_outcome_no_delete BEFORE DELETE ON forwarded_email_outcomes
WHEN NOT EXISTS(SELECT 1 FROM erasure_permits erasurePermit JOIN erasure_requests q ON q.id=erasurePermit.request_id WHERE erasurePermit.store_id='forwarded_email_outcomes' AND erasurePermit.user_id=q.user_id AND q.state='Erasing' AND (OLD.user_id=erasurePermit.user_id))
BEGIN SELECT RAISE(ABORT, 'email_outcome_append_only'); END;

DROP TRIGGER forwarded_email_review_no_delete;
CREATE TRIGGER forwarded_email_review_no_delete BEFORE DELETE ON forwarded_email_needs_review
WHEN NOT EXISTS(SELECT 1 FROM erasure_permits erasurePermit JOIN erasure_requests q ON q.id=erasurePermit.request_id WHERE erasurePermit.store_id='forwarded_email_needs_review' AND erasurePermit.user_id=q.user_id AND q.state='Erasing' AND (OLD.user_id=erasurePermit.user_id))
BEGIN SELECT RAISE(ABORT, 'email_review_append_only'); END;

DROP TRIGGER source_attestation_no_delete;
CREATE TRIGGER source_attestation_no_delete BEFORE DELETE ON source_attestations
WHEN NOT EXISTS(SELECT 1 FROM erasure_permits erasurePermit JOIN erasure_requests q ON q.id=erasurePermit.request_id WHERE erasurePermit.store_id='source_attestations' AND erasurePermit.user_id=q.user_id AND q.state='Erasing' AND (OLD.user_id=erasurePermit.user_id))
BEGIN SELECT RAISE(ABORT, 'attestation_append_only'); END;

DROP TRIGGER hosted_confirmations_no_delete_active;
CREATE TRIGGER hosted_confirmations_no_delete_active BEFORE DELETE ON hosted_confirmations
WHEN (OLD.expires_at_ms >= unixepoch('now') * 1000) AND NOT EXISTS(SELECT 1 FROM erasure_permits erasurePermit JOIN erasure_requests q ON q.id=erasurePermit.request_id WHERE erasurePermit.store_id='hosted_confirmations' AND erasurePermit.user_id=q.user_id AND q.state='Erasing' AND (OLD.user_id=erasurePermit.user_id))
BEGIN SELECT RAISE(ABORT, 'hosted_confirmation_retention_not_due'); END;

DROP TRIGGER transcript_retention_guard;
CREATE TRIGGER transcript_retention_guard BEFORE DELETE ON transcript_entries
WHEN (NOT EXISTS (SELECT 1 FROM hosted_turns WHERE id = OLD.turn_id AND user_id = OLD.user_id
  AND status <> 'pending' AND terminal_at_ms < (unixepoch('now') * 1000 - 2592000000))
AND NOT EXISTS (SELECT 1 FROM hosted_compacted_conversations AS c
  JOIN hosted_turns AS t ON t.id = OLD.turn_id AND t.user_id = OLD.user_id
  WHERE c.user_id = OLD.user_id AND c.hosted_session_id = OLD.hosted_session_id
    AND c.through_sequence >= OLD.sequence AND t.status <> 'pending')) AND NOT EXISTS(SELECT 1 FROM erasure_permits erasurePermit JOIN erasure_requests q ON q.id=erasurePermit.request_id WHERE erasurePermit.store_id='transcript_entries' AND erasurePermit.user_id=q.user_id AND q.state='Erasing' AND (OLD.user_id=erasurePermit.user_id))
BEGIN SELECT RAISE(ABORT, 'transcript_retention_not_due'); END;

DROP TRIGGER pat_audit_no_delete;
CREATE TRIGGER pat_audit_no_delete BEFORE DELETE ON pat_audit
WHEN (NOT EXISTS (SELECT 1 FROM audit_retention_permits WHERE user_id = OLD.user_id AND OLD.occurred_at_ms < cutoff_ms)) AND NOT EXISTS(SELECT 1 FROM erasure_permits erasurePermit JOIN erasure_requests q ON q.id=erasurePermit.request_id WHERE erasurePermit.store_id='pat_audit' AND erasurePermit.user_id=q.user_id AND q.state='Erasing' AND (OLD.user_id=erasurePermit.user_id))
BEGIN SELECT RAISE(ABORT, 'audit_append_only'); END;

DROP TRIGGER category_audit_no_delete;
CREATE TRIGGER category_audit_no_delete BEFORE DELETE ON category_audit
WHEN (NOT EXISTS (SELECT 1 FROM audit_retention_permits WHERE user_id = OLD.user_id AND OLD.occurred_at_ms < cutoff_ms)) AND NOT EXISTS(SELECT 1 FROM erasure_permits erasurePermit JOIN erasure_requests q ON q.id=erasurePermit.request_id WHERE erasurePermit.store_id='category_audit' AND erasurePermit.user_id=q.user_id AND q.state='Erasing' AND (OLD.user_id=erasurePermit.user_id))
BEGIN SELECT RAISE(ABORT, 'audit_append_only'); END;

DROP TRIGGER memory_audit_no_delete;
CREATE TRIGGER memory_audit_no_delete BEFORE DELETE ON memory_audit
WHEN (NOT EXISTS (SELECT 1 FROM audit_retention_permits WHERE user_id = OLD.user_id AND OLD.occurred_at_ms < cutoff_ms)) AND NOT EXISTS(SELECT 1 FROM erasure_permits erasurePermit JOIN erasure_requests q ON q.id=erasurePermit.request_id WHERE erasurePermit.store_id='memory_audit' AND erasurePermit.user_id=q.user_id AND q.state='Erasing' AND (OLD.user_id=erasurePermit.user_id))
BEGIN SELECT RAISE(ABORT, 'audit_append_only'); END;

DROP TRIGGER budget_audit_no_delete;
CREATE TRIGGER budget_audit_no_delete BEFORE DELETE ON budget_audit
WHEN (NOT EXISTS (SELECT 1 FROM audit_retention_permits WHERE user_id = OLD.user_id AND OLD.occurred_at_ms < cutoff_ms)) AND NOT EXISTS(SELECT 1 FROM erasure_permits erasurePermit JOIN erasure_requests q ON q.id=erasurePermit.request_id WHERE erasurePermit.store_id='budget_audit' AND erasurePermit.user_id=q.user_id AND q.state='Erasing' AND (OLD.user_id=erasurePermit.user_id))
BEGIN SELECT RAISE(ABORT, 'audit_append_only'); END;

DROP TRIGGER statement_submission_audit_no_delete;
CREATE TRIGGER statement_submission_audit_no_delete BEFORE DELETE ON statement_submission_audit
WHEN (NOT EXISTS (SELECT 1 FROM audit_retention_permits WHERE user_id = OLD.user_id AND OLD.occurred_at_ms < cutoff_ms)) AND NOT EXISTS(SELECT 1 FROM erasure_permits erasurePermit JOIN erasure_requests q ON q.id=erasurePermit.request_id WHERE erasurePermit.store_id='statement_submission_audit' AND erasurePermit.user_id=q.user_id AND q.state='Erasing' AND (OLD.user_id=erasurePermit.user_id))
BEGIN SELECT RAISE(ABORT, 'audit_append_only'); END;

DROP TRIGGER statement_review_audit_no_delete;
CREATE TRIGGER statement_review_audit_no_delete BEFORE DELETE ON statement_review_audit
WHEN (NOT EXISTS (SELECT 1 FROM audit_retention_permits WHERE user_id = OLD.user_id AND OLD.occurred_at_ms < cutoff_ms)) AND NOT EXISTS(SELECT 1 FROM erasure_permits erasurePermit JOIN erasure_requests q ON q.id=erasurePermit.request_id WHERE erasurePermit.store_id='statement_review_audit' AND erasurePermit.user_id=q.user_id AND q.state='Erasing' AND (OLD.user_id=erasurePermit.user_id))
BEGIN SELECT RAISE(ABORT, 'audit_append_only'); END;

DROP TRIGGER email_replacement_audit_no_delete;
CREATE TRIGGER email_replacement_audit_no_delete BEFORE DELETE ON email_replacement_audit
WHEN (NOT EXISTS (SELECT 1 FROM audit_retention_permits WHERE user_id = OLD.user_id AND OLD.occurred_at_ms < cutoff_ms)) AND NOT EXISTS(SELECT 1 FROM erasure_permits erasurePermit JOIN erasure_requests q ON q.id=erasurePermit.request_id WHERE erasurePermit.store_id='email_replacement_audit' AND erasurePermit.user_id=q.user_id AND q.state='Erasing' AND (OLD.user_id=erasurePermit.user_id))
BEGIN SELECT RAISE(ABORT, 'audit_append_only'); END;

DROP TRIGGER dashboard_audit_no_delete;
CREATE TRIGGER dashboard_audit_no_delete BEFORE DELETE ON dashboard_audit
WHEN (NOT EXISTS (SELECT 1 FROM audit_retention_permits WHERE user_id = OLD.user_id AND OLD.occurred_at_ms < cutoff_ms)) AND NOT EXISTS(SELECT 1 FROM erasure_permits erasurePermit JOIN erasure_requests q ON q.id=erasurePermit.request_id WHERE erasurePermit.store_id='dashboard_audit' AND erasurePermit.user_id=q.user_id AND q.state='Erasing' AND (OLD.user_id=erasurePermit.user_id))
BEGIN SELECT RAISE(ABORT, 'audit_append_only'); END;

DROP TRIGGER weekly_consent_records_no_delete;
CREATE TRIGGER weekly_consent_records_no_delete BEFORE DELETE ON weekly_consent_records
WHEN NOT EXISTS(SELECT 1 FROM erasure_permits erasurePermit JOIN erasure_requests q ON q.id=erasurePermit.request_id WHERE erasurePermit.store_id='weekly_consent_records' AND erasurePermit.user_id=q.user_id AND q.state='Erasing' AND (OLD.user_id=erasurePermit.user_id))
BEGIN SELECT RAISE(ABORT,'consent_append_only'); END;

DROP TRIGGER weekly_schedule_revision_no_delete;
CREATE TRIGGER weekly_schedule_revision_no_delete BEFORE DELETE ON weekly_schedule_revisions
WHEN NOT EXISTS(SELECT 1 FROM erasure_permits erasurePermit JOIN erasure_requests q ON q.id=erasurePermit.request_id WHERE erasurePermit.store_id='weekly_schedule_revisions' AND erasurePermit.user_id=q.user_id AND q.state='Erasing' AND (OLD.user_id=erasurePermit.user_id))
BEGIN SELECT RAISE(ABORT,'weekly_revision_immutable'); END;

DROP TRIGGER weekly_schedule_executions_no_delete;
CREATE TRIGGER weekly_schedule_executions_no_delete BEFORE DELETE ON weekly_schedule_executions
WHEN NOT EXISTS(SELECT 1 FROM erasure_permits erasurePermit JOIN erasure_requests q ON q.id=erasurePermit.request_id WHERE erasurePermit.store_id='weekly_schedule_executions' AND erasurePermit.user_id=q.user_id AND q.state='Erasing' AND (OLD.user_id=erasurePermit.user_id))
BEGIN SELECT RAISE(ABORT,'weekly_execution_immutable'); END;

DROP TRIGGER proactive_transcript_retention_guard;
CREATE TRIGGER proactive_transcript_retention_guard BEFORE DELETE ON proactive_transcript_entries
WHEN (OLD.expires_at_ms > unixepoch('now') * 1000) AND NOT EXISTS(SELECT 1 FROM erasure_permits erasurePermit JOIN erasure_requests q ON q.id=erasurePermit.request_id WHERE erasurePermit.store_id='proactive_transcript_entries' AND erasurePermit.user_id=q.user_id AND q.state='Erasing' AND (OLD.user_id=erasurePermit.user_id))
BEGIN SELECT RAISE(ABORT,'proactive_transcript_retention_not_due'); END;

DROP TRIGGER oauth_grant_consents_no_delete;
CREATE TRIGGER oauth_grant_consents_no_delete BEFORE DELETE ON oauth_grant_consents
WHEN NOT EXISTS(SELECT 1 FROM erasure_permits erasurePermit JOIN erasure_requests q ON q.id=erasurePermit.request_id WHERE erasurePermit.store_id='oauth_grant_consents' AND erasurePermit.user_id=q.user_id AND q.state='Erasing' AND (OLD.user_id=erasurePermit.user_id))
BEGIN SELECT RAISE(ABORT,'consent_append_only'); END;

DROP TRIGGER weekly_report_no_delete;
CREATE TRIGGER weekly_report_no_delete BEFORE DELETE ON weekly_summary_reports
WHEN NOT EXISTS(SELECT 1 FROM erasure_permits erasurePermit JOIN erasure_requests q ON q.id=erasurePermit.request_id WHERE erasurePermit.store_id='weekly_summary_reports' AND erasurePermit.user_id=q.user_id AND q.state='Erasing' AND (OLD.user_id=erasurePermit.user_id))
BEGIN SELECT RAISE(ABORT,'weekly_report_immutable'); END;

DROP TRIGGER oauth_refresh_events_no_delete;
CREATE TRIGGER oauth_refresh_events_no_delete BEFORE DELETE ON oauth_refresh_events
WHEN NOT EXISTS(SELECT 1 FROM erasure_permits erasurePermit JOIN erasure_requests q ON q.id=erasurePermit.request_id WHERE erasurePermit.store_id='oauth_refresh_events' AND erasurePermit.user_id=q.user_id AND q.state='Erasing' AND (OLD.user_id=erasurePermit.user_id))
BEGIN SELECT RAISE(ABORT,'oauth_append_only'); END;

DROP TRIGGER oauth_revocation_consents_no_delete;
CREATE TRIGGER oauth_revocation_consents_no_delete BEFORE DELETE ON oauth_revocation_consents
WHEN NOT EXISTS(SELECT 1 FROM erasure_permits erasurePermit JOIN erasure_requests q ON q.id=erasurePermit.request_id WHERE erasurePermit.store_id='oauth_revocation_consents' AND erasurePermit.user_id=q.user_id AND q.state='Erasing' AND (OLD.user_id=erasurePermit.user_id))
BEGIN SELECT RAISE(ABORT,'consent_append_only'); END;

DROP TRIGGER statement_clarification_audit_no_delete;
CREATE TRIGGER statement_clarification_audit_no_delete BEFORE DELETE ON statement_clarification_audit
WHEN (NOT EXISTS (SELECT 1 FROM audit_retention_permits WHERE user_id = OLD.user_id AND OLD.occurred_at_ms < cutoff_ms)) AND NOT EXISTS(SELECT 1 FROM erasure_permits erasurePermit JOIN erasure_requests q ON q.id=erasurePermit.request_id WHERE erasurePermit.store_id='statement_clarification_audit' AND erasurePermit.user_id=q.user_id AND q.state='Erasing' AND (OLD.user_id=erasurePermit.user_id))
BEGIN SELECT RAISE(ABORT, 'audit_append_only'); END;

DROP TRIGGER subscription_identity_no_delete;
CREATE TRIGGER subscription_identity_no_delete BEFORE DELETE ON subscription_identities
WHEN NOT EXISTS(SELECT 1 FROM erasure_permits erasurePermit JOIN erasure_requests q ON q.id=erasurePermit.request_id WHERE erasurePermit.store_id='subscription_identities' AND erasurePermit.user_id=q.user_id AND q.state='Erasing' AND (OLD.user_id=erasurePermit.user_id))
BEGIN SELECT RAISE(ABORT, 'subscription_identity_immutable'); END;

DROP TRIGGER refund_no_delete;
CREATE TRIGGER refund_no_delete BEFORE DELETE ON refund_attempts
WHEN NOT EXISTS(SELECT 1 FROM erasure_permits erasurePermit JOIN erasure_requests q ON q.id=erasurePermit.request_id WHERE erasurePermit.store_id='refund_attempts' AND erasurePermit.user_id=q.user_id AND q.state='Erasing' AND (OLD.user_id=erasurePermit.user_id))
BEGIN SELECT RAISE(ABORT, 'refund_history_immutable'); END;

DROP TRIGGER refund_claim_no_delete;
CREATE TRIGGER refund_claim_no_delete BEFORE DELETE ON refund_submission_claims
WHEN NOT EXISTS(SELECT 1 FROM erasure_permits erasurePermit JOIN erasure_requests q ON q.id=erasurePermit.request_id WHERE erasurePermit.store_id='refund_submission_claims' AND erasurePermit.user_id=q.user_id AND q.state='Erasing' AND (EXISTS(SELECT 1 FROM refund_attempts p WHERE p.id=OLD.refund_id AND p.user_id=erasurePermit.user_id)))
BEGIN SELECT RAISE(ABORT, 'refund_claim_immutable'); END;

DROP TRIGGER refund_evidence_no_delete;
CREATE TRIGGER refund_evidence_no_delete BEFORE DELETE ON refund_outcome_evidence
WHEN NOT EXISTS(SELECT 1 FROM erasure_permits erasurePermit JOIN erasure_requests q ON q.id=erasurePermit.request_id WHERE erasurePermit.store_id='refund_outcome_evidence' AND erasurePermit.user_id=q.user_id AND q.state='Erasing' AND (EXISTS(SELECT 1 FROM refund_attempts p WHERE p.id=OLD.refund_id AND p.user_id=erasurePermit.user_id)))
BEGIN SELECT RAISE(ABORT, 'refund_evidence_immutable'); END;

DROP TRIGGER billing_access_adjustment_no_delete;
CREATE TRIGGER billing_access_adjustment_no_delete BEFORE DELETE ON billing_access_adjustments
WHEN NOT EXISTS(SELECT 1 FROM erasure_permits erasurePermit JOIN erasure_requests q ON q.id=erasurePermit.request_id WHERE erasurePermit.store_id='billing_access_adjustments' AND erasurePermit.user_id=q.user_id AND q.state='Erasing' AND (EXISTS(SELECT 1 FROM refund_attempts p WHERE p.id=OLD.refund_id AND p.user_id=erasurePermit.user_id)))
BEGIN SELECT RAISE(ABORT, 'billing_access_adjustment_immutable'); END;

DROP TRIGGER subscription_renewal_stop_no_delete;
CREATE TRIGGER subscription_renewal_stop_no_delete BEFORE DELETE ON subscription_renewal_stops
WHEN NOT EXISTS(SELECT 1 FROM erasure_permits erasurePermit JOIN erasure_requests q ON q.id=erasurePermit.request_id WHERE erasurePermit.store_id='subscription_renewal_stops' AND erasurePermit.user_id=q.user_id AND q.state='Erasing' AND (OLD.user_id=erasurePermit.user_id))
BEGIN SELECT RAISE(ABORT, 'subscription_renewal_stop_immutable'); END;

DROP TRIGGER oauth_user_revocation_no_delete;
CREATE TRIGGER oauth_user_revocation_no_delete BEFORE DELETE ON oauth_user_revocation_consents
WHEN NOT EXISTS(SELECT 1 FROM erasure_permits erasurePermit JOIN erasure_requests q ON q.id=erasurePermit.request_id WHERE erasurePermit.store_id='oauth_user_revocation_consents' AND erasurePermit.user_id=q.user_id AND q.state='Erasing' AND (OLD.user_id=erasurePermit.user_id))
BEGIN SELECT RAISE(ABORT,'consent_append_only'); END;

DROP TRIGGER weekly_consent_revocations_no_delete;
CREATE TRIGGER weekly_consent_revocations_no_delete BEFORE DELETE ON weekly_consent_revocation_records
WHEN NOT EXISTS(SELECT 1 FROM erasure_permits erasurePermit JOIN erasure_requests q ON q.id=erasurePermit.request_id WHERE erasurePermit.store_id='weekly_consent_revocation_records' AND erasurePermit.user_id=q.user_id AND q.state='Erasing' AND (OLD.user_id=erasurePermit.user_id))
BEGIN SELECT RAISE(ABORT,'consent_append_only'); END;

DROP TRIGGER weekly_consent_rejections_no_delete;
CREATE TRIGGER weekly_consent_rejections_no_delete BEFORE DELETE ON weekly_consent_rejections
WHEN NOT EXISTS(SELECT 1 FROM erasure_permits erasurePermit JOIN erasure_requests q ON q.id=erasurePermit.request_id WHERE erasurePermit.store_id='weekly_consent_rejections' AND erasurePermit.user_id=q.user_id AND q.state='Erasing' AND (OLD.user_id=erasurePermit.user_id))
BEGIN SELECT RAISE(ABORT,'consent_append_only'); END;

DROP TRIGGER reminder_revision_no_delete;
CREATE TRIGGER reminder_revision_no_delete BEFORE DELETE ON reminder_schedule_revisions
WHEN NOT EXISTS(SELECT 1 FROM erasure_permits erasurePermit JOIN erasure_requests q ON q.id=erasurePermit.request_id WHERE erasurePermit.store_id='reminder_schedule_revisions' AND erasurePermit.user_id=q.user_id AND q.state='Erasing' AND (OLD.user_id=erasurePermit.user_id))
BEGIN SELECT RAISE(ABORT,'reminder_instruction_immutable'); END;

DROP TRIGGER insight_delivery_attempts_no_delete;
CREATE TRIGGER insight_delivery_attempts_no_delete BEFORE DELETE ON insight_delivery_attempts
WHEN NOT EXISTS(SELECT 1 FROM erasure_permits erasurePermit JOIN erasure_requests q ON q.id=erasurePermit.request_id WHERE erasurePermit.store_id='insight_delivery_attempts' AND erasurePermit.user_id=q.user_id AND q.state='Erasing' AND (OLD.user_id=erasurePermit.user_id))
BEGIN SELECT RAISE(ABORT,'insight_delivery_append_only'); END;

DROP TRIGGER recurring_legacy_no_delete;
CREATE TRIGGER recurring_legacy_no_delete BEFORE DELETE ON recurring_legacy_confirmations
 WHEN NOT EXISTS(SELECT 1 FROM erasure_permits erasurePermit JOIN erasure_requests q ON q.id=erasurePermit.request_id WHERE erasurePermit.store_id='recurring_legacy_confirmations' AND erasurePermit.user_id=q.user_id AND q.state='Erasing' AND (OLD.user_id=erasurePermit.user_id))
BEGIN SELECT RAISE(ABORT,'recurring_legacy_immutable'); END;

DROP TRIGGER proactivity_consent_records_no_delete;
CREATE TRIGGER proactivity_consent_records_no_delete BEFORE DELETE ON proactivity_consent_records
WHEN NOT EXISTS(SELECT 1 FROM erasure_permits erasurePermit JOIN erasure_requests q ON q.id=erasurePermit.request_id WHERE erasurePermit.store_id='proactivity_consent_records' AND erasurePermit.user_id=q.user_id AND q.state='Erasing' AND (OLD.user_id=erasurePermit.user_id))
BEGIN SELECT RAISE(ABORT,'consent_append_only'); END;

DROP TRIGGER insight_audit_no_delete;
CREATE TRIGGER insight_audit_no_delete BEFORE DELETE ON insight_audit
WHEN (NOT EXISTS (SELECT 1 FROM audit_retention_permits WHERE user_id=OLD.user_id AND OLD.occurred_at_ms<cutoff_ms)) AND NOT EXISTS(SELECT 1 FROM erasure_permits erasurePermit JOIN erasure_requests q ON q.id=erasurePermit.request_id WHERE erasurePermit.store_id='insight_audit' AND erasurePermit.user_id=q.user_id AND q.state='Erasing' AND (OLD.user_id=erasurePermit.user_id))
BEGIN SELECT RAISE(ABORT, 'audit_append_only'); END;

DROP TRIGGER subscription_cancellation_no_delete;
CREATE TRIGGER subscription_cancellation_no_delete BEFORE DELETE ON subscription_cancellations
WHEN NOT EXISTS(SELECT 1 FROM erasure_permits erasurePermit JOIN erasure_requests q ON q.id=erasurePermit.request_id WHERE erasurePermit.store_id='subscription_cancellations' AND erasurePermit.user_id=q.user_id AND q.state='Erasing' AND (OLD.user_id=erasurePermit.user_id))
BEGIN SELECT RAISE(ABORT, 'subscription_cancellation_immutable'); END;

DROP TRIGGER transaction_audit_no_delete;
CREATE TRIGGER transaction_audit_no_delete BEFORE DELETE ON transaction_audit
WHEN (NOT EXISTS (SELECT 1 FROM audit_retention_permits WHERE user_id = OLD.user_id AND OLD.occurred_at_ms < cutoff_ms)) AND NOT EXISTS(SELECT 1 FROM erasure_permits erasurePermit JOIN erasure_requests q ON q.id=erasurePermit.request_id WHERE erasurePermit.store_id='transaction_audit' AND erasurePermit.user_id=q.user_id AND q.state='Erasing' AND (OLD.user_id=erasurePermit.user_id))
BEGIN SELECT RAISE(ABORT, 'audit_append_only'); END;

CREATE TRIGGER erasure_fence_audit_retention_permits_insert BEFORE INSERT ON audit_retention_permits
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND (NEW.user_id=q.user_id) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='audit_retention_permits'))
BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;

CREATE TRIGGER erasure_fence_audit_retention_permits_update BEFORE UPDATE ON audit_retention_permits
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND ((NEW.user_id=q.user_id) OR (OLD.user_id=q.user_id)) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='audit_retention_permits'))
BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;

CREATE TRIGGER erasure_fence_audit_retention_permits_delete BEFORE DELETE ON audit_retention_permits
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND (OLD.user_id=q.user_id) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='audit_retention_permits'))
BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;

CREATE TRIGGER erasure_fence_backup_recovery_credentials_insert BEFORE INSERT ON backup_recovery_credentials
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND (NEW.user_id=q.user_id) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='backup_recovery_credentials'))
BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;

CREATE TRIGGER erasure_fence_backup_recovery_credentials_update BEFORE UPDATE ON backup_recovery_credentials
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND ((NEW.user_id=q.user_id) OR (OLD.user_id=q.user_id)) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='backup_recovery_credentials'))
BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;

CREATE TRIGGER erasure_fence_backup_recovery_credentials_delete BEFORE DELETE ON backup_recovery_credentials
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND (OLD.user_id=q.user_id) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='backup_recovery_credentials'))
BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;

CREATE TRIGGER erasure_fence_billing_attempts_insert BEFORE INSERT ON billing_attempts
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND (NEW.user_id=q.user_id) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='billing_history'))
BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;

CREATE TRIGGER erasure_fence_billing_attempts_update BEFORE UPDATE ON billing_attempts
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND ((NEW.user_id=q.user_id) OR (OLD.user_id=q.user_id)) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='billing_history'))
BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;

CREATE TRIGGER erasure_fence_billing_attempts_delete BEFORE DELETE ON billing_attempts
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND (OLD.user_id=q.user_id) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='billing_history'))
BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;

CREATE TRIGGER erasure_fence_billing_price_notices_insert BEFORE INSERT ON billing_price_notices
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND (NEW.user_id=q.user_id) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='billing_price_notices'))
BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;

CREATE TRIGGER erasure_fence_billing_price_notices_update BEFORE UPDATE ON billing_price_notices
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND ((NEW.user_id=q.user_id) OR (OLD.user_id=q.user_id)) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='billing_price_notices'))
BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;

CREATE TRIGGER erasure_fence_billing_price_notices_delete BEFORE DELETE ON billing_price_notices
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND (OLD.user_id=q.user_id) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='billing_price_notices'))
BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;

CREATE TRIGGER erasure_fence_browser_login_approvals_insert BEFORE INSERT ON browser_login_approvals
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND (NEW.user_id=q.user_id) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='browser_login_approvals'))
BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;

CREATE TRIGGER erasure_fence_browser_login_approvals_update BEFORE UPDATE ON browser_login_approvals
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND ((NEW.user_id=q.user_id) OR (OLD.user_id=q.user_id)) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='browser_login_approvals'))
BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;

CREATE TRIGGER erasure_fence_browser_login_approvals_delete BEFORE DELETE ON browser_login_approvals
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND (OLD.user_id=q.user_id) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='browser_login_approvals'))
BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;

CREATE TRIGGER erasure_fence_browser_login_pairings_insert BEFORE INSERT ON browser_login_pairings
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND (NEW.user_id=q.user_id) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='browser_login_pairings'))
BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;

CREATE TRIGGER erasure_fence_browser_login_pairings_update BEFORE UPDATE ON browser_login_pairings
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND ((NEW.user_id=q.user_id) OR (OLD.user_id=q.user_id)) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='browser_login_pairings'))
BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;

CREATE TRIGGER erasure_fence_browser_login_pairings_delete BEFORE DELETE ON browser_login_pairings
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND (OLD.user_id=q.user_id) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='browser_login_pairings'))
BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;

CREATE TRIGGER erasure_fence_browser_pairing_email_proofs_insert BEFORE INSERT ON browser_pairing_email_proofs
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND (NEW.user_id=q.user_id) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='browser_pairing_email_proofs'))
BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;

CREATE TRIGGER erasure_fence_browser_pairing_email_proofs_update BEFORE UPDATE ON browser_pairing_email_proofs
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND ((NEW.user_id=q.user_id) OR (OLD.user_id=q.user_id)) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='browser_pairing_email_proofs'))
BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;

CREATE TRIGGER erasure_fence_browser_pairing_email_proofs_delete BEFORE DELETE ON browser_pairing_email_proofs
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND (OLD.user_id=q.user_id) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='browser_pairing_email_proofs'))
BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;

CREATE TRIGGER erasure_fence_browser_pairing_email_user_limits_insert BEFORE INSERT ON browser_pairing_email_user_limits
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND (NEW.user_id=q.user_id) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='browser_pairing_email_user_limits'))
BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;

CREATE TRIGGER erasure_fence_browser_pairing_email_user_limits_update BEFORE UPDATE ON browser_pairing_email_user_limits
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND ((NEW.user_id=q.user_id) OR (OLD.user_id=q.user_id)) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='browser_pairing_email_user_limits'))
BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;

CREATE TRIGGER erasure_fence_browser_pairing_email_user_limits_delete BEFORE DELETE ON browser_pairing_email_user_limits
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND (OLD.user_id=q.user_id) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='browser_pairing_email_user_limits'))
BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;

CREATE TRIGGER erasure_fence_budget_alert_occurrences_insert BEFORE INSERT ON budget_alert_occurrences
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND (NEW.user_id=q.user_id) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='budget_alert_occurrences'))
BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;

CREATE TRIGGER erasure_fence_budget_alert_occurrences_update BEFORE UPDATE ON budget_alert_occurrences
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND ((NEW.user_id=q.user_id) OR (OLD.user_id=q.user_id)) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='budget_alert_occurrences'))
BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;

CREATE TRIGGER erasure_fence_budget_alert_occurrences_delete BEFORE DELETE ON budget_alert_occurrences
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND (OLD.user_id=q.user_id) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='budget_alert_occurrences'))
BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;

CREATE TRIGGER erasure_fence_budget_audit_insert BEFORE INSERT ON budget_audit
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND (NEW.user_id=q.user_id) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='budget_audit'))
BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;

CREATE TRIGGER erasure_fence_budget_audit_update BEFORE UPDATE ON budget_audit
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND ((NEW.user_id=q.user_id) OR (OLD.user_id=q.user_id)) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='budget_audit'))
BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;

CREATE TRIGGER erasure_fence_budget_audit_delete BEFORE DELETE ON budget_audit
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND (OLD.user_id=q.user_id) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='budget_audit'))
BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;

CREATE TRIGGER erasure_fence_budget_crossing_publications_insert BEFORE INSERT ON budget_crossing_publications
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND (NEW.user_id=q.user_id) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='budget_crossing_publications'))
BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;

CREATE TRIGGER erasure_fence_budget_crossing_publications_update BEFORE UPDATE ON budget_crossing_publications
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND ((NEW.user_id=q.user_id) OR (OLD.user_id=q.user_id)) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='budget_crossing_publications'))
BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;

CREATE TRIGGER erasure_fence_budget_crossing_publications_delete BEFORE DELETE ON budget_crossing_publications
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND (OLD.user_id=q.user_id) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='budget_crossing_publications'))
BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;

CREATE TRIGGER erasure_fence_budget_first_creation_insert BEFORE INSERT ON budget_first_creation
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND (NEW.user_id=q.user_id) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='budget_first_creation'))
BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;

CREATE TRIGGER erasure_fence_budget_first_creation_update BEFORE UPDATE ON budget_first_creation
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND ((NEW.user_id=q.user_id) OR (OLD.user_id=q.user_id)) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='budget_first_creation'))
BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;

CREATE TRIGGER erasure_fence_budget_first_creation_delete BEFORE DELETE ON budget_first_creation
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND (OLD.user_id=q.user_id) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='budget_first_creation'))
BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;

CREATE TRIGGER erasure_fence_budget_group_currencies_insert BEFORE INSERT ON budget_group_currencies
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND (NEW.user_id=q.user_id) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='budget_group_currencies'))
BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;

CREATE TRIGGER erasure_fence_budget_group_currencies_update BEFORE UPDATE ON budget_group_currencies
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND ((NEW.user_id=q.user_id) OR (OLD.user_id=q.user_id)) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='budget_group_currencies'))
BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;

CREATE TRIGGER erasure_fence_budget_group_currencies_delete BEFORE DELETE ON budget_group_currencies
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND (OLD.user_id=q.user_id) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='budget_group_currencies'))
BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;

CREATE TRIGGER erasure_fence_budget_month_caps_insert BEFORE INSERT ON budget_month_caps
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND (NEW.user_id=q.user_id) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='budget_month_caps'))
BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;

CREATE TRIGGER erasure_fence_budget_month_caps_update BEFORE UPDATE ON budget_month_caps
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND ((NEW.user_id=q.user_id) OR (OLD.user_id=q.user_id)) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='budget_month_caps'))
BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;

CREATE TRIGGER erasure_fence_budget_month_caps_delete BEFORE DELETE ON budget_month_caps
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND (OLD.user_id=q.user_id) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='budget_month_caps'))
BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;

CREATE TRIGGER erasure_fence_budget_month_latches_insert BEFORE INSERT ON budget_month_latches
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND (NEW.user_id=q.user_id) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='budget_month_latches'))
BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;

CREATE TRIGGER erasure_fence_budget_month_latches_update BEFORE UPDATE ON budget_month_latches
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND ((NEW.user_id=q.user_id) OR (OLD.user_id=q.user_id)) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='budget_month_latches'))
BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;

CREATE TRIGGER erasure_fence_budget_month_latches_delete BEFORE DELETE ON budget_month_latches
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND (OLD.user_id=q.user_id) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='budget_month_latches'))
BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;

CREATE TRIGGER erasure_fence_budget_plan_months_insert BEFORE INSERT ON budget_plan_months
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND (NEW.user_id=q.user_id) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='budget_plan_months'))
BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;

CREATE TRIGGER erasure_fence_budget_plan_months_update BEFORE UPDATE ON budget_plan_months
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND ((NEW.user_id=q.user_id) OR (OLD.user_id=q.user_id)) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='budget_plan_months'))
BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;

CREATE TRIGGER erasure_fence_budget_plan_months_delete BEFORE DELETE ON budget_plan_months
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND (OLD.user_id=q.user_id) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='budget_plan_months'))
BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;

CREATE TRIGGER erasure_fence_budget_reconciliation_work_insert BEFORE INSERT ON budget_reconciliation_work
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND (NEW.user_id=q.user_id) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='budget_reconciliation_work'))
BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;

CREATE TRIGGER erasure_fence_budget_reconciliation_work_update BEFORE UPDATE ON budget_reconciliation_work
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND ((NEW.user_id=q.user_id) OR (OLD.user_id=q.user_id)) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='budget_reconciliation_work'))
BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;

CREATE TRIGGER erasure_fence_budget_reconciliation_work_delete BEFORE DELETE ON budget_reconciliation_work
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND (OLD.user_id=q.user_id) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='budget_reconciliation_work'))
BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;

CREATE TRIGGER erasure_fence_budget_report_progress_insert BEFORE INSERT ON budget_report_progress
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND (NEW.user_id=q.user_id) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='budget_report_progress'))
BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;

CREATE TRIGGER erasure_fence_budget_report_progress_update BEFORE UPDATE ON budget_report_progress
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND ((NEW.user_id=q.user_id) OR (OLD.user_id=q.user_id)) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='budget_report_progress'))
BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;

CREATE TRIGGER erasure_fence_budget_report_progress_delete BEFORE DELETE ON budget_report_progress
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND (OLD.user_id=q.user_id) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='budget_report_progress'))
BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;

CREATE TRIGGER erasure_fence_budget_threshold_alerts_insert BEFORE INSERT ON budget_threshold_alerts
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND (NEW.user_id=q.user_id) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='budget_threshold_alerts'))
BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;

CREATE TRIGGER erasure_fence_budget_threshold_alerts_update BEFORE UPDATE ON budget_threshold_alerts
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND ((NEW.user_id=q.user_id) OR (OLD.user_id=q.user_id)) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='budget_threshold_alerts'))
BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;

CREATE TRIGGER erasure_fence_budget_threshold_alerts_delete BEFORE DELETE ON budget_threshold_alerts
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND (OLD.user_id=q.user_id) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='budget_threshold_alerts'))
BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;

CREATE TRIGGER erasure_fence_budget_user_versions_insert BEFORE INSERT ON budget_user_versions
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND (NEW.user_id=q.user_id) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='budget_user_versions'))
BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;

CREATE TRIGGER erasure_fence_budget_user_versions_update BEFORE UPDATE ON budget_user_versions
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND ((NEW.user_id=q.user_id) OR (OLD.user_id=q.user_id)) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='budget_user_versions'))
BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;

CREATE TRIGGER erasure_fence_budget_user_versions_delete BEFORE DELETE ON budget_user_versions
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND (OLD.user_id=q.user_id) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='budget_user_versions'))
BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;

CREATE TRIGGER erasure_fence_budgets_insert BEFORE INSERT ON budgets
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND (NEW.user_id=q.user_id) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='budgets'))
BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;

CREATE TRIGGER erasure_fence_budgets_update BEFORE UPDATE ON budgets
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND ((NEW.user_id=q.user_id) OR (OLD.user_id=q.user_id)) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='budgets'))
BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;

CREATE TRIGGER erasure_fence_budgets_delete BEFORE DELETE ON budgets
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND (OLD.user_id=q.user_id) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='budgets'))
BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;

CREATE TRIGGER erasure_fence_canonical_request_acceptances_insert BEFORE INSERT ON canonical_request_acceptances
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND (NEW.user_id=q.user_id) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='canonical_request_acceptances'))
BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;

CREATE TRIGGER erasure_fence_canonical_request_acceptances_update BEFORE UPDATE ON canonical_request_acceptances
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND ((NEW.user_id=q.user_id) OR (OLD.user_id=q.user_id)) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='canonical_request_acceptances'))
BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;

CREATE TRIGGER erasure_fence_canonical_request_acceptances_delete BEFORE DELETE ON canonical_request_acceptances
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND (OLD.user_id=q.user_id) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='canonical_request_acceptances'))
BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;

CREATE TRIGGER erasure_fence_canonical_request_leases_insert BEFORE INSERT ON canonical_request_leases
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND (NEW.user_id=q.user_id) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='canonical_request_leases'))
BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;

CREATE TRIGGER erasure_fence_canonical_request_leases_update BEFORE UPDATE ON canonical_request_leases
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND ((NEW.user_id=q.user_id) OR (OLD.user_id=q.user_id)) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='canonical_request_leases'))
BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;

CREATE TRIGGER erasure_fence_canonical_request_leases_delete BEFORE DELETE ON canonical_request_leases
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND (OLD.user_id=q.user_id) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='canonical_request_leases'))
BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;

CREATE TRIGGER erasure_fence_canonical_request_replays_insert BEFORE INSERT ON canonical_request_replays
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND (NEW.user_id=q.user_id) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='canonical_request_replays'))
BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;

CREATE TRIGGER erasure_fence_canonical_request_replays_update BEFORE UPDATE ON canonical_request_replays
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND ((NEW.user_id=q.user_id) OR (OLD.user_id=q.user_id)) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='canonical_request_replays'))
BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;

CREATE TRIGGER erasure_fence_canonical_request_replays_delete BEFORE DELETE ON canonical_request_replays
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND (OLD.user_id=q.user_id) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='canonical_request_replays'))
BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;

CREATE TRIGGER erasure_fence_canonical_security_mutations_insert BEFORE INSERT ON canonical_security_mutations
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND (NEW.user_id=q.user_id) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='canonical_security_mutations'))
BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;

CREATE TRIGGER erasure_fence_canonical_security_mutations_update BEFORE UPDATE ON canonical_security_mutations
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND ((NEW.user_id=q.user_id) OR (OLD.user_id=q.user_id)) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='canonical_security_mutations'))
BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;

CREATE TRIGGER erasure_fence_canonical_security_mutations_delete BEFORE DELETE ON canonical_security_mutations
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND (OLD.user_id=q.user_id) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='canonical_security_mutations'))
BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;

CREATE TRIGGER erasure_fence_canonical_user_reads_insert BEFORE INSERT ON canonical_user_reads
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND (NEW.user_id=q.user_id) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='canonical_user_reads'))
BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;

CREATE TRIGGER erasure_fence_canonical_user_reads_update BEFORE UPDATE ON canonical_user_reads
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND ((NEW.user_id=q.user_id) OR (OLD.user_id=q.user_id)) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='canonical_user_reads'))
BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;

CREATE TRIGGER erasure_fence_canonical_user_reads_delete BEFORE DELETE ON canonical_user_reads
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND (OLD.user_id=q.user_id) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='canonical_user_reads'))
BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;

CREATE TRIGGER erasure_fence_card_enrollments_insert BEFORE INSERT ON card_enrollments
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND (NEW.user_id=q.user_id) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='card_enrollments'))
BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;

CREATE TRIGGER erasure_fence_card_enrollments_update BEFORE UPDATE ON card_enrollments
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND ((NEW.user_id=q.user_id) OR (OLD.user_id=q.user_id)) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='card_enrollments'))
BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;

CREATE TRIGGER erasure_fence_card_enrollments_delete BEFORE DELETE ON card_enrollments
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND (OLD.user_id=q.user_id) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='card_enrollments'))
BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;

CREATE TRIGGER erasure_fence_card_payment_sources_insert BEFORE INSERT ON card_payment_sources
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND (NEW.user_id=q.user_id) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='card_payment_sources'))
BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;

CREATE TRIGGER erasure_fence_card_payment_sources_update BEFORE UPDATE ON card_payment_sources
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND ((NEW.user_id=q.user_id) OR (OLD.user_id=q.user_id)) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='card_payment_sources'))
BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;

CREATE TRIGGER erasure_fence_card_payment_sources_delete BEFORE DELETE ON card_payment_sources
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND (OLD.user_id=q.user_id) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='card_payment_sources'))
BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;

CREATE TRIGGER erasure_fence_category_audit_insert BEFORE INSERT ON category_audit
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND (NEW.user_id=q.user_id) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='category_audit'))
BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;

CREATE TRIGGER erasure_fence_category_audit_update BEFORE UPDATE ON category_audit
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND ((NEW.user_id=q.user_id) OR (OLD.user_id=q.user_id)) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='category_audit'))
BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;

CREATE TRIGGER erasure_fence_category_audit_delete BEFORE DELETE ON category_audit
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND (OLD.user_id=q.user_id) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='category_audit'))
BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;
