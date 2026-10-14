-- No public operation can enable an institution. Production eligibility remains unestablished.
CREATE TABLE connection_institution_gate (
  institution_id TEXT PRIMARY KEY NOT NULL CHECK (institution_id = 'bancolombia'),
  enabled INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0, 1))
) STRICT;
INSERT INTO connection_institution_gate (institution_id, enabled) VALUES ('bancolombia', 0);

-- Retain the same association through expiry, revocation and reauthorization.
CREATE TABLE connections (
  id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id),
  institution_id TEXT NOT NULL REFERENCES connection_institution_gate(institution_id),
  state TEXT NOT NULL CHECK (state IN ('Connecting', 'Active', 'Action required', 'Ended')),
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  UNIQUE (user_id, institution_id),
  UNIQUE (user_id, id, institution_id)
) STRICT;
CREATE TABLE connection_attempts (
  id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL,
  connection_id TEXT NOT NULL,
  institution_id TEXT NOT NULL,
  public_reference TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL CHECK (status IN ('pending', 'consumed', 'invalidated')),
  created_at_ms INTEGER NOT NULL,
  expires_at_ms INTEGER NOT NULL,
  consumed_at_ms INTEGER,
  CHECK (expires_at_ms = created_at_ms + 600000),
  CHECK ((status = 'consumed' AND consumed_at_ms IS NOT NULL AND consumed_at_ms >= created_at_ms AND consumed_at_ms < expires_at_ms)
    OR (status != 'consumed' AND consumed_at_ms IS NULL)),
  FOREIGN KEY (user_id, connection_id, institution_id) REFERENCES connections(user_id, id, institution_id)
) STRICT;
CREATE UNIQUE INDEX connection_one_pending_attempt ON connection_attempts(user_id, connection_id) WHERE status = 'pending';
CREATE INDEX connection_attempt_expiry ON connection_attempts(user_id, expires_at_ms);
CREATE TRIGGER connection_attempt_transition BEFORE UPDATE ON connection_attempts
WHEN OLD.status != 'pending' OR NEW.status = 'pending'
  OR NEW.id != OLD.id OR NEW.user_id != OLD.user_id OR NEW.connection_id != OLD.connection_id
  OR NEW.institution_id != OLD.institution_id OR NEW.public_reference != OLD.public_reference
  OR NEW.created_at_ms != OLD.created_at_ms OR NEW.expires_at_ms != OLD.expires_at_ms
BEGIN SELECT RAISE(ABORT, 'connection_attempt_transition'); END;
CREATE TRIGGER connection_identity_immutable BEFORE UPDATE ON connections
WHEN NEW.id != OLD.id OR NEW.user_id != OLD.user_id OR NEW.institution_id != OLD.institution_id OR NEW.created_at_ms != OLD.created_at_ms
BEGIN SELECT RAISE(ABORT, 'connection_identity_immutable'); END;

-- Browser, PAT and OAuth Connection work consume the same stable-User Audit budget.
-- PAT activity answers consume the same stable-User canonical Audit budget.
DROP VIEW canonical_audit_usage;
CREATE VIEW canonical_audit_usage AS
SELECT * FROM (
SELECT user_id, occurred_at_ms FROM transaction_audit WHERE operation != 'operations.executeAtomicBatch'
UNION ALL SELECT user_id, occurred_at_ms FROM pat_audit
  WHERE operation != 'operations.executeAtomicBatch'
  AND (((pat_id IS NOT NULL OR (oauth_connection_id IS NOT NULL AND oauth_credential_id IS NOT NULL))
    AND operation NOT LIKE 'pats.%') OR operation LIKE 'connections.%' OR operation IN ('pats.listPATs', 'pats.getPATActivity', 'recurring.listRecurringSeries'))
UNION ALL SELECT user_id, occurred_at_ms FROM category_audit
UNION ALL SELECT user_id, occurred_at_ms FROM memory_audit)
UNION ALL SELECT user_id, occurred_at_ms FROM statement_submission_audit
UNION ALL SELECT user_id, occurred_at_ms FROM statement_review_audit
UNION ALL SELECT user_id, occurred_at_ms FROM statement_clarification_audit;

DROP TRIGGER pat_canonical_daily_budget;
CREATE TRIGGER pat_canonical_daily_budget BEFORE INSERT ON pat_audit
WHEN NEW.operation != 'operations.executeAtomicBatch'
AND (((NEW.pat_id IS NOT NULL OR (NEW.oauth_connection_id IS NOT NULL AND NEW.oauth_credential_id IS NOT NULL))
  AND NEW.operation NOT LIKE 'pats.%') OR NEW.operation LIKE 'connections.%' OR NEW.operation IN ('pats.listPATs', 'pats.getPATActivity', 'recurring.listRecurringSeries'))
AND (SELECT count(*) FROM canonical_audit_usage WHERE user_id = NEW.user_id
  AND occurred_at_ms >= (NEW.occurred_at_ms / 86400000) * 86400000
  AND occurred_at_ms < ((NEW.occurred_at_ms / 86400000) + 1) * 86400000) >= 256
BEGIN SELECT RAISE(ABORT, 'transaction_audit_limit'); END;

DROP TRIGGER recurring_shared_pat_budget;
CREATE TRIGGER recurring_shared_pat_budget BEFORE INSERT ON pat_audit
WHEN NEW.operation != 'operations.executeAtomicBatch'
AND (((NEW.pat_id IS NOT NULL OR (NEW.oauth_connection_id IS NOT NULL AND NEW.oauth_credential_id IS NOT NULL))
  AND NEW.operation NOT LIKE 'pats.%') OR NEW.operation LIKE 'connections.%' OR NEW.operation IN ('pats.listPATs', 'pats.getPATActivity', 'recurring.listRecurringSeries'))
AND (SELECT count(*) FROM canonical_audit_usage WHERE user_id = NEW.user_id
  AND occurred_at_ms >= (NEW.occurred_at_ms / 86400000) * 86400000
  AND occurred_at_ms < ((NEW.occurred_at_ms / 86400000) + 1) * 86400000) >= 256
BEGIN SELECT RAISE(ABORT, 'transaction_audit_limit'); END;

