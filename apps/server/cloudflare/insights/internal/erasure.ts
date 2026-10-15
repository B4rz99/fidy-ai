import type { ErasureProjection } from "../../erasure-store/contract";

export const projections: ReadonlyArray<ErasureProjection> = [
  {
    id: "budget_alert_occurrences",
    dataClass: "schedules",
    dependencies: [],
    quiescence: { _tag: "Synchronous" },
    select: (userId) => ({
      sql: "SELECT CAST(r.rowid AS TEXT) AS rowRef,json_object('user_id',r.\"user_id\",'delivery_group_id',r.\"delivery_group_id\",'threshold',r.\"threshold\",'insight_event_id',r.\"insight_event_id\",'crossing_json',r.\"crossing_json\") AS body FROM budget_alert_occurrences r WHERE r.user_id=?",
      params: [userId],
    }),
    candidates: (userId) => ({
      sql: "SELECT CAST(r.rowid AS TEXT) AS rowRef FROM budget_alert_occurrences r WHERE r.user_id=?",
      params: [userId],
    }),
    remaining: (userId) => ({
      sql: "SELECT 1 FROM budget_alert_occurrences r WHERE r.user_id=?",
      params: [userId],
    }),
    remove: (scope) => [
      {
        sql: "DELETE FROM budget_alert_occurrences AS r WHERE r.user_id=? AND CAST(r.rowid AS TEXT) IN(SELECT row_ref FROM erasure_chunk WHERE request_id=?)",
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
      sql: "SELECT CAST(r.rowid AS TEXT) AS rowRef,json_object('id',r.\"id\",'user_id',r.\"user_id\",'insight_event_id',r.\"insight_event_id\",'sent_at',r.\"sent_at\",'channel',r.\"channel\",'provider',r.\"provider\",'provider_message_id',r.\"provider_message_id\") AS body FROM insight_delivery_attempts r WHERE r.user_id=?",
      params: [userId],
    }),
    candidates: (userId) => ({
      sql: "SELECT CAST(r.rowid AS TEXT) AS rowRef FROM insight_delivery_attempts r WHERE r.user_id=?",
      params: [userId],
    }),
    remaining: (userId) => ({
      sql: "SELECT 1 FROM insight_delivery_attempts r WHERE r.user_id=?",
      params: [userId],
    }),
    remove: (scope) => [
      {
        sql: "DELETE FROM insight_delivery_attempts AS r WHERE r.user_id=? AND CAST(r.rowid AS TEXT) IN(SELECT row_ref FROM erasure_chunk WHERE request_id=?)",
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
      "recurring_digest_reports",
      "reminder_occurrence_reports",
      "weekly_governor_deliveries",
      "weekly_summary_reports",
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
      sql: "SELECT CAST(r.rowid AS TEXT) AS rowRef,json_object('user_id',r.\"user_id\",'delivery_id',r.\"delivery_id\",'insight_event_id',r.\"insight_event_id\") AS body FROM proactivity_message_events r WHERE r.user_id=?",
      params: [userId],
    }),
    candidates: (userId) => ({
      sql: "SELECT CAST(r.rowid AS TEXT) AS rowRef FROM proactivity_message_events r WHERE r.user_id=?",
      params: [userId],
    }),
    remaining: (userId) => ({
      sql: "SELECT 1 FROM proactivity_message_events r WHERE r.user_id=?",
      params: [userId],
    }),
    remove: (scope) => [
      {
        sql: "DELETE FROM proactivity_message_events AS r WHERE r.user_id=? AND CAST(r.rowid AS TEXT) IN(SELECT row_ref FROM erasure_chunk WHERE request_id=?)",
        params: [scope.userId, scope.reference],
      },
    ],
  },
  {
    id: "proactivity_offer_requests",
    dataClass: "schedules",
    dependencies: [],
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
    id: "proactivity_outbox",
    dataClass: "schedules",
    dependencies: [],
    quiescence: {
      _tag: "Durable",
      select: ({ current, userId }) => ({
        sql: "SELECT 1 FROM proactivity_outbox o JOIN proactivity_reports r ON r.user_id=o.user_id AND r.delivery_id=o.delivery_id WHERE o.user_id=? AND o.state IN('ready','started') AND r.expires_at_ms>?",
        params: [userId, current],
      }),
    },
    select: (userId) => ({
      sql: "SELECT CAST(r.rowid AS TEXT) AS rowRef,json_object('user_id',r.\"user_id\",'delivery_id',r.\"delivery_id\",'created_at_ms',r.\"created_at_ms\",'state',r.\"state\",'last_attempt_at_ms',r.\"last_attempt_at_ms\",'restart_attempts',r.\"restart_attempts\") AS body FROM proactivity_outbox r WHERE r.user_id=?",
      params: [userId],
    }),
    candidates: (userId) => ({
      sql: "SELECT CAST(r.rowid AS TEXT) AS rowRef FROM proactivity_outbox r WHERE r.user_id=?",
      params: [userId],
    }),
    remaining: (userId) => ({
      sql: "SELECT 1 FROM proactivity_outbox r WHERE r.user_id=?",
      params: [userId],
    }),
    remove: (scope) => [
      {
        sql: "DELETE FROM proactivity_outbox AS r WHERE r.user_id=? AND CAST(r.rowid AS TEXT) IN(SELECT row_ref FROM erasure_chunk WHERE request_id=?)",
        params: [scope.userId, scope.reference],
      },
    ],
  },
  {
    id: "proactivity_reports",
    dataClass: "schedules",
    dependencies: ["proactivity_message_events", "proactivity_outbox"],
    quiescence: { _tag: "Synchronous" },
    select: (userId) => ({
      sql: "SELECT CAST(r.rowid AS TEXT) AS rowRef,json_object('delivery_id',r.\"delivery_id\",'user_id',r.\"user_id\",'role',r.\"role\",'consent_grant_id',r.\"consent_grant_id\",'offer_id',r.\"offer_id\",'text',r.\"text\",'scheduled_at_ms',r.\"scheduled_at_ms\",'expires_at_ms',r.\"expires_at_ms\",'time_zone',r.\"time_zone\",'created_at_ms',r.\"created_at_ms\") AS body FROM proactivity_reports r WHERE r.user_id=?",
      params: [userId],
    }),
    candidates: (userId) => ({
      sql: "SELECT CAST(r.rowid AS TEXT) AS rowRef FROM proactivity_reports r WHERE r.user_id=?",
      params: [userId],
    }),
    remaining: (userId) => ({
      sql: "SELECT 1 FROM proactivity_reports r WHERE r.user_id=?",
      params: [userId],
    }),
    remove: (scope) => [
      {
        sql: "DELETE FROM proactivity_reports AS r WHERE r.user_id=? AND CAST(r.rowid AS TEXT) IN(SELECT row_ref FROM erasure_chunk WHERE request_id=?)",
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
      sql: "SELECT CAST(r.rowid AS TEXT) AS rowRef,json_object('user_id',r.\"user_id\",'id',r.\"id\",'version',r.\"version\",'enabled',r.\"enabled\",'grant_id',r.\"grant_id\",'context_json',r.\"context_json\",'acceptance_from_ms',r.\"acceptance_from_ms\",'accepted_at_ms',r.\"accepted_at_ms\",'last_source_identity',r.\"last_source_identity\",'next_closed_at_ms',r.\"next_closed_at_ms\",'last_evaluated_at_ms',r.\"last_evaluated_at_ms\") AS body FROM recurring_digest_instructions r WHERE r.user_id=?",
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
      sql: "SELECT CAST(r.rowid AS TEXT) AS rowRef,json_object('user_id',r.\"user_id\",'request_id',r.\"request_id\") AS body FROM recurring_digest_opportunities r WHERE r.user_id=?",
      params: [userId],
    }),
    candidates: (userId) => ({
      sql: "SELECT CAST(r.rowid AS TEXT) AS rowRef FROM recurring_digest_opportunities r WHERE r.user_id=?",
      params: [userId],
    }),
    remaining: (userId) => ({
      sql: "SELECT 1 FROM recurring_digest_opportunities r WHERE r.user_id=?",
      params: [userId],
    }),
    remove: (scope) => [
      {
        sql: "DELETE FROM recurring_digest_opportunities AS r WHERE r.user_id=? AND CAST(r.rowid AS TEXT) IN(SELECT row_ref FROM erasure_chunk WHERE request_id=?)",
        params: [scope.userId, scope.reference],
      },
    ],
  },
  {
    id: "recurring_digest_reports",
    dataClass: "schedules",
    dependencies: [],
    quiescence: { _tag: "Synchronous" },
    select: (userId) => ({
      sql: "SELECT CAST(r.rowid AS TEXT) AS rowRef,json_object('user_id',r.\"user_id\",'insight_event_id',r.\"insight_event_id\",'instruction_id',r.\"instruction_id\",'instruction_version',r.\"instruction_version\",'grant_id',r.\"grant_id\",'local_date',r.\"local_date\",'day_from_ms',r.\"day_from_ms\",'day_to_ms',r.\"day_to_ms\",'report_json',r.\"report_json\") AS body FROM recurring_digest_reports r WHERE r.user_id=?",
      params: [userId],
    }),
    candidates: (userId) => ({
      sql: "SELECT CAST(r.rowid AS TEXT) AS rowRef FROM recurring_digest_reports r WHERE r.user_id=?",
      params: [userId],
    }),
    remaining: (userId) => ({
      sql: "SELECT 1 FROM recurring_digest_reports r WHERE r.user_id=?",
      params: [userId],
    }),
    remove: (scope) => [
      {
        sql: "DELETE FROM recurring_digest_reports AS r WHERE r.user_id=? AND CAST(r.rowid AS TEXT) IN(SELECT row_ref FROM erasure_chunk WHERE request_id=?)",
        params: [scope.userId, scope.reference],
      },
    ],
  },
  {
    id: "recurring_digest_scans",
    dataClass: "schedules",
    dependencies: [],
    quiescence: { _tag: "Synchronous" },
    select: (userId) => ({
      sql: "SELECT CAST(r.rowid AS TEXT) AS rowRef,json_object('user_id',r.\"user_id\",'checkpoint',r.\"checkpoint\",'cursor',r.\"cursor\",'cutoff_at_ms',r.\"cutoff_at_ms\",'complete',r.\"complete\") AS body FROM recurring_digest_scans r WHERE r.user_id=?",
      params: [userId],
    }),
    candidates: (userId) => ({
      sql: "SELECT CAST(r.rowid AS TEXT) AS rowRef FROM recurring_digest_scans r WHERE r.user_id=?",
      params: [userId],
    }),
    remaining: (userId) => ({
      sql: "SELECT 1 FROM recurring_digest_scans r WHERE r.user_id=?",
      params: [userId],
    }),
    remove: (scope) => [
      {
        sql: "DELETE FROM recurring_digest_scans AS r WHERE r.user_id=? AND CAST(r.rowid AS TEXT) IN(SELECT row_ref FROM erasure_chunk WHERE request_id=?)",
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
      sql: "SELECT CAST(r.rowid AS TEXT) AS rowRef,json_object('user_id',r.\"user_id\",'delivery_id',r.\"delivery_id\") AS body FROM reminder_delivery_receipts r WHERE r.user_id=?",
      params: [userId],
    }),
    candidates: (userId) => ({
      sql: "SELECT CAST(r.rowid AS TEXT) AS rowRef FROM reminder_delivery_receipts r WHERE r.user_id=?",
      params: [userId],
    }),
    remaining: (userId) => ({
      sql: "SELECT 1 FROM reminder_delivery_receipts r WHERE r.user_id=?",
      params: [userId],
    }),
    remove: (scope) => [
      {
        sql: "DELETE FROM reminder_delivery_receipts AS r WHERE r.user_id=? AND CAST(r.rowid AS TEXT) IN(SELECT row_ref FROM erasure_chunk WHERE request_id=?)",
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
      sql: "SELECT CAST(r.rowid AS TEXT) AS rowRef,json_object('user_id',r.\"user_id\",'standing_json',r.\"standing_json\",'last_reply_at_ms',r.\"last_reply_at_ms\",'question_id',r.\"question_id\",'question_delivered_at_ms',r.\"question_delivered_at_ms\",'notice_turn_id',r.\"notice_turn_id\",'notice_completed',r.\"notice_completed\") AS body FROM reminder_governors r WHERE r.user_id=?",
      params: [userId],
    }),
    candidates: (userId) => ({
      sql: "SELECT CAST(r.rowid AS TEXT) AS rowRef FROM reminder_governors r WHERE r.user_id=?",
      params: [userId],
    }),
    remaining: (userId) => ({
      sql: "SELECT 1 FROM reminder_governors r WHERE r.user_id=?",
      params: [userId],
    }),
    remove: (scope) => [
      {
        sql: "DELETE FROM reminder_governors AS r WHERE r.user_id=? AND CAST(r.rowid AS TEXT) IN(SELECT row_ref FROM erasure_chunk WHERE request_id=?)",
        params: [scope.userId, scope.reference],
      },
    ],
  },
  {
    id: "reminder_occurrence_reports",
    dataClass: "schedules",
    dependencies: [],
    quiescence: { _tag: "Synchronous" },
    select: (userId) => ({
      sql: "SELECT CAST(r.rowid AS TEXT) AS rowRef,json_object('user_id',r.\"user_id\",'insight_event_id',r.\"insight_event_id\",'consent_grant_id',r.\"consent_grant_id\",'expires_at_ms',r.\"expires_at_ms\") AS body FROM reminder_occurrence_reports r WHERE r.user_id=?",
      params: [userId],
    }),
    candidates: (userId) => ({
      sql: "SELECT CAST(r.rowid AS TEXT) AS rowRef FROM reminder_occurrence_reports r WHERE r.user_id=?",
      params: [userId],
    }),
    remaining: (userId) => ({
      sql: "SELECT 1 FROM reminder_occurrence_reports r WHERE r.user_id=?",
      params: [userId],
    }),
    remove: (scope) => [
      {
        sql: "DELETE FROM reminder_occurrence_reports AS r WHERE r.user_id=? AND CAST(r.rowid AS TEXT) IN(SELECT row_ref FROM erasure_chunk WHERE request_id=?)",
        params: [scope.userId, scope.reference],
      },
    ],
  },
  {
    id: "reminder_schedule_executions",
    dataClass: "schedules",
    dependencies: [],
    quiescence: { _tag: "Synchronous" },
    select: (userId) => ({
      sql: "SELECT CAST(r.rowid AS TEXT) AS rowRef,json_object('user_id',r.\"user_id\",'schedule_id',r.\"schedule_id\",'schedule_version',r.\"schedule_version\",'scheduled_at',r.\"scheduled_at\",'outcome',r.\"outcome\") AS body FROM reminder_schedule_executions r WHERE r.user_id=?",
      params: [userId],
    }),
    candidates: (userId) => ({
      sql: "SELECT CAST(r.rowid AS TEXT) AS rowRef FROM reminder_schedule_executions r WHERE r.user_id=?",
      params: [userId],
    }),
    remaining: (userId) => ({
      sql: "SELECT 1 FROM reminder_schedule_executions r WHERE r.user_id=?",
      params: [userId],
    }),
    remove: (scope) => [
      {
        sql: "DELETE FROM reminder_schedule_executions AS r WHERE r.user_id=? AND CAST(r.rowid AS TEXT) IN(SELECT row_ref FROM erasure_chunk WHERE request_id=?)",
        params: [scope.userId, scope.reference],
      },
    ],
  },
  {
    id: "reminder_schedule_revisions",
    dataClass: "schedules",
    dependencies: [],
    quiescence: { _tag: "Synchronous" },
    select: (userId) => ({
      sql: "SELECT CAST(r.rowid AS TEXT) AS rowRef,json_object('user_id',r.\"user_id\",'schedule_id',r.\"schedule_id\",'version',r.\"version\",'snapshot_json',r.\"snapshot_json\") AS body FROM reminder_schedule_revisions r WHERE r.user_id=?",
      params: [userId],
    }),
    candidates: (userId) => ({
      sql: "SELECT CAST(r.rowid AS TEXT) AS rowRef FROM reminder_schedule_revisions r WHERE r.user_id=?",
      params: [userId],
    }),
    remaining: (userId) => ({
      sql: "SELECT 1 FROM reminder_schedule_revisions r WHERE r.user_id=?",
      params: [userId],
    }),
    remove: (scope) => [
      {
        sql: "DELETE FROM reminder_schedule_revisions AS r WHERE r.user_id=? AND CAST(r.rowid AS TEXT) IN(SELECT row_ref FROM erasure_chunk WHERE request_id=?)",
        params: [scope.userId, scope.reference],
      },
    ],
  },
  {
    id: "reminder_schedules",
    dataClass: "schedules",
    dependencies: ["reminder_schedule_executions", "reminder_schedule_revisions"],
    quiescence: { _tag: "Synchronous" },
    select: (userId) => ({
      sql: "SELECT CAST(r.rowid AS TEXT) AS rowRef,json_object('id',r.\"id\",'user_id',r.\"user_id\",'version',r.\"version\",'enabled',r.\"enabled\",'snapshot_json',r.\"snapshot_json\",'next_scheduled_at',r.\"next_scheduled_at\",'consent_grant_id',r.\"consent_grant_id\",'last_evaluated_at_ms',r.\"last_evaluated_at_ms\") AS body FROM reminder_schedules r WHERE r.user_id=?",
      params: [userId],
    }),
    candidates: (userId) => ({
      sql: "SELECT CAST(r.rowid AS TEXT) AS rowRef FROM reminder_schedules r WHERE r.user_id=?",
      params: [userId],
    }),
    remaining: (userId) => ({
      sql: "SELECT 1 FROM reminder_schedules r WHERE r.user_id=?",
      params: [userId],
    }),
    remove: (scope) => [
      {
        sql: "DELETE FROM reminder_schedules AS r WHERE r.user_id=? AND CAST(r.rowid AS TEXT) IN(SELECT row_ref FROM erasure_chunk WHERE request_id=?)",
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
      sql: "SELECT CAST(r.rowid AS TEXT) AS rowRef,json_object('user_id',r.\"user_id\",'insight_event_id',r.\"insight_event_id\") AS body FROM weekly_governor_deliveries r WHERE r.user_id=?",
      params: [userId],
    }),
    candidates: (userId) => ({
      sql: "SELECT CAST(r.rowid AS TEXT) AS rowRef FROM weekly_governor_deliveries r WHERE r.user_id=?",
      params: [userId],
    }),
    remaining: (userId) => ({
      sql: "SELECT 1 FROM weekly_governor_deliveries r WHERE r.user_id=?",
      params: [userId],
    }),
    remove: (scope) => [
      {
        sql: "DELETE FROM weekly_governor_deliveries AS r WHERE r.user_id=? AND CAST(r.rowid AS TEXT) IN(SELECT row_ref FROM erasure_chunk WHERE request_id=?)",
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
      sql: "SELECT CAST(r.rowid AS TEXT) AS rowRef,json_object('user_id',r.\"user_id\",'unanswered',r.\"unanswered\",'last_reply_at_ms',r.\"last_reply_at_ms\",'question_needed',r.\"question_needed\",'question_delivered',r.\"question_delivered\",'question_delivered_at_ms',r.\"question_delivered_at_ms\",'question_event_id',r.\"question_event_id\",'paused_at_ms',r.\"paused_at_ms\",'notice_session_id',r.\"notice_session_id\",'notice_turn_id',r.\"notice_turn_id\",'notice_completed',r.\"notice_completed\") AS body FROM weekly_governors r WHERE r.user_id=?",
      params: [userId],
    }),
    candidates: (userId) => ({
      sql: "SELECT CAST(r.rowid AS TEXT) AS rowRef FROM weekly_governors r WHERE r.user_id=?",
      params: [userId],
    }),
    remaining: (userId) => ({
      sql: "SELECT 1 FROM weekly_governors r WHERE r.user_id=?",
      params: [userId],
    }),
    remove: (scope) => [
      {
        sql: "DELETE FROM weekly_governors AS r WHERE r.user_id=? AND CAST(r.rowid AS TEXT) IN(SELECT row_ref FROM erasure_chunk WHERE request_id=?)",
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
  {
    id: "weekly_schedule_executions",
    dataClass: "schedules",
    dependencies: [],
    quiescence: { _tag: "Synchronous" },
    select: (userId) => ({
      sql: "SELECT CAST(r.rowid AS TEXT) AS rowRef,json_object('user_id',r.\"user_id\",'schedule_id',r.\"schedule_id\",'schedule_version',r.\"schedule_version\",'scheduled_at',r.\"scheduled_at\",'outcome',r.\"outcome\") AS body FROM weekly_schedule_executions r WHERE r.user_id=?",
      params: [userId],
    }),
    candidates: (userId) => ({
      sql: "SELECT CAST(r.rowid AS TEXT) AS rowRef FROM weekly_schedule_executions r WHERE r.user_id=?",
      params: [userId],
    }),
    remaining: (userId) => ({
      sql: "SELECT 1 FROM weekly_schedule_executions r WHERE r.user_id=?",
      params: [userId],
    }),
    remove: (scope) => [
      {
        sql: "DELETE FROM weekly_schedule_executions AS r WHERE r.user_id=? AND CAST(r.rowid AS TEXT) IN(SELECT row_ref FROM erasure_chunk WHERE request_id=?)",
        params: [scope.userId, scope.reference],
      },
    ],
  },
  {
    id: "weekly_schedule_revisions",
    dataClass: "schedules",
    dependencies: [],
    quiescence: { _tag: "Synchronous" },
    select: (userId) => ({
      sql: "SELECT CAST(r.rowid AS TEXT) AS rowRef,json_object('user_id',r.\"user_id\",'schedule_id',r.\"schedule_id\",'version',r.\"version\",'snapshot_json',r.\"snapshot_json\") AS body FROM weekly_schedule_revisions r WHERE r.user_id=?",
      params: [userId],
    }),
    candidates: (userId) => ({
      sql: "SELECT CAST(r.rowid AS TEXT) AS rowRef FROM weekly_schedule_revisions r WHERE r.user_id=?",
      params: [userId],
    }),
    remaining: (userId) => ({
      sql: "SELECT 1 FROM weekly_schedule_revisions r WHERE r.user_id=?",
      params: [userId],
    }),
    remove: (scope) => [
      {
        sql: "DELETE FROM weekly_schedule_revisions AS r WHERE r.user_id=? AND CAST(r.rowid AS TEXT) IN(SELECT row_ref FROM erasure_chunk WHERE request_id=?)",
        params: [scope.userId, scope.reference],
      },
    ],
  },
  {
    id: "weekly_schedules",
    dataClass: "schedules",
    dependencies: ["weekly_schedule_executions", "weekly_schedule_revisions"],
    quiescence: { _tag: "Synchronous" },
    select: (userId) => ({
      sql: "SELECT CAST(r.rowid AS TEXT) AS rowRef,json_object('id',r.\"id\",'user_id',r.\"user_id\",'version',r.\"version\",'enabled',r.\"enabled\",'weekday',r.\"weekday\",'hour',r.\"hour\",'minute',r.\"minute\",'time_zone',r.\"time_zone\",'service_market',r.\"service_market\",'locale',r.\"locale\",'next_scheduled_at',r.\"next_scheduled_at\",'consent_grant_id',r.\"consent_grant_id\",'last_evaluated_at_ms',r.\"last_evaluated_at_ms\") AS body FROM weekly_schedules r WHERE r.user_id=?",
      params: [userId],
    }),
    candidates: (userId) => ({
      sql: "SELECT CAST(r.rowid AS TEXT) AS rowRef FROM weekly_schedules r WHERE r.user_id=?",
      params: [userId],
    }),
    remaining: (userId) => ({
      sql: "SELECT 1 FROM weekly_schedules r WHERE r.user_id=?",
      params: [userId],
    }),
    remove: (scope) => [
      {
        sql: "DELETE FROM weekly_schedules AS r WHERE r.user_id=? AND CAST(r.rowid AS TEXT) IN(SELECT row_ref FROM erasure_chunk WHERE request_id=?)",
        params: [scope.userId, scope.reference],
      },
    ],
  },
  {
    id: "weekly_summary_outbox",
    dataClass: "schedules",
    dependencies: [],
    quiescence: {
      _tag: "Durable",
      select: ({ current, userId }) => ({
        sql: "SELECT 1 FROM weekly_summary_outbox o JOIN weekly_summary_reports r ON r.user_id=o.user_id AND r.insight_event_id=o.insight_event_id WHERE o.user_id=? AND o.state IN('ready','started') AND r.expires_at_ms>?",
        params: [userId, current],
      }),
    },
    select: (userId) => ({
      sql: "SELECT CAST(r.rowid AS TEXT) AS rowRef,json_object('user_id',r.\"user_id\",'insight_event_id',r.\"insight_event_id\",'state',r.\"state\",'created_at_ms',r.\"created_at_ms\",'last_attempt_at_ms',r.\"last_attempt_at_ms\",'restart_attempts',r.\"restart_attempts\") AS body FROM weekly_summary_outbox r WHERE r.user_id=?",
      params: [userId],
    }),
    candidates: (userId) => ({
      sql: "SELECT CAST(r.rowid AS TEXT) AS rowRef FROM weekly_summary_outbox r WHERE r.user_id=?",
      params: [userId],
    }),
    remaining: (userId) => ({
      sql: "SELECT 1 FROM weekly_summary_outbox r WHERE r.user_id=?",
      params: [userId],
    }),
    remove: (scope) => [
      {
        sql: "DELETE FROM weekly_summary_outbox AS r WHERE r.user_id=? AND CAST(r.rowid AS TEXT) IN(SELECT row_ref FROM erasure_chunk WHERE request_id=?)",
        params: [scope.userId, scope.reference],
      },
    ],
  },
  {
    id: "weekly_summary_reports",
    dataClass: "schedules",
    dependencies: ["weekly_summary_outbox"],
    quiescence: { _tag: "Synchronous" },
    select: (userId) => ({
      sql: "SELECT CAST(r.rowid AS TEXT) AS rowRef,json_object('user_id',r.\"user_id\",'insight_event_id',r.\"insight_event_id\",'consent_grant_id',r.\"consent_grant_id\",'payload_json',r.\"payload_json\",'presentation_json',r.\"presentation_json\",'scheduled_at_ms',r.\"scheduled_at_ms\",'expires_at_ms',r.\"expires_at_ms\") AS body FROM weekly_summary_reports r WHERE r.user_id=?",
      params: [userId],
    }),
    candidates: (userId) => ({
      sql: "SELECT CAST(r.rowid AS TEXT) AS rowRef FROM weekly_summary_reports r WHERE r.user_id=?",
      params: [userId],
    }),
    remaining: (userId) => ({
      sql: "SELECT 1 FROM weekly_summary_reports r WHERE r.user_id=?",
      params: [userId],
    }),
    remove: (scope) => [
      {
        sql: "DELETE FROM weekly_summary_reports AS r WHERE r.user_id=? AND CAST(r.rowid AS TEXT) IN(SELECT row_ref FROM erasure_chunk WHERE request_id=?)",
        params: [scope.userId, scope.reference],
      },
    ],
  },
];
