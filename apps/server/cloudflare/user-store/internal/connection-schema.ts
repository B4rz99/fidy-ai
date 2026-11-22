const history = [
  `CREATE TABLE connection_attempts (
  id TEXT PRIMARY KEY NOT NULL,
  connection_id TEXT NOT NULL,
  public_reference TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL CHECK (status IN ('pending', 'consumed', 'invalidated')),
  created_at_ms INTEGER NOT NULL,
  expires_at_ms INTEGER NOT NULL,
  consumed_at_ms INTEGER, prepared_session_id TEXT REFERENCES web_sessions(id) CHECK(prepared_session_id IS NULL OR status='consumed'),
  CHECK (expires_at_ms = created_at_ms + 600000),
  CHECK ((status = 'consumed' AND consumed_at_ms IS NOT NULL AND consumed_at_ms >= created_at_ms AND consumed_at_ms < expires_at_ms)
    OR (status != 'consumed' AND consumed_at_ms IS NULL)),
  FOREIGN KEY (connection_id) REFERENCES connections(id)
) STRICT`,
  `CREATE TABLE connections (
  id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id),
  institution_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('Connecting', 'Active', 'Action required', 'Ended')),
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  UNIQUE (user_id, institution_id)
) STRICT`,
  `CREATE INDEX connection_attempt_expiry ON connection_attempts(connection_id, expires_at_ms)`,
  `CREATE INDEX connection_attempt_retention ON connection_attempts(expires_at_ms, id)`,
  `CREATE UNIQUE INDEX connection_one_pending_attempt ON connection_attempts(connection_id) WHERE status = 'pending'`,
  `CREATE TRIGGER connection_attempt_transition BEFORE UPDATE ON connection_attempts
WHEN OLD.status != 'pending' OR NEW.status = 'pending'
  OR NEW.id != OLD.id OR NEW.connection_id != OLD.connection_id
  OR NEW.public_reference != OLD.public_reference
  OR NEW.created_at_ms != OLD.created_at_ms OR NEW.expires_at_ms != OLD.expires_at_ms
BEGIN SELECT RAISE(ABORT, 'connection_attempt_transition'); END`,
  `CREATE TRIGGER connection_identity_immutable BEFORE UPDATE ON connections
WHEN NEW.id != OLD.id OR NEW.user_id != OLD.user_id OR NEW.institution_id != OLD.institution_id OR NEW.created_at_ms != OLD.created_at_ms
BEGIN SELECT RAISE(ABORT, 'connection_identity_immutable'); END`,
  `CREATE TRIGGER connection_preparation_binding BEFORE UPDATE ON connection_attempts
WHEN NEW.prepared_session_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM web_sessions s WHERE s.id=NEW.prepared_session_id AND s.user_id=(SELECT user_id FROM connections WHERE id=NEW.connection_id) AND NEW.status='consumed')
BEGIN SELECT RAISE(ABORT,'connection_execution_binding'); END`,
  `CREATE TRIGGER connection_preparation_immutable BEFORE UPDATE ON connection_attempts
WHEN OLD.prepared_session_id IS NOT NULL AND (NEW.id IS NOT OLD.id OR NEW.prepared_session_id IS NOT OLD.prepared_session_id OR NEW.consumed_at_ms IS NOT OLD.consumed_at_ms)
BEGIN SELECT RAISE(ABORT,'connection_execution_immutable'); END`,
  `CREATE TRIGGER connection_preparation_initial BEFORE INSERT ON connection_attempts
WHEN NEW.prepared_session_id IS NOT NULL
BEGIN SELECT RAISE(ABORT,'connection_execution_binding'); END`,
  `CREATE TABLE connection_authorizations (
  attempt_id TEXT PRIMARY KEY NOT NULL REFERENCES connection_attempts(id) ON DELETE CASCADE,
  intent_json TEXT NOT NULL CHECK(json_valid(intent_json)),
  consent_id TEXT CHECK(consent_id IS NULL OR length(consent_id) BETWEEN 1 AND 128),
  verifier TEXT CHECK(verifier IS NULL OR length(verifier)=43),
  state_digest TEXT NOT NULL CHECK(length(state_digest)=43),
  phase TEXT NOT NULL CHECK(phase IN ('preparing','prepared','failed')),
  handoff_url TEXT,
  expires_at_ms INTEGER NOT NULL,
  CHECK((phase='prepared' AND handoff_url IS NOT NULL) OR (phase!='prepared' AND handoff_url IS NULL)),
  CHECK((phase='failed' AND verifier IS NULL) OR (phase!='failed' AND verifier IS NOT NULL))
) STRICT`,
  `CREATE TRIGGER connection_authorization_binding BEFORE INSERT ON connection_authorizations
WHEN NEW.phase!='preparing' OR NEW.consent_id IS NOT NULL OR NOT EXISTS(
  SELECT 1 FROM connection_attempts a WHERE a.id=NEW.attempt_id AND a.status='consumed'
    AND a.prepared_session_id IS NOT NULL AND NEW.expires_at_ms=a.expires_at_ms)
BEGIN SELECT RAISE(ABORT,'connection_authorization_binding'); END`,
  `CREATE TRIGGER connection_authorization_transition BEFORE UPDATE ON connection_authorizations
WHEN OLD.phase='failed' OR (NEW.phase='preparing' AND NOT(OLD.phase='preparing' AND OLD.consent_id IS NULL AND NEW.consent_id IS NOT NULL)) OR (OLD.phase='prepared' AND NEW.phase!='failed')
  OR NEW.intent_json IS NOT OLD.intent_json OR (OLD.consent_id IS NOT NULL AND NEW.consent_id IS NOT OLD.consent_id)
  OR NEW.attempt_id IS NOT OLD.attempt_id OR (NEW.verifier IS NOT OLD.verifier AND NEW.phase!='failed')
  OR NEW.state_digest IS NOT OLD.state_digest
  OR NEW.expires_at_ms>OLD.expires_at_ms
BEGIN SELECT RAISE(ABORT,'connection_authorization_transition'); END`,
  `CREATE TABLE connection_grants (
  attempt_id TEXT PRIMARY KEY NOT NULL REFERENCES connection_attempts(id) ON DELETE RESTRICT,
  state TEXT NOT NULL CHECK(state IN ('claimed','quarantined','active','cleanup_required')),
  envelope TEXT CHECK(envelope IS NULL OR length(envelope) BETWEEN 1 AND 100000),
  expires_at_ms INTEGER,
  claimed_at_ms INTEGER NOT NULL,
  CHECK((state IN ('quarantined','active') AND envelope IS NOT NULL AND expires_at_ms IS NOT NULL) OR state IN ('claimed','cleanup_required'))
) STRICT`,
  `CREATE TABLE connection_accounts (
  id TEXT PRIMARY KEY NOT NULL CHECK(length(id)=36),
  connection_id TEXT NOT NULL REFERENCES connections(id) ON DELETE RESTRICT,
  provider_reference TEXT NOT NULL CHECK(length(provider_reference) BETWEEN 1 AND 256),
  grant_attempt_id TEXT NOT NULL REFERENCES connection_grants(attempt_id) ON DELETE RESTRICT,
  UNIQUE(connection_id,provider_reference)
) STRICT`,
  `CREATE INDEX connection_grant_recovery ON connection_grants(state,claimed_at_ms)`,
  `CREATE UNIQUE INDEX connection_authorization_state ON connection_authorizations(state_digest)`,
  `CREATE TRIGGER connection_grant_binding BEFORE INSERT ON connection_grants
WHEN NEW.state!='claimed' OR NEW.envelope IS NOT NULL OR NEW.expires_at_ms IS NOT NULL OR NOT EXISTS(
 SELECT 1 FROM connection_attempts a JOIN connection_authorizations b ON b.attempt_id=a.id JOIN connections c ON c.id=a.connection_id
 WHERE a.id=NEW.attempt_id AND a.status='consumed' AND a.prepared_session_id IS NOT NULL
 AND a.expires_at_ms>NEW.claimed_at_ms AND b.phase='prepared' AND b.consent_id IS NOT NULL AND c.state='Connecting'
 AND NOT EXISTS(SELECT 1 FROM connection_attempts newer WHERE newer.connection_id=c.id AND newer.rowid>a.rowid))
BEGIN SELECT RAISE(ABORT,'connection_grant_binding'); END`,
  `CREATE TRIGGER connection_grant_transition BEFORE UPDATE ON connection_grants
WHEN NEW.attempt_id IS NOT OLD.attempt_id OR NEW.claimed_at_ms IS NOT OLD.claimed_at_ms
 OR NOT ((OLD.state='claimed' AND NEW.state IN ('quarantined','cleanup_required'))
  OR (OLD.state='quarantined' AND NEW.state IN ('active','cleanup_required'))
  OR (OLD.state='active' AND NEW.state='cleanup_required'))
 OR (OLD.envelope IS NOT NULL AND (NEW.envelope IS NOT OLD.envelope OR NEW.expires_at_ms IS NOT OLD.expires_at_ms))
BEGIN SELECT RAISE(ABORT,'connection_grant_transition'); END`,
  `CREATE TRIGGER connection_account_binding_insert BEFORE INSERT ON connection_accounts
WHEN NOT EXISTS(SELECT 1 FROM connection_grants g JOIN connection_attempts a ON a.id=g.attempt_id WHERE g.attempt_id=NEW.grant_attempt_id AND a.connection_id=NEW.connection_id AND g.state='active')
BEGIN SELECT RAISE(ABORT,'connection_account_binding'); END`,
  `CREATE TRIGGER connection_account_binding_update BEFORE UPDATE ON connection_accounts
WHEN NEW.id IS NOT OLD.id OR NEW.connection_id IS NOT OLD.connection_id OR NEW.provider_reference IS NOT OLD.provider_reference
 OR NOT EXISTS(SELECT 1 FROM connection_grants g JOIN connection_attempts a ON a.id=g.attempt_id WHERE g.attempt_id=NEW.grant_attempt_id AND a.connection_id=NEW.connection_id AND g.state='active')
BEGIN SELECT RAISE(ABORT,'connection_account_binding'); END`,
  `ALTER TABLE connection_grants ADD COLUMN cleanup_after_ms INTEGER NOT NULL DEFAULT 0 CHECK(cleanup_after_ms>=0)`,
  `ALTER TABLE connection_grants ADD COLUMN cleanup_claim TEXT CHECK(cleanup_claim IS NULL OR length(cleanup_claim)=36)`,
  `ALTER TABLE connection_grants ADD COLUMN cleaned_at_ms INTEGER CHECK(cleaned_at_ms IS NULL OR (state='cleanup_required' AND envelope IS NULL AND expires_at_ms IS NULL))`,
  `ALTER TABLE connection_grants ADD COLUMN cleanup_access_seen INTEGER NOT NULL DEFAULT 0 CHECK(cleanup_access_seen IN (0,1))`,
  `ALTER TABLE connection_grants ADD COLUMN cleanup_refresh_seen INTEGER NOT NULL DEFAULT 0 CHECK(cleanup_refresh_seen IN (0,1))`,
  `DROP TRIGGER connection_grant_transition`,
  `CREATE TRIGGER connection_grant_transition BEFORE UPDATE ON connection_grants
WHEN NEW.attempt_id IS NOT OLD.attempt_id OR NEW.claimed_at_ms IS NOT OLD.claimed_at_ms
 OR NOT ((OLD.state='claimed' AND NEW.state IN ('quarantined','cleanup_required'))
  OR (OLD.state='quarantined' AND NEW.state IN ('active','cleanup_required'))
  OR (OLD.state='active' AND NEW.state='cleanup_required')
  OR (OLD.state='cleanup_required' AND NEW.state='cleanup_required'))
 OR NEW.cleanup_access_seen<OLD.cleanup_access_seen OR NEW.cleanup_refresh_seen<OLD.cleanup_refresh_seen
 OR ((NEW.cleanup_access_seen IS NOT OLD.cleanup_access_seen OR NEW.cleanup_refresh_seen IS NOT OLD.cleanup_refresh_seen)
  AND NOT (OLD.state='cleanup_required' AND OLD.cleanup_claim IS NOT NULL AND OLD.cleanup_claim IS NEW.cleanup_claim AND OLD.cleaned_at_ms IS NULL))
 OR (OLD.envelope IS NOT NULL AND (NEW.envelope IS NOT OLD.envelope OR NEW.expires_at_ms IS NOT OLD.expires_at_ms)
  AND NOT (OLD.state='cleanup_required' AND NEW.state='cleanup_required' AND OLD.cleaned_at_ms IS NULL AND NEW.cleaned_at_ms IS NOT NULL AND NEW.envelope IS NULL AND NEW.expires_at_ms IS NULL))
 OR (OLD.cleaned_at_ms IS NOT NULL AND (NEW.cleaned_at_ms IS NOT OLD.cleaned_at_ms OR NEW.envelope IS NOT NULL OR NEW.expires_at_ms IS NOT NULL))
 OR (NEW.cleaned_at_ms IS NOT OLD.cleaned_at_ms AND NOT (OLD.state='cleanup_required' AND OLD.envelope IS NOT NULL AND OLD.cleanup_claim IS NOT NULL AND NEW.cleaned_at_ms IS NOT NULL AND NEW.envelope IS NULL AND NEW.expires_at_ms IS NULL))
BEGIN SELECT RAISE(ABORT,'connection_grant_transition'); END`,
  `CREATE TABLE connection_synchronizations(id TEXT PRIMARY KEY,account_id TEXT NOT NULL REFERENCES connection_accounts(id),
    grant_attempt_id TEXT NOT NULL REFERENCES connection_grants(attempt_id),start_cursor TEXT,admitted_at_ms INTEGER NOT NULL,
    expires_at_ms INTEGER NOT NULL,offer_at_ms INTEGER NOT NULL,state TEXT NOT NULL CHECK(state IN ('pending','running','complete','cancelled')),
    claim_token TEXT,claim_until_ms INTEGER,completed_at_ms INTEGER,
    CHECK((state='running')=(claim_token IS NOT NULL AND claim_until_ms IS NOT NULL)),CHECK(expires_at_ms>admitted_at_ms)) STRICT`,
  "CREATE UNIQUE INDEX connection_sync_pending ON connection_synchronizations(account_id) WHERE state IN ('pending','running')",
  "CREATE INDEX connection_sync_retention ON connection_synchronizations(expires_at_ms) WHERE state IN ('complete','cancelled')",
  "CREATE INDEX connection_sync_offer ON connection_synchronizations(offer_at_ms) WHERE state IN ('pending','running')",
  `CREATE TABLE connection_refresh(account_id TEXT PRIMARY KEY REFERENCES connection_accounts(id),grant_attempt_id TEXT NOT NULL REFERENCES connection_grants(attempt_id),cursor TEXT,last_success_ms INTEGER,next_refresh_ms INTEGER) STRICT`,
  "CREATE INDEX connection_refresh_due ON connection_refresh(next_refresh_ms)",
  `CREATE TABLE connection_movements(account_id TEXT NOT NULL REFERENCES connection_accounts(id),reference TEXT NOT NULL,transaction_id TEXT NOT NULL UNIQUE REFERENCES transactions(id),PRIMARY KEY(account_id,reference)) STRICT`,
] as const;

export const connectionSchema = (): ReadonlyArray<string> => history;

export const connectionGrantCleanupSchema = (): ReadonlyArray<string> => [
  "DROP TRIGGER connection_grant_transition",
  `CREATE TRIGGER connection_grant_transition BEFORE UPDATE ON connection_grants
WHEN NEW.attempt_id IS NOT OLD.attempt_id OR NEW.claimed_at_ms IS NOT OLD.claimed_at_ms
 OR NOT ((OLD.state='claimed' AND NEW.state IN ('quarantined','cleanup_required'))
  OR (OLD.state='quarantined' AND NEW.state IN ('active','cleanup_required'))
  OR (OLD.state='active' AND NEW.state='cleanup_required')
  OR (OLD.state='cleanup_required' AND NEW.state='cleanup_required'))
 OR NEW.cleanup_access_seen<OLD.cleanup_access_seen OR NEW.cleanup_refresh_seen<OLD.cleanup_refresh_seen
 OR ((NEW.cleanup_access_seen IS NOT OLD.cleanup_access_seen OR NEW.cleanup_refresh_seen IS NOT OLD.cleanup_refresh_seen)
  AND NOT (OLD.state='cleanup_required' AND OLD.cleanup_claim IS NOT NULL AND OLD.cleanup_claim IS NEW.cleanup_claim AND OLD.cleaned_at_ms IS NULL))
 OR (OLD.envelope IS NOT NULL AND (NEW.envelope IS NOT OLD.envelope OR NEW.expires_at_ms IS NOT OLD.expires_at_ms)
  AND NOT (OLD.state='cleanup_required' AND NEW.state='cleanup_required' AND OLD.cleaned_at_ms IS NULL AND NEW.cleaned_at_ms IS NOT NULL AND NEW.envelope IS NULL AND NEW.expires_at_ms IS NULL))
 OR (OLD.cleaned_at_ms IS NOT NULL AND (NEW.cleaned_at_ms IS NOT OLD.cleaned_at_ms OR NEW.envelope IS NOT NULL OR NEW.expires_at_ms IS NOT NULL))
 OR (NEW.cleaned_at_ms IS NOT OLD.cleaned_at_ms AND NOT (
  (OLD.state='cleanup_required' AND OLD.envelope IS NOT NULL AND OLD.cleanup_claim IS NOT NULL AND NEW.cleaned_at_ms IS NOT NULL AND NEW.envelope IS NULL AND NEW.expires_at_ms IS NULL)
  OR (OLD.state='cleanup_required' AND OLD.envelope IS NULL AND NEW.cleaned_at_ms IS NOT NULL AND NEW.envelope IS NULL AND NEW.expires_at_ms IS NULL)))
BEGIN SELECT RAISE(ABORT,'connection_grant_transition'); END`,
];
