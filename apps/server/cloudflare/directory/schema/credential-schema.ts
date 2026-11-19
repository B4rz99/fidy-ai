export const publicDirectorySchema = (): ReadonlyArray<string> =>
  [
    "CREATE TABLE oauth_public_clients(id TEXT PRIMARY KEY,metadata_json TEXT NOT NULL,created_at_ms INTEGER NOT NULL,last_used_at_ms INTEGER NOT NULL) STRICT",
    "CREATE TRIGGER oauth_client_capacity BEFORE INSERT ON oauth_public_clients WHEN (SELECT count(*) FROM oauth_public_clients)>=10000 BEGIN SELECT RAISE(ABORT,'client_capacity'); END",
    "CREATE INDEX oauth_unused_clients ON oauth_public_clients(last_used_at_ms)",
    `CREATE TABLE oauth_review_requests(id TEXT PRIMARY KEY,client_id TEXT NOT NULL,request_json TEXT NOT NULL,source_digest TEXT NOT NULL,created_at_ms INTEGER NOT NULL,expires_at_ms INTEGER NOT NULL,user_id TEXT,completed INTEGER NOT NULL DEFAULT 0) STRICT`,
    "CREATE INDEX oauth_review_source ON oauth_review_requests(source_digest,completed,expires_at_ms)",
    "CREATE TRIGGER oauth_review_capacity BEFORE INSERT ON oauth_review_requests WHEN (SELECT count(*) FROM oauth_review_requests WHERE source_digest=NEW.source_digest AND completed=0 AND expires_at_ms>NEW.created_at_ms)>=5 BEGIN SELECT RAISE(ABORT,'review_capacity'); END",
    "CREATE INDEX oauth_review_expiry ON oauth_review_requests(expires_at_ms)",
    "CREATE INDEX oauth_bound_reviews ON oauth_review_requests(user_id,expires_at_ms)",
    "CREATE TABLE oauth_routes(kind TEXT NOT NULL,digest TEXT NOT NULL,user_id TEXT NOT NULL,connection_id TEXT NOT NULL,record_id TEXT NOT NULL,operation TEXT NOT NULL,expires_at_ms INTEGER NOT NULL,PRIMARY KEY(kind,digest)) STRICT",
    "CREATE INDEX oauth_route_expiry ON oauth_routes(expires_at_ms)",
    "CREATE TABLE oauth_leases(id TEXT PRIMARY KEY,expires_at_ms INTEGER NOT NULL) STRICT",
    "CREATE INDEX oauth_lease_expiry ON oauth_leases(expires_at_ms)",
  ] as const;
