-- Retain the initialized statement-publication control in the shared assertion store.
INSERT INTO sql_assertions(scope,accepted)
 SELECT 'statement_submission',accepted FROM statement_submission_assertion WHERE 1=1
 ON CONFLICT(scope) DO UPDATE SET accepted=excluded.accepted;

DROP TABLE statement_submission_assertion;
