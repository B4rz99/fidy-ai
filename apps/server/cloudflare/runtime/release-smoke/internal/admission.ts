export const maxActiveProbes = 8;
export const smokeAdmissionSql =
  "INSERT OR IGNORE INTO release_smoke_probes (probe_id, git_revision, expires_at_ms, status) SELECT ?, ?, ?, 'pending' WHERE (SELECT COUNT(*) FROM release_smoke_probes WHERE expires_at_ms > ?) < ?";
export const smokeClaimSql =
  "UPDATE release_smoke_probes SET status = 'queued' WHERE probe_id = ? AND status = 'pending' AND expires_at_ms > ?";
