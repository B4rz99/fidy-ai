import type { ErasureProjection } from "../../erasure-store/contract";

const recordProjections: ReadonlyArray<ErasureProjection> = [
  {
    id: "schedule_executions",
    table: "schedule_history",
    predicate: "r.record_type='execution'",
    readPredicate: "1=1",
    source:
      "(SELECT rowid,record_type,kind,user_id,schedule_id,version AS schedule_version,scheduled_at,outcome FROM schedule_history WHERE record_type='execution')",
    fields: ["kind", "user_id", "schedule_id", "schedule_version", "scheduled_at", "outcome"],
    dependencies: [],
  },
  {
    id: "schedule_revisions",
    table: "schedule_history",
    predicate: "r.record_type='revision'",
    readPredicate: "1=1",
    source:
      "(SELECT rowid,record_type,kind,user_id,schedule_id,version,snapshot_json FROM schedule_history WHERE record_type='revision')",
    fields: ["kind", "user_id", "schedule_id", "version", "snapshot_json"],
    dependencies: [],
  },
  {
    id: "schedules",
    table: "schedules",
    predicate: "r.kind IN ('weekly','reminder')",
    readPredicate: "r.kind IN ('weekly','reminder')",
    source: "schedules",
    fields: [
      "kind",
      "id",
      "user_id",
      "version",
      "enabled",
      "snapshot_json",
      "next_scheduled_at",
      "consent_grant_id",
      "last_evaluated_at_ms",
    ],
    dependencies: ["schedule_executions", "schedule_revisions"],
  },
  {
    id: "insight_reports",
    table: "insight_reports",
    predicate: "r.kind IN ('weekly-summary','proactivity-delivery')",
    readPredicate: "r.kind IN ('weekly-summary','proactivity-delivery')",
    source: "insight_reports",
    fields: [
      "kind",
      "user_id",
      "delivery_id",
      "role",
      "consent_grant_id",
      "offer_id",
      "text",
      "scheduled_at_ms",
      "expires_at_ms",
      "time_zone",
      "created_at_ms",
      "payload_json",
      "presentation_json",
      "reminder_grant_id",
      "reminder_expires_at_ms",
      "instruction_id",
      "instruction_version",
      "grant_id",
      "local_date",
      "day_from_ms",
      "day_to_ms",
      "report_json",
      "dispatch_state",
      "dispatch_created_at_ms",
      "dispatch_last_attempt_at_ms",
      "dispatch_restart_attempts",
    ],
    dependencies: ["proactivity_message_events", "reminder_delivery_receipts"],
  },
  {
    id: "insight_events",
    table: "insight_events",
    predicate: "1=1",
    readPredicate: "1=1",
    source: "insight_events",
    fields: [
      "id",
      "user_id",
      "kind",
      "schedule_id",
      "schedule_version",
      "service_market",
      "locale",
      "time_zone",
      "scheduled_at",
      "money_groups_json",
      "lifecycle_state",
    ],
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
    table: "insight_reports",
    predicate: "r.kind='offer-request'",
    readPredicate: "1=1",
    source:
      "(SELECT rowid,delivery_id AS id,user_id,request_kind AS kind,request_message_id,created_at_ms,materialized_at_ms,last_evaluated_at_ms,offer_delivery_id AS delivery_id,current_recurring_opportunity FROM insight_reports WHERE kind='offer-request')",
    fields: [
      "id",
      "user_id",
      "kind",
      "request_message_id",
      "created_at_ms",
      "materialized_at_ms",
      "last_evaluated_at_ms",
      "delivery_id",
    ],
    dependencies: ["recurring_digest_opportunities"],
  },
  {
    id: "recurring_digest_days",
    table: "schedule_history",
    predicate: "r.record_type='digest-day'",
    readPredicate: "1=1",
    source:
      "(SELECT rowid,user_id,local_date,day_from_ms,day_to_ms,insight_event_id FROM schedule_history WHERE record_type='digest-day')",
    fields: ["user_id", "local_date", "day_from_ms", "day_to_ms", "insight_event_id"],
    dependencies: [],
  },
  {
    id: "recurring_digest_instructions",
    table: "schedules",
    predicate: "r.kind='digest'",
    readPredicate: "1=1",
    source:
      "(SELECT rowid,user_id,id,version,enabled,consent_grant_id AS grant_id,snapshot_json AS context_json,acceptance_from_ms,accepted_at_ms,last_source_identity,next_closed_at_ms,last_evaluated_at_ms,source_checkpoint,source_cursor,source_cutoff_at_ms,source_complete FROM schedules WHERE kind='digest')",
    fields: [
      "user_id",
      "id",
      "version",
      "enabled",
      "grant_id",
      "context_json",
      "acceptance_from_ms",
      "accepted_at_ms",
      "last_source_identity",
      "next_closed_at_ms",
      "last_evaluated_at_ms",
      "source_checkpoint",
      "source_cursor",
      "source_cutoff_at_ms",
      "source_complete",
    ],
    dependencies: [],
  },
  {
    id: "reminder_delivery_receipts",
    table: "insight_reports",
    predicate: "r.reminder_governor_counted=1",
    readPredicate: "1=1",
    source:
      "(SELECT rowid,'reminder' AS kind,user_id,NULL AS insight_event_id,delivery_id,delivery_id AS receipt_id FROM insight_reports WHERE kind='proactivity-delivery' AND reminder_governor_counted=1)",
    fields: ["user_id", "delivery_id"],
    clearFields: ["reminder_governor_counted"],
    dependencies: [],
  },
  {
    id: "reminder_governors",
    table: "proactivity_governors",
    predicate: "kind='reminder'",
    readPredicate: "1=1",
    source: "(SELECT rowid,* FROM proactivity_governors WHERE kind='reminder')",
    fields: [
      "user_id",
      "standing_json",
      "last_reply_at_ms",
      "question_id",
      "question_delivered_at_ms",
      "notice_turn_id",
      "notice_completed",
    ],
    dependencies: [],
  },
  {
    id: "weekly_governor_deliveries",
    table: "insight_events",
    predicate: "r.weekly_governor_counted=1",
    readPredicate: "1=1",
    source:
      "(SELECT rowid,'weekly' AS kind,user_id,id AS insight_event_id,NULL AS delivery_id,id AS receipt_id FROM insight_events WHERE weekly_governor_counted=1)",
    fields: ["user_id", "insight_event_id"],
    clearFields: ["weekly_governor_counted"],
    dependencies: [],
  },
  {
    id: "weekly_governors",
    table: "proactivity_governors",
    predicate: "kind='weekly'",
    readPredicate: "1=1",
    source: "(SELECT rowid,* FROM proactivity_governors WHERE kind='weekly')",
    fields: [
      "user_id",
      "unanswered",
      "last_reply_at_ms",
      "question_needed",
      "question_delivered",
      "question_delivered_at_ms",
      "question_event_id",
      "paused_at_ms",
      "notice_session_id",
      "notice_turn_id",
      "notice_completed",
    ],
    dependencies: [],
  },
  {
    id: "weekly_question_intents",
    table: "insight_reports",
    predicate: "r.kind='weekly-question'",
    readPredicate: "1=1",
    source:
      "(SELECT rowid,delivery_id AS id,user_id,origin,request_message_id,rejection_offer_id,dispatch_state AS state,created_at_ms,dispatch_last_attempt_at_ms AS last_attempt_at_ms,dispatch_restart_attempts AS restart_attempts FROM insight_reports WHERE kind='weekly-question')",
    fields: [
      "id",
      "user_id",
      "origin",
      "request_message_id",
      "rejection_offer_id",
      "state",
      "created_at_ms",
      "last_attempt_at_ms",
      "restart_attempts",
    ],
    dependencies: [],
  },
].map((definition): ErasureProjection => {
  const { id, table, source, predicate, readPredicate, fields, dependencies } = definition;
  const removal =
    definition.clearFields !== undefined
      ? `UPDATE ${table} AS r SET ${definition.clearFields.map((field) => `${field}=NULL`).join(",")}`
      : `DELETE FROM ${table} AS r`;
  return {
    id,
    dataClass: "schedules",
    dependencies,
    quiescence: { _tag: "Synchronous" },
    select: (userId) => ({
      sql: `SELECT CAST(r.rowid AS TEXT) AS rowRef,json_object(${fields.map((field) => `'${field}',r.${field}`).join(",")}) AS body FROM ${source} r WHERE ${readPredicate} AND r.user_id=?`,
      params: [userId],
    }),
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
        sql: `${removal} WHERE ${predicate} AND r.user_id=? AND CAST(r.rowid AS TEXT) IN(SELECT row_ref FROM erasure_chunk WHERE request_id=?)`,
        params: [scope.userId, scope.reference],
      },
    ],
  };
});

export const projections: ReadonlyArray<ErasureProjection> = [
  ...recordProjections,

  {
    id: "budget_alert_occurrences",
    dataClass: "schedules",
    dependencies: [],
    quiescence: { _tag: "Synchronous" },
    select: (userId) => ({
      sql: "SELECT CAST(r.rowid AS TEXT) AS rowRef,json_object('user_id',r.\"user_id\",'delivery_group_id',r.\"delivery_group_id\",'threshold',r.\"threshold\",'insight_event_id',r.\"insight_event_id\",'crossing_json',r.\"crossing_json\") AS body FROM (SELECT rowid,user_id,budget_delivery_group_id AS delivery_group_id,budget_threshold AS threshold,id AS insight_event_id,budget_crossing_json AS crossing_json FROM insight_events WHERE budget_delivery_group_id IS NOT NULL) r WHERE r.user_id=?",
      params: [userId],
    }),
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
        sql: "UPDATE insight_events AS r SET budget_delivery_group_id=NULL,budget_threshold=NULL,budget_crossing_json=NULL WHERE r.budget_delivery_group_id IS NOT NULL AND r.user_id=? AND CAST(r.rowid AS TEXT) IN(SELECT row_ref FROM erasure_chunk WHERE request_id=?)",
        params: [scope.userId, scope.reference],
      },
    ],
  },
  {
    id: "insight_delivery_attempts",
    dataClass: "schedules",
    dependencies: [],
    quiescence: { _tag: "Synchronous" },
    select: (userId) => ({
      sql: "SELECT CAST(r.rowid AS TEXT) AS rowRef,json_object('id',r.\"delivery_receipt_id\",'user_id',r.\"user_id\",'insight_event_id',r.\"id\",'sent_at',r.\"delivery_sent_at\",'channel',r.\"delivery_channel\",'provider',r.\"delivery_provider\",'provider_message_id',r.\"delivery_provider_message_id\") AS body FROM insight_events r WHERE r.delivery_receipt_id IS NOT NULL AND r.user_id=?",
      params: [userId],
    }),
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
        sql: "UPDATE insight_events AS r SET delivery_receipt_id=NULL,delivery_sent_at=NULL,delivery_channel=NULL,delivery_provider=NULL,delivery_provider_message_id=NULL WHERE r.delivery_receipt_id IS NOT NULL AND r.user_id=? AND CAST(r.rowid AS TEXT) IN(SELECT row_ref FROM erasure_chunk WHERE request_id=?)",
        params: [scope.userId, scope.reference],
      },
    ],
  },

  {
    id: "proactivity_message_events",
    dataClass: "schedules",
    dependencies: [],
    quiescence: { _tag: "Synchronous" },
    select: (userId) => ({
      sql: "SELECT CAST(r.rowid AS TEXT) AS rowRef,json_object('user_id',r.\"user_id\",'delivery_id',r.\"delivery_id\",'insight_event_id',r.\"insight_event_id\") AS body FROM (SELECT rowid,user_id AS user_id,report_delivery_id AS delivery_id,id AS insight_event_id FROM insight_events WHERE report_delivery_id IS NOT NULL) r WHERE r.user_id=?",
      params: [userId],
    }),
    candidates: (userId) => ({
      sql: "SELECT CAST(r.rowid AS TEXT) AS rowRef FROM (SELECT rowid,user_id AS user_id,report_delivery_id AS delivery_id,id AS insight_event_id FROM insight_events WHERE report_delivery_id IS NOT NULL) r WHERE r.user_id=?",
      params: [userId],
    }),
    remaining: (userId) => ({
      sql: "SELECT 1 FROM (SELECT rowid,user_id AS user_id,report_delivery_id AS delivery_id,id AS insight_event_id FROM insight_events WHERE report_delivery_id IS NOT NULL) r WHERE r.user_id=?",
      params: [userId],
    }),
    remove: (scope) => [
      {
        sql: "UPDATE insight_events AS r SET report_delivery_id=NULL WHERE r.user_id=? AND report_delivery_id IS NOT NULL AND CAST(r.rowid AS TEXT) IN(SELECT row_ref FROM erasure_chunk WHERE request_id=?)",
        params: [scope.userId, scope.reference],
      },
    ],
  },

  {
    id: "recurring_digest_consumption",
    dataClass: "schedules",
    dependencies: [],
    quiescence: { _tag: "Synchronous" },
    select: (userId) => ({
      sql: "SELECT CAST(r.rowid AS TEXT) AS rowRef,json_object('user_id',r.\"user_id\",'confirmation_id',r.\"confirmation_id\",'disposition',r.\"disposition\") AS body FROM (SELECT rowid,user_id,confirmation_id,disposition FROM recurring_digest_items WHERE disposition IS NOT NULL) r WHERE r.user_id=?",
      params: [userId],
    }),
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
        sql: "DELETE FROM recurring_digest_items AS r WHERE r.disposition IS NOT NULL AND r.confirmed_at_ms IS NULL AND r.user_id=? AND CAST(r.rowid AS TEXT) IN(SELECT row_ref FROM erasure_chunk WHERE request_id=?)",
        params: [scope.userId, scope.reference],
      },
      {
        sql: "UPDATE recurring_digest_items AS r SET disposition=NULL WHERE r.disposition IS NOT NULL AND r.confirmed_at_ms IS NOT NULL AND r.user_id=? AND CAST(r.rowid AS TEXT) IN(SELECT row_ref FROM erasure_chunk WHERE request_id=?)",
        params: [scope.userId, scope.reference],
      },
    ],
  },

  {
    id: "recurring_digest_opportunities",
    dataClass: "schedules",
    dependencies: [],
    quiescence: { _tag: "Synchronous" },
    select: (userId) => ({
      sql: "SELECT CAST(r.rowid AS TEXT) AS rowRef,json_object('user_id',r.\"user_id\",'request_id',r.\"request_id\") AS body FROM (SELECT rowid,user_id,id AS request_id FROM (SELECT rowid,delivery_id AS id,user_id,request_kind AS kind,request_message_id,created_at_ms,materialized_at_ms,last_evaluated_at_ms,offer_delivery_id AS delivery_id,current_recurring_opportunity FROM insight_reports WHERE kind='offer-request') WHERE current_recurring_opportunity=1) r WHERE r.user_id=?",
      params: [userId],
    }),
    candidates: (userId) => ({
      sql: "SELECT CAST(r.rowid AS TEXT) AS rowRef FROM (SELECT rowid,user_id,id AS request_id FROM (SELECT rowid,delivery_id AS id,user_id,request_kind AS kind,request_message_id,created_at_ms,materialized_at_ms,last_evaluated_at_ms,offer_delivery_id AS delivery_id,current_recurring_opportunity FROM insight_reports WHERE kind='offer-request') WHERE current_recurring_opportunity=1) r WHERE r.user_id=?",
      params: [userId],
    }),
    remaining: (userId) => ({
      sql: "SELECT 1 FROM (SELECT rowid,user_id,id AS request_id FROM (SELECT rowid,delivery_id AS id,user_id,request_kind AS kind,request_message_id,created_at_ms,materialized_at_ms,last_evaluated_at_ms,offer_delivery_id AS delivery_id,current_recurring_opportunity FROM insight_reports WHERE kind='offer-request') WHERE current_recurring_opportunity=1) r WHERE r.user_id=?",
      params: [userId],
    }),
    remove: (scope) => [
      {
        sql: "UPDATE insight_reports AS r SET current_recurring_opportunity=NULL WHERE r.kind='offer-request' AND r.user_id=? AND r.current_recurring_opportunity=1 AND CAST(r.rowid AS TEXT) IN(SELECT row_ref FROM erasure_chunk WHERE request_id=?)",
        params: [scope.userId, scope.reference],
      },
    ],
  },

  {
    id: "recurring_digest_staging",
    dataClass: "schedules",
    dependencies: [],
    quiescence: { _tag: "Synchronous" },
    select: (userId) => ({
      sql: "SELECT CAST(r.rowid AS TEXT) AS rowRef,json_object('user_id',r.\"user_id\",'confirmation_id',r.\"confirmation_id\",'confirmed_at_ms',r.\"confirmed_at_ms\",'context_json',r.\"context_json\",'item_json',r.\"item_json\",'eligible',r.\"eligible\") AS body FROM (SELECT rowid,user_id,confirmation_id,confirmed_at_ms,context_json,item_json,eligible FROM recurring_digest_items WHERE confirmed_at_ms IS NOT NULL) r WHERE r.user_id=?",
      params: [userId],
    }),
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
        sql: "DELETE FROM recurring_digest_items AS r WHERE r.confirmed_at_ms IS NOT NULL AND r.disposition IS NULL AND r.user_id=? AND CAST(r.rowid AS TEXT) IN(SELECT row_ref FROM erasure_chunk WHERE request_id=?)",
        params: [scope.userId, scope.reference],
      },
      {
        sql: "UPDATE recurring_digest_items AS r SET confirmed_at_ms=NULL,context_json=NULL,item_json=NULL,eligible=NULL WHERE r.confirmed_at_ms IS NOT NULL AND r.disposition IS NOT NULL AND r.user_id=? AND CAST(r.rowid AS TEXT) IN(SELECT row_ref FROM erasure_chunk WHERE request_id=?)",
        params: [scope.userId, scope.reference],
      },
    ],
  },
];
