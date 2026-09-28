-- Metadata-only notification state. The keyspace is fixed by application alert vocabulary.
CREATE TABLE operational_alerts (
  kind TEXT NOT NULL,
  owner TEXT NOT NULL,
  severity TEXT NOT NULL CHECK (severity IN ('warning', 'critical')),
  state TEXT NOT NULL CHECK (state IN ('firing', 'resolved')),
  first_seen_ms INTEGER NOT NULL,
  last_seen_ms INTEGER NOT NULL,
  last_attempt_ms INTEGER,
  attempt_started_ms INTEGER,
  delivery_confirmed INTEGER NOT NULL DEFAULT 0 CHECK (delivery_confirmed IN (0, 1)),
  next_attempt_ms INTEGER NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  acknowledged_ms INTEGER,
  PRIMARY KEY (kind, owner)
);
