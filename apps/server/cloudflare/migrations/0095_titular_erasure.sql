CREATE TABLE erasure_requests (
  id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL UNIQUE,
  case_ref TEXT UNIQUE,
  scope_ref TEXT,
  authority_ref TEXT,
  requested_at_ms INTEGER NOT NULL,
  restoring INTEGER NOT NULL DEFAULT 0 CHECK(restoring IN(0,1)),
  restore_generation TEXT,
  restore_cursor TEXT NOT NULL DEFAULT '',
  restore_objects_done INTEGER NOT NULL DEFAULT 0 CHECK(restore_objects_done IN(0,1)),
  restore_records_cursor TEXT NOT NULL DEFAULT '',
  restore_records_done INTEGER NOT NULL DEFAULT 0 CHECK(restore_records_done IN(0,1)),
  archive_generation TEXT NOT NULL DEFAULT 'initial',
  state TEXT NOT NULL CHECK(state IN ('AwaitingReview','Draining','Sealing','Archiving','Erasing','ExternalPending','Complete')),
  decision_json TEXT CHECK(decision_json IS NULL OR length(decision_json)<=16384),
  reviewed_at_ms INTEGER,
  operator_ref TEXT,
  objects_captured INTEGER NOT NULL DEFAULT 0 CHECK(objects_captured IN (0,1)),
  last_erased_at_ms INTEGER,
  purge_pending INTEGER NOT NULL DEFAULT 0 CHECK(purge_pending IN(0,1)),
  purge_records_cursor TEXT NOT NULL DEFAULT '',
  last_continued_at_ms INTEGER NOT NULL DEFAULT 0,
  next_continuation_at_ms INTEGER NOT NULL DEFAULT 0,
  connection_blocked INTEGER NOT NULL DEFAULT 0 CHECK(connection_blocked IN(0,1)),
  coordinator_cleared INTEGER NOT NULL DEFAULT 0 CHECK(coordinator_cleared IN (0,1)),
  marker_written INTEGER NOT NULL DEFAULT 0 CHECK(marker_written IN (0,1))
) STRICT;

CREATE TABLE erasure_steps (
  request_id TEXT NOT NULL REFERENCES erasure_requests(id),
  store_id TEXT NOT NULL,
  data_class TEXT NOT NULL,
  archive_done INTEGER NOT NULL DEFAULT 0 CHECK(archive_done IN (0,1)),
  delete_done INTEGER NOT NULL DEFAULT 0 CHECK(delete_done IN (0,1)),
  PRIMARY KEY(request_id,store_id)
) STRICT;
CREATE TABLE erasure_archives (
  request_id TEXT NOT NULL REFERENCES erasure_requests(id),
  store_id TEXT NOT NULL,
  row_ref TEXT NOT NULL,
  body TEXT NOT NULL CHECK(length(body)<=1048576),
  recovery_written INTEGER NOT NULL DEFAULT 0 CHECK(recovery_written IN(0,1)),
  PRIMARY KEY(request_id,store_id,row_ref)
) STRICT;
CREATE TABLE erasure_permits (
  request_id TEXT PRIMARY KEY NOT NULL REFERENCES erasure_requests(id),
  user_id TEXT NOT NULL,
  store_id TEXT NOT NULL
) STRICT;
CREATE TABLE erasure_chunk (
  request_id TEXT NOT NULL REFERENCES erasure_requests(id),
  row_ref TEXT NOT NULL,
  PRIMARY KEY(request_id,row_ref)
) STRICT;
CREATE TABLE erasure_custody_evidence (
  request_id TEXT NOT NULL REFERENCES erasure_requests(id),
  custodian TEXT NOT NULL CHECK(custodian IN ('Cloudflare','Kapso','Meta','Resend','Wompi','SupportInbox','CaseRegister','CaseEvidence')),
  state TEXT NOT NULL CHECK(state IN ('Pending','Accepted','Verified','NotApplicable','Retained','Unresolved')),
  evidence_json TEXT,
  PRIMARY KEY(request_id,custodian)
) STRICT;
CREATE TABLE erasure_objects (
  request_id TEXT NOT NULL REFERENCES erasure_requests(id),
  bucket TEXT NOT NULL CHECK(bucket IN ('email','statement')),
  object_key TEXT NOT NULL CHECK(length(object_key) BETWEEN 1 AND 1024),
  retained_key TEXT,
  recovery_written INTEGER NOT NULL DEFAULT 0 CHECK(recovery_written IN(0,1)),
  held_deleted INTEGER NOT NULL DEFAULT 0 CHECK(held_deleted IN(0,1)),
  missing INTEGER NOT NULL DEFAULT 0 CHECK(missing IN (0,1)),
  done INTEGER NOT NULL DEFAULT 0 CHECK(done IN (0,1)),
  PRIMARY KEY(request_id,bucket,object_key)
) STRICT;
CREATE TABLE erasure_generation (
  id INTEGER PRIMARY KEY CHECK(id=1),
  generation TEXT NOT NULL
) STRICT;
INSERT INTO erasure_generation(id,generation) VALUES(1,'initial');
CREATE TABLE erasure_runtime_assertion (
  id INTEGER PRIMARY KEY CHECK(id=1),
  accepted INTEGER NOT NULL CHECK(accepted=1)
) STRICT;

CREATE TABLE erasure_writers (
  id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL,
  bucket TEXT NOT NULL CHECK(bucket IN ('email','statement')),
  object_key TEXT NOT NULL,
  started_at_ms INTEGER NOT NULL,
  expires_at_ms INTEGER NOT NULL
) STRICT;
CREATE INDEX erasure_writers_by_user ON erasure_writers(user_id);
CREATE TABLE erasure_writer_assertion (
  id INTEGER PRIMARY KEY CHECK(id=1),
  accepted INTEGER NOT NULL CHECK(accepted=1)
) STRICT;

CREATE TABLE erasure_custody_events (
  id TEXT PRIMARY KEY NOT NULL,
  request_id TEXT NOT NULL REFERENCES erasure_requests(id),
  custodian TEXT NOT NULL,
  evidence_json TEXT NOT NULL CHECK(length(evidence_json)<=4096),
  recorded_at_ms INTEGER NOT NULL,
  operator_ref TEXT NOT NULL
) STRICT;

CREATE TABLE erasure_restore_sessions (
  id INTEGER PRIMARY KEY CHECK(id=1),
  generation TEXT NOT NULL,
  cursor TEXT NOT NULL,
  scanned INTEGER NOT NULL CHECK(scanned IN(0,1))
) STRICT;
CREATE TABLE erasure_restore_members (
  generation TEXT NOT NULL,
  request_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  PRIMARY KEY(generation,request_id)
) STRICT;

CREATE TABLE erasure_control_sweeps (
  bucket TEXT PRIMARY KEY NOT NULL CHECK(bucket IN('email','statement','erasure')),
  cursor TEXT NOT NULL
) STRICT;
