import type { ErasureProjection } from "../../erasure-store/contract";

const storingInterruptionMs = 900000;

export const projections: ReadonlyArray<ErasureProjection> = [
  {
    id: "ingestion_review_items",
    dataClass: "ingestion",
    dependencies: ["ingestion_review_state"],
    quiescence: { _tag: "Synchronous" },

    candidates: (userId) => ({
      sql: "SELECT CAST(r.rowid AS TEXT) AS rowRef FROM ingestion_review_items r WHERE r.source_kind<>'statement' AND r.user_id=?",
      params: [userId],
    }),
    remaining: (userId) => ({
      sql: "SELECT 1 FROM ingestion_review_items r WHERE r.source_kind<>'statement' AND r.user_id=?",
      params: [userId],
    }),
    remove: (scope) => [
      {
        sql: "DELETE FROM ingestion_review_items AS r WHERE r.source_kind<>'statement' AND r.user_id=? AND CAST(r.rowid AS TEXT) IN(SELECT value AS row_ref FROM json_each(?))",
        params: [scope.userId, scope.rowRefsJson],
      },
    ],
  },

  {
    id: "ingestion_review_state",
    dataClass: "ingestion",
    dependencies: [],
    quiescence: { _tag: "Synchronous" },

    candidates: (userId) => ({
      sql: "SELECT CAST(r.rowid AS TEXT) AS rowRef FROM ingestion_review_workspace_state r WHERE r.user_id=?",
      params: [userId],
    }),
    remaining: (userId) => ({
      sql: "SELECT 1 FROM ingestion_review_workspace_state r WHERE r.user_id=?",
      params: [userId],
    }),
    remove: (scope) => [
      {
        sql: "UPDATE ingestion_review_items AS r SET workspace_state=NULL,workspace_revision=NULL,draft_json=NULL,transaction_id=NULL,workspace_updated_at_ms=NULL,workspace_archive_row_ref=NULL WHERE r.user_id=? AND r.workspace_archive_row_ref IN(SELECT value AS row_ref FROM json_each(?))",
        params: [scope.userId, scope.rowRefsJson],
      },
    ],
  },
  {
    id: "email_forwarding_addresses",
    dataClass: "ingestion",
    dependencies: [],
    quiescence: { _tag: "Synchronous" },

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
        sql: "DELETE FROM forwarding_addresses AS r WHERE r.user_id=? AND CAST(r.rowid AS TEXT) IN(SELECT value AS row_ref FROM json_each(?))",
        params: [scope.userId, scope.rowRefsJson],
      },
    ],
  },
  {
    id: "forwarded_email_receipts",
    dataClass: "ingestion",
    dependencies: ["source_attestations", "ingestion_review_items"],
    quiescence: {
      _tag: "Durable",
      select: ({ current, userId }) => ({
        sql: "SELECT 1 FROM forwarded_email_receipts r WHERE r.user_id=? AND r.state IN('storing','queued') AND r.expires_at_ms>? AND (r.state='queued' OR r.received_at_ms>?) AND r.outcome IS NULL",
        params: [userId, current, current - storingInterruptionMs],
      }),
    },

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
        sql: "DELETE FROM forwarded_email_receipts AS r WHERE r.user_id=? AND CAST(r.rowid AS TEXT) IN(SELECT value AS row_ref FROM json_each(?))",
        params: [scope.userId, scope.rowRefsJson],
      },
    ],
  },
  {
    id: "media_submissions",
    dataClass: "ingestion",
    dependencies: ["media_submission_audit", "ingestion_review_items"],
    quiescence: { _tag: "Synchronous" },

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
        sql: "DELETE FROM media_submissions AS r WHERE r.user_id=? AND CAST(r.rowid AS TEXT) IN(SELECT value AS row_ref FROM json_each(?))",
        params: [scope.userId, scope.rowRefsJson],
      },
    ],
  },
  {
    id: "statement_backfill_entitlements",
    dataClass: "ingestion",
    dependencies: [],
    quiescence: { _tag: "Synchronous" },

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
        sql: "DELETE FROM statement_backfill_entitlements AS r WHERE r.user_id=? AND CAST(r.rowid AS TEXT) IN(SELECT value AS row_ref FROM json_each(?))",
        params: [scope.userId, scope.rowRefsJson],
      },
    ],
  },

  {
    id: "statement_materializations",
    dataClass: "ingestion",
    dependencies: ["statement_materialization_parts"],
    quiescence: { _tag: "Synchronous" },

    candidates: (userId) => ({
      sql: "SELECT CAST(r.rowid AS TEXT) AS rowRef FROM statement_materializations r WHERE EXISTS(SELECT 1 FROM statement_submissions p WHERE p.id=r.submission_id AND p.user_id=?)",
      params: [userId],
    }),
    remaining: (userId) => ({
      sql: "SELECT 1 FROM statement_materializations r WHERE EXISTS(SELECT 1 FROM statement_submissions p WHERE p.id=r.submission_id AND p.user_id=?)",
      params: [userId],
    }),
    remove: (scope) => [
      {
        sql: "DELETE FROM statement_materializations AS r WHERE EXISTS(SELECT 1 FROM statement_submissions p WHERE p.id=r.submission_id AND p.user_id=?) AND CAST(r.rowid AS TEXT) IN(SELECT value AS row_ref FROM json_each(?))",
        params: [scope.userId, scope.rowRefsJson],
      },
    ],
  },

  {
    id: "statement_materialization_parts",
    dataClass: "ingestion",
    dependencies: [],
    quiescence: { _tag: "Synchronous" },

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
        sql: "DELETE FROM statement_materialization_parts AS r WHERE EXISTS(SELECT 1 FROM statement_submissions p WHERE p.id=r.submission_id AND p.user_id=?) AND CAST(r.rowid AS TEXT) IN(SELECT value AS row_ref FROM json_each(?))",
        params: [scope.userId, scope.rowRefsJson],
      },
    ],
  },

  {
    id: "statement_needs_review",
    dataClass: "ingestion",
    dependencies: ["ingestion_review_state"],
    quiescence: { _tag: "Synchronous" },

    candidates: (userId) => ({
      sql: "SELECT CAST(r.rowid AS TEXT) AS rowRef FROM statement_review_context r WHERE r.user_id=?",
      params: [userId],
    }),
    remaining: (userId) => ({
      sql: "SELECT 1 FROM statement_review_context r WHERE r.user_id=?",
      params: [userId],
    }),
    remove: (scope) => [
      {
        sql: "DELETE FROM ingestion_review_items AS r WHERE r.source_kind='statement' AND r.user_id=? AND CAST(r.rowid AS TEXT) IN(SELECT value AS row_ref FROM json_each(?))",
        params: [scope.userId, scope.rowRefsJson],
      },
    ],
  },
  {
    id: "statement_record_outcomes",
    dataClass: "ingestion",
    dependencies: [],
    quiescence: { _tag: "Synchronous" },

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
        sql: "DELETE FROM statement_record_outcomes AS r WHERE r.user_id=? AND CAST(r.rowid AS TEXT) IN(SELECT value AS row_ref FROM json_each(?))",
        params: [scope.userId, scope.rowRefsJson],
      },
    ],
  },
  {
    id: "statement_staging_objects",
    dataClass: "ingestion",
    dependencies: ["statement_submissions", "statement_whatsapp_documents"],
    quiescence: { _tag: "Synchronous" },

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
        sql: "DELETE FROM statement_staging_objects AS r WHERE r.user_id=? AND CAST(r.rowid AS TEXT) IN(SELECT value AS row_ref FROM json_each(?))",
        params: [scope.userId, scope.rowRefsJson],
      },
    ],
  },
  {
    id: "statement_submissions",
    dataClass: "ingestion",
    dependencies: [
      "source_attestations",
      "statement_backfill_entitlements",
      "statement_materializations",
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
        sql: "DELETE FROM statement_submissions AS r WHERE r.user_id=? AND CAST(r.rowid AS TEXT) IN(SELECT value AS row_ref FROM json_each(?))",
        params: [scope.userId, scope.rowRefsJson],
      },
    ],
  },
  {
    id: "statement_whatsapp_documents",
    dataClass: "ingestion",
    dependencies: [],
    quiescence: { _tag: "Synchronous" },

    candidates: (userId) => ({
      sql: "SELECT CAST(r.rowid AS TEXT) AS rowRef FROM (SELECT rowid,id AS turn_id,user_id,document_media_id AS media_id,document_staging_id AS staging_id,document_upload_grant_id AS upload_grant_id,document_upload_expires_at_ms AS upload_expires_at_ms,document_reference_json AS reference_json,started_at_ms AS created_at_ms FROM hosted_turns WHERE document_media_id IS NOT NULL) r WHERE r.user_id=?",
      params: [userId],
    }),
    remaining: (userId) => ({
      sql: "SELECT 1 FROM (SELECT rowid,id AS turn_id,user_id,document_media_id AS media_id,document_staging_id AS staging_id,document_upload_grant_id AS upload_grant_id,document_upload_expires_at_ms AS upload_expires_at_ms,document_reference_json AS reference_json,started_at_ms AS created_at_ms FROM hosted_turns WHERE document_media_id IS NOT NULL) r WHERE r.user_id=?",
      params: [userId],
    }),
    remove: (scope) => [
      {
        sql: "UPDATE hosted_turns SET document_media_id=NULL,document_staging_id=NULL,document_upload_grant_id=NULL,document_upload_expires_at_ms=NULL,document_reference_json=NULL WHERE user_id=? AND CAST(rowid AS TEXT) IN(SELECT value AS row_ref FROM json_each(?))",
        params: [scope.userId, scope.rowRefsJson],
      },
    ],
  },
];
