-- A one-row assertion forces D1 batch rollback when a guarded PAT lifecycle step
-- changes no row without throwing (for example, an ignored Consent evidence write).
CREATE TABLE pat_atomic_assertion (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  accepted INTEGER NOT NULL CHECK (accepted = 1)
) STRICT;
