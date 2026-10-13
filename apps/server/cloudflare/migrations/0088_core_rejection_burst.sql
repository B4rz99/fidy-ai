-- Lossy telemetry presence only; never authentication or request-admission authority.
CREATE TABLE operational_core_rejection_burst (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  observed_at_ms INTEGER NOT NULL CHECK (observed_at_ms >= 0 AND observed_at_ms % 60000 = 0)
) STRICT;
