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
      sql: "SELECT CAST(r.rowid AS TEXT) AS rowRef,json_object('id',r.\"id\",'user_id',r.\"user_id\",'local_part',r.\"local_part\",'created_at_ms',r.\"created_at_ms\") AS body FROM email_forwarding_addresses r WHERE r.user_id=?",
      params: [userId],
    }),
    candidates: (userId) => ({
      sql: "SELECT CAST(r.rowid AS TEXT) AS rowRef FROM email_forwarding_addresses r WHERE r.user_id=?",
      params: [userId],
    }),
    remaining: (userId) => ({
      sql: "SELECT 1 FROM email_forwarding_addresses r WHERE r.user_id=?",
      params: [userId],
    }),
    remove: (scope) => [
      {
        sql: "DELETE FROM email_forwarding_addresses AS r WHERE r.user_id=? AND CAST(r.rowid AS TEXT) IN(SELECT row_ref FROM erasure_chunk WHERE request_id=?)",
        params: [scope.userId, scope.reference],
      },
    ],
  },
  {
    id: "forwarded_email_deferrals",
    dataClass: "ingestion",
    dependencies: [],
    quiescence: { _tag: "Synchronous" },
    select: (userId) => ({
      sql: "SELECT CAST(r.rowid AS TEXT) AS rowRef,json_object('receipt_id',r.\"receipt_id\",'user_id',r.\"user_id\",'resume_at_ms',r.\"resume_at_ms\",'checked_at_ms',r.\"checked_at_ms\") AS body FROM forwarded_email_deferrals r WHERE r.user_id=?",
      params: [userId],
    }),
    candidates: (userId) => ({
      sql: "SELECT CAST(r.rowid AS TEXT) AS rowRef FROM forwarded_email_deferrals r WHERE r.user_id=?",
      params: [userId],
    }),
    remaining: (userId) => ({
      sql: "SELECT 1 FROM forwarded_email_deferrals r WHERE r.user_id=?",
      params: [userId],
    }),
    remove: (scope) => [
      {
        sql: "DELETE FROM forwarded_email_deferrals AS r WHERE r.user_id=? AND CAST(r.rowid AS TEXT) IN(SELECT row_ref FROM erasure_chunk WHERE request_id=?)",
        params: [scope.userId, scope.reference],
      },
    ],
  },
  {
    id: "forwarded_email_needs_review",
    dataClass: "ingestion",
    dependencies: [],
    quiescence: { _tag: "Synchronous" },
    select: (userId) => ({
      sql: "SELECT CAST(r.rowid AS TEXT) AS rowRef,json_object('id',r.\"id\",'receipt_id',r.\"receipt_id\",'user_id',r.\"user_id\",'reason',r.\"reason\",'created_at_ms',r.\"created_at_ms\",'evidence_expires_at_ms',r.\"evidence_expires_at_ms\") AS body FROM forwarded_email_needs_review r WHERE r.user_id=?",
      params: [userId],
    }),
    candidates: (userId) => ({
      sql: "SELECT CAST(r.rowid AS TEXT) AS rowRef FROM forwarded_email_needs_review r WHERE r.user_id=?",
      params: [userId],
    }),
    remaining: (userId) => ({
      sql: "SELECT 1 FROM forwarded_email_needs_review r WHERE r.user_id=?",
      params: [userId],
    }),
    remove: (scope) => [
      {
        sql: "DELETE FROM forwarded_email_needs_review AS r WHERE r.user_id=? AND CAST(r.rowid AS TEXT) IN(SELECT row_ref FROM erasure_chunk WHERE request_id=?)",
        params: [scope.userId, scope.reference],
      },
    ],
  },
  {
    id: "forwarded_email_outbox",
    dataClass: "ingestion",
    dependencies: [],
    quiescence: { _tag: "Synchronous" },
    select: (userId) => ({
      sql: "SELECT CAST(r.rowid AS TEXT) AS rowRef,json_object('receipt_id',r.\"receipt_id\",'user_id',r.\"user_id\",'sent_at_ms',r.\"sent_at_ms\") AS body FROM forwarded_email_outbox r WHERE r.user_id=?",
      params: [userId],
    }),
    candidates: (userId) => ({
      sql: "SELECT CAST(r.rowid AS TEXT) AS rowRef FROM forwarded_email_outbox r WHERE r.user_id=?",
      params: [userId],
    }),
    remaining: (userId) => ({
      sql: "SELECT 1 FROM forwarded_email_outbox r WHERE r.user_id=?",
      params: [userId],
    }),
    remove: (scope) => [
      {
        sql: "DELETE FROM forwarded_email_outbox AS r WHERE r.user_id=? AND CAST(r.rowid AS TEXT) IN(SELECT row_ref FROM erasure_chunk WHERE request_id=?)",
        params: [scope.userId, scope.reference],
      },
    ],
  },
  {
    id: "forwarded_email_outcomes",
    dataClass: "ingestion",
    dependencies: [],
    quiescence: { _tag: "Synchronous" },
    select: (userId) => ({
      sql: "SELECT CAST(r.rowid AS TEXT) AS rowRef,json_object('receipt_id',r.\"receipt_id\",'user_id',r.\"user_id\",'outcome',r.\"outcome\",'transaction_id',r.\"transaction_id\",'review_id',r.\"review_id\",'completed_at_ms',r.\"completed_at_ms\") AS body FROM forwarded_email_outcomes r WHERE r.user_id=?",
      params: [userId],
    }),
    candidates: (userId) => ({
      sql: "SELECT CAST(r.rowid AS TEXT) AS rowRef FROM forwarded_email_outcomes r WHERE r.user_id=?",
      params: [userId],
    }),
    remaining: (userId) => ({
      sql: "SELECT 1 FROM forwarded_email_outcomes r WHERE r.user_id=?",
      params: [userId],
    }),
    remove: (scope) => [
      {
        sql: "DELETE FROM forwarded_email_outcomes AS r WHERE r.user_id=? AND CAST(r.rowid AS TEXT) IN(SELECT row_ref FROM erasure_chunk WHERE request_id=?)",
        params: [scope.userId, scope.reference],
      },
    ],
  },
  {
    id: "forwarded_email_receipts",
    dataClass: "ingestion",
    dependencies: [
      "forwarded_email_deferrals",
      "forwarded_email_needs_review",
      "forwarded_email_outbox",
      "forwarded_email_outcomes",
      "source_attestations",
    ],
    quiescence: {
      _tag: "Durable",
      select: ({ current, userId }) => ({
        sql: "SELECT 1 FROM forwarded_email_receipts r WHERE r.user_id=? AND r.state IN('storing','queued') AND r.expires_at_ms>? AND (r.state='queued' OR r.received_at_ms>?) AND NOT EXISTS(SELECT 1 FROM forwarded_email_outcomes o WHERE o.receipt_id=r.id AND o.user_id=r.user_id)",
        params: [userId, current, current - storingInterruptionMs],
      }),
    },
    select: (userId) => ({
      sql: "SELECT CAST(r.rowid AS TEXT) AS rowRef,json_object('id',r.\"id\",'user_id',r.\"user_id\",'object_key',r.\"object_key\",'byte_length',r.\"byte_length\",'state',r.\"state\",'received_at_ms',r.\"received_at_ms\",'expires_at_ms',r.\"expires_at_ms\",'time_zone',r.\"time_zone\") AS body FROM forwarded_email_receipts r WHERE r.user_id=?",
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
    id: "media_needs_review",
    dataClass: "ingestion",
    dependencies: [],
    quiescence: { _tag: "Synchronous" },
    select: (userId) => ({
      sql: "SELECT CAST(r.rowid AS TEXT) AS rowRef,json_object('id',r.\"id\",'user_id',r.\"user_id\",'reason',r.\"reason\",'created_at_ms',r.\"created_at_ms\") AS body FROM media_needs_review r WHERE r.user_id=?",
      params: [userId],
    }),
    candidates: (userId) => ({
      sql: "SELECT CAST(r.rowid AS TEXT) AS rowRef FROM media_needs_review r WHERE r.user_id=?",
      params: [userId],
    }),
    remaining: (userId) => ({
      sql: "SELECT 1 FROM media_needs_review r WHERE r.user_id=?",
      params: [userId],
    }),
    remove: (scope) => [
      {
        sql: "DELETE FROM media_needs_review AS r WHERE r.user_id=? AND CAST(r.rowid AS TEXT) IN(SELECT row_ref FROM erasure_chunk WHERE request_id=?)",
        params: [scope.userId, scope.reference],
      },
    ],
  },
  {
    id: "media_submission_outbox",
    dataClass: "ingestion",
    dependencies: [],
    quiescence: {
      _tag: "Durable",
      select: ({ current, userId }) => ({
        sql: "SELECT 1 FROM media_submission_outbox o JOIN media_submissions s ON s.id=o.submission_id WHERE o.user_id=? AND s.expires_at_ms>?",
        params: [userId, current],
      }),
    },
    select: (userId) => ({
      sql: "SELECT CAST(r.rowid AS TEXT) AS rowRef,json_object('submission_id',r.\"submission_id\",'user_id',r.\"user_id\",'created_at_ms',r.\"created_at_ms\") AS body FROM media_submission_outbox r WHERE r.user_id=?",
      params: [userId],
    }),
    candidates: (userId) => ({
      sql: "SELECT CAST(r.rowid AS TEXT) AS rowRef FROM media_submission_outbox r WHERE r.user_id=?",
      params: [userId],
    }),
    remaining: (userId) => ({
      sql: "SELECT 1 FROM media_submission_outbox r WHERE r.user_id=?",
      params: [userId],
    }),
    remove: (scope) => [
      {
        sql: "DELETE FROM media_submission_outbox AS r WHERE r.user_id=? AND CAST(r.rowid AS TEXT) IN(SELECT row_ref FROM erasure_chunk WHERE request_id=?)",
        params: [scope.userId, scope.reference],
      },
    ],
  },
  {
    id: "media_submissions",
    dataClass: "ingestion",
    dependencies: ["media_needs_review", "media_submission_audit", "media_submission_outbox"],
    quiescence: { _tag: "Synchronous" },
    select: (userId) => ({
      sql: "SELECT CAST(r.rowid AS TEXT) AS rowRef,json_object('id',r.\"id\",'user_id',r.\"user_id\",'portfolio_id',r.\"portfolio_id\",'bsuid',r.\"bsuid\",'message_id',r.\"message_id\",'media_id',r.\"media_id\",'caption',r.\"caption\",'accepted_at_ms',r.\"accepted_at_ms\",'expires_at_ms',r.\"expires_at_ms\",'service_market',r.\"service_market\",'locale',r.\"locale\",'time_zone',r.\"time_zone\") AS body FROM media_submissions r WHERE r.user_id=?",
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
      sql: "SELECT CAST(r.rowid AS TEXT) AS rowRef,json_object('user_id',r.\"user_id\",'submission_id',r.\"submission_id\",'consumed_at_ms',r.\"consumed_at_ms\") AS body FROM statement_backfill_entitlements r WHERE r.user_id=?",
      params: [userId],
    }),
    candidates: (userId) => ({
      sql: "SELECT CAST(r.rowid AS TEXT) AS rowRef FROM statement_backfill_entitlements r WHERE r.user_id=?",
      params: [userId],
    }),
    remaining: (userId) => ({
      sql: "SELECT 1 FROM statement_backfill_entitlements r WHERE r.user_id=?",
      params: [userId],
    }),
    remove: (scope) => [
      {
        sql: "DELETE FROM statement_backfill_entitlements AS r WHERE r.user_id=? AND CAST(r.rowid AS TEXT) IN(SELECT row_ref FROM erasure_chunk WHERE request_id=?)",
        params: [scope.userId, scope.reference],
      },
    ],
  },
  {
    id: "statement_clarifications",
    dataClass: "ingestion",
    dependencies: [],
    quiescence: { _tag: "Synchronous" },
    select: (userId) => ({
      sql: "SELECT CAST(r.rowid AS TEXT) AS rowRef,json_object('submission_id',r.\"submission_id\",'user_id',r.\"user_id\",'state',r.\"state\",'expires_at_ms',r.\"expires_at_ms\",'ended_at_ms',r.\"ended_at_ms\") AS body FROM statement_clarifications r WHERE r.user_id=?",
      params: [userId],
    }),
    candidates: (userId) => ({
      sql: "SELECT CAST(r.rowid AS TEXT) AS rowRef FROM statement_clarifications r WHERE r.user_id=?",
      params: [userId],
    }),
    remaining: (userId) => ({
      sql: "SELECT 1 FROM statement_clarifications r WHERE r.user_id=?",
      params: [userId],
    }),
    remove: (scope) => [
      {
        sql: "DELETE FROM statement_clarifications AS r WHERE r.user_id=? AND CAST(r.rowid AS TEXT) IN(SELECT row_ref FROM erasure_chunk WHERE request_id=?)",
        params: [scope.userId, scope.reference],
      },
    ],
  },
  {
    id: "statement_hosted_origins",
    dataClass: "ingestion",
    dependencies: [],
    quiescence: { _tag: "Synchronous" },
    select: (userId) => ({
      sql: "SELECT CAST(r.rowid AS TEXT) AS rowRef,json_object('submission_id',r.\"submission_id\",'user_id',r.\"user_id\",'session_id',r.\"session_id\",'turn_id',r.\"turn_id\",'expires_at_ms',r.\"expires_at_ms\",'abandoned_at_ms',r.\"abandoned_at_ms\") AS body FROM statement_hosted_origins r WHERE r.user_id=?",
      params: [userId],
    }),
    candidates: (userId) => ({
      sql: "SELECT CAST(r.rowid AS TEXT) AS rowRef FROM statement_hosted_origins r WHERE r.user_id=?",
      params: [userId],
    }),
    remaining: (userId) => ({
      sql: "SELECT 1 FROM statement_hosted_origins r WHERE r.user_id=?",
      params: [userId],
    }),
    remove: (scope) => [
      {
        sql: "DELETE FROM statement_hosted_origins AS r WHERE r.user_id=? AND CAST(r.rowid AS TEXT) IN(SELECT row_ref FROM erasure_chunk WHERE request_id=?)",
        params: [scope.userId, scope.reference],
      },
    ],
  },
  {
    id: "statement_ingestion_outbox",
    dataClass: "ingestion",
    dependencies: [],
    quiescence: { _tag: "Synchronous" },
    select: (userId) => ({
      sql: "SELECT CAST(r.rowid AS TEXT) AS rowRef,json_object('submission_id',r.\"submission_id\",'user_id',r.\"user_id\",'revision',r.\"revision\",'published_at_ms',r.\"published_at_ms\",'last_attempt_at_ms',r.\"last_attempt_at_ms\",'last_reconciled_at_ms',r.\"last_reconciled_at_ms\") AS body FROM statement_ingestion_outbox r WHERE r.user_id=?",
      params: [userId],
    }),
    candidates: (userId) => ({
      sql: "SELECT CAST(r.rowid AS TEXT) AS rowRef FROM statement_ingestion_outbox r WHERE r.user_id=?",
      params: [userId],
    }),
    remaining: (userId) => ({
      sql: "SELECT 1 FROM statement_ingestion_outbox r WHERE r.user_id=?",
      params: [userId],
    }),
    remove: (scope) => [
      {
        sql: "DELETE FROM statement_ingestion_outbox AS r WHERE r.user_id=? AND CAST(r.rowid AS TEXT) IN(SELECT row_ref FROM erasure_chunk WHERE request_id=?)",
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
      sql: "SELECT CAST(r.rowid AS TEXT) AS rowRef,json_object('submission_id',r.\"submission_id\",'chunk_index',r.\"chunk_index\",'part_index',r.\"part_index\",'body',r.\"body\",'sha256',r.\"sha256\") AS body FROM statement_materialization_parts r WHERE EXISTS(SELECT 1 FROM statement_materializations p WHERE p.submission_id=r.submission_id AND p.user_id=?)",
      params: [userId],
    }),
    candidates: (userId) => ({
      sql: "SELECT CAST(r.rowid AS TEXT) AS rowRef FROM statement_materialization_parts r WHERE EXISTS(SELECT 1 FROM statement_materializations p WHERE p.submission_id=r.submission_id AND p.user_id=?)",
      params: [userId],
    }),
    remaining: (userId) => ({
      sql: "SELECT 1 FROM statement_materialization_parts r WHERE EXISTS(SELECT 1 FROM statement_materializations p WHERE p.submission_id=r.submission_id AND p.user_id=?)",
      params: [userId],
    }),
    remove: (scope) => [
      {
        sql: "DELETE FROM statement_materialization_parts AS r WHERE EXISTS(SELECT 1 FROM statement_materializations p WHERE p.submission_id=r.submission_id AND p.user_id=?) AND CAST(r.rowid AS TEXT) IN(SELECT row_ref FROM erasure_chunk WHERE request_id=?)",
        params: [scope.userId, scope.reference],
      },
    ],
  },
  {
    id: "statement_materializations",
    dataClass: "ingestion",
    dependencies: ["statement_materialization_parts"],
    quiescence: { _tag: "Synchronous" },
    select: (userId) => ({
      sql: "SELECT CAST(r.rowid AS TEXT) AS rowRef,json_object('submission_id',r.\"submission_id\",'user_id',r.\"user_id\",'source_sha256',r.\"source_sha256\",'parts_sha256',r.\"parts_sha256\",'parser_revision',r.\"parser_revision\",'source_format',r.\"source_format\",'representation_revision',r.\"representation_revision\",'service_market',r.\"service_market\",'locale',r.\"locale\",'time_zone',r.\"time_zone\",'expires_at_ms',r.\"expires_at_ms\",'headers_json',r.\"headers_json\",'row_count',r.\"row_count\",'part_count',r.\"part_count\",'byte_length',r.\"byte_length\",'state',r.\"state\") AS body FROM statement_materializations r WHERE r.user_id=?",
      params: [userId],
    }),
    candidates: (userId) => ({
      sql: "SELECT CAST(r.rowid AS TEXT) AS rowRef FROM statement_materializations r WHERE r.user_id=?",
      params: [userId],
    }),
    remaining: (userId) => ({
      sql: "SELECT 1 FROM statement_materializations r WHERE r.user_id=?",
      params: [userId],
    }),
    remove: (scope) => [
      {
        sql: "DELETE FROM statement_materializations AS r WHERE r.user_id=? AND CAST(r.rowid AS TEXT) IN(SELECT row_ref FROM erasure_chunk WHERE request_id=?)",
        params: [scope.userId, scope.reference],
      },
    ],
  },
  {
    id: "statement_needs_review",
    dataClass: "ingestion",
    dependencies: ["statement_review_decisions"],
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
    id: "statement_review_decisions",
    dataClass: "ingestion",
    dependencies: [],
    quiescence: { _tag: "Synchronous" },
    select: (userId) => ({
      sql: "SELECT CAST(r.rowid AS TEXT) AS rowRef,json_object('review_id',r.\"review_id\",'submission_id',r.\"submission_id\",'user_id',r.\"user_id\",'decision',r.\"decision\",'transaction_id',r.\"transaction_id\",'decided_at_ms',r.\"decided_at_ms\") AS body FROM statement_review_decisions r WHERE r.user_id=?",
      params: [userId],
    }),
    candidates: (userId) => ({
      sql: "SELECT CAST(r.rowid AS TEXT) AS rowRef FROM statement_review_decisions r WHERE r.user_id=?",
      params: [userId],
    }),
    remaining: (userId) => ({
      sql: "SELECT 1 FROM statement_review_decisions r WHERE r.user_id=?",
      params: [userId],
    }),
    remove: (scope) => [
      {
        sql: "DELETE FROM statement_review_decisions AS r WHERE r.user_id=? AND CAST(r.rowid AS TEXT) IN(SELECT row_ref FROM erasure_chunk WHERE request_id=?)",
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
      "statement_clarifications",
      "statement_hosted_origins",
      "statement_ingestion_outbox",
      "statement_materializations",
      "statement_needs_review",
      "statement_record_outcomes",
      "statement_review_decisions",
    ],
    quiescence: {
      _tag: "Durable",
      select: ({ current, userId }) => ({
        sql: "SELECT 1 FROM statement_submissions s JOIN statement_staging_objects o ON o.id=s.staging_id WHERE s.user_id=? AND s.status IN('queued','processing') AND COALESCE(s.retention_expires_at_ms,o.expires_at_ms)>?",
        params: [userId, current],
      }),
    },
    select: (userId) => ({
      sql: "SELECT CAST(r.rowid AS TEXT) AS rowRef,json_object('id',r.\"id\",'user_id',r.\"user_id\",'idempotency_key',r.\"idempotency_key\",'staging_id',r.\"staging_id\",'submitted_at_ms',r.\"submitted_at_ms\",'source_format',r.\"source_format\",'parser_revision',r.\"parser_revision\",'service_market',r.\"service_market\",'locale',r.\"locale\",'time_zone',r.\"time_zone\",'status',r.\"status\",'started_at_ms',r.\"started_at_ms\",'completed_at_ms',r.\"completed_at_ms\",'legacy_failure_reason',r.\"legacy_failure_reason\",'input_rows',r.\"input_rows\",'accepted_rows',r.\"accepted_rows\",'needs_review_rows',r.\"needs_review_rows\",'retention_expires_at_ms',r.\"retention_expires_at_ms\",'failure_reason',r.\"failure_reason\",'source_parse_attempts',r.\"source_parse_attempts\",'processed_rows',r.\"processed_rows\",'processed_accepted_rows',r.\"processed_accepted_rows\",'processed_review_rows',r.\"processed_review_rows\") AS body FROM statement_submissions r WHERE r.user_id=?",
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
      sql: "SELECT CAST(r.rowid AS TEXT) AS rowRef,json_object('turn_id',r.\"turn_id\",'user_id',r.\"user_id\",'media_id',r.\"media_id\",'staging_id',r.\"staging_id\",'upload_grant_id',r.\"upload_grant_id\",'upload_expires_at_ms',r.\"upload_expires_at_ms\",'reference_json',r.\"reference_json\",'created_at_ms',r.\"created_at_ms\") AS body FROM statement_whatsapp_documents r WHERE r.user_id=?",
      params: [userId],
    }),
    candidates: (userId) => ({
      sql: "SELECT CAST(r.rowid AS TEXT) AS rowRef FROM statement_whatsapp_documents r WHERE r.user_id=?",
      params: [userId],
    }),
    remaining: (userId) => ({
      sql: "SELECT 1 FROM statement_whatsapp_documents r WHERE r.user_id=?",
      params: [userId],
    }),
    remove: (scope) => [
      {
        sql: "DELETE FROM statement_whatsapp_documents AS r WHERE r.user_id=? AND CAST(r.rowid AS TEXT) IN(SELECT row_ref FROM erasure_chunk WHERE request_id=?)",
        params: [scope.userId, scope.reference],
      },
    ],
  },
];
