-- Preserve the closed failure signals used by admission, publication and cursor handling.

CREATE TRIGGER IF NOT EXISTS sql_assertions_refusal_insert BEFORE INSERT ON sql_assertions
WHEN NEW.accepted IS NOT 1
BEGIN
  SELECT CASE NEW.scope
    WHEN 'canonical_request' THEN RAISE(ABORT, 'canonical_request_rate')
    WHEN 'commercial_allowance' THEN RAISE(ABORT, 'commercial_authority_required')
    WHEN 'connection_browser' THEN RAISE(ABORT, 'connection_browser_commit')
    WHEN 'media_capacity' THEN RAISE(ABORT, 'media_work_capacity')
    WHEN 'media_publication' THEN RAISE(ABORT, 'media_publication_required')
    WHEN 'recurring_cursor' THEN RAISE(ABORT, 'recurring_cursor_changed')
  END;
END;

CREATE TRIGGER IF NOT EXISTS sql_assertions_refusal_update BEFORE UPDATE ON sql_assertions
WHEN NEW.accepted IS NOT 1
BEGIN
  SELECT CASE NEW.scope
    WHEN 'canonical_request' THEN RAISE(ABORT, 'canonical_request_rate')
    WHEN 'commercial_allowance' THEN RAISE(ABORT, 'commercial_authority_required')
    WHEN 'connection_browser' THEN RAISE(ABORT, 'connection_browser_commit')
    WHEN 'media_capacity' THEN RAISE(ABORT, 'media_work_capacity')
    WHEN 'media_publication' THEN RAISE(ABORT, 'media_publication_required')
    WHEN 'recurring_cursor' THEN RAISE(ABORT, 'recurring_cursor_changed')
  END;
END;

INSERT INTO sql_assertions(scope,accepted)
SELECT 'canonical_request',min(accepted) FROM canonical_request_assertions HAVING count(*) > 0
ON CONFLICT(scope) DO UPDATE SET accepted=excluded.accepted;

INSERT INTO sql_assertions(scope,accepted)
SELECT 'commercial_allowance',min(valid) FROM commercial_allowance_assertions HAVING count(*) > 0
ON CONFLICT(scope) DO UPDATE SET accepted=excluded.accepted;

INSERT INTO sql_assertions(scope,accepted)
SELECT 'connection_browser',min(accepted) FROM connection_browser_atomic_assertion HAVING count(*) > 0
ON CONFLICT(scope) DO UPDATE SET accepted=excluded.accepted;

INSERT INTO sql_assertions(scope,accepted)
SELECT 'media_capacity',min(capacity) FROM media_publication_assertions HAVING count(*) > 0
ON CONFLICT(scope) DO UPDATE SET accepted=excluded.accepted;

INSERT INTO sql_assertions(scope,accepted)
SELECT 'media_publication',min(published) FROM media_publication_assertions HAVING count(*) > 0
ON CONFLICT(scope) DO UPDATE SET accepted=excluded.accepted;

INSERT INTO sql_assertions(scope,accepted)
SELECT 'recurring_cursor',min(CASE WHEN expected_revision = current_revision THEN 1 ELSE 0 END) FROM recurring_cursor_assertion HAVING count(*) > 0
ON CONFLICT(scope) DO UPDATE SET accepted=excluded.accepted;

DROP TABLE canonical_request_assertions;

DROP TABLE commercial_allowance_assertions;

DROP TABLE connection_browser_atomic_assertion;

DROP TABLE media_publication_assertions;

DROP TABLE recurring_cursor_assertion;
