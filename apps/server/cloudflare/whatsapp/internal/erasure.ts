import type { ErasureProjection } from "../../erasure-store/contract";

export const projections: ReadonlyArray<ErasureProjection> = [
  {
    id: "hosted_voice_refusals",
    dataClass: "conversation",
    dependencies: [],
    quiescence: { _tag: "Synchronous" },
    select: (userId) => ({
      sql: "SELECT CAST(r.rowid AS TEXT) AS rowRef,json_object('portfolio_id',r.\"portfolio_id\",'message_id',r.\"message_id\",'user_id',r.\"user_id\",'claimed_at_ms',r.\"claimed_at_ms\",'outcome',r.\"outcome\") AS body FROM hosted_voice_refusals r WHERE r.user_id=?",
      params: [userId],
    }),
    candidates: (userId) => ({
      sql: "SELECT CAST(r.rowid AS TEXT) AS rowRef FROM hosted_voice_refusals r WHERE r.user_id=?",
      params: [userId],
    }),
    remaining: (userId) => ({
      sql: "SELECT 1 FROM hosted_voice_refusals r WHERE r.user_id=?",
      params: [userId],
    }),
    remove: (scope) => [
      {
        sql: "DELETE FROM hosted_voice_refusals AS r WHERE r.user_id=? AND CAST(r.rowid AS TEXT) IN(SELECT row_ref FROM erasure_chunk WHERE request_id=?)",
        params: [scope.userId, scope.reference],
      },
    ],
  },
  {
    id: "hosted_whatsapp_delivery",
    dataClass: "conversation",
    dependencies: ["hosted_whatsapp_delivery_events"],
    quiescence: {
      _tag: "Durable",
      select: ({ userId }) => ({
        sql: "SELECT 1 FROM hosted_whatsapp_delivery WHERE user_id=? AND state='sending'",
        params: [userId],
      }),
    },
    select: (userId) => ({
      sql: "SELECT CAST(r.rowid AS TEXT) AS rowRef,json_object('turn_id',r.\"turn_id\",'user_id',r.\"user_id\",'text',r.\"text\",'business_phone_number_id',r.\"business_phone_number_id\",'proposed_at_ms',r.\"proposed_at_ms\",'state',r.\"state\",'provider_message_id',r.\"provider_message_id\",'delivered_at_ms',r.\"delivered_at_ms\",'send_started_at_ms',r.\"send_started_at_ms\") AS body FROM hosted_whatsapp_delivery r WHERE r.user_id=?",
      params: [userId],
    }),
    candidates: (userId) => ({
      sql: "SELECT CAST(r.rowid AS TEXT) AS rowRef FROM hosted_whatsapp_delivery r WHERE r.user_id=?",
      params: [userId],
    }),
    remaining: (userId) => ({
      sql: "SELECT 1 FROM hosted_whatsapp_delivery r WHERE r.user_id=?",
      params: [userId],
    }),
    remove: (scope) => [
      {
        sql: "DELETE FROM hosted_whatsapp_delivery AS r WHERE r.user_id=? AND CAST(r.rowid AS TEXT) IN(SELECT row_ref FROM erasure_chunk WHERE request_id=?)",
        params: [scope.userId, scope.reference],
      },
    ],
  },
  {
    id: "hosted_whatsapp_delivery_events",
    dataClass: "conversation",
    dependencies: [],
    quiescence: { _tag: "Synchronous" },
    select: (userId) => ({
      sql: "SELECT CAST(r.rowid AS TEXT) AS rowRef,json_object('provider_message_id',r.\"provider_message_id\",'status',r.\"status\",'occurred_at_ms',r.\"occurred_at_ms\",'received_at_ms',r.\"received_at_ms\") AS body FROM hosted_whatsapp_delivery_events r WHERE EXISTS(SELECT 1 FROM hosted_whatsapp_delivery p WHERE p.correlation_token=r.correlation_token AND p.user_id=?)",
      params: [userId],
    }),
    candidates: (userId) => ({
      sql: "SELECT CAST(r.rowid AS TEXT) AS rowRef FROM hosted_whatsapp_delivery_events r WHERE EXISTS(SELECT 1 FROM hosted_whatsapp_delivery p WHERE p.correlation_token=r.correlation_token AND p.user_id=?)",
      params: [userId],
    }),
    remaining: (userId) => ({
      sql: "SELECT 1 FROM hosted_whatsapp_delivery_events r WHERE EXISTS(SELECT 1 FROM hosted_whatsapp_delivery p WHERE p.correlation_token=r.correlation_token AND p.user_id=?)",
      params: [userId],
    }),
    remove: (scope) => [
      {
        sql: "DELETE FROM hosted_whatsapp_delivery_events AS r WHERE EXISTS(SELECT 1 FROM hosted_whatsapp_delivery p WHERE p.correlation_token=r.correlation_token AND p.user_id=?) AND CAST(r.rowid AS TEXT) IN(SELECT row_ref FROM erasure_chunk WHERE request_id=?)",
        params: [scope.userId, scope.reference],
      },
    ],
  },
  {
    id: "hosted_whatsapp_inbound",
    dataClass: "conversation",
    dependencies: ["hosted_whatsapp_delivery", "hosted_whatsapp_outbox"],
    quiescence: { _tag: "Synchronous" },
    select: (userId) => ({
      sql: "SELECT CAST(r.rowid AS TEXT) AS rowRef,json_object('turn_id',r.\"turn_id\",'user_id',r.\"user_id\",'portfolio_id',r.\"portfolio_id\",'bsuid',r.\"bsuid\",'message_id',r.\"message_id\",'business_phone_number_id',r.\"business_phone_number_id\",'occurred_at_ms',r.\"occurred_at_ms\",'received_at_ms',r.\"received_at_ms\",'reply_to_message_id',r.\"reply_to_message_id\",'sandbox_phone',r.\"sandbox_phone\") AS body FROM hosted_whatsapp_inbound r WHERE r.user_id=?",
      params: [userId],
    }),
    candidates: (userId) => ({
      sql: "SELECT CAST(r.rowid AS TEXT) AS rowRef FROM hosted_whatsapp_inbound r WHERE r.user_id=?",
      params: [userId],
    }),
    remaining: (userId) => ({
      sql: "SELECT 1 FROM hosted_whatsapp_inbound r WHERE r.user_id=?",
      params: [userId],
    }),
    remove: (scope) => [
      {
        sql: "DELETE FROM hosted_whatsapp_inbound AS r WHERE r.user_id=? AND CAST(r.rowid AS TEXT) IN(SELECT row_ref FROM erasure_chunk WHERE request_id=?)",
        params: [scope.userId, scope.reference],
      },
    ],
  },
  {
    id: "hosted_whatsapp_outbox",
    dataClass: "conversation",
    dependencies: [],
    quiescence: { _tag: "Synchronous" },
    select: (userId) => ({
      sql: "SELECT CAST(r.rowid AS TEXT) AS rowRef,json_object('turn_id',r.\"turn_id\",'user_id',r.\"user_id\",'offered_at_ms',r.\"offered_at_ms\",'created_at_ms',r.\"created_at_ms\") AS body FROM hosted_whatsapp_outbox r WHERE r.user_id=?",
      params: [userId],
    }),
    candidates: (userId) => ({
      sql: "SELECT CAST(r.rowid AS TEXT) AS rowRef FROM hosted_whatsapp_outbox r WHERE r.user_id=?",
      params: [userId],
    }),
    remaining: (userId) => ({
      sql: "SELECT 1 FROM hosted_whatsapp_outbox r WHERE r.user_id=?",
      params: [userId],
    }),
    remove: (scope) => [
      {
        sql: "DELETE FROM hosted_whatsapp_outbox AS r WHERE r.user_id=? AND CAST(r.rowid AS TEXT) IN(SELECT row_ref FROM erasure_chunk WHERE request_id=?)",
        params: [scope.userId, scope.reference],
      },
    ],
  },
  {
    id: "hosted_whatsapp_windows",
    dataClass: "conversation",
    dependencies: [],
    quiescence: { _tag: "Synchronous" },
    select: (userId) => ({
      sql: "SELECT CAST(r.rowid AS TEXT) AS rowRef,json_object('user_id',r.\"user_id\",'portfolio_id',r.\"portfolio_id\",'bsuid',r.\"bsuid\",'last_verified_inbound_at_ms',r.\"last_verified_inbound_at_ms\",'closes_at_ms',r.\"closes_at_ms\") AS body FROM hosted_whatsapp_windows r WHERE r.user_id=?",
      params: [userId],
    }),
    candidates: (userId) => ({
      sql: "SELECT CAST(r.rowid AS TEXT) AS rowRef FROM hosted_whatsapp_windows r WHERE r.user_id=?",
      params: [userId],
    }),
    remaining: (userId) => ({
      sql: "SELECT 1 FROM hosted_whatsapp_windows r WHERE r.user_id=?",
      params: [userId],
    }),
    remove: (scope) => [
      {
        sql: "DELETE FROM hosted_whatsapp_windows AS r WHERE r.user_id=? AND CAST(r.rowid AS TEXT) IN(SELECT row_ref FROM erasure_chunk WHERE request_id=?)",
        params: [scope.userId, scope.reference],
      },
    ],
  },
  {
    id: "insight_whatsapp_claims",
    dataClass: "conversation",
    dependencies: [],
    quiescence: { _tag: "Synchronous" },
    select: (userId) => ({
      sql: "SELECT CAST(r.rowid AS TEXT) AS rowRef,json_object('user_id',r.\"user_id\",'insight_event_id',r.\"insight_event_id\",'portfolio_id',r.\"portfolio_id\",'bsuid',r.\"bsuid\",'business_phone_number_id',r.\"business_phone_number_id\",'summary_json',r.\"summary_json\",'text',r.\"text\",'scheduled_at_ms',r.\"scheduled_at_ms\",'expires_at_ms',r.\"expires_at_ms\",'time_zone',r.\"time_zone\",'state',r.\"state\",'send_started_at_ms',r.\"send_started_at_ms\",'provider_message_id',r.\"provider_message_id\",'delivered_at_ms',r.\"delivered_at_ms\",'last_received_at_ms',r.\"last_received_at_ms\") AS body FROM insight_whatsapp_claims r WHERE r.user_id=?",
      params: [userId],
    }),
    candidates: (userId) => ({
      sql: "SELECT CAST(r.rowid AS TEXT) AS rowRef FROM insight_whatsapp_claims r WHERE r.user_id=?",
      params: [userId],
    }),
    remaining: (userId) => ({
      sql: "SELECT 1 FROM insight_whatsapp_claims r WHERE r.user_id=?",
      params: [userId],
    }),
    remove: (scope) => [
      {
        sql: "DELETE FROM insight_whatsapp_claims AS r WHERE r.user_id=? AND CAST(r.rowid AS TEXT) IN(SELECT row_ref FROM erasure_chunk WHERE request_id=?)",
        params: [scope.userId, scope.reference],
      },
    ],
  },
  {
    id: "insight_whatsapp_routes",
    dataClass: "conversation",
    dependencies: [],
    quiescence: { _tag: "Synchronous" },
    select: (userId) => ({
      sql: "SELECT CAST(r.rowid AS TEXT) AS rowRef,json_object('user_id',r.\"user_id\",'portfolio_id',r.\"portfolio_id\",'bsuid',r.\"bsuid\",'business_phone_number_id',r.\"business_phone_number_id\",'verified_at_ms',r.\"verified_at_ms\") AS body FROM insight_whatsapp_routes r WHERE r.user_id=?",
      params: [userId],
    }),
    candidates: (userId) => ({
      sql: "SELECT CAST(r.rowid AS TEXT) AS rowRef FROM insight_whatsapp_routes r WHERE r.user_id=?",
      params: [userId],
    }),
    remaining: (userId) => ({
      sql: "SELECT 1 FROM insight_whatsapp_routes r WHERE r.user_id=?",
      params: [userId],
    }),
    remove: (scope) => [
      {
        sql: "DELETE FROM insight_whatsapp_routes AS r WHERE r.user_id=? AND CAST(r.rowid AS TEXT) IN(SELECT row_ref FROM erasure_chunk WHERE request_id=?)",
        params: [scope.userId, scope.reference],
      },
    ],
  },
  {
    id: "proactivity_whatsapp_claims",
    dataClass: "conversation",
    dependencies: [],
    quiescence: { _tag: "Synchronous" },
    select: (userId) => ({
      sql: "SELECT CAST(r.rowid AS TEXT) AS rowRef,json_object('user_id',r.\"user_id\",'delivery_id',r.\"delivery_id\",'role',r.\"role\",'consent_grant_id',r.\"consent_grant_id\",'portfolio_id',r.\"portfolio_id\",'bsuid',r.\"bsuid\",'business_phone_number_id',r.\"business_phone_number_id\",'template_json',r.\"template_json\",'text',r.\"text\",'scheduled_at_ms',r.\"scheduled_at_ms\",'expires_at_ms',r.\"expires_at_ms\",'time_zone',r.\"time_zone\",'state',r.\"state\",'send_started_at_ms',r.\"send_started_at_ms\",'provider_message_id',r.\"provider_message_id\",'delivered_at_ms',r.\"delivered_at_ms\") AS body FROM proactivity_whatsapp_claims r WHERE r.user_id=?",
      params: [userId],
    }),
    candidates: (userId) => ({
      sql: "SELECT CAST(r.rowid AS TEXT) AS rowRef FROM proactivity_whatsapp_claims r WHERE r.user_id=?",
      params: [userId],
    }),
    remaining: (userId) => ({
      sql: "SELECT 1 FROM proactivity_whatsapp_claims r WHERE r.user_id=?",
      params: [userId],
    }),
    remove: (scope) => [
      {
        sql: "DELETE FROM proactivity_whatsapp_claims AS r WHERE r.user_id=? AND CAST(r.rowid AS TEXT) IN(SELECT row_ref FROM erasure_chunk WHERE request_id=?)",
        params: [scope.userId, scope.reference],
      },
    ],
  },
  {
    id: "weekly_governor_questions",
    dataClass: "conversation",
    dependencies: [],
    quiescence: { _tag: "Synchronous" },
    select: (userId) => ({
      sql: "SELECT CAST(r.rowid AS TEXT) AS rowRef,json_object('id',r.\"id\",'user_id',r.\"user_id\",'offer_id',r.\"offer_id\",'grant_id',r.\"grant_id\",'created_at_ms',r.\"created_at_ms\",'expires_at_ms',r.\"expires_at_ms\",'state',r.\"state\",'portfolio_id',r.\"portfolio_id\",'bsuid',r.\"bsuid\",'business_phone_number_id',r.\"business_phone_number_id\",'text',r.\"text\",'offer_json',r.\"offer_json\",'time_zone',r.\"time_zone\",'send_started_at_ms',r.\"send_started_at_ms\",'provider_message_id',r.\"provider_message_id\",'delivered_at_ms',r.\"delivered_at_ms\",'last_attempt_at_ms',r.\"last_attempt_at_ms\") AS body FROM weekly_governor_questions r WHERE r.user_id=?",
      params: [userId],
    }),
    candidates: (userId) => ({
      sql: "SELECT CAST(r.rowid AS TEXT) AS rowRef FROM weekly_governor_questions r WHERE r.user_id=?",
      params: [userId],
    }),
    remaining: (userId) => ({
      sql: "SELECT 1 FROM weekly_governor_questions r WHERE r.user_id=?",
      params: [userId],
    }),
    remove: (scope) => [
      {
        sql: "DELETE FROM weekly_governor_questions AS r WHERE r.user_id=? AND CAST(r.rowid AS TEXT) IN(SELECT row_ref FROM erasure_chunk WHERE request_id=?)",
        params: [scope.userId, scope.reference],
      },
    ],
  },
];
