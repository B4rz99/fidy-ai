CREATE TABLE proactivity_offer_requests (
 id TEXT PRIMARY KEY NOT NULL,
 user_id TEXT NOT NULL REFERENCES users(id),
 kind TEXT NOT NULL CHECK(kind IN ('budget-threshold','manual-entry-reminder')),
 request_message_id TEXT NOT NULL,
 created_at_ms INTEGER NOT NULL,
 materialized_at_ms INTEGER,
 last_evaluated_at_ms INTEGER NOT NULL DEFAULT 0,
 UNIQUE(user_id,kind,request_message_id)
) STRICT;
CREATE INDEX proactivity_offer_requests_due ON proactivity_offer_requests(materialized_at_ms,last_evaluated_at_ms,created_at_ms);
