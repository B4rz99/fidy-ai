const credentialAuditTable = `CREATE TABLE audit_entries(id TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id),record_type TEXT NOT NULL,
   session_id TEXT REFERENCES web_sessions(id),pat_id TEXT REFERENCES pats(id),operation TEXT,outcome TEXT,occurred_at_ms INTEGER NOT NULL,
   oauth_connection_id TEXT REFERENCES oauth_connections(id),oauth_credential_id TEXT REFERENCES oauth_credentials(access_id),
   CHECK((oauth_connection_id IS NULL AND oauth_credential_id IS NULL) OR (record_type='credential_call' AND session_id IS NULL AND pat_id IS NULL AND oauth_connection_id IS NOT NULL AND oauth_credential_id IS NOT NULL)),
   CHECK((record_type='session_call' AND session_id IS NOT NULL AND pat_id IS NULL AND ((operation='emailAuthentication.requestEmailReplacement' AND outcome='accepted') OR (operation='emailAuthentication.completeEmailReplacement' AND outcome IN ('replaced','rejected')))) OR
   (record_type='security_mutation' AND session_id IS NOT NULL AND pat_id IS NULL AND operation='recovery.rotateBackupRecoveryCode' AND outcome IS NULL) OR
   (record_type='identity_read' AND session_id IS NOT NULL AND pat_id IS NULL AND operation IS NULL AND outcome IS NULL) OR
   (operation IS NOT NULL AND ((record_type='session_call' AND session_id IS NOT NULL AND pat_id IS NULL AND outcome IN ('success','validation_failed','not_found')) OR
   (record_type='credential_call' AND (pat_id IS NOT NULL OR session_id IS NOT NULL OR (oauth_connection_id IS NOT NULL AND oauth_credential_id IS NOT NULL)) AND outcome IN ('accepted','rejected')) OR
   (record_type='request_admission' AND pat_id IS NOT NULL AND session_id IS NULL AND outcome IS NULL))))) STRICT`;

export const userPATSchema = (): ReadonlyArray<string> =>
  [
    `CREATE TABLE pat_pairings(id TEXT PRIMARY KEY,public_code TEXT NOT NULL,proof_digest BLOB NOT NULL CHECK(length(proof_digest)=32),
  recipient_label TEXT NOT NULL,scopes_json TEXT NOT NULL,lifetime_days INTEGER NOT NULL,expires_at_ms INTEGER NOT NULL,user_id TEXT NOT NULL REFERENCES users(id),
  wrong_attempts INTEGER NOT NULL,last_poll_at_ms INTEGER,minimum_poll_seconds INTEGER NOT NULL,state TEXT NOT NULL DEFAULT 'pending_approval',
  approved_at_ms INTEGER,pat_expires_at_ms INTEGER) STRICT`,
    "CREATE INDEX pat_pairing_expiry ON pat_pairings(expires_at_ms) WHERE state='approved_awaiting_claim'",
    "CREATE INDEX pat_grant_expiry ON pats(expires_at_ms) WHERE revoked_at_ms IS NULL",
    "CREATE TABLE pat_review_events (id INTEGER PRIMARY KEY,session_id TEXT NOT NULL REFERENCES web_sessions(id),expires_at_ms INTEGER NOT NULL) STRICT",
    "CREATE INDEX pat_review_session ON pat_review_events(session_id,expires_at_ms)",
    "ALTER TABLE consent_history RENAME TO previous_credential_consent",
    `CREATE TABLE consent_history (
  id TEXT PRIMARY KEY NOT NULL DEFAULT(lower(hex(randomblob(16)))),user_id TEXT NOT NULL REFERENCES users(id),record_type TEXT NOT NULL,
  grant_record_id TEXT,session_id TEXT,occurred_at_ms INTEGER NOT NULL,withdrawal_id TEXT,
  disclosure_json TEXT,disclosure_message_id TEXT,decision_message_id TEXT,decision_received_at_ms INTEGER,
  request_id TEXT,pairing_id TEXT,grant_consent_id TEXT,pat_id TEXT,reason TEXT,connection_id TEXT,
  CHECK(record_type IN ('processing_grant','processing_withdrawal','processing_renewal','pat_grant','pat_revocation','oauth_grant','oauth_replay_revocation','oauth_user_revocation'))
  ) STRICT`,
    `INSERT INTO consent_history(id,user_id,record_type,grant_record_id,session_id,occurred_at_ms,withdrawal_id,disclosure_json,disclosure_message_id,decision_message_id,decision_received_at_ms)
  SELECT id,user_id,record_type,grant_record_id,session_id,occurred_at_ms,withdrawal_id,disclosure_json,disclosure_message_id,decision_message_id,decision_received_at_ms FROM previous_credential_consent`,
    "DROP TABLE previous_credential_consent",
    "CREATE UNIQUE INDEX granted_manual_pat ON consent_history(user_id,request_id) WHERE record_type='pat_grant'",
    "CREATE UNIQUE INDEX granted_paired_pat ON consent_history(user_id,pairing_id) WHERE record_type='pat_grant'",
    "CREATE UNIQUE INDEX oauth_consent_per_decision ON consent_history(connection_id,record_type) WHERE record_type IN ('oauth_grant','oauth_replay_revocation','oauth_user_revocation')",
    "CREATE TRIGGER credential_consent_immutable BEFORE UPDATE ON consent_history BEGIN SELECT RAISE(ABORT,'consent_immutable'); END",
    "CREATE UNIQUE INDEX revoked_pat_grant ON consent_history(grant_consent_id) WHERE record_type='pat_revocation'",
  ] as const;

export const oauthUserSchema = (): ReadonlyArray<string> =>
  [
    "CREATE TABLE oauth_user_admissions(expires_at_ms INTEGER NOT NULL) STRICT",
    "CREATE INDEX oauth_user_admission_expiry ON oauth_user_admissions(expires_at_ms)",
    `CREATE TABLE oauth_review_requests(id TEXT PRIMARY KEY,user_id TEXT NOT NULL,client_id TEXT NOT NULL,state TEXT NOT NULL,expires_at_ms INTEGER NOT NULL) STRICT`,
    `CREATE TABLE oauth_connections (
  id TEXT PRIMARY KEY NOT NULL,
  request_id TEXT NOT NULL UNIQUE,
  user_id TEXT NOT NULL REFERENCES users(id),
  client_id TEXT NOT NULL,
  claimed_client_name TEXT NOT NULL,
  redirect_uri TEXT NOT NULL,
  resource TEXT NOT NULL CHECK (resource = 'https://api.fidyapp.com/mcp'),
  scopes_json TEXT NOT NULL,
  approved_at_ms INTEGER NOT NULL,
  expires_at_ms INTEGER NOT NULL CHECK (expires_at_ms > approved_at_ms),
  revoked_at_ms INTEGER
, refresh_allowed INTEGER NOT NULL DEFAULT 0 CHECK (refresh_allowed IN (0,1)), code_digest BLOB, code_challenge TEXT, code_expires_at_ms INTEGER, code_consumed_at_ms INTEGER CHECK((code_digest IS NULL AND code_challenge IS NULL AND code_expires_at_ms IS NULL AND code_consumed_at_ms IS NULL) OR (code_digest IS NOT NULL AND (length(code_digest) = 32) AND code_challenge IS NOT NULL AND code_expires_at_ms IS NOT NULL))) STRICT`,
    `CREATE TABLE oauth_credentials (
 kind TEXT NOT NULL CHECK(kind IN ('access','refresh')),
 id TEXT NOT NULL,connection_id TEXT NOT NULL REFERENCES oauth_connections(id),
 user_id TEXT NOT NULL REFERENCES users(id),digest BLOB NOT NULL CHECK(length(digest)=32),issued_at_ms INTEGER NOT NULL,
 expires_at_ms INTEGER NOT NULL CHECK(expires_at_ms>issued_at_ms),consumed_at_ms INTEGER,
 scopes_json TEXT NOT NULL DEFAULT '["read"]',
 access_id TEXT GENERATED ALWAYS AS(CASE WHEN kind='access' THEN id END) VIRTUAL UNIQUE,
 refresh_id TEXT GENERATED ALWAYS AS(CASE WHEN kind='refresh' THEN id END) VIRTUAL UNIQUE,
 replacement_refresh_id TEXT UNIQUE,
 refresh_event_id TEXT UNIQUE,
 refresh_event_row_ref TEXT UNIQUE,
 UNIQUE(user_id,connection_id,refresh_id),
 FOREIGN KEY(user_id,connection_id,replacement_refresh_id) REFERENCES oauth_credentials(user_id,connection_id,refresh_id),
 CHECK(replacement_refresh_id IS NULL OR (kind='refresh' AND user_id IS NOT NULL AND consumed_at_ms IS NOT NULL AND replacement_refresh_id<>id)),
 CHECK((refresh_event_id IS NULL AND refresh_event_row_ref IS NULL) OR (refresh_event_id IS NOT NULL AND refresh_event_row_ref IS NOT NULL AND replacement_refresh_id IS NOT NULL)),
 PRIMARY KEY(kind,id),UNIQUE(kind,digest),CHECK(kind='refresh' OR(user_id IS NOT NULL AND consumed_at_ms IS NULL))
) STRICT`,
    `CREATE UNIQUE INDEX oauth_codes_digest ON oauth_connections(code_digest) WHERE code_digest IS NOT NULL`,
    `CREATE INDEX oauth_connection_user ON oauth_connections(user_id,id)`,
    `CREATE TABLE oauth_operation_intents(reference TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id),connection_id TEXT NOT NULL REFERENCES oauth_connections(id),operation TEXT NOT NULL,input_json TEXT NOT NULL,input_digest BLOB NOT NULL CHECK(length(input_digest)=32),binding_json TEXT NOT NULL,disclosure_revision TEXT NOT NULL,created_at_ms INTEGER NOT NULL,expires_at_ms INTEGER NOT NULL) STRICT`,
    "CREATE INDEX oauth_intent_expiry ON oauth_operation_intents(expires_at_ms)",
    "ALTER TABLE audit_entries RENAME TO previous_credential_audit",
    credentialAuditTable,
    "INSERT INTO audit_entries(id,user_id,record_type,session_id,pat_id,operation,outcome,occurred_at_ms) SELECT id,user_id,record_type,session_id,pat_id,operation,outcome,occurred_at_ms FROM previous_credential_audit",
    "DROP TABLE previous_credential_audit",
    "CREATE TRIGGER audit_entries_immutable BEFORE UPDATE ON audit_entries BEGIN SELECT RAISE(ABORT,'audit_immutable'); END",
    "CREATE INDEX audit_entries_oauth_activity ON audit_entries(user_id,oauth_connection_id,occurred_at_ms DESC,id DESC) WHERE record_type='credential_call'",
  ] as const;

const connectionAuditTable = credentialAuditTable.replace(
  "CHECK((record_type='session_call'",
  "CHECK((record_type='connection_synchronization' AND operation='connections.synchronize' AND outcome='success' AND session_id IS NULL AND pat_id IS NULL AND oauth_connection_id IS NULL) OR (record_type='session_call'"
);

export const connectionAuditSchema = (): ReadonlyArray<string> => [
  "CREATE TABLE saved_connection_audit AS SELECT * FROM audit_entries",
  "DROP TABLE audit_entries",
  connectionAuditTable,
  "INSERT INTO audit_entries SELECT * FROM saved_connection_audit",
  "DROP TABLE saved_connection_audit",
  "CREATE TRIGGER audit_entries_immutable BEFORE UPDATE ON audit_entries BEGIN SELECT RAISE(ABORT,'audit_immutable'); END",
  "CREATE INDEX audit_entries_oauth_activity ON audit_entries(user_id,oauth_connection_id,occurred_at_ms DESC,id DESC) WHERE record_type='credential_call'",
];

const hostedAuditTable = connectionAuditTable
  .replace(
    "CHECK((oauth_connection_id",
    `refusal_reason TEXT CHECK(refusal_reason IS NULL OR (refusal_reason='resource_limit' AND record_type='session_call' AND operation IN ('memory.remember','memory.revise') AND outcome='validation_failed')),
    hosted_turn_id TEXT CHECK(hosted_turn_id IS NULL OR (record_type='credential_call' AND session_id IS NULL AND pat_id IS NULL AND oauth_connection_id IS NULL AND oauth_credential_id IS NULL)),
    CHECK((oauth_connection_id`
  )
  .replace(
    "(pat_id IS NOT NULL OR session_id IS NOT NULL",
    "(hosted_turn_id IS NOT NULL OR pat_id IS NOT NULL OR session_id IS NOT NULL"
  );

const hostedAuditGuards = [
  "CREATE TRIGGER audit_entries_immutable BEFORE UPDATE ON audit_entries BEGIN SELECT RAISE(ABORT,'audit_immutable'); END",
  "CREATE INDEX audit_entries_oauth_activity ON audit_entries(user_id,oauth_connection_id,occurred_at_ms DESC,id DESC) WHERE record_type='credential_call'",
  `CREATE TRIGGER hosted_credential_origin BEFORE INSERT ON audit_entries WHEN NEW.hosted_turn_id IS NOT NULL AND NOT EXISTS(
      SELECT 1 FROM hosted_turns t WHERE t.id=NEW.hosted_turn_id AND t.user_id=NEW.user_id AND t.state='running' AND t.deadline_ms>NEW.occurred_at_ms
    ) BEGIN SELECT RAISE(ABORT,'hosted_authority_unavailable'); END`,
];

export const hostedMetadataAuditSchema = (): ReadonlyArray<string> => [
  "CREATE TABLE saved_hosted_audit AS SELECT * FROM audit_entries",
  "DROP TABLE audit_entries",
  hostedAuditTable,
  "INSERT INTO audit_entries SELECT *,NULL FROM saved_hosted_audit",
  "DROP TABLE saved_hosted_audit",
  ...hostedAuditGuards,
];

export const mediaAuditSchema = (): ReadonlyArray<string> => [
  "CREATE TABLE saved_media_audit AS SELECT * FROM audit_entries",
  "DROP TABLE audit_entries",
  hostedAuditTable.replace(
    "CHECK((record_type='connection_synchronization'",
    "CHECK((record_type='media_admission' AND operation IS NULL AND outcome='accepted' AND session_id IS NULL AND pat_id IS NULL AND oauth_connection_id IS NULL AND hosted_turn_id IS NULL) OR (record_type='connection_synchronization'"
  ),
  "INSERT INTO audit_entries SELECT * FROM saved_media_audit",
  "DROP TABLE saved_media_audit",
  ...hostedAuditGuards,
];
