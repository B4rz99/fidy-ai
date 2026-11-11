ALTER TABLE transaction_projection_state ADD COLUMN repair_revision INTEGER NOT NULL DEFAULT 0 CHECK(repair_revision >= 0);
