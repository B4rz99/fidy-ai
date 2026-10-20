-- Bound compound SELECT size for native D1.
INSERT INTO sql_assertions (scope, accepted)
SELECT 'budget_mutation', accepted FROM budget_mutation_assertion
UNION ALL SELECT 'category_mutation', accepted FROM category_mutation_assertion
UNION ALL SELECT 'dashboard', accepted FROM dashboard_assertion
UNION ALL SELECT 'erasure_writer', accepted FROM erasure_writer_assertion
UNION ALL SELECT 'forwarded_email', accepted FROM forwarded_email_assertion;

INSERT INTO sql_assertions (scope, accepted)
SELECT 'ingestion_review', accepted FROM ingestion_review_assertion
UNION ALL SELECT 'insight_mutation', accepted FROM insight_mutation_assertion
UNION ALL SELECT 'oauth_atomic', accepted FROM oauth_atomic_assertion
UNION ALL SELECT 'oauth_confirmation', accepted FROM oauth_confirmation_guard
UNION ALL SELECT 'pat_atomic', accepted FROM pat_atomic_assertion;

INSERT INTO sql_assertions (scope, accepted)
SELECT 'proactivity_consent', accepted FROM proactivity_consent_assertion
UNION ALL SELECT 'proactivity_message', accepted FROM proactivity_message_assertion
UNION ALL SELECT 'processing_consent_renewal', accepted FROM processing_consent_renewal_assertion
UNION ALL SELECT 'recurring', accepted FROM recurring_assertion
UNION ALL SELECT 'recurring_plan', accepted FROM recurring_plan_assertion;

INSERT INTO sql_assertions (scope, accepted)
SELECT 'reminder_schedule', accepted FROM reminder_schedule_assertion
UNION ALL SELECT 'transaction_fact', accepted FROM transaction_fact_assertion
UNION ALL SELECT 'weekly_consent', accepted FROM weekly_consent_assertion
UNION ALL SELECT 'weekly_schedule', accepted FROM weekly_schedule_assertion;

DROP TABLE budget_mutation_assertion;
DROP TABLE category_mutation_assertion;
DROP TABLE dashboard_assertion;
DROP TABLE erasure_writer_assertion;
DROP TABLE forwarded_email_assertion;
DROP TABLE ingestion_review_assertion;
DROP TABLE insight_mutation_assertion;
DROP TABLE oauth_atomic_assertion;
DROP TABLE oauth_confirmation_guard;
DROP TABLE pat_atomic_assertion;
DROP TABLE proactivity_consent_assertion;
DROP TABLE proactivity_message_assertion;
DROP TABLE processing_consent_renewal_assertion;
DROP TABLE recurring_assertion;
DROP TABLE recurring_plan_assertion;
DROP TABLE reminder_schedule_assertion;
DROP TABLE transaction_fact_assertion;
DROP TABLE weekly_consent_assertion;
DROP TABLE weekly_schedule_assertion;
