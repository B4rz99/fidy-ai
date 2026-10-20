import type { ErasureProjection } from "../../erasure-store/contract";

export const projections: ReadonlyArray<ErasureProjection> = [
  {
    id: "dashboard_projection_bucket",
    dataClass: "projections",
    dependencies: [
      "dashboard_projection_leaf",
      "hosted_mutation_commits",
      "hosted_whatsapp_inbound",
      "transaction_reconciliation_decisions",
      "transaction_reconciliation_members",
      "transactions",
      "transcript_entries",
    ],
    quiescence: { _tag: "Synchronous" },
    select: (userId) => ({
      sql: "SELECT CAST(r.rowid AS TEXT) AS rowRef,json_object('user_id',r.\"user_id\",'size_seconds',r.\"size_seconds\",'bucket',r.\"bucket\",'currency',r.\"currency\",'direction',r.\"direction\",'category_id',r.\"category_id\",'count',r.\"count\",'maximum',r.\"maximum\",'max_minor',r.\"max_minor\") AS body FROM dashboard_projection_bucket r WHERE r.user_id=?",
      params: [userId],
    }),
    candidates: (userId) => ({
      sql: "SELECT CAST(r.rowid AS TEXT) AS rowRef FROM dashboard_projection_bucket r WHERE r.user_id=?",
      params: [userId],
    }),
    remaining: (userId) => ({
      sql: "SELECT 1 FROM dashboard_projection_bucket r WHERE r.user_id=?",
      params: [userId],
    }),
    remove: (scope) => [
      {
        sql: "DELETE FROM dashboard_projection_bucket AS r WHERE r.user_id=? AND CAST(r.rowid AS TEXT) IN(SELECT row_ref FROM erasure_chunk WHERE request_id=?)",
        params: [scope.userId, scope.reference],
      },
    ],
  },
  {
    id: "dashboard_projection_digit",
    dataClass: "projections",
    dependencies: [
      "dashboard_projection_leaf",
      "hosted_mutation_commits",
      "hosted_whatsapp_inbound",
      "transaction_reconciliation_decisions",
      "transaction_reconciliation_members",
      "transactions",
      "transcript_entries",
    ],
    quiescence: { _tag: "Synchronous" },
    select: (userId) => ({
      sql: "SELECT CAST(r.rowid AS TEXT) AS rowRef,json_object('user_id',r.\"user_id\",'size_seconds',r.\"size_seconds\",'bucket',r.\"bucket\",'currency',r.\"currency\",'direction',r.\"direction\",'category_id',r.\"category_id\",'position',r.\"position\",'digit_sum',r.\"digit_sum\") AS body FROM dashboard_projection_digit r WHERE r.user_id=?",
      params: [userId],
    }),
    candidates: (userId) => ({
      sql: "SELECT CAST(r.rowid AS TEXT) AS rowRef FROM dashboard_projection_digit r WHERE r.user_id=?",
      params: [userId],
    }),
    remaining: (userId) => ({
      sql: "SELECT 1 FROM dashboard_projection_digit r WHERE r.user_id=?",
      params: [userId],
    }),
    remove: (scope) => [
      {
        sql: "DELETE FROM dashboard_projection_digit AS r WHERE r.user_id=? AND CAST(r.rowid AS TEXT) IN(SELECT row_ref FROM erasure_chunk WHERE request_id=?)",
        params: [scope.userId, scope.reference],
      },
    ],
  },
  {
    id: "dashboard_projection_leaf",
    dataClass: "projections",
    dependencies: [],
    quiescence: { _tag: "Synchronous" },
    select: (userId) => ({
      sql: "SELECT CAST(r.rowid AS TEXT) AS rowRef,json_object('user_id',r.\"user_id\",'id',r.\"id\",'amount',r.\"amount\",'currency',r.\"currency\",'direction',r.\"direction\",'category_id',r.\"category_id\",'counterparty',r.\"counterparty\",'notes',r.\"notes\",'occurred_at',r.\"occurred_at\",'created_at',r.\"created_at\",'revision',r.\"revision\") AS body FROM dashboard_projection_leaf r WHERE r.user_id=?",
      params: [userId],
    }),
    candidates: (userId) => ({
      sql: "SELECT CAST(r.rowid AS TEXT) AS rowRef FROM dashboard_projection_leaf r WHERE r.user_id=?",
      params: [userId],
    }),
    remaining: (userId) => ({
      sql: "SELECT 1 FROM dashboard_projection_leaf r WHERE r.user_id=?",
      params: [userId],
    }),
    remove: (scope) => [
      {
        sql: "DELETE FROM dashboard_projection_leaf AS r WHERE r.user_id=? AND CAST(r.rowid AS TEXT) IN(SELECT row_ref FROM erasure_chunk WHERE request_id=?)",
        params: [scope.userId, scope.reference],
      },
    ],
  },
  {
    id: "dashboard_projection_state",
    dataClass: "projections",
    dependencies: [
      "dashboard_projection_leaf",
      "hosted_mutation_commits",
      "hosted_whatsapp_inbound",
      "transaction_reconciliation_decisions",
      "transaction_reconciliation_members",
      "transactions",
      "transcript_entries",
    ],
    quiescence: { _tag: "Synchronous" },
    select: (userId) => ({
      sql: "SELECT CAST(r.rowid AS TEXT) AS rowRef,json_object('user_id',r.\"user_id\",'version',r.\"version\",'readiness',r.\"readiness\",'cursor_id',r.\"cursor_id\",'attempted_at_ms',r.\"attempted_at_ms\",'fact_revision',r.fact_revision,'first_captured_at',r.first_captured_at,'time_zone',r.time_zone) AS body FROM dashboard_projection_state r WHERE r.user_id=?",
      params: [userId],
    }),
    candidates: (userId) => ({
      sql: "SELECT CAST(r.rowid AS TEXT) AS rowRef FROM dashboard_projection_state r WHERE r.user_id=?",
      params: [userId],
    }),
    remaining: (userId) => ({
      sql: "SELECT 1 FROM dashboard_projection_state r WHERE r.user_id=?",
      params: [userId],
    }),
    remove: (scope) => [
      {
        sql: "DELETE FROM dashboard_projection_state AS r WHERE r.user_id=? AND CAST(r.rowid AS TEXT) IN(SELECT row_ref FROM erasure_chunk WHERE request_id=?)",
        params: [scope.userId, scope.reference],
      },
    ],
  },
  {
    id: "source_attestations",
    dataClass: "transactions",
    dependencies: [],
    quiescence: { _tag: "Synchronous" },
    select: (userId) => ({
      sql: "SELECT CAST(r.rowid AS TEXT) AS rowRef,json_object('id',r.\"id\",'user_id',r.\"user_id\",'transaction_id',r.\"transaction_id\",'kind',r.\"kind\",'service_market',r.\"service_market\",'locale',r.\"locale\",'time_zone',r.\"time_zone\",'interpretation_revision',r.\"interpretation_revision\",'created_at',r.\"created_at\",'statement_submission_id',r.\"statement_submission_id\",'statement_record_number',r.\"statement_record_number\",'statement_content_hash',r.\"statement_content_hash\",'source_format',r.\"source_format\",'received_email_id',r.\"received_email_id\",'message_content_sha256',r.\"message_content_sha256\",'message_evidence',r.\"message_evidence\",'deterministic_interpretation',r.\"deterministic_interpretation\",'extractor_revision',r.\"extractor_revision\",'review_item_id',r.\"review_item_id\",'user_provided_fields',r.\"user_provided_fields\") AS body FROM source_attestations r WHERE r.user_id=?",
      params: [userId],
    }),
    candidates: (userId) => ({
      sql: "SELECT CAST(r.rowid AS TEXT) AS rowRef FROM source_attestations r WHERE r.user_id=?",
      params: [userId],
    }),
    remaining: (userId) => ({
      sql: "SELECT 1 FROM source_attestations r WHERE r.user_id=?",
      params: [userId],
    }),
    remove: (scope) => [
      {
        sql: "DELETE FROM source_attestations AS r WHERE r.user_id=? AND CAST(r.rowid AS TEXT) IN(SELECT row_ref FROM erasure_chunk WHERE request_id=?)",
        params: [scope.userId, scope.reference],
      },
    ],
  },
  {
    id: "transaction_corrections",
    dataClass: "transactions",
    dependencies: [],
    quiescence: { _tag: "Synchronous" },
    select: (userId) => ({
      sql: "SELECT CAST(r.rowid AS TEXT) AS rowRef,json_object('id',r.\"id\",'user_id',r.\"user_id\",'transaction_id',r.\"transaction_id\",'previous_revision',r.\"previous_revision\",'changed_fields',r.\"changed_fields\",'before_facts',r.\"before_facts\",'after_facts',r.\"after_facts\",'corrected_at',r.\"corrected_at\") AS body FROM transaction_corrections r WHERE r.user_id=?",
      params: [userId],
    }),
    candidates: (userId) => ({
      sql: "SELECT CAST(r.rowid AS TEXT) AS rowRef FROM transaction_corrections r WHERE r.user_id=?",
      params: [userId],
    }),
    remaining: (userId) => ({
      sql: "SELECT 1 FROM transaction_corrections r WHERE r.user_id=?",
      params: [userId],
    }),
    remove: (scope) => [
      {
        sql: "DELETE FROM transaction_corrections AS r WHERE r.user_id=? AND CAST(r.rowid AS TEXT) IN(SELECT row_ref FROM erasure_chunk WHERE request_id=?)",
        params: [scope.userId, scope.reference],
      },
    ],
  },
  {
    id: "transaction_reconciliation_decisions",
    dataClass: "projections",
    dependencies: ["transaction_reconciliation_members"],
    quiescence: { _tag: "Synchronous" },
    select: (userId) => ({
      sql: "SELECT CAST(r.rowid AS TEXT) AS rowRef,json_object('user_id',r.\"user_id\",'first_transaction_id',r.\"first_transaction_id\",'second_transaction_id',r.\"second_transaction_id\",'state',r.\"state\",'visible_transaction_id',r.\"visible_transaction_id\",'decided_at',r.\"decided_at\") AS body FROM transaction_reconciliation_decisions r WHERE r.user_id=?",
      params: [userId],
    }),
    candidates: (userId) => ({
      sql: "SELECT CAST(r.rowid AS TEXT) AS rowRef FROM transaction_reconciliation_decisions r WHERE r.user_id=?",
      params: [userId],
    }),
    remaining: (userId) => ({
      sql: "SELECT 1 FROM transaction_reconciliation_decisions r WHERE r.user_id=?",
      params: [userId],
    }),
    remove: (scope) => [
      {
        sql: "DELETE FROM transaction_reconciliation_decisions AS r WHERE r.user_id=? AND CAST(r.rowid AS TEXT) IN(SELECT row_ref FROM erasure_chunk WHERE request_id=?)",
        params: [scope.userId, scope.reference],
      },
    ],
  },
  {
    id: "transaction_reconciliation_members",
    dataClass: "projections",
    dependencies: [],
    quiescence: { _tag: "Synchronous" },
    select: (userId) => ({
      sql: "SELECT CAST(r.rowid AS TEXT) AS rowRef,json_object('user_id',r.\"user_id\",'transaction_id',r.\"transaction_id\",'first_transaction_id',r.\"first_transaction_id\",'second_transaction_id',r.\"second_transaction_id\") AS body FROM reconciled_transactions r WHERE r.user_id=?",
      params: [userId],
    }),
    candidates: (userId) => ({
      sql: "SELECT CAST(r.rowid AS TEXT) AS rowRef FROM reconciled_transactions r WHERE r.user_id=?",
      params: [userId],
    }),
    remaining: (userId) => ({
      sql: "SELECT 1 FROM reconciled_transactions r WHERE r.user_id=?",
      params: [userId],
    }),
    remove: (scope) => [
      {
        sql: "UPDATE transactions AS r SET reconciliation_row_ref=NULL,reconciliation_first_id=NULL,reconciliation_second_id=NULL WHERE r.reconciliation_first_id IS NOT NULL AND r.user_id=? AND COALESCE(r.reconciliation_row_ref,'member:'||r.id) IN(SELECT row_ref FROM erasure_chunk WHERE request_id=?)",
        params: [scope.userId, scope.reference],
      },
    ],
  },
  {
    id: "transactions",
    dataClass: "transactions",
    dependencies: [
      "ingestion_review_state",
      "source_attestations",
      "forwarded_email_receipts",
      "statement_record_outcomes",
      "transaction_corrections",
      "transaction_reconciliation_decisions",
      "transaction_reconciliation_members",
    ],
    quiescence: { _tag: "Synchronous" },
    select: (userId) => ({
      sql: "SELECT CAST(r.rowid AS TEXT) AS rowRef,json_object('id',r.\"id\",'user_id',r.\"user_id\",'amount',r.\"amount\",'currency',r.\"currency\",'direction',r.\"direction\",'counterparty',r.\"counterparty\",'category_id',r.\"category_id\",'notes',r.\"notes\",'occurred_at',r.\"occurred_at\",'created_at',r.\"created_at\",'revision',r.\"revision\",'user_decisions',r.\"user_decisions\",'deleted_at_ms',r.\"deleted_at_ms\") AS body FROM transactions r WHERE r.user_id=?",
      params: [userId],
    }),
    candidates: (userId) => ({
      sql: "SELECT CAST(r.rowid AS TEXT) AS rowRef FROM transactions r WHERE r.user_id=?",
      params: [userId],
    }),
    remaining: (userId) => ({
      sql: "SELECT 1 FROM transactions r WHERE r.user_id=?",
      params: [userId],
    }),
    remove: (scope) => [
      {
        sql: "DELETE FROM transactions AS r WHERE r.user_id=? AND CAST(r.rowid AS TEXT) IN(SELECT row_ref FROM erasure_chunk WHERE request_id=?)",
        params: [scope.userId, scope.reference],
      },
    ],
  },
];
