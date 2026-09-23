-- A skipped guarded capture audit aborts the entire Transaction/SourceAttestation D1 batch.
CREATE TABLE transaction_capture_assertion (
  id INTEGER PRIMARY KEY NOT NULL CHECK (id = 1),
  accepted INTEGER NOT NULL CHECK (accepted = 1)
) STRICT;
