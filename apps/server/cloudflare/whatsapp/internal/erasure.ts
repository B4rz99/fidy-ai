import type { ErasureProjection } from "../../erasure-store/contract";

/** Keep exact logical permits while sharing the delivery storage mechanics. */
const recordProjection = ({
  id,
  kind,

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

  return {
    id,
    dataClass: "conversation",
    dependencies,
    quiescence,

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
        sql: `DELETE FROM ${table} AS r WHERE ${owned} AND CAST(r.rowid AS TEXT) IN(SELECT value AS row_ref FROM json_each(?))`,
        params: [scope.userId, scope.rowRefsJson],
      },
    ],
  };
};

export const projections: ReadonlyArray<ErasureProjection> = [
  recordProjection({
    id: "hosted_voice_refusals",
    kind: "voice-refusal",

    dependencies: [],
    quiescence: { _tag: "Synchronous" },
  }),
  recordProjection({
    id: "hosted_whatsapp_delivery",
    kind: "hosted",

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

    dependencies: [],
    quiescence: { _tag: "Synchronous" },
  }),
  {
    id: "hosted_whatsapp_inbound",
    dataClass: "conversation",
    dependencies: ["hosted_whatsapp_delivery"],
    quiescence: { _tag: "Synchronous" },

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
        sql: "UPDATE hosted_turns SET inbound_portfolio_id=NULL,inbound_bsuid=NULL,inbound_message_id=NULL,inbound_business_phone_number_id=NULL,inbound_occurred_at_ms=NULL,inbound_received_at_ms=NULL,inbound_reply_to_message_id=NULL,inbound_sandbox_phone=NULL,dispatch_offered_at_ms=NULL,dispatch_created_at_ms=NULL WHERE user_id=? AND CAST(rowid AS TEXT) IN(SELECT value AS row_ref FROM json_each(?))",
        params: [scope.userId, scope.rowRefsJson],
      },
    ],
  },
  {
    id: "hosted_whatsapp_windows",
    dataClass: "conversation",
    dependencies: [],
    quiescence: { _tag: "Synchronous" },

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
        sql: "DELETE FROM whatsapp_service_windows AS r WHERE r.user_id=? AND CAST(r.rowid AS TEXT) IN(SELECT value AS row_ref FROM json_each(?))",
        params: [scope.userId, scope.rowRefsJson],
      },
    ],
  },
  recordProjection({
    id: "insight_whatsapp_claims",
    kind: "insight",
    dependencies: [],
    quiescence: { _tag: "Synchronous" },
  }),
  {
    id: "insight_whatsapp_routes",
    dataClass: "conversation",
    dependencies: [],
    quiescence: { _tag: "Synchronous" },

    candidates: (userId) => ({
      sql: "SELECT CAST(r.rowid AS TEXT) AS rowRef FROM whatsapp_recipients r WHERE r.user_id=?",
      params: [userId],
    }),
    remaining: (userId) => ({
      sql: "SELECT 1 FROM whatsapp_recipients r WHERE r.user_id=?",
      params: [userId],
    }),
    remove: (scope) => [
      {
        sql: "DELETE FROM whatsapp_recipients AS r WHERE r.user_id=? AND CAST(r.rowid AS TEXT) IN(SELECT value AS row_ref FROM json_each(?))",
        params: [scope.userId, scope.rowRefsJson],
      },
    ],
  },
  recordProjection({
    id: "proactivity_whatsapp_claims",
    kind: "proactivity",
    dependencies: [],
    quiescence: { _tag: "Synchronous" },
  }),
  recordProjection({
    id: "weekly_governor_questions",
    kind: "weekly-question",
    dependencies: [],
    quiescence: { _tag: "Synchronous" },
  }),
];
