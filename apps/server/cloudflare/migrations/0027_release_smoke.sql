-- Reserved deployment proof only; no User identity, financial data, or provider evidence.
CREATE TABLE release_smoke_probes (
  probe_id TEXT PRIMARY KEY NOT NULL CHECK (length(probe_id) = 32),
  git_revision TEXT NOT NULL CHECK (length(git_revision) = 40),
  expires_at_ms INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'passed'))
) STRICT;
CREATE INDEX release_smoke_expiry ON release_smoke_probes(expires_at_ms);
