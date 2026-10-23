import type { ErasureProjection } from "../../erasure-store/contract";

const recordProjections: ReadonlyArray<ErasureProjection> = [
  {
    id: "schedule_executions",
    table: "schedule_history",
    predicate: "r.record_type='execution'",
    readPredicate: "1=1",
    source:
      "(SELECT rowid,record_type,kind,user_id,schedule_id,version AS schedule_version,scheduled_at,outcome FROM schedule_history WHERE record_type='execution')",

    dependencies: [],
  },
  {
    id: "schedule_revisions",
    table: "schedule_history",
    predicate: "r.record_type='revision'",
    readPredicate: "1=1",
    source:
      "(SELECT rowid,record_type,kind,user_id,schedule_id,version,snapshot_json FROM schedule_history WHERE record_type='revision')",

    dependencies: [],
  },
  {
    id: "schedules",
    table: "schedules",
    predicate: "r.kind IN ('weekly','reminder')",
    readPredicate: "r.kind IN ('weekly','reminder')",
    source: "schedules",

    dependencies: ["schedule_executions", "schedule_revisions"],
  },
  {
    id: "insight_reports",
    table: "insight_reports",
    predicate: "1=1",
    readPredicate: "1=1",
    source: "insight_reports",

    dependencies: ["proactive_messages"],
  },
  {
    id: "proactive_messages",
    table: "proactive_messages",
    predicate: "r.kind IN ('weekly-summary','proactivity-delivery')",
    readPredicate: "r.kind IN ('weekly-summary','proactivity-delivery')",
    source: "proactive_messages",

    dependencies: [
      "proactivity_message_events",
      "reminder_delivery_receipts",
      "reminder_control_receipts",
      "proactivity_offer_requests",
      "proactive_transcript_entries",
    ],
  },
  {
    id: "insight_events",
    table: "insight_events",
    predicate: "1=1",
    readPredicate: "1=1",
    source: "insight_events",

    dependencies: [
      "budget_alert_occurrences",
      "insight_delivery_attempts",
      "insight_whatsapp_claims",
      "proactive_transcript_entries",
      "proactive_transcript_event_links",
      "proactivity_message_events",
      "insight_reports",
      "weekly_governor_deliveries",
    ],
  },
  {
    id: "proactivity_offer_requests",
    table: "insight_offer_requests",
    predicate: "1=1",
    readPredicate: "1=1",
    source:
      "(SELECT rowid,id,user_id,request_kind AS kind,request_message_id,created_at_ms,materialized_at_ms,last_evaluated_at_ms,offer_message_id AS delivery_id,current_recurring_opportunity FROM insight_offer_requests)",

    dependencies: ["recurring_digest_opportunities"],
  },
  {
    id: "recurring_digest_days",
    table: "schedule_history",
    predicate: "r.record_type='digest-day'",
    readPredicate: "1=1",
    source:
      "(SELECT rowid,user_id,local_date,day_from_ms,day_to_ms,insight_event_id FROM schedule_history WHERE record_type='digest-day')",

    dependencies: [],
  },
  {
    id: "recurring_digest_instructions",
    table: "schedules",
    predicate: "r.kind='digest'",
    readPredicate: "1=1",
    source:
      "(SELECT rowid,user_id,id,version,enabled,consent_grant_id AS grant_id,snapshot_json AS context_json,acceptance_from_ms,accepted_at_ms,last_source_identity,next_closed_at_ms,last_evaluated_at_ms,source_checkpoint,source_cursor,source_cutoff_at_ms,source_complete FROM schedules WHERE kind='digest')",

    dependencies: [],
  },
  {
    id: "reminder_delivery_receipts",
    table: "proactive_messages",
    predicate: "r.reminder_governor_counted=1",
    readPredicate: "1=1",
    source:
      "(SELECT rowid,'reminder' AS kind,user_id,NULL AS insight_event_id,id AS delivery_id,id AS receipt_id FROM proactive_messages WHERE kind='proactivity-delivery' AND reminder_governor_counted=1)",

    clearFields: ["reminder_governor_counted"],
    dependencies: [],
  },
  {
    id: "reminder_governors",
    table: "reminder_proactivity_state",
    predicate: "1=1",
    readPredicate: "1=1",
    source: "reminder_proactivity_state",

    dependencies: [],
  },
  {
    id: "weekly_governor_deliveries",
    table: "insight_events",
    predicate: "r.weekly_governor_counted=1",
    readPredicate: "1=1",
    source:
      "(SELECT rowid,'weekly' AS kind,user_id,id AS insight_event_id,NULL AS delivery_id,id AS receipt_id FROM insight_events WHERE weekly_governor_counted=1)",

    clearFields: ["weekly_governor_counted"],
    dependencies: [],
  },
  {
    id: "weekly_governors",
    table: "weekly_proactivity_state",
    predicate: "1=1",
    readPredicate: "1=1",
    source: "weekly_proactivity_state",

    dependencies: [],
  },
  {
    id: "weekly_question_intents",
    table: "weekly_question_requests",
    predicate: "1=1",
    readPredicate: "1=1",
    source: "weekly_question_requests",

    dependencies: [],
  },
].map((definition): ErasureProjection => {
  const { id, table, source, predicate, readPredicate, dependencies } = definition;
  const removal =
    definition.clearFields !== undefined
      ? `UPDATE ${table} AS r SET ${definition.clearFields.map((field) => `${field}=NULL`).join(",")}`
      : `DELETE FROM ${table} AS r`;
  return {
    id,
    dataClass: "schedules",
    dependencies,
    quiescence: { _tag: "Synchronous" },

    candidates: (userId) => ({
      sql: `SELECT CAST(r.rowid AS TEXT) AS rowRef FROM ${source} r WHERE ${readPredicate} AND r.user_id=?`,
      params: [userId],
    }),
    remaining: (userId) => ({
      sql: `SELECT 1 FROM ${source} r WHERE ${readPredicate} AND r.user_id=?`,
      params: [userId],
    }),
    remove: (scope) => [
      {
        sql: `${removal} WHERE ${predicate} AND r.user_id=? AND CAST(r.rowid AS TEXT) IN(SELECT value AS row_ref FROM json_each(?))`,
        params: [scope.userId, scope.rowRefsJson],
      },
    ],
  };
});

const controlReceiptRef =
  "CASE WHEN r.control_audit_sequence IS NOT NULL THEN CAST(r.control_audit_sequence AS TEXT) ELSE 'message:'||r.rowid END";

export const projections: ReadonlyArray<ErasureProjection> = [
  ...recordProjections,
  {
    id: "reminder_control_receipts",
    dataClass: "schedules",
    dependencies: [],
    quiescence: { _tag: "Synchronous" },

    candidates: (userId) => ({
      sql: `SELECT ${controlReceiptRef} AS rowRef FROM proactive_messages r WHERE r.control_message_id IS NOT NULL AND r.user_id=?`,
      params: [userId],
    }),
    remaining: (userId) => ({
      sql: "SELECT 1 FROM proactive_messages WHERE control_message_id IS NOT NULL AND user_id=?",
      params: [userId],
    }),
    remove: (scope) => [
      {
        sql: `UPDATE proactive_messages AS r SET control_message_id=NULL,control_choice=NULL,control_audit_sequence=NULL WHERE r.control_message_id IS NOT NULL AND r.user_id=? AND (${controlReceiptRef}) IN(SELECT value AS row_ref FROM json_each(?))`,
        params: [scope.userId, scope.rowRefsJson],
      },
    ],
  },

  {
    id: "budget_alert_occurrences",
    dataClass: "schedules",
    dependencies: [],
    quiescence: { _tag: "Synchronous" },

    candidates: (userId) => ({
      sql: "SELECT CAST(r.rowid AS TEXT) AS rowRef FROM (SELECT rowid,user_id,budget_delivery_group_id AS delivery_group_id,budget_threshold AS threshold,id AS insight_event_id,budget_crossing_json AS crossing_json FROM insight_events WHERE budget_delivery_group_id IS NOT NULL) r WHERE r.user_id=?",
      params: [userId],
    }),
    remaining: (userId) => ({
      sql: "SELECT 1 FROM (SELECT rowid,user_id,budget_delivery_group_id AS delivery_group_id,budget_threshold AS threshold,id AS insight_event_id,budget_crossing_json AS crossing_json FROM insight_events WHERE budget_delivery_group_id IS NOT NULL) r WHERE r.user_id=?",
      params: [userId],
    }),
    remove: (scope) => [
      {
        sql: "UPDATE insight_events AS r SET budget_delivery_group_id=NULL,budget_threshold=NULL,budget_crossing_json=NULL WHERE r.budget_delivery_group_id IS NOT NULL AND r.user_id=? AND CAST(r.rowid AS TEXT) IN(SELECT value AS row_ref FROM json_each(?))",
        params: [scope.userId, scope.rowRefsJson],
      },
    ],
  },
  {
    id: "insight_delivery_attempts",
    dataClass: "schedules",
    dependencies: [],
    quiescence: { _tag: "Synchronous" },

    candidates: (userId) => ({
      sql: "SELECT CAST(r.rowid AS TEXT) AS rowRef FROM insight_events r WHERE r.delivery_receipt_id IS NOT NULL AND r.user_id=?",
      params: [userId],
    }),
    remaining: (userId) => ({
      sql: "SELECT 1 FROM insight_events r WHERE r.delivery_receipt_id IS NOT NULL AND r.user_id=?",
      params: [userId],
    }),
    remove: (scope) => [
      {
        sql: "UPDATE insight_events AS r SET delivery_receipt_id=NULL,delivery_sent_at_ms=NULL,delivery_channel=NULL,delivery_provider=NULL,delivery_provider_message_id=NULL WHERE r.delivery_receipt_id IS NOT NULL AND r.user_id=? AND CAST(r.rowid AS TEXT) IN(SELECT value AS row_ref FROM json_each(?))",
        params: [scope.userId, scope.rowRefsJson],
      },
    ],
  },

  {
    id: "proactivity_message_events",
    dataClass: "schedules",
    dependencies: [],
    quiescence: { _tag: "Synchronous" },

    candidates: (userId) => ({
      sql: "SELECT CAST(r.rowid AS TEXT) AS rowRef FROM (SELECT rowid,user_id AS user_id,message_kind,message_id AS delivery_id,id AS insight_event_id FROM insight_events WHERE message_id IS NOT NULL) r WHERE r.user_id=?",
      params: [userId],
    }),
    remaining: (userId) => ({
      sql: "SELECT 1 FROM (SELECT rowid,user_id AS user_id,message_kind,message_id AS delivery_id,id AS insight_event_id FROM insight_events WHERE message_id IS NOT NULL) r WHERE r.user_id=?",
      params: [userId],
    }),
    remove: (scope) => [
      {
        sql: "UPDATE insight_events AS r SET message_kind=NULL,message_id=NULL WHERE r.user_id=? AND message_id IS NOT NULL AND CAST(r.rowid AS TEXT) IN(SELECT value AS row_ref FROM json_each(?))",
        params: [scope.userId, scope.rowRefsJson],
      },
    ],
  },

  {
    id: "recurring_digest_consumption",
    dataClass: "schedules",
    dependencies: [],
    quiescence: { _tag: "Synchronous" },

    candidates: (userId) => ({
      sql: "SELECT CAST(r.rowid AS TEXT) AS rowRef FROM (SELECT rowid,user_id,confirmation_id,disposition FROM recurring_digest_items WHERE disposition IS NOT NULL) r WHERE r.user_id=?",
      params: [userId],
    }),
    remaining: (userId) => ({
      sql: "SELECT 1 FROM (SELECT rowid,user_id,confirmation_id,disposition FROM recurring_digest_items WHERE disposition IS NOT NULL) r WHERE r.user_id=?",
      params: [userId],
    }),
    remove: (scope) => [
      {
        sql: "DELETE FROM recurring_digest_items AS r WHERE r.disposition IS NOT NULL AND r.confirmed_at_ms IS NULL AND r.user_id=? AND CAST(r.rowid AS TEXT) IN(SELECT value AS row_ref FROM json_each(?))",
        params: [scope.userId, scope.rowRefsJson],
      },
      {
        sql: "UPDATE recurring_digest_items AS r SET disposition=NULL WHERE r.disposition IS NOT NULL AND r.confirmed_at_ms IS NOT NULL AND r.user_id=? AND CAST(r.rowid AS TEXT) IN(SELECT value AS row_ref FROM json_each(?))",
        params: [scope.userId, scope.rowRefsJson],
      },
    ],
  },

  {
    id: "recurring_digest_opportunities",
    dataClass: "schedules",
    dependencies: [],
    quiescence: { _tag: "Synchronous" },

    candidates: (userId) => ({
      sql: "SELECT CAST(r.rowid AS TEXT) AS rowRef FROM (SELECT rowid,user_id,id AS request_id FROM (SELECT rowid,id,user_id,request_kind AS kind,request_message_id,created_at_ms,materialized_at_ms,last_evaluated_at_ms,offer_message_id AS delivery_id,current_recurring_opportunity FROM insight_offer_requests) WHERE current_recurring_opportunity=1) r WHERE r.user_id=?",
      params: [userId],
    }),
    remaining: (userId) => ({
      sql: "SELECT 1 FROM (SELECT rowid,user_id,id AS request_id FROM (SELECT rowid,id,user_id,request_kind AS kind,request_message_id,created_at_ms,materialized_at_ms,last_evaluated_at_ms,offer_message_id AS delivery_id,current_recurring_opportunity FROM insight_offer_requests) WHERE current_recurring_opportunity=1) r WHERE r.user_id=?",
      params: [userId],
    }),
    remove: (scope) => [
      {
        sql: "UPDATE insight_offer_requests AS r SET current_recurring_opportunity=NULL WHERE r.user_id=? AND r.current_recurring_opportunity=1 AND CAST(r.rowid AS TEXT) IN(SELECT value AS row_ref FROM json_each(?))",
        params: [scope.userId, scope.rowRefsJson],
      },
    ],
  },

  {
    id: "recurring_digest_staging",
    dataClass: "schedules",
    dependencies: [],
    quiescence: { _tag: "Synchronous" },

    candidates: (userId) => ({
      sql: "SELECT CAST(r.rowid AS TEXT) AS rowRef FROM (SELECT rowid,user_id,confirmation_id,confirmed_at_ms,context_json,item_json,eligible FROM recurring_digest_items WHERE confirmed_at_ms IS NOT NULL) r WHERE r.user_id=?",
      params: [userId],
    }),
    remaining: (userId) => ({
      sql: "SELECT 1 FROM (SELECT rowid,user_id,confirmation_id,confirmed_at_ms,context_json,item_json,eligible FROM recurring_digest_items WHERE confirmed_at_ms IS NOT NULL) r WHERE r.user_id=?",
      params: [userId],
    }),
    remove: (scope) => [
      {
        sql: "DELETE FROM recurring_digest_items AS r WHERE r.confirmed_at_ms IS NOT NULL AND r.disposition IS NULL AND r.user_id=? AND CAST(r.rowid AS TEXT) IN(SELECT value AS row_ref FROM json_each(?))",
        params: [scope.userId, scope.rowRefsJson],
      },
      {
        sql: "UPDATE recurring_digest_items AS r SET confirmed_at_ms=NULL,context_json=NULL,item_json=NULL,eligible=NULL WHERE r.confirmed_at_ms IS NOT NULL AND r.disposition IS NOT NULL AND r.user_id=? AND CAST(r.rowid AS TEXT) IN(SELECT value AS row_ref FROM json_each(?))",
        params: [scope.userId, scope.rowRefsJson],
      },
    ],
  },
];
