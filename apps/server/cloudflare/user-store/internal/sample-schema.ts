export const sampleSchema = (): ReadonlyArray<string> => [
  `CREATE INDEX ingest_sample_expiry ON ingest_sample_candidates(expires_at_ms,id)`,
  `CREATE TABLE ingest_sample_previews(candidate_id TEXT PRIMARY KEY REFERENCES ingest_sample_candidates(id) ON DELETE CASCADE,revision INTEGER NOT NULL,digest TEXT NOT NULL,issuer TEXT NOT NULL,operator TEXT NOT NULL,previewed_at_ms INTEGER NOT NULL) STRICT`,
  `CREATE TABLE ingest_sample_decisions(
    candidate_id TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id),revision INTEGER NOT NULL,digest TEXT NOT NULL,
    issuer TEXT NOT NULL,operator TEXT NOT NULL,decided_at_ms INTEGER NOT NULL,
    sample_id TEXT UNIQUE,artifact TEXT,phase TEXT NOT NULL CHECK(phase IN('rejected','approved','published','removing','withdrawn')),
    due_ms INTEGER,
    CHECK((phase='rejected')=(sample_id IS NULL)),CHECK((phase='approved')=(artifact IS NOT NULL)),
    CHECK((phase IN('approved','removing'))=(due_ms IS NOT NULL))) STRICT`,
  `CREATE INDEX ingest_sample_due ON ingest_sample_decisions(due_ms) WHERE due_ms IS NOT NULL`,
  `CREATE TABLE ingest_sample_reservations(nonce TEXT PRIMARY KEY,sample_id TEXT NOT NULL REFERENCES ingest_sample_decisions(sample_id)) STRICT`,
  `CREATE INDEX ingest_sample_writers ON ingest_sample_reservations(sample_id)`,
];
