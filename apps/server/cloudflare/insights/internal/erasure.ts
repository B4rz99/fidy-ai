import type { ErasureProjection } from "../../erasure-store/contract";

const scheduleProjections: ReadonlyArray<ErasureProjection> = [
  {
    id: "schedule_executions",
    fields: ["kind", "user_id", "schedule_id", "schedule_version", "scheduled_at", "outcome"],
    dependencies: [],
  },
  {
    id: "schedule_revisions",
    fields: ["kind", "user_id", "schedule_id", "version", "snapshot_json"],
    dependencies: [],
  },
  {
    id: "schedules",
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
].map(({ id, fields, dependencies }): ErasureProjection => ({
  id,
  dataClass: "schedules",
  dependencies,
  quiescence: { _tag: "Synchronous" },
  select: (userId) => ({
    sql: `SELECT CAST(r.rowid AS TEXT) AS rowRef,json_object(${fields.map((field) => `'${field}',r.${field}`).join(",")}) AS body FROM ${id} r WHERE r.user_id=?`,
    params: [userId],
  }),
  candidates: (userId) => ({
    sql: `SELECT CAST(r.rowid AS TEXT) AS rowRef FROM ${id} r WHERE r.user_id=?`,
    params: [userId],
  }),
  remaining: (userId) => ({
    sql: `SELECT 1 FROM ${id} r WHERE r.user_id=?`,
    params: [userId],
  }),
  remove: (scope) => [
    {
      sql: `DELETE FROM ${id} AS r WHERE r.user_id=? AND CAST(r.rowid AS TEXT) IN(SELECT row_ref FROM erasure_chunk WHERE request_id=?)`,
      params: [scope.userId, scope.reference],
    },
  ],
}));

export const projections: ReadonlyArray<ErasureProjection> = [
  ...scheduleProjections,
  {
    id: "insight_reports",
    dataClass: "schedules",
    dependencies: ["proactivity_message_events"],
    quiescence: { _tag: "Synchronous" },
    select: (userId) => ({
      sql: "SELECT CAST(r.rowid AS TEXT) AS rowRef,json_object('kind',r.kind,'user_id',r.user_id,'delivery_id',r.delivery_id,'role',r.role,'consent_grant_id',r.consent_grant_id,'offer_id',r.offer_id,'text',r.text,'scheduled_at_ms',r.scheduled_at_ms,'expires_at_ms',r.expires_at_ms,'time_zone',r.time_zone,'created_at_ms',r.created_at_ms,'payload_json',r.payload_json,'presentation_json',r.presentation_json,'reminder_grant_id',r.reminder_grant_id,'reminder_expires_at_ms',r.reminder_expires_at_ms,'instruction_id',r.instruction_id,'instruction_version',r.instruction_version,'grant_id',r.grant_id,'local_date',r.local_date,'day_from_ms',r.day_from_ms,'day_to_ms',r.day_to_ms,'report_json',r.report_json,'dispatch_state',r.dispatch_state,'dispatch_created_at_ms',r.dispatch_created_at_ms,'dispatch_last_attempt_at_ms',r.dispatch_last_attempt_at_ms,'dispatch_restart_attempts',r.dispatch_restart_attempts) AS body FROM insight_reports r WHERE r.user_id=?",
      params: [userId],
    }),
    candidates: (userId) => ({
      sql: "SELECT CAST(r.rowid AS TEXT) AS rowRef FROM insight_reports r WHERE r.user_id=?",
      params: [userId],
    }),
    remaining: (userId) => ({
      sql: "SELECT 1 FROM insight_reports r WHERE r.user_id=?",
      params: [userId],
    }),
    remove: (scope) => [
      {
        sql: "DELETE FROM insight_reports AS r WHERE r.user_id=? AND CAST(r.rowid AS TEXT) IN(SELECT row_ref FROM erasure_chunk WHERE request_id=?)",
        params: [scope.userId, scope.reference],
      },
    ],
  },

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
    id: "insight_events",
    dataClass: "schedules",
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
    quiescence: { _tag: "Synchronous" },
    select: (userId) => ({
      sql: "SELECT CAST(r.rowid AS TEXT) AS rowRef,json_object('id',r.\"id\",'user_id',r.\"user_id\",'kind',r.\"kind\",'schedule_id',r.\"schedule_id\",'schedule_version',r.\"schedule_version\",'service_market',r.\"service_market\",'locale',r.\"locale\",'time_zone',r.\"time_zone\",'scheduled_at',r.\"scheduled_at\",'money_groups_json',r.\"money_groups_json\",'lifecycle_state',r.\"lifecycle_state\") AS body FROM insight_events r WHERE r.user_id=?",
      params: [userId],
    }),
    candidates: (userId) => ({
      sql: "SELECT CAST(r.rowid AS TEXT) AS rowRef FROM insight_events r WHERE r.user_id=?",
      params: [userId],
    }),
    remaining: (userId) => ({
      sql: "SELECT 1 FROM insight_events r WHERE r.user_id=?",
      params: [userId],
    }),
    remove: (scope) => [
      {
        sql: "DELETE FROM insight_events AS r WHERE r.user_id=? AND CAST(r.rowid AS TEXT) IN(SELECT row_ref FROM erasure_chunk WHERE request_id=?)",
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
    id: "proactivity_offer_requests",
    dataClass: "schedules",
    dependencies: ["recurring_digest_opportunities"],
    quiescence: { _tag: "Synchronous" },
    select: (userId) => ({
      sql: "SELECT CAST(r.rowid AS TEXT) AS rowRef,json_object('id',r.\"id\",'user_id',r.\"user_id\",'kind',r.\"kind\",'request_message_id',r.\"request_message_id\",'created_at_ms',r.\"created_at_ms\",'materialized_at_ms',r.\"materialized_at_ms\",'last_evaluated_at_ms',r.\"last_evaluated_at_ms\",'delivery_id',r.\"delivery_id\") AS body FROM proactivity_offer_requests r WHERE r.user_id=?",
      params: [userId],
    }),
    candidates: (userId) => ({
      sql: "SELECT CAST(r.rowid AS TEXT) AS rowRef FROM proactivity_offer_requests r WHERE r.user_id=?",
      params: [userId],
    }),
    remaining: (userId) => ({
      sql: "SELECT 1 FROM proactivity_offer_requests r WHERE r.user_id=?",
      params: [userId],
    }),
    remove: (scope) => [
      {
        sql: "DELETE FROM proactivity_offer_requests AS r WHERE r.user_id=? AND CAST(r.rowid AS TEXT) IN(SELECT row_ref FROM erasure_chunk WHERE request_id=?)",
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
      sql: "SELECT CAST(r.rowid AS TEXT) AS rowRef,json_object('user_id',r.\"user_id\",'confirmation_id',r.\"confirmation_id\",'disposition',r.\"disposition\") AS body FROM recurring_digest_consumption r WHERE r.user_id=?",
      params: [userId],
    }),
    candidates: (userId) => ({
      sql: "SELECT CAST(r.rowid AS TEXT) AS rowRef FROM recurring_digest_consumption r WHERE r.user_id=?",
      params: [userId],
    }),
    remaining: (userId) => ({
      sql: "SELECT 1 FROM recurring_digest_consumption r WHERE r.user_id=?",
      params: [userId],
    }),
    remove: (scope) => [
      {
        sql: "DELETE FROM recurring_digest_consumption AS r WHERE r.user_id=? AND CAST(r.rowid AS TEXT) IN(SELECT row_ref FROM erasure_chunk WHERE request_id=?)",
        params: [scope.userId, scope.reference],
      },
    ],
  },
  {
    id: "recurring_digest_days",
    dataClass: "schedules",
    dependencies: [],
    quiescence: { _tag: "Synchronous" },
    select: (userId) => ({
      sql: "SELECT CAST(r.rowid AS TEXT) AS rowRef,json_object('user_id',r.\"user_id\",'local_date',r.\"local_date\",'day_from_ms',r.\"day_from_ms\",'day_to_ms',r.\"day_to_ms\",'insight_event_id',r.\"insight_event_id\") AS body FROM recurring_digest_days r WHERE r.user_id=?",
      params: [userId],
    }),
    candidates: (userId) => ({
      sql: "SELECT CAST(r.rowid AS TEXT) AS rowRef FROM recurring_digest_days r WHERE r.user_id=?",
      params: [userId],
    }),
    remaining: (userId) => ({
      sql: "SELECT 1 FROM recurring_digest_days r WHERE r.user_id=?",
      params: [userId],
    }),
    remove: (scope) => [
      {
        sql: "DELETE FROM recurring_digest_days AS r WHERE r.user_id=? AND CAST(r.rowid AS TEXT) IN(SELECT row_ref FROM erasure_chunk WHERE request_id=?)",
        params: [scope.userId, scope.reference],
      },
    ],
  },
  {
    id: "recurring_digest_instructions",
    dataClass: "schedules",
    dependencies: [],
    quiescence: { _tag: "Synchronous" },
    select: (userId) => ({
      sql: "SELECT CAST(r.rowid AS TEXT) AS rowRef,json_object('user_id',r.\"user_id\",'id',r.\"id\",'version',r.\"version\",'enabled',r.\"enabled\",'grant_id',r.\"grant_id\",'context_json',r.\"context_json\",'acceptance_from_ms',r.\"acceptance_from_ms\",'accepted_at_ms',r.\"accepted_at_ms\",'last_source_identity',r.\"last_source_identity\",'next_closed_at_ms',r.\"next_closed_at_ms\",'last_evaluated_at_ms',r.\"last_evaluated_at_ms\",'source_checkpoint',r.source_checkpoint,'source_cursor',r.source_cursor,'source_cutoff_at_ms',r.source_cutoff_at_ms,'source_complete',r.source_complete) AS body FROM recurring_digest_instructions r WHERE r.user_id=?",
      params: [userId],
    }),
    candidates: (userId) => ({
      sql: "SELECT CAST(r.rowid AS TEXT) AS rowRef FROM recurring_digest_instructions r WHERE r.user_id=?",
      params: [userId],
    }),
    remaining: (userId) => ({
      sql: "SELECT 1 FROM recurring_digest_instructions r WHERE r.user_id=?",
      params: [userId],
    }),
    remove: (scope) => [
      {
        sql: "DELETE FROM recurring_digest_instructions AS r WHERE r.user_id=? AND CAST(r.rowid AS TEXT) IN(SELECT row_ref FROM erasure_chunk WHERE request_id=?)",
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
      sql: "SELECT CAST(r.rowid AS TEXT) AS rowRef,json_object('user_id',r.\"user_id\",'request_id',r.\"request_id\") AS body FROM (SELECT rowid,user_id,id AS request_id FROM proactivity_offer_requests WHERE current_recurring_opportunity=1) r WHERE r.user_id=?",
      params: [userId],
    }),
    candidates: (userId) => ({
      sql: "SELECT CAST(r.rowid AS TEXT) AS rowRef FROM (SELECT rowid,user_id,id AS request_id FROM proactivity_offer_requests WHERE current_recurring_opportunity=1) r WHERE r.user_id=?",
      params: [userId],
    }),
    remaining: (userId) => ({
      sql: "SELECT 1 FROM (SELECT rowid,user_id,id AS request_id FROM proactivity_offer_requests WHERE current_recurring_opportunity=1) r WHERE r.user_id=?",
      params: [userId],
    }),
    remove: (scope) => [
      {
        sql: "UPDATE proactivity_offer_requests AS r SET current_recurring_opportunity=NULL WHERE r.user_id=? AND r.current_recurring_opportunity=1 AND CAST(r.rowid AS TEXT) IN(SELECT row_ref FROM erasure_chunk WHERE request_id=?)",
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
      sql: "SELECT CAST(r.rowid AS TEXT) AS rowRef,json_object('user_id',r.\"user_id\",'confirmation_id',r.\"confirmation_id\",'confirmed_at_ms',r.\"confirmed_at_ms\",'context_json',r.\"context_json\",'item_json',r.\"item_json\",'eligible',r.\"eligible\") AS body FROM recurring_digest_staging r WHERE r.user_id=?",
      params: [userId],
    }),
    candidates: (userId) => ({
      sql: "SELECT CAST(r.rowid AS TEXT) AS rowRef FROM recurring_digest_staging r WHERE r.user_id=?",
      params: [userId],
    }),
    remaining: (userId) => ({
      sql: "SELECT 1 FROM recurring_digest_staging r WHERE r.user_id=?",
      params: [userId],
    }),
    remove: (scope) => [
      {
        sql: "DELETE FROM recurring_digest_staging AS r WHERE r.user_id=? AND CAST(r.rowid AS TEXT) IN(SELECT row_ref FROM erasure_chunk WHERE request_id=?)",
        params: [scope.userId, scope.reference],
      },
    ],
  },
  {
    id: "reminder_control_receipts",
    dataClass: "schedules",
    dependencies: [],
    quiescence: { _tag: "Synchronous" },
    select: (userId) => ({
      sql: "SELECT CAST(r.rowid AS TEXT) AS rowRef,json_object('user_id',r.\"user_id\",'message_id',r.\"message_id\",'choice',r.\"choice\") AS body FROM reminder_control_receipts r WHERE r.user_id=?",
      params: [userId],
    }),
    candidates: (userId) => ({
      sql: "SELECT CAST(r.rowid AS TEXT) AS rowRef FROM reminder_control_receipts r WHERE r.user_id=?",
      params: [userId],
    }),
    remaining: (userId) => ({
      sql: "SELECT 1 FROM reminder_control_receipts r WHERE r.user_id=?",
      params: [userId],
    }),
    remove: (scope) => [
      {
        sql: "DELETE FROM reminder_control_receipts AS r WHERE r.user_id=? AND CAST(r.rowid AS TEXT) IN(SELECT row_ref FROM erasure_chunk WHERE request_id=?)",
        params: [scope.userId, scope.reference],
      },
    ],
  },
  {
    id: "reminder_delivery_receipts",
    dataClass: "schedules",
    dependencies: [],
    quiescence: { _tag: "Synchronous" },
    select: (userId) => ({
      sql: "SELECT CAST(r.rowid AS TEXT) AS rowRef,json_object('user_id',r.\"user_id\",'delivery_id',r.\"delivery_id\") AS body FROM (SELECT rowid,* FROM governor_delivery_receipts WHERE kind='reminder') r WHERE r.user_id=?",
      params: [userId],
    }),
    candidates: (userId) => ({
      sql: "SELECT CAST(r.rowid AS TEXT) AS rowRef FROM (SELECT rowid,* FROM governor_delivery_receipts WHERE kind='reminder') r WHERE r.user_id=?",
      params: [userId],
    }),
    remaining: (userId) => ({
      sql: "SELECT 1 FROM (SELECT rowid,* FROM governor_delivery_receipts WHERE kind='reminder') r WHERE r.user_id=?",
      params: [userId],
    }),
    remove: (scope) => [
      {
        sql: "DELETE FROM governor_delivery_receipts AS r WHERE kind='reminder' AND r.user_id=? AND CAST(r.rowid AS TEXT) IN(SELECT row_ref FROM erasure_chunk WHERE request_id=?)",
        params: [scope.userId, scope.reference],
      },
    ],
  },
  {
    id: "reminder_governors",
    dataClass: "schedules",
    dependencies: [],
    quiescence: { _tag: "Synchronous" },
    select: (userId) => ({
      sql: "SELECT CAST(r.rowid AS TEXT) AS rowRef,json_object('user_id',r.\"user_id\",'standing_json',r.\"standing_json\",'last_reply_at_ms',r.\"last_reply_at_ms\",'question_id',r.\"question_id\",'question_delivered_at_ms',r.\"question_delivered_at_ms\",'notice_turn_id',r.\"notice_turn_id\",'notice_completed',r.\"notice_completed\") AS body FROM (SELECT rowid,* FROM proactivity_governors WHERE kind='reminder') r WHERE r.user_id=?",
      params: [userId],
    }),
    candidates: (userId) => ({
      sql: "SELECT CAST(r.rowid AS TEXT) AS rowRef FROM (SELECT rowid,* FROM proactivity_governors WHERE kind='reminder') r WHERE r.user_id=?",
      params: [userId],
    }),
    remaining: (userId) => ({
      sql: "SELECT 1 FROM (SELECT rowid,* FROM proactivity_governors WHERE kind='reminder') r WHERE r.user_id=?",
      params: [userId],
    }),
    remove: (scope) => [
      {
        sql: "DELETE FROM proactivity_governors AS r WHERE kind='reminder' AND r.user_id=? AND CAST(r.rowid AS TEXT) IN(SELECT row_ref FROM erasure_chunk WHERE request_id=?)",
        params: [scope.userId, scope.reference],
      },
    ],
  },

  {
    id: "weekly_governor_deliveries",
    dataClass: "schedules",
    dependencies: [],
    quiescence: { _tag: "Synchronous" },
    select: (userId) => ({
      sql: "SELECT CAST(r.rowid AS TEXT) AS rowRef,json_object('user_id',r.\"user_id\",'insight_event_id',r.\"insight_event_id\") AS body FROM (SELECT rowid,* FROM governor_delivery_receipts WHERE kind='weekly') r WHERE r.user_id=?",
      params: [userId],
    }),
    candidates: (userId) => ({
      sql: "SELECT CAST(r.rowid AS TEXT) AS rowRef FROM (SELECT rowid,* FROM governor_delivery_receipts WHERE kind='weekly') r WHERE r.user_id=?",
      params: [userId],
    }),
    remaining: (userId) => ({
      sql: "SELECT 1 FROM (SELECT rowid,* FROM governor_delivery_receipts WHERE kind='weekly') r WHERE r.user_id=?",
      params: [userId],
    }),
    remove: (scope) => [
      {
        sql: "DELETE FROM governor_delivery_receipts AS r WHERE kind='weekly' AND r.user_id=? AND CAST(r.rowid AS TEXT) IN(SELECT row_ref FROM erasure_chunk WHERE request_id=?)",
        params: [scope.userId, scope.reference],
      },
    ],
  },
  {
    id: "weekly_governors",
    dataClass: "schedules",
    dependencies: [],
    quiescence: { _tag: "Synchronous" },
    select: (userId) => ({
      sql: "SELECT CAST(r.rowid AS TEXT) AS rowRef,json_object('user_id',r.\"user_id\",'unanswered',r.\"unanswered\",'last_reply_at_ms',r.\"last_reply_at_ms\",'question_needed',r.\"question_needed\",'question_delivered',r.\"question_delivered\",'question_delivered_at_ms',r.\"question_delivered_at_ms\",'question_event_id',r.\"question_event_id\",'paused_at_ms',r.\"paused_at_ms\",'notice_session_id',r.\"notice_session_id\",'notice_turn_id',r.\"notice_turn_id\",'notice_completed',r.\"notice_completed\") AS body FROM (SELECT rowid,* FROM proactivity_governors WHERE kind='weekly') r WHERE r.user_id=?",
      params: [userId],
    }),
    candidates: (userId) => ({
      sql: "SELECT CAST(r.rowid AS TEXT) AS rowRef FROM (SELECT rowid,* FROM proactivity_governors WHERE kind='weekly') r WHERE r.user_id=?",
      params: [userId],
    }),
    remaining: (userId) => ({
      sql: "SELECT 1 FROM (SELECT rowid,* FROM proactivity_governors WHERE kind='weekly') r WHERE r.user_id=?",
      params: [userId],
    }),
    remove: (scope) => [
      {
        sql: "DELETE FROM proactivity_governors AS r WHERE kind='weekly' AND r.user_id=? AND CAST(r.rowid AS TEXT) IN(SELECT row_ref FROM erasure_chunk WHERE request_id=?)",
        params: [scope.userId, scope.reference],
      },
    ],
  },
  {
    id: "weekly_question_intents",
    dataClass: "schedules",
    dependencies: [],
    quiescence: { _tag: "Synchronous" },
    select: (userId) => ({
      sql: "SELECT CAST(r.rowid AS TEXT) AS rowRef,json_object('id',r.\"id\",'user_id',r.\"user_id\",'origin',r.\"origin\",'request_message_id',r.\"request_message_id\",'rejection_offer_id',r.\"rejection_offer_id\",'state',r.\"state\",'created_at_ms',r.\"created_at_ms\",'last_attempt_at_ms',r.\"last_attempt_at_ms\",'restart_attempts',r.\"restart_attempts\") AS body FROM weekly_question_intents r WHERE r.user_id=?",
      params: [userId],
    }),
    candidates: (userId) => ({
      sql: "SELECT CAST(r.rowid AS TEXT) AS rowRef FROM weekly_question_intents r WHERE r.user_id=?",
      params: [userId],
    }),
    remaining: (userId) => ({
      sql: "SELECT 1 FROM weekly_question_intents r WHERE r.user_id=?",
      params: [userId],
    }),
    remove: (scope) => [
      {
        sql: "DELETE FROM weekly_question_intents AS r WHERE r.user_id=? AND CAST(r.rowid AS TEXT) IN(SELECT row_ref FROM erasure_chunk WHERE request_id=?)",
        params: [scope.userId, scope.reference],
      },
    ],
  },
];
