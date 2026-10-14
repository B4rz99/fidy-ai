-- Global operational inspection reads only the oldest bounded pending sample for each owner.
CREATE INDEX onboarding_pending_health ON pending_email_enrollments(created_at_ms)
  WHERE state IN ('awaiting_delivery', 'sending', 'ambiguous');
CREATE INDEX pairing_email_pending_health ON browser_pairing_email_proofs(last_requested_at_ms)
  WHERE state IN ('awaiting_delivery', 'sending', 'ambiguous');
CREATE INDEX replacement_email_pending_health ON email_replacements(created_at_ms)
  WHERE state IN ('awaiting_delivery', 'sending', 'ambiguous');
CREATE INDEX billing_pending_health ON billing_attempts(created_at_ms) WHERE status = 'pending';
CREATE INDEX statement_pending_health ON statement_submissions(submitted_at_ms)
  WHERE status IN ('queued', 'processing');

-- Retained rejected work is separate from pending work and from Workflow execution failure.
CREATE INDEX onboarding_rejected_health ON pending_email_enrollments(created_at_ms) WHERE state = 'rejected';
CREATE INDEX pairing_email_rejected_health ON browser_pairing_email_proofs(last_requested_at_ms) WHERE state = 'rejected';
CREATE INDEX replacement_email_rejected_health ON email_replacements(created_at_ms) WHERE state = 'rejected';
