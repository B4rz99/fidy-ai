-- Replace development-only derived generations; captures, receipts and original retention stay intact.
-- Reprocessing uses the existing bounded same-source reservation protocol.
DROP TRIGGER statement_materialization_terminal;
DROP TABLE statement_materialization_parts;
DROP TABLE statement_materializations;

-- Private derived material. Publication is atomic; a partial generation cannot drive captures.
CREATE TABLE statement_materializations (
  submission_id TEXT PRIMARY KEY NOT NULL REFERENCES statement_submissions(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id),
  source_sha256 TEXT NOT NULL CHECK(length(source_sha256)=64),
  parts_sha256 TEXT NOT NULL CHECK(length(parts_sha256)=64),
  parser_revision TEXT NOT NULL,
  source_format TEXT NOT NULL CHECK(source_format IN ('csv','xlsx')),
  representation_revision TEXT NOT NULL,
  service_market TEXT NOT NULL,
  locale TEXT NOT NULL,
  time_zone TEXT NOT NULL,
  expires_at_ms INTEGER NOT NULL,
  headers_json TEXT NOT NULL CHECK(json_valid(headers_json) AND length(CAST(headers_json AS BLOB))<=524288),
  row_count INTEGER NOT NULL CHECK(row_count BETWEEN 1 AND 20000),
  part_count INTEGER NOT NULL CHECK(part_count BETWEEN 1 AND 1024),
  byte_length INTEGER NOT NULL CHECK(byte_length BETWEEN 1 AND 16777216),
  state TEXT NOT NULL CHECK(state IN ('building','ready'))
) STRICT;
CREATE TABLE statement_materialization_parts (
  submission_id TEXT NOT NULL REFERENCES statement_materializations(submission_id) ON DELETE CASCADE,
  chunk_index INTEGER NOT NULL CHECK(chunk_index BETWEEN 0 AND 624),
  part_index INTEGER NOT NULL CHECK(part_index BETWEEN 0 AND 1023),
  body TEXT NOT NULL CHECK(length(CAST(body AS BLOB)) BETWEEN 1 AND 524288),
  sha256 TEXT NOT NULL CHECK(length(sha256)=64),
  PRIMARY KEY(submission_id,chunk_index,part_index)
) STRICT;
CREATE TRIGGER statement_materialization_owner BEFORE INSERT ON statement_materializations
WHEN NOT EXISTS (SELECT 1 FROM statement_submissions s JOIN statement_staging_objects o
  ON o.id=s.staging_id AND o.user_id=s.user_id
  WHERE s.id=NEW.submission_id AND s.user_id=NEW.user_id AND s.status IN ('queued','processing')
    AND s.parser_revision=NEW.parser_revision AND s.source_format=NEW.source_format
    AND s.service_market=NEW.service_market AND s.locale=NEW.locale AND s.time_zone=NEW.time_zone
    AND o.sha256=NEW.source_sha256 AND s.retention_expires_at_ms=NEW.expires_at_ms)
BEGIN SELECT RAISE(ABORT,'statement_materialization_owner'); END;
CREATE TRIGGER statement_materialization_identity BEFORE UPDATE ON statement_materializations
WHEN NEW.submission_id<>OLD.submission_id OR NEW.user_id<>OLD.user_id
  OR NEW.source_sha256<>OLD.source_sha256 OR NEW.parser_revision<>OLD.parser_revision
  OR NEW.parts_sha256<>OLD.parts_sha256
  OR NEW.source_format<>OLD.source_format OR NEW.expires_at_ms<>OLD.expires_at_ms
  OR NEW.representation_revision<>OLD.representation_revision
  OR NEW.service_market<>OLD.service_market OR NEW.locale<>OLD.locale OR NEW.time_zone<>OLD.time_zone
  OR NEW.headers_json<>OLD.headers_json OR NEW.row_count<>OLD.row_count
  OR NEW.part_count<>OLD.part_count OR NEW.byte_length<>OLD.byte_length OR OLD.state='ready'
BEGIN SELECT RAISE(ABORT,'statement_materialization_identity'); END;
CREATE TRIGGER statement_materialization_part_guard BEFORE INSERT ON statement_materialization_parts
WHEN NOT EXISTS (SELECT 1 FROM statement_materializations m JOIN statement_submissions s
  ON s.id=m.submission_id AND s.user_id=m.user_id WHERE m.submission_id=NEW.submission_id
  AND m.state='building' AND s.status IN ('queued','processing'))
BEGIN SELECT RAISE(ABORT,'statement_materialization_part_guard'); END;
CREATE TRIGGER statement_materialization_part_immutable BEFORE UPDATE ON statement_materialization_parts
BEGIN SELECT RAISE(ABORT,'statement_materialization_part_immutable'); END;
CREATE TRIGGER statement_materialization_terminal AFTER UPDATE OF status ON statement_submissions
WHEN NEW.status IN ('completed','failed')
BEGIN DELETE FROM statement_materializations WHERE submission_id=NEW.id AND user_id=NEW.user_id; END;

