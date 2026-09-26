-- TrialPeriod is born only at verified onboarding. Recovery and consent changes cannot renew it.
CREATE TRIGGER trial_period_immutable_update BEFORE UPDATE ON trial_periods
BEGIN SELECT RAISE(ABORT, 'trial_period_immutable'); END;
CREATE TRIGGER trial_period_immutable_delete BEFORE DELETE ON trial_periods
BEGIN SELECT RAISE(ABORT, 'trial_period_immutable'); END;
-- A paid period is the immutable result of one verified BillingAttempt, never a mutable tier flag.
CREATE TRIGGER billing_paid_period_immutable_update BEFORE UPDATE ON billing_paid_periods
BEGIN SELECT RAISE(ABORT, 'billing_paid_period_immutable'); END;
CREATE TRIGGER billing_paid_period_immutable_delete BEFORE DELETE ON billing_paid_periods
BEGIN SELECT RAISE(ABORT, 'billing_paid_period_immutable'); END;
