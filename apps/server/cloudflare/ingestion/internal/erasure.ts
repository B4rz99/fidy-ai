import type { ErasureProjection } from "../../erasure-store/contract";

const storingInterruptionMs = 900000;

export const projections: ReadonlyArray<ErasureProjection> = [
  {
    id: "ingestion_review_state",
    dataClass: "ingestion",
    dependencies: [],
    quiescence: { _tag: "Synchronous" },
    select: (userId) => ({
      sql: "SELECT CAST(r.rowid AS TEXT) AS rowRef,json_object('id',r.\"id\",'user_id',r.\"user_id\",'status',r.\"status\",'revision',r.\"revision\",'draft_json',r.\"draft_json\",'transaction_id',r.\"transaction_id\",'expires_at_ms',r.\"expires_at_ms\",'updated_at_ms',r.\"updated_at_ms\",'created_at_ms',r.\"created_at_ms\") AS body FROM ingestion_review_state r WHERE r.user_id=?",
      params: [userId],
    }),
    candidates: (userId) => ({
      sql: "SELECT CAST(r.rowid AS TEXT) AS rowRef FROM ingestion_review_state r WHERE r.user_id=?",
      params: [userId],
    }),
    remaining: (userId) => ({
      sql: "SELECT 1 FROM ingestion_review_state r WHERE r.user_id=?",
      params: [userId],
    }),
    remove: (scope) => [
      {
        sql: "DELETE FROM ingestion_review_state AS r WHERE r.user_id=? AND CAST(r.rowid AS TEXT) IN(SELECT row_ref FROM erasure_chunk WHERE request_id=?)",
        params: [scope.userId, scope.reference],
      },
    ],
  },
  {
    id: "email_forwarding_addresses",
    dataClass: "ingestion",
    dependencies: [],
    quiescence: { _tag: "Synchronous" },
    select: (userId) => ({
      sql: "SELECT CAST(r.rowid AS TEXT) AS rowRef,json_object('id',r.\"id\",'user_id',r.\"user_id\",'local_part',r.\"local_part\",'created_at_ms',r.\"issued_at_ms\") AS body FROM forwarding_addresses r WHERE r.user_id=?",
      params: [userId],
    }),
    candidates: (userId) => ({
      sql: "SELECT CAST(r.rowid AS TEXT) AS rowRef FROM forwarding_addresses r WHERE r.user_id=?",
      params: [userId],
    }),
    remaining: (userId) => ({
      sql: "SELECT 1 FROM forwarding_addresses r WHERE r.user_id=?",
      params: [userId],
    }),
    remove: (scope) => [
      {
        sql: "DELETE FROM forwarding_addresses AS r WHERE r.user_id=? AND CAST(r.rowid AS TEXT) IN(SELECT row_ref FROM erasure_chunk WHERE request_id=?)",
        params: [scope.userId, scope.reference],
      },
    ],
  },
  {
    id: "forwarded_email_receipts",
    dataClass: "ingestion",
    dependencies: ["source_attestations"],
    quiescence: {
      _tag: "Durable",
      select: ({ current, userId }) => ({
        sql: "SELECT 1 FROM forwarded_email_receipts r WHERE r.user_id=? AND r.state IN('storing','queued') AND r.expires_at_ms>? AND (r.state='queued' OR r.received_at_ms>?) AND r.outcome IS NULL",
        params: [userId, current, current - storingInterruptionMs],
      }),
    },
    select: (userId) => ({
      sql: "SELECT CAST(r.rowid AS TEXT) AS rowRef,json_object('id',r.\"id\",'user_id',r.\"user_id\",'object_key',r.\"object_key\",'byte_length',r.\"byte_length\",'state',r.\"state\",'received_at_ms',r.\"received_at_ms\",'expires_at_ms',r.\"expires_at_ms\",'time_zone',r.\"time_zone\",'deferred_checked_at_ms',r.\"deferred_checked_at_ms\",'outcome',r.outcome,'outcome_transaction_id',r.outcome_transaction_id,'outcome_review_id',r.outcome_review_id,'outcome_completed_at_ms',r.outcome_completed_at_ms,'review_id',r.review_id,'review_reason',r.review_reason,'review_created_at_ms',r.review_created_at_ms,'review_evidence_expires_at_ms',r.review_evidence_expires_at_ms,'dispatch_user_id',r.dispatch_user_id,'dispatch_sent_at_ms',r.dispatch_sent_at_ms) AS body FROM forwarded_email_receipts r WHERE r.user_id=?",
      params: [userId],
    }),
    candidates: (userId) => ({
      sql: "SELECT CAST(r.rowid AS TEXT) AS rowRef FROM forwarded_email_receipts r WHERE r.user_id=?",
      params: [userId],
    }),
    remaining: (userId) => ({
      sql: "SELECT 1 FROM forwarded_email_receipts r WHERE r.user_id=?",
      params: [userId],
    }),
    remove: (scope) => [
      {
        sql: "DELETE FROM forwarded_email_receipts AS r WHERE r.user_id=? AND CAST(r.rowid AS TEXT) IN(SELECT row_ref FROM erasure_chunk WHERE request_id=?)",
        params: [scope.userId, scope.reference],
      },
    ],
  },
  {
    id: "media_submissions",
    dataClass: "ingestion",
    dependencies: ["media_submission_audit"],
    quiescence: { _tag: "Synchronous" },
    select: (userId) => ({
      sql: "SELECT CAST(r.rowid AS TEXT) AS rowRef,json_object('id',r.\"id\",'user_id',r.\"user_id\",'portfolio_id',r.\"portfolio_id\",'bsuid',r.\"bsuid\",'message_id',r.\"message_id\",'media_id',r.\"media_id\",'caption',r.\"caption\",'accepted_at_ms',r.\"accepted_at_ms\",'expires_at_ms',r.\"expires_at_ms\",'service_market',r.\"service_market\",'locale',r.\"locale\",'time_zone',r.\"time_zone\",'review_reason',r.\"review_reason\",'review_created_at_ms',r.\"review_created_at_ms\") AS body FROM media_submissions r WHERE r.user_id=?",
      params: [userId],
    }),
    candidates: (userId) => ({
      sql: "SELECT CAST(r.rowid AS TEXT) AS rowRef FROM media_submissions r WHERE r.user_id=?",
      params: [userId],
    }),
    remaining: (userId) => ({
      sql: "SELECT 1 FROM media_submissions r WHERE r.user_id=?",
      params: [userId],
    }),
    remove: (scope) => [
      {
        sql: "DELETE FROM media_submissions AS r WHERE r.user_id=? AND CAST(r.rowid AS TEXT) IN(SELECT row_ref FROM erasure_chunk WHERE request_id=?)",
        params: [scope.userId, scope.reference],
      },
    ],
  },
  {
    id: "statement_backfill_entitlements",
    dataClass: "ingestion",
    dependencies: [],
    quiescence: { _tag: "Synchronous" },
    select: (userId) => ({
      sql: "SELECT CAST(r.rowid AS TEXT) AS rowRef,json_object('user_id',r.\"id\",'submission_id',r.\"backfill_submission_id\",'consumed_at_ms',r.\"backfill_consumed_at_ms\") AS body FROM users r WHERE r.backfill_present IS NOT NULL AND r.id=?",
      params: [userId],
    }),
    candidates: (userId) => ({
      sql: "SELECT CAST(r.rowid AS TEXT) AS rowRef FROM users r WHERE r.backfill_present IS NOT NULL AND r.id=?",
      params: [userId],
    }),
    remaining: (userId) => ({
      sql: "SELECT 1 FROM users r WHERE r.backfill_present IS NOT NULL AND r.id=?",
      params: [userId],
    }),
    remove: (scope) => [
      {
        sql: "UPDATE users AS r SET backfill_present=NULL,backfill_submission_id=NULL,backfill_consumed_at_ms=NULL WHERE r.backfill_present IS NOT NULL AND r.id=? AND CAST(r.rowid AS TEXT) IN(SELECT row_ref FROM erasure_chunk WHERE request_id=?)",
        params: [scope.userId, scope.reference],
      },
    ],
  },

  {
    id: "statement_materialization_parts",
    dataClass: "ingestion",
    dependencies: [],
    quiescence: { _tag: "Synchronous" },
    select: (userId) => ({
      sql: "SELECT CAST(r.rowid AS TEXT) AS rowRef,json_object('submission_id',r.\"submission_id\",'chunk_index',r.\"chunk_index\",'part_index',r.\"part_index\",'body',r.\"body\",'sha256',r.\"sha256\") AS body FROM statement_materialization_parts r WHERE EXISTS(SELECT 1 FROM statement_submissions p WHERE p.id=r.submission_id AND p.user_id=?)",
      params: [userId],
    }),
    candidates: (userId) => ({
      sql: "SELECT CAST(r.rowid AS TEXT) AS rowRef FROM statement_materialization_parts r WHERE EXISTS(SELECT 1 FROM statement_submissions p WHERE p.id=r.submission_id AND p.user_id=?)",
      params: [userId],
    }),
    remaining: (userId) => ({
      sql: "SELECT 1 FROM statement_materialization_parts r WHERE EXISTS(SELECT 1 FROM statement_submissions p WHERE p.id=r.submission_id AND p.user_id=?)",
      params: [userId],
    }),
    remove: (scope) => [
      {
        sql: "DELETE FROM statement_materialization_parts AS r WHERE EXISTS(SELECT 1 FROM statement_submissions p WHERE p.id=r.submission_id AND p.user_id=?) AND CAST(r.rowid AS TEXT) IN(SELECT row_ref FROM erasure_chunk WHERE request_id=?)",
        params: [scope.userId, scope.reference],
      },
    ],
  },

  {
    id: "statement_needs_review",
    dataClass: "ingestion",
    dependencies: ["ingestion_review_state"],
    quiescence: { _tag: "Synchronous" },
    select: (userId) => ({
      sql: "SELECT CAST(r.rowid AS TEXT) AS rowRef,json_object('id',r.\"id\",'user_id',r.\"user_id\",'submission_id',r.\"submission_id\",'record_number',r.\"record_number\",'reason',r.\"reason\",'original_evidence',r.\"original_evidence\",'known_money',r.\"known_money\",'issues',r.\"issues\",'status',r.\"status\",'evidence_expires_at_ms',r.\"evidence_expires_at_ms\",'created_at_ms',r.\"created_at_ms\",'service_market',r.\"service_market\",'locale',r.\"locale\",'time_zone',r.\"time_zone\",'source_format',r.\"source_format\",'parser_revision',r.\"parser_revision\",'extractor_revision',r.\"extractor_revision\",'review_suggestions_json',r.\"review_suggestions_json\") AS body FROM statement_needs_review r WHERE r.user_id=?",
      params: [userId],
    }),
    candidates: (userId) => ({
      sql: "SELECT CAST(r.rowid AS TEXT) AS rowRef FROM statement_needs_review r WHERE r.user_id=?",
      params: [userId],
    }),
    remaining: (userId) => ({
      sql: "SELECT 1 FROM statement_needs_review r WHERE r.user_id=?",
      params: [userId],
    }),
    remove: (scope) => [
      {
        sql: "DELETE FROM statement_needs_review AS r WHERE r.user_id=? AND CAST(r.rowid AS TEXT) IN(SELECT row_ref FROM erasure_chunk WHERE request_id=?)",
        params: [scope.userId, scope.reference],
      },
    ],
  },
  {
    id: "statement_record_outcomes",
    dataClass: "ingestion",
    dependencies: [],
    quiescence: { _tag: "Synchronous" },
    select: (userId) => ({
      sql: "SELECT CAST(r.rowid AS TEXT) AS rowRef,json_object('user_id',r.\"user_id\",'submission_id',r.\"submission_id\",'record_number',r.\"record_number\",'outcome',r.\"outcome\",'transaction_id',r.\"transaction_id\") AS body FROM statement_record_outcomes r WHERE r.user_id=?",
      params: [userId],
    }),
    candidates: (userId) => ({
      sql: "SELECT CAST(r.rowid AS TEXT) AS rowRef FROM statement_record_outcomes r WHERE r.user_id=?",
      params: [userId],
    }),
    remaining: (userId) => ({
      sql: "SELECT 1 FROM statement_record_outcomes r WHERE r.user_id=?",
      params: [userId],
    }),
    remove: (scope) => [
      {
        sql: "DELETE FROM statement_record_outcomes AS r WHERE r.user_id=? AND CAST(r.rowid AS TEXT) IN(SELECT row_ref FROM erasure_chunk WHERE request_id=?)",
        params: [scope.userId, scope.reference],
      },
    ],
  },
  {
    id: "statement_staging_objects",
    dataClass: "ingestion",
    dependencies: ["statement_submissions", "statement_whatsapp_documents"],
    quiescence: { _tag: "Synchronous" },
    select: (userId) => ({
      sql: "SELECT CAST(r.rowid AS TEXT) AS rowRef,json_object('id',r.\"id\",'user_id',r.\"user_id\",'object_key',r.\"object_key\",'byte_length',r.\"byte_length\",'sha256',r.\"sha256\",'status',r.\"status\",'created_at_ms',r.\"created_at_ms\",'expires_at_ms',r.\"expires_at_ms\",'published_submission_id',r.\"published_submission_id\",'source_format',r.\"source_format\",'object_deleted_at_ms',r.\"object_deleted_at_ms\") AS body FROM statement_staging_objects r WHERE r.user_id=?",
      params: [userId],
    }),
    candidates: (userId) => ({
      sql: "SELECT CAST(r.rowid AS TEXT) AS rowRef FROM statement_staging_objects r WHERE r.user_id=?",
      params: [userId],
    }),
    remaining: (userId) => ({
      sql: "SELECT 1 FROM statement_staging_objects r WHERE r.user_id=?",
      params: [userId],
    }),
    remove: (scope) => [
      {
        sql: "DELETE FROM statement_staging_objects AS r WHERE r.user_id=? AND CAST(r.rowid AS TEXT) IN(SELECT row_ref FROM erasure_chunk WHERE request_id=?)",
        params: [scope.userId, scope.reference],
      },
    ],
  },
  {
    id: "statement_submissions",
    dataClass: "ingestion",
    dependencies: [
      "source_attestations",
      "statement_backfill_entitlements",
      "statement_materialization_parts",
      "statement_needs_review",
      "statement_record_outcomes",
    ],
    quiescence: {
      _tag: "Durable",
      select: ({ current, userId }) => ({
        sql: "SELECT 1 FROM statement_submissions s JOIN statement_staging_objects o ON o.id=s.staging_id WHERE s.user_id=? AND s.status IN('queued','processing') AND COALESCE(s.retention_expires_at_ms,o.expires_at_ms)>?",
        params: [userId, current],
      }),
    },
    select: (userId) => ({
      sql: "SELECT CAST(r.rowid AS TEXT) AS rowRef,json_object('id',r.\"id\",'user_id',r.\"user_id\",'idempotency_key',r.\"idempotency_key\",'staging_id',r.\"staging_id\",'submitted_at_ms',r.\"submitted_at_ms\",'source_format',r.\"source_format\",'parser_revision',r.\"parser_revision\",'service_market',r.\"service_market\",'locale',r.\"locale\",'time_zone',r.\"time_zone\",'status',r.\"status\",'started_at_ms',r.\"started_at_ms\",'completed_at_ms',r.\"completed_at_ms\",'input_rows',r.\"input_rows\",'accepted_rows',r.\"accepted_rows\",'needs_review_rows',r.\"needs_review_rows\",'retention_expires_at_ms',r.\"retention_expires_at_ms\",'failure_reason',r.\"failure_reason\",'source_parse_attempts',r.\"source_parse_attempts\",'processed_rows',r.\"processed_rows\",'processed_accepted_rows',r.\"processed_accepted_rows\",'processed_review_rows',r.\"processed_review_rows\",'material_source_sha256',r.material_source_sha256,'material_parts_sha256',r.material_parts_sha256,'material_parser_revision',CASE WHEN r.material_state IS NOT NULL THEN r.parser_revision END,'material_source_format',CASE WHEN r.material_state IS NOT NULL THEN r.source_format END,'material_representation_revision',r.material_representation_revision,'material_service_market',CASE WHEN r.material_state IS NOT NULL THEN r.service_market END,'material_locale',CASE WHEN r.material_state IS NOT NULL THEN r.locale END,'material_time_zone',CASE WHEN r.material_state IS NOT NULL THEN r.time_zone END,'material_expires_at_ms',r.material_expires_at_ms,'material_headers_json',r.material_headers_json,'material_row_count',r.material_row_count,'material_part_count',r.material_part_count,'material_byte_length',r.material_byte_length,'material_state',r.material_state,'hosted_session_id',r.hosted_session_id,'hosted_turn_id',r.hosted_turn_id,'hosted_expires_at_ms',r.hosted_expires_at_ms,'hosted_abandoned_at_ms',r.hosted_abandoned_at_ms,'clarification_state',r.clarification_state,'clarification_expires_at_ms',r.clarification_expires_at_ms,'clarification_ended_at_ms',r.clarification_ended_at_ms,'work_user_id',CASE WHEN r.work_published_at_ms IS NOT NULL THEN r.user_id END,'work_revision',CASE WHEN r.work_published_at_ms IS NOT NULL THEN 1 END,'work_published_at_ms',r.work_published_at_ms,'work_last_attempt_at_ms',r.work_last_attempt_at_ms,'work_last_reconciled_at_ms',r.work_last_reconciled_at_ms) AS body FROM statement_submissions r WHERE r.user_id=?",
      params: [userId],
    }),
    candidates: (userId) => ({
      sql: "SELECT CAST(r.rowid AS TEXT) AS rowRef FROM statement_submissions r WHERE r.user_id=?",
      params: [userId],
    }),
    remaining: (userId) => ({
      sql: "SELECT 1 FROM statement_submissions r WHERE r.user_id=?",
      params: [userId],
    }),
    remove: (scope) => [
      {
        sql: "DELETE FROM statement_submissions AS r WHERE r.user_id=? AND CAST(r.rowid AS TEXT) IN(SELECT row_ref FROM erasure_chunk WHERE request_id=?)",
        params: [scope.userId, scope.reference],
      },
    ],
  },
  {
    id: "statement_whatsapp_documents",
    dataClass: "ingestion",
    dependencies: [],
    quiescence: { _tag: "Synchronous" },
    select: (userId) => ({
      sql: "SELECT CAST(r.rowid AS TEXT) AS rowRef,json_object('turn_id',r.\"turn_id\",'user_id',r.\"user_id\",'media_id',r.\"media_id\",'staging_id',r.\"staging_id\",'upload_grant_id',r.\"upload_grant_id\",'upload_expires_at_ms',r.\"upload_expires_at_ms\",'reference_json',r.\"reference_json\",'created_at_ms',r.\"created_at_ms\") AS body FROM (SELECT rowid,id AS turn_id,user_id,document_media_id AS media_id,document_staging_id AS staging_id,document_upload_grant_id AS upload_grant_id,document_upload_expires_at_ms AS upload_expires_at_ms,document_reference_json AS reference_json,document_created_at_ms AS created_at_ms FROM hosted_turns WHERE document_media_id IS NOT NULL) r WHERE r.user_id=?",
      params: [userId],
    }),
    candidates: (userId) => ({
      sql: "SELECT CAST(r.rowid AS TEXT) AS rowRef FROM (SELECT rowid,id AS turn_id,user_id,document_media_id AS media_id,document_staging_id AS staging_id,document_upload_grant_id AS upload_grant_id,document_upload_expires_at_ms AS upload_expires_at_ms,document_reference_json AS reference_json,document_created_at_ms AS created_at_ms FROM hosted_turns WHERE document_media_id IS NOT NULL) r WHERE r.user_id=?",
      params: [userId],
    }),
    remaining: (userId) => ({
      sql: "SELECT 1 FROM (SELECT rowid,id AS turn_id,user_id,document_media_id AS media_id,document_staging_id AS staging_id,document_upload_grant_id AS upload_grant_id,document_upload_expires_at_ms AS upload_expires_at_ms,document_reference_json AS reference_json,document_created_at_ms AS created_at_ms FROM hosted_turns WHERE document_media_id IS NOT NULL) r WHERE r.user_id=?",
      params: [userId],
    }),
    remove: (scope) => [
      {
        sql: "UPDATE hosted_turns SET document_media_id=NULL,document_staging_id=NULL,document_upload_grant_id=NULL,document_upload_expires_at_ms=NULL,document_reference_json=NULL,document_created_at_ms=NULL WHERE user_id=? AND CAST(rowid AS TEXT) IN(SELECT row_ref FROM erasure_chunk WHERE request_id=?)",
        params: [scope.userId, scope.reference],
      },
    ],
  },
];
