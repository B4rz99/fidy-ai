-- Resource admission is security and spend protection, not commercial allowance accounting.
CREATE TABLE resource_admission_grants (
  id TEXT PRIMARY KEY NOT NULL CHECK (length(id) BETWEEN 1 AND 128),
  admitted_at_epoch_ms INTEGER NOT NULL CHECK (admitted_at_epoch_ms >= 0),
  claim_count INTEGER NOT NULL CHECK (claim_count BETWEEN 1 AND 16)
) STRICT;

CREATE TABLE resource_admission_events (
  grant_id TEXT NOT NULL
    REFERENCES resource_admission_grants(id) DEFERRABLE INITIALLY DEFERRED,
  policy_key TEXT NOT NULL CHECK (length(policy_key) BETWEEN 1 AND 128),
  dimension TEXT NOT NULL CHECK (
    dimension IN ('stable_user', 'source', 'operation', 'outstanding_work', 'spend')
  ),
  scope_key TEXT NOT NULL CHECK (length(scope_key) BETWEEN 1 AND 256),
  policy_kind TEXT NOT NULL CHECK (
    policy_kind IN ('rolling_window', 'calendar_window', 'outstanding')
  ),
  units INTEGER NOT NULL CHECK (units > 0),
  admitted_at_epoch_ms INTEGER NOT NULL CHECK (admitted_at_epoch_ms >= 0),
  window_start_epoch_ms INTEGER,
  expires_at_epoch_ms INTEGER NOT NULL,
  released_at_epoch_ms INTEGER,
  PRIMARY KEY (grant_id, policy_key),
  CHECK (expires_at_epoch_ms > admitted_at_epoch_ms),
  CHECK (
    (policy_kind = 'outstanding' AND window_start_epoch_ms IS NULL) OR
    (policy_kind <> 'outstanding' AND window_start_epoch_ms IS NOT NULL)
  ),
  CHECK (released_at_epoch_ms IS NULL OR released_at_epoch_ms >= admitted_at_epoch_ms)
) STRICT;

CREATE INDEX resource_admission_active_scope
  ON resource_admission_events (
    policy_key,
    dimension,
    scope_key,
    expires_at_epoch_ms,
    admitted_at_epoch_ms
  );

CREATE INDEX resource_admission_grant_release
  ON resource_admission_events (grant_id, dimension, released_at_epoch_ms);

-- A caller inserts every conditional event before its grant. Missing even one event aborts the
-- complete D1 batch, including proof/replay evidence or outbox rows composed after the grant.
CREATE TRIGGER resource_admission_require_every_claim
BEFORE INSERT ON resource_admission_grants
WHEN (
  SELECT count(*)
  FROM resource_admission_events
  WHERE grant_id = NEW.id
) <> NEW.claim_count
BEGIN
  SELECT RAISE(ABORT, 'resource_admission_refused');
END;
