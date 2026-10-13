-- One retained counter per verified User and one service counter. Pairing lifecycle never
-- releases send capacity; each counter is reused when its admission window expires.
CREATE TABLE browser_pairing_email_user_limits (
  user_id TEXT PRIMARY KEY NOT NULL REFERENCES users(id),
  window_started_at_ms INTEGER NOT NULL,
  requests INTEGER NOT NULL CHECK (requests BETWEEN 1 AND 5)
) STRICT;
CREATE TABLE browser_pairing_email_global_limit (
  id INTEGER PRIMARY KEY NOT NULL CHECK (id = 1),
  window_started_at_ms INTEGER NOT NULL,
  requests INTEGER NOT NULL CHECK (requests BETWEEN 1 AND 1000)
) STRICT;
