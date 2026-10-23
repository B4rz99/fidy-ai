import type { ErasureProjection } from "../../erasure-store/contract";

/** Keep exact logical permits and archive fields while sharing the delivery storage mechanics. */
const recordProjection = ({
  id,
  kind,
  fields,
  dependencies,
  quiescence,
}: Readonly<{
  id: string;
  kind:
    | "hosted"
    | "insight"
    | "proactivity"
    | "weekly-question"
    | "voice-refusal"
    | "delivery-status";
  fields: ReadonlyArray<string>;
  dependencies: ReadonlyArray<string>;
  quiescence: ErasureProjection["quiescence"];
}>): ErasureProjection => {
  const table =
    kind === "voice-refusal" || kind === "delivery-status"
      ? "whatsapp_event_records"
      : "whatsapp_deliveries";
  const subject =
    kind === "delivery-status"
      ? "EXISTS(SELECT 1 FROM whatsapp_deliveries p WHERE p.kind='hosted' AND p.hosted_correlation_token=r.correlation_token AND p.user_id=?)"
      : "r.user_id=?";
  const owned = `r.kind='${kind}' AND ${subject}`;
  const body = "json_object(" + fields.map((field) => `'${field}',r."${field}"`).join(",") + ")";
  return {
    id,
    dataClass: "conversation",
    dependencies,
    quiescence,
    select: (userId) => ({
      sql: `SELECT CAST(r.rowid AS TEXT) AS rowRef,${body} AS body FROM ${table} r WHERE ${owned}`,
      params: [userId],
    }),
    candidates: (userId) => ({
      sql: `SELECT CAST(r.rowid AS TEXT) AS rowRef FROM ${table} r WHERE ${owned}`,
      params: [userId],
    }),
    remaining: (userId) => ({
      sql: `SELECT 1 FROM ${table} r WHERE ${owned}`,
      params: [userId],
    }),
    remove: (scope) => [
      {
        sql: `DELETE FROM ${table} AS r WHERE ${owned} AND CAST(r.rowid AS TEXT) IN(SELECT row_ref FROM erasure_chunk WHERE request_id=?)`,
        params: [scope.userId, scope.reference],
      },
    ],
  };
};

export const projections: ReadonlyArray<ErasureProjection> = [
  recordProjection({
    id: "hosted_voice_refusals",
    kind: "voice-refusal",
    fields: ["portfolio_id", "message_id", "user_id", "claimed_at_ms", "outcome"],
    dependencies: [],
    quiescence: { _tag: "Synchronous" },
  }),
  recordProjection({
    id: "hosted_whatsapp_delivery",
    kind: "hosted",
    fields: [
      "turn_id",
      "user_id",
      "text",
      "business_phone_number_id",
      "proposed_at_ms",
      "state",
      "provider_message_id",
      "delivered_at_ms",
      "send_started_at_ms",
    ],
    dependencies: ["hosted_whatsapp_delivery_events"],
    quiescence: {
      _tag: "Durable",
      select: ({ userId }) => ({
        sql: "SELECT 1 FROM whatsapp_deliveries WHERE kind='hosted' AND user_id=? AND state='sending'",
        params: [userId],
      }),
    },
  }),
  recordProjection({
    id: "hosted_whatsapp_delivery_events",
    kind: "delivery-status",
    fields: ["provider_message_id", "status", "occurred_at_ms", "received_at_ms"],
    dependencies: [],
    quiescence: { _tag: "Synchronous" },
  }),
  {
    id: "hosted_whatsapp_inbound",
    dataClass: "conversation",
    dependencies: ["hosted_whatsapp_delivery"],
    quiescence: { _tag: "Synchronous" },
    select: (userId) => ({
      sql: "SELECT CAST(r.rowid AS TEXT) AS rowRef,json_object('turn_id',r.\"turn_id\",'user_id',r.\"user_id\",'portfolio_id',r.\"portfolio_id\",'bsuid',r.\"bsuid\",'message_id',r.\"message_id\",'business_phone_number_id',r.\"business_phone_number_id\",'occurred_at_ms',r.\"occurred_at_ms\",'received_at_ms',r.\"received_at_ms\",'reply_to_message_id',r.\"reply_to_message_id\",'sandbox_phone',r.\"sandbox_phone\",'dispatch_user_id',CASE WHEN r.dispatch_created_at_ms IS NOT NULL THEN r.user_id END,'dispatch_offered_at_ms',r.dispatch_offered_at_ms,'dispatch_created_at_ms',r.dispatch_created_at_ms) AS body FROM (SELECT rowid,id AS turn_id,user_id,inbound_portfolio_id AS portfolio_id,inbound_bsuid AS bsuid,inbound_message_id AS message_id,inbound_business_phone_number_id AS business_phone_number_id,inbound_occurred_at_ms AS occurred_at_ms,inbound_received_at_ms AS received_at_ms,inbound_reply_to_message_id AS reply_to_message_id,inbound_sandbox_phone AS sandbox_phone,dispatch_offered_at_ms,dispatch_created_at_ms FROM hosted_turns WHERE inbound_message_id IS NOT NULL) r WHERE r.user_id=?",
      params: [userId],
    }),
    candidates: (userId) => ({
      sql: "SELECT CAST(r.rowid AS TEXT) AS rowRef FROM (SELECT rowid,id AS turn_id,user_id,inbound_portfolio_id AS portfolio_id,inbound_bsuid AS bsuid,inbound_message_id AS message_id,inbound_business_phone_number_id AS business_phone_number_id,inbound_occurred_at_ms AS occurred_at_ms,inbound_received_at_ms AS received_at_ms,inbound_reply_to_message_id AS reply_to_message_id,inbound_sandbox_phone AS sandbox_phone,dispatch_offered_at_ms,dispatch_created_at_ms FROM hosted_turns WHERE inbound_message_id IS NOT NULL) r WHERE r.user_id=?",
      params: [userId],
    }),
    remaining: (userId) => ({
      sql: "SELECT 1 FROM (SELECT rowid,id AS turn_id,user_id,inbound_portfolio_id AS portfolio_id,inbound_bsuid AS bsuid,inbound_message_id AS message_id,inbound_business_phone_number_id AS business_phone_number_id,inbound_occurred_at_ms AS occurred_at_ms,inbound_received_at_ms AS received_at_ms,inbound_reply_to_message_id AS reply_to_message_id,inbound_sandbox_phone AS sandbox_phone,dispatch_offered_at_ms,dispatch_created_at_ms FROM hosted_turns WHERE inbound_message_id IS NOT NULL) r WHERE r.user_id=?",
      params: [userId],
    }),
    remove: (scope) => [
      {
        sql: "UPDATE hosted_turns SET inbound_portfolio_id=NULL,inbound_bsuid=NULL,inbound_message_id=NULL,inbound_business_phone_number_id=NULL,inbound_occurred_at_ms=NULL,inbound_received_at_ms=NULL,inbound_reply_to_message_id=NULL,inbound_sandbox_phone=NULL,dispatch_offered_at_ms=NULL,dispatch_created_at_ms=NULL WHERE user_id=? AND CAST(rowid AS TEXT) IN(SELECT row_ref FROM erasure_chunk WHERE request_id=?)",
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
      sql: "SELECT CAST(r.rowid AS TEXT) AS rowRef,json_object('user_id',r.\"user_id\",'portfolio_id',r.\"portfolio_id\",'bsuid',r.\"bsuid\",'last_verified_inbound_at_ms',r.\"last_verified_inbound_at_ms\",'closes_at_ms',r.last_verified_inbound_at_ms+86400000) AS body FROM whatsapp_service_windows r WHERE r.user_id=?",
      params: [userId],
    }),
    candidates: (userId) => ({
      sql: "SELECT CAST(r.rowid AS TEXT) AS rowRef FROM whatsapp_service_windows r WHERE r.user_id=?",
      params: [userId],
    }),
    remaining: (userId) => ({
      sql: "SELECT 1 FROM whatsapp_service_windows r WHERE r.user_id=?",
      params: [userId],
    }),
    remove: (scope) => [
      {
        sql: "DELETE FROM whatsapp_service_windows AS r WHERE r.user_id=? AND CAST(r.rowid AS TEXT) IN(SELECT row_ref FROM erasure_chunk WHERE request_id=?)",
        params: [scope.userId, scope.reference],
      },
    ],
  },
  recordProjection({
    id: "insight_whatsapp_claims",
    kind: "insight",
    dependencies: [],
    quiescence: { _tag: "Synchronous" },
    fields: [
      "user_id",
      "insight_event_id",
      "portfolio_id",
      "bsuid",
      "business_phone_number_id",
      "summary_json",
      "text",
      "scheduled_at_ms",
      "expires_at_ms",
      "time_zone",
      "state",
      "send_started_at_ms",
      "provider_message_id",
      "delivered_at_ms",
      "last_received_at_ms",
    ],
  }),
  {
    id: "insight_whatsapp_routes",
    dataClass: "conversation",
    dependencies: [],
    quiescence: { _tag: "Synchronous" },
    select: (userId) => ({
      sql: "SELECT CAST(r.rowid AS TEXT) AS rowRef,json_object('user_id',r.\"user_id\",'portfolio_id',r.\"portfolio_id\",'bsuid',r.\"bsuid\",'business_phone_number_id',r.\"business_phone_number_id\",'verified_at_ms',r.\"verified_at_ms\") AS body FROM (SELECT rowid,id AS user_id,route_portfolio_id AS portfolio_id,route_bsuid AS bsuid,route_phone_number_id AS business_phone_number_id,route_verified_at_ms AS verified_at_ms FROM users WHERE route_portfolio_id IS NOT NULL) r WHERE r.user_id=?",
      params: [userId],
    }),
    candidates: (userId) => ({
      sql: "SELECT CAST(r.rowid AS TEXT) AS rowRef FROM (SELECT rowid,id AS user_id,route_portfolio_id AS portfolio_id,route_bsuid AS bsuid,route_phone_number_id AS business_phone_number_id,route_verified_at_ms AS verified_at_ms FROM users WHERE route_portfolio_id IS NOT NULL) r WHERE r.user_id=?",
      params: [userId],
    }),
    remaining: (userId) => ({
      sql: "SELECT 1 FROM (SELECT rowid,id AS user_id,route_portfolio_id AS portfolio_id,route_bsuid AS bsuid,route_phone_number_id AS business_phone_number_id,route_verified_at_ms AS verified_at_ms FROM users WHERE route_portfolio_id IS NOT NULL) r WHERE r.user_id=?",
      params: [userId],
    }),
    remove: (scope) => [
      {
        sql: "UPDATE users AS r SET route_portfolio_id=NULL,route_bsuid=NULL,route_phone_number_id=NULL,route_verified_at_ms=NULL WHERE r.id=? AND r.route_portfolio_id IS NOT NULL AND CAST(r.rowid AS TEXT) IN(SELECT row_ref FROM erasure_chunk WHERE request_id=?)",
        params: [scope.userId, scope.reference],
      },
    ],
  },
  recordProjection({
    id: "proactivity_whatsapp_claims",
    kind: "proactivity",
    dependencies: [],
    quiescence: { _tag: "Synchronous" },
    fields: [
      "user_id",
      "delivery_id",
      "role",
      "consent_grant_id",
      "portfolio_id",
      "bsuid",
      "business_phone_number_id",
      "template_json",
      "text",
      "scheduled_at_ms",
      "expires_at_ms",
      "time_zone",
      "state",
      "send_started_at_ms",
      "provider_message_id",
      "delivered_at_ms",
    ],
  }),
  recordProjection({
    id: "weekly_governor_questions",
    kind: "weekly-question",
    dependencies: [],
    quiescence: { _tag: "Synchronous" },
    fields: [
      "id",
      "user_id",
      "offer_id",
      "grant_id",
      "created_at_ms",
      "expires_at_ms",
      "state",
      "portfolio_id",
      "bsuid",
      "business_phone_number_id",
      "text",
      "offer_json",
      "time_zone",
      "send_started_at_ms",
      "provider_message_id",
      "delivered_at_ms",
      "last_attempt_at_ms",
    ],
  }),
];
