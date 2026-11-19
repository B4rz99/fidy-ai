const history = [
  `ALTER TABLE forwarded_email_receipts ADD COLUMN capacity_slot INTEGER`,
  `ALTER TABLE forwarded_email_receipts ADD COLUMN capacity_generation INTEGER`,
  `ALTER TABLE forwarded_email_receipts ADD COLUMN capacity_claimed INTEGER NOT NULL DEFAULT 0`,
  `ALTER TABLE forwarded_email_receipts ADD COLUMN capacity_settled INTEGER NOT NULL DEFAULT 0`,
  `ALTER TABLE forwarded_email_receipts ADD COLUMN delivery_digest TEXT`,
  `ALTER TABLE forwarded_email_receipts ADD COLUMN object_key TEXT`,
  `ALTER TABLE forwarded_email_receipts ADD COLUMN byte_length INTEGER`,
  `ALTER TABLE forwarded_email_receipts ADD COLUMN received_at_ms INTEGER`,
  `ALTER TABLE forwarded_email_receipts ADD COLUMN expires_at_ms INTEGER`,
  `ALTER TABLE forwarded_email_receipts ADD COLUMN time_zone TEXT`,
  `ALTER TABLE forwarded_email_receipts ADD COLUMN state TEXT`,
  `ALTER TABLE forwarded_email_receipts ADD COLUMN outcome TEXT`,
  `ALTER TABLE forwarded_email_receipts ADD COLUMN outcome_transaction_id TEXT`,
  `ALTER TABLE forwarded_email_receipts ADD COLUMN outcome_review_id TEXT`,
  `ALTER TABLE forwarded_email_receipts ADD COLUMN dispatch_sent_at_ms INTEGER`,
  `ALTER TABLE forwarded_email_receipts ADD COLUMN stage_checked_at_ms INTEGER`,
  `ALTER TABLE forwarded_email_receipts ADD COLUMN forwarding_address_id TEXT`,
  `CREATE UNIQUE INDEX email_owner_digest ON forwarded_email_receipts(user_id,delivery_digest)`,
  `CREATE UNIQUE INDEX email_owner_receipt ON forwarded_email_receipts(user_id,id)`,
  `CREATE TABLE statement_staging_objects (
  id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id),
  -- Private R2 locator under the stable User prefix with an independently random opaque tail.
  -- Never returned to callers; possession of a staging reference grants no ownership or authority.
  object_key TEXT NOT NULL UNIQUE,
  -- 5242880 mirrors maximumStatementBytes in src/core/ingestion/model.ts.
  byte_length INTEGER NOT NULL CHECK (byte_length >= 1 AND byte_length <= 5242880),
  sha256 TEXT NOT NULL CHECK (length(sha256) = 64 AND sha256 NOT GLOB '*[^0-9a-f]*'),
  status TEXT NOT NULL CHECK (status IN ('pending', 'available', 'published', 'deleting')),
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
  expires_at_ms INTEGER NOT NULL CHECK (expires_at_ms > created_at_ms),
  -- Pointer to the submission that consumed this material, written only with the published state.
  published_submission_id TEXT, source_format TEXT
  CHECK (source_format IS NULL OR source_format IN ('csv', 'xlsx')), object_deleted_at_ms INTEGER,
  CHECK ((status = 'published') = (published_submission_id IS NOT NULL))
) STRICT`,
  `CREATE TABLE statement_submissions (
  id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id),
  idempotency_key TEXT NOT NULL CHECK (length(idempotency_key) = 36),
  staging_id TEXT NOT NULL UNIQUE REFERENCES statement_staging_objects(id),
  submitted_at_ms INTEGER NOT NULL CHECK (submitted_at_ms >= 0), source_format TEXT
  CHECK (source_format IS NULL OR source_format IN ('csv', 'xlsx')), parser_revision TEXT, service_market TEXT, locale TEXT, time_zone TEXT, status TEXT NOT NULL DEFAULT 'queued'
  CHECK (status IN ('queued', 'processing', 'completed', 'failed')), started_at_ms INTEGER, completed_at_ms INTEGER, retention_expires_at_ms INTEGER, failure_reason TEXT
  CHECK (failure_reason IS NULL OR failure_reason IN ('unsupported-format', 'resource-limit',
    'malformed-file', 'mapping-unavailable', 'retention-expired')), source_parse_attempts INTEGER NOT NULL DEFAULT 0 CHECK(source_parse_attempts BETWEEN 0 AND 3), processed_rows INTEGER NOT NULL DEFAULT 0 CHECK(processed_rows>=0), processed_accepted_rows INTEGER NOT NULL DEFAULT 0 CHECK(processed_accepted_rows>=0), processed_review_rows INTEGER NOT NULL DEFAULT 0 CHECK(processed_review_rows>=0), hosted_session_id TEXT, hosted_turn_id TEXT, hosted_expires_at_ms INTEGER, hosted_abandoned_at_ms INTEGER, clarification_state TEXT, clarification_expires_at_ms INTEGER, clarification_ended_at_ms INTEGER, work_published_at_ms INTEGER, work_last_attempt_at_ms INTEGER, work_last_reconciled_at_ms INTEGER CHECK((work_published_at_ms IS NULL AND work_last_attempt_at_ms IS NULL AND work_last_reconciled_at_ms IS NULL) OR (work_published_at_ms IS NOT NULL AND (work_published_at_ms >= 0) AND (work_last_attempt_at_ms IS NULL OR work_last_attempt_at_ms >= 0) AND (work_last_reconciled_at_ms IS NULL OR work_last_reconciled_at_ms >= 0))),
  UNIQUE (user_id, idempotency_key)
) STRICT`,
  `CREATE UNIQUE INDEX submission_owner ON statement_submissions(user_id,id)`,
  `CREATE TABLE media_submissions (
 id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), portfolio_id TEXT NOT NULL,
 bsuid TEXT NOT NULL, message_id TEXT NOT NULL, input_digest TEXT NOT NULL, media_id TEXT, caption TEXT,
 accepted_at_ms INTEGER NOT NULL, expires_at_ms INTEGER NOT NULL,
 service_market TEXT NOT NULL, locale TEXT NOT NULL, time_zone TEXT NOT NULL, capacity_held INTEGER NOT NULL DEFAULT 1 CHECK(capacity_held IN (0,1)),
 UNIQUE(user_id,portfolio_id,message_id), CHECK(expires_at_ms = accepted_at_ms + 2592000000)
)`,
  `CREATE UNIQUE INDEX media_owner ON media_submissions(user_id,id)`,
  `CREATE TABLE ingestion_review_items (
 id TEXT NOT NULL,
 user_id TEXT NOT NULL REFERENCES users(id),
 source_kind TEXT NOT NULL CHECK(source_kind IN ('statement','email','media')),
 email_receipt_id TEXT,
 media_submission_id TEXT,
 statement_submission_id TEXT,
 record_number INTEGER,
 reason TEXT NOT NULL,
 created_at_ms INTEGER NOT NULL,
 evidence_expires_at_ms INTEGER NOT NULL,
 service_market TEXT NOT NULL,
 locale TEXT NOT NULL,
 time_zone TEXT NOT NULL,
 source_format TEXT,
 parser_revision TEXT,
 extractor_revision TEXT,
 original_evidence TEXT,
 known_money_json TEXT,
 issues_json TEXT,
 evidence_state TEXT CHECK(evidence_state IN ('retained','resolved','expired')),
 suggestions_json TEXT,
 workspace_state TEXT CHECK(workspace_state IN ('pending','skipped','created','abandoned')),
 workspace_revision INTEGER CHECK(workspace_revision>0),
 draft_json TEXT CHECK(draft_json IS NULL OR length(draft_json)<=4096),
 transaction_id TEXT,
 workspace_updated_at_ms INTEGER,
 workspace_archive_row_ref TEXT,
 PRIMARY KEY(user_id,id),
 UNIQUE(statement_submission_id,record_number),
 UNIQUE(email_receipt_id),
 UNIQUE(media_submission_id),
 FOREIGN KEY(user_id,statement_submission_id) REFERENCES statement_submissions(user_id,id),
 FOREIGN KEY(user_id,email_receipt_id) REFERENCES forwarded_email_receipts(user_id,id),
 FOREIGN KEY(user_id,media_submission_id) REFERENCES media_submissions(user_id,id),
 FOREIGN KEY(transaction_id,user_id) REFERENCES transactions(id,user_id),
 CHECK((source_kind='statement' AND statement_submission_id IS NOT NULL AND record_number IS NOT NULL AND record_number>0 AND email_receipt_id IS NULL AND media_submission_id IS NULL)
 OR (source_kind='email' AND email_receipt_id IS NOT NULL AND statement_submission_id IS NULL AND record_number IS NULL AND media_submission_id IS NULL)
 OR (source_kind='media' AND media_submission_id IS NOT NULL AND statement_submission_id IS NULL AND record_number IS NULL AND email_receipt_id IS NULL)),
 CHECK((source_kind='statement' AND source_format IS NOT NULL AND source_format IN ('csv','xlsx') AND parser_revision IS NOT NULL AND extractor_revision IS NOT NULL AND issues_json IS NOT NULL AND evidence_state IS NOT NULL AND ((evidence_state='retained')=(original_evidence IS NOT NULL))
 AND reason IN ('malformed-source-row','missing-required-fact','ambiguous-direction','ambiguous-currency','canonical-validation-failed','mapping-unavailable','model-unavailable'))
 OR (source_kind<>'statement' AND source_format IS NULL AND parser_revision IS NULL AND extractor_revision IS NULL AND issues_json IS NULL AND evidence_state IS NULL AND original_evidence IS NULL AND known_money_json IS NULL
 AND ((source_kind='media' AND reason IN ('extraction-unavailable','unparseable-material')) OR (source_kind='email' AND reason IN ('canonical-validation-failed','unsupported-content','unknown-format','ambiguous-format','invalid-format','provider-retrieval-failed','processing-interrupted','consent-revoked'))))),
 CHECK((workspace_state IS NULL AND workspace_revision IS NULL AND draft_json IS NULL AND transaction_id IS NULL AND workspace_updated_at_ms IS NULL AND workspace_archive_row_ref IS NULL)
 OR (workspace_state IS NOT NULL AND workspace_revision IS NOT NULL AND workspace_updated_at_ms IS NOT NULL AND workspace_archive_row_ref IS NOT NULL AND ((workspace_state='created')=(transaction_id IS NOT NULL))))
) STRICT`,
  `CREATE VIEW ingestion_review_sources AS SELECT id,user_id,source_kind AS source,reason,created_at_ms,evidence_expires_at_ms AS expires_at_ms,service_market,locale,time_zone,
 CASE WHEN workspace_state='abandoned' THEN 'expired' ELSE coalesce(workspace_state,'pending') END AS status,transaction_id,coalesce(workspace_revision,0) AS revision,draft_json,suggestions_json FROM ingestion_review_items`,
  `CREATE VIEW statement_review_context AS SELECT rowid,id,user_id,statement_submission_id AS submission_id,record_number,reason,original_evidence,known_money_json AS known_money,issues_json AS issues,CASE evidence_state WHEN 'retained' THEN 'pending' ELSE evidence_state END AS status,evidence_expires_at_ms,created_at_ms,service_market,locale,time_zone,source_format,parser_revision,extractor_revision,suggestions_json AS review_suggestions_json FROM ingestion_review_items WHERE source_kind='statement'`,
  `CREATE INDEX ingestion_review_page ON ingestion_review_items(user_id,evidence_expires_at_ms,id)`,
  `CREATE INDEX ingestion_review_recent ON ingestion_review_items(user_id,created_at_ms DESC,id DESC)`,
  `ALTER TABLE source_attestations ADD COLUMN review_item_id TEXT`,
  `ALTER TABLE source_attestations ADD COLUMN statement_submission_id TEXT`,
  `ALTER TABLE source_attestations ADD COLUMN statement_record_number INTEGER`,
  `ALTER TABLE source_attestations ADD COLUMN content_sha256 TEXT`,
  `ALTER TABLE source_attestations ADD COLUMN source_format TEXT`,
  `ALTER TABLE source_attestations ADD COLUMN received_email_id TEXT`,
  `ALTER TABLE source_attestations ADD COLUMN interpretation_json TEXT`,
  `ALTER TABLE source_attestations ADD COLUMN user_provided_fields TEXT`,
  `CREATE TABLE statement_documents(id TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id),portfolio TEXT NOT NULL,bsuid TEXT NOT NULL,message TEXT NOT NULL,endpoint TEXT NOT NULL,media_id TEXT NOT NULL,occurred_at_ms INTEGER NOT NULL,received_at_ms INTEGER NOT NULL,expires_at_ms INTEGER NOT NULL,object_key TEXT NOT NULL UNIQUE,last_stage_attempt_at_ms INTEGER NOT NULL,unsupported INTEGER NOT NULL DEFAULT 0 CHECK(unsupported IN(0,1)),disposition INTEGER NOT NULL DEFAULT 0 CHECK(disposition BETWEEN 0 AND 2),UNIQUE(user_id,portfolio,message)) STRICT`,
  `CREATE TABLE statement_document_origins(user_id TEXT NOT NULL REFERENCES users(id),message TEXT NOT NULL,session_id TEXT NOT NULL,turn_id TEXT NOT NULL,occurred_at_ms INTEGER NOT NULL,expires_at_ms INTEGER NOT NULL,forget_at_ms INTEGER NOT NULL,PRIMARY KEY(user_id,message)) STRICT`,
  `CREATE INDEX statement_origin_expiry ON statement_document_origins(forget_at_ms)`,
  `CREATE TABLE statement_backfill(user_id TEXT PRIMARY KEY REFERENCES users(id),submission_id TEXT NOT NULL,consumed_at_ms INTEGER) STRICT`,
  `CREATE TABLE statement_parts(submission_id TEXT NOT NULL REFERENCES statement_submissions(id),part INTEGER NOT NULL,rows_json TEXT NOT NULL,PRIMARY KEY(submission_id,part)) STRICT`,
  `ALTER TABLE statement_submissions ADD COLUMN headers_json TEXT`,
  `ALTER TABLE statement_submissions ADD COLUMN materialized_rows INTEGER`,
  `CREATE VIEW ingestion_statement_review_decisions AS SELECT id AS review_id,statement_submission_id AS submission_id,user_id,CASE workspace_state WHEN 'created' THEN 'resolved' ELSE workspace_state END AS decision,transaction_id,workspace_updated_at_ms AS decided_at_ms FROM ingestion_review_items WHERE source_kind='statement' AND workspace_state!='pending'`,
  `CREATE VIEW statement_submission_context AS SELECT s.rowid AS rowid,s.*,
 CASE WHEN status='completed' OR (status='failed' AND processed_rows>0) THEN processed_rows END AS input_rows,
 CASE WHEN status='completed' OR (status='failed' AND processed_rows>0) THEN processed_accepted_rows END AS accepted_rows,
 CASE WHEN status='completed' OR (status='failed' AND processed_rows>0) THEN processed_review_rows END AS needs_review_rows
 FROM statement_submissions s`,
  `CREATE INDEX forwarded_pending ON forwarded_email_receipts(state,outcome,expires_at_ms)`,
  `CREATE TABLE ingest_sample_candidates(id TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id),receipt_id TEXT NOT NULL UNIQUE REFERENCES forwarded_email_receipts(id),revision INTEGER NOT NULL DEFAULT 1 CHECK(revision>0),service_market TEXT NOT NULL CHECK(service_market='CO'),source_format TEXT NOT NULL,source_provider TEXT NOT NULL,parser_revision TEXT NOT NULL,anonymization_revision TEXT NOT NULL,structure TEXT NOT NULL,expires_at_ms INTEGER NOT NULL) STRICT`,
  `ALTER TABLE forwarding_addresses ADD COLUMN route_registered INTEGER NOT NULL DEFAULT 0 CHECK(route_registered IN (0,1))`,
  `DROP TRIGGER issue_forwarding_address`,
  `CREATE TRIGGER issue_forwarding_address AFTER INSERT ON consent_history WHEN NEW.record_type='processing_grant' BEGIN INSERT INTO forwarding_addresses(id,user_id,local_part,issued_at_ms) SELECT lower(hex(randomblob(4)))||'-'||lower(hex(randomblob(2)))||'-4'||substr(lower(hex(randomblob(2))),2)||'-8'||substr(lower(hex(randomblob(2))),2)||'-'||lower(hex(randomblob(6))),NEW.user_id,lower(hex(randomblob(24))),NEW.occurred_at_ms WHERE NOT EXISTS(SELECT 1 FROM forwarding_addresses WHERE user_id=NEW.user_id); END`,
] as const;

export const ingestionSchema = (): ReadonlyArray<string> => history;
