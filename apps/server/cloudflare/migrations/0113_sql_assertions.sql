CREATE TABLE sql_assertions (
  scope TEXT PRIMARY KEY NOT NULL,
  accepted INTEGER NOT NULL CHECK (accepted = 1)
) STRICT;
