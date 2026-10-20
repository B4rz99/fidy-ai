-- Payment guards are atomic batch checks, not retained enrollment or billing evidence.
-- Runtime checks now use fixed payment scopes in sql_assertions.
DROP TRIGGER IF EXISTS erasure_fence_payment_commit_guards_insert;

DROP TRIGGER IF EXISTS erasure_fence_payment_commit_guards_update;

DROP TRIGGER IF EXISTS erasure_fence_payment_commit_guards_delete;

DROP TRIGGER IF EXISTS erasure_preserve_payment_commit_guards_delete;

DROP TABLE payment_commit_guards;
