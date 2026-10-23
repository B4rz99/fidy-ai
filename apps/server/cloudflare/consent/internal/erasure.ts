import type { ErasureProjection } from "../../erasure-store/contract";

/** Preserve original archive keys and exact evidence while live history uses its normalized envelope. */
const archiveValue = (field: string): string => {
  switch (field) {
    case "accepted_at_ms":
      return "r.occurred_at_ms";
    case "disclosure_revision":
      return "json_extract(r.disclosure_json,'$.revision')";
    case "disclosure_text":
      return "json_extract(r.disclosure_json,'$.text')";
    case "policy_reason":
      return "r.reason";
    default:
      return `r."${field}"`;
  }
};

/** A logical Consent purpose keeps its dependency order and exact erasure permit in the shared store. */
const historyProjection = ({
  id,
  recordType,
  dependencies,
  archiveFields,
  hasChildren,
}: Readonly<{
  id: string;
  recordType: string;
  dependencies: ReadonlyArray<string>;
  archiveFields: ReadonlyArray<string>;
  hasChildren: boolean;
}>): ErasureProjection => {
  const scope = "r.user_id=? AND r.record_type='" + recordType + "'";
  const body =
    archiveFields.length === 0
      ? "'{}'"
      : "json_object(" +
        archiveFields.map((field) => `'${field}',${archiveValue(field)}`).join(",") +
        ")";
  return {
    id,
    dataClass: "consent",
    dependencies,
    quiescence: { _tag: "Synchronous" },
    select: (userId) => ({
      sql: `SELECT CAST(r.sequence AS TEXT) AS rowRef,${body} AS body FROM consent_history r WHERE ${scope}`,
      params: [userId],
    }),
    candidates: (userId) => ({
      sql: `SELECT CAST(r.sequence AS TEXT) AS rowRef FROM consent_history r WHERE ${scope}${hasChildren ? " AND NOT EXISTS(SELECT 1 FROM consent_history child WHERE child.record_type=r.record_type AND child.grant_id=r.id AND child.user_id=r.user_id AND child.sequence<>r.sequence)" : ""}`,
      params: [userId],
    }),
    remaining: (userId) => ({
      sql: `SELECT 1 FROM consent_history r WHERE ${scope}`,
      params: [userId],
    }),
    remove: (subject) => [
      {
        sql: `DELETE FROM consent_history AS r WHERE ${scope} AND CAST(r.sequence AS TEXT) IN(SELECT row_ref FROM erasure_chunk WHERE request_id=?)`,
        params: [subject.userId, subject.reference],
      },
    ],
  };
};

export const projections: ReadonlyArray<ErasureProjection> = [
  historyProjection({
    hasChildren: false,
    id: "processing_consent_withdrawal_records",
    recordType: "processing_withdrawal",
    dependencies: ["processing_consent_renewals"],
    archiveFields: ["id", "user_id", "grant_record_id", "session_id", "occurred_at_ms"],
  }),
  historyProjection({
    hasChildren: false,
    id: "processing_consent_renewals",
    recordType: "processing_renewal",
    dependencies: [],
    archiveFields: [
      "id",
      "user_id",
      "withdrawal_id",
      "grant_record_id",
      "session_id",
      "disclosure_json",
      "accepted_at_ms",
    ],
  }),
  historyProjection({
    hasChildren: false,
    id: "oauth_grant_consents",
    recordType: "oauth_grant",
    dependencies: [],
    archiveFields: [
      "id",
      "connection_id",
      "user_id",
      "session_id",
      "disclosure_revision",
      "disclosure_text",
      "accepted_at_ms",
    ],
  }),
  historyProjection({
    hasChildren: false,
    id: "oauth_revocation_consents",
    recordType: "oauth_replay_revocation",
    dependencies: [],
    archiveFields: ["id", "user_id", "connection_id", "reason", "occurred_at_ms"],
  }),
  historyProjection({
    hasChildren: false,
    id: "oauth_user_revocation_consents",
    recordType: "oauth_user_revocation",
    dependencies: [],
    archiveFields: [
      "connection_id",
      "user_id",
      "session_id",
      "reason",
      "disclosure_revision",
      "disclosure_text",
      "occurred_at_ms",
    ],
  }),
  historyProjection({
    hasChildren: false,
    id: "onboarding_consent_records",
    recordType: "processing_grant",
    dependencies: ["processing_consent_withdrawal_records", "processing_consent_renewals"],
    archiveFields: [
      "id",
      "user_id",
      "disclosure_json",
      "disclosure_message_id",
      "decision_message_id",
      "decision_received_at_ms",
      "accepted_at_ms",
    ],
  }),
  historyProjection({
    hasChildren: false,
    id: "pat_grant_consents",
    recordType: "pat_grant",
    dependencies: ["pat_revocation_consents"],
    archiveFields: [
      "id",
      "user_id",
      "session_id",
      "pairing_id",
      "request_id",
      "disclosure_revision",
      "disclosure_text",
      "accepted_at_ms",
    ],
  }),
  historyProjection({
    hasChildren: false,
    id: "pat_revocation_consents",
    recordType: "pat_revocation",
    dependencies: [],
    archiveFields: [
      "id",
      "grant_consent_id",
      "user_id",
      "pat_id",
      "pairing_id",
      "session_id",
      "policy_reason",
      "disclosure_revision",
      "disclosure_text",
      "occurred_at_ms",
    ],
  }),
  historyProjection({
    id: "proactivity_consent_records",
    recordType: "proactivity_grant",
    dependencies: [
      "insight_events",
      "insight_reports",
      "recurring_digest_instructions",
      "schedules",
    ],
    archiveFields: [
      "id",
      "user_id",
      "kind",
      "grant_id",
      "offer_id",
      "decision_message_id",
      "record_json",
      "occurred_at_ms",
    ],
    hasChildren: true,
  }),
  historyProjection({
    id: "weekly_consent_records",
    recordType: "weekly_grant",
    dependencies: ["weekly_consent_revocation_records", "insight_reports"],
    archiveFields: ["id", "user_id", "grant_id", "offer_id", "record_json", "occurred_at_ms"],
    hasChildren: true,
  }),
  historyProjection({
    hasChildren: false,
    id: "weekly_consent_rejections",
    recordType: "weekly_rejection",
    dependencies: [],
    archiveFields: ["sequence", "id", "user_id", "offer_id", "decision_message_id", "decision"],
  }),
  historyProjection({
    hasChildren: false,
    id: "weekly_consent_revocation_records",
    recordType: "weekly_revocation",
    dependencies: [],
    archiveFields: [
      "id",
      "user_id",
      "grant_id",
      "offer_id",
      "decision_message_id",
      "decision",
      "record_json",
      "occurred_at_ms",
    ],
  }),

  {
    id: "pending_consent_exchanges",
    dataClass: "consent",
    dependencies: ["whatsapp_provider_handoffs"],
    quiescence: { _tag: "Synchronous" },
    select: (userId) => ({
      sql: "SELECT CAST(r.rowid AS TEXT) AS rowRef,json_object('id',r.\"id\",'portfolio_id',r.\"portfolio_id\",'bsuid',r.\"bsuid\",'phone_number_id',r.\"phone_number_id\",'initiating_message_id',r.\"initiating_message_id\",'initiating_body_sha256',r.\"initiating_body_sha256\",'disclosure_json',r.\"disclosure_json\",'disclosure_message_id',r.\"disclosure_message_id\",'created_at_ms',r.\"created_at_ms\",'disclosed_at_ms',r.\"disclosed_at_ms\",'decision_not_before_ms',r.\"decision_not_before_ms\",'expires_at_ms',r.\"expires_at_ms\",'state',r.\"state\",'rejected_at_ms',r.\"rejected_at_ms\",'sandbox_phone',r.\"sandbox_phone\",'delivery_phone_number_id',r.delivery_phone_number_id,'delivery_message_id',r.delivery_message_id,'delivery_occurred_at_ms',r.delivery_occurred_at_ms,'delivery_received_at_ms',r.delivery_received_at_ms,'delivery_not_before_ms',r.delivery_not_before_ms,'decision_portfolio_id',CASE WHEN r.decision_value IS NOT NULL THEN r.portfolio_id END,'decision_bsuid',CASE WHEN r.decision_value IS NOT NULL THEN r.bsuid END,'decision_phone_number_id',CASE WHEN r.decision_value IS NOT NULL THEN r.phone_number_id END,'decision_value',r.decision_value,'decision_disclosure_json',CASE WHEN r.decision_value IS NOT NULL THEN r.disclosure_json END,'decision_disclosure_message_id',CASE WHEN r.decision_value IS NOT NULL THEN r.disclosure_message_id END,'decision_message_id',r.decision_message_id,'decision_delivery_key',r.decision_delivery_key,'decision_body_sha256',r.decision_body_sha256,'decision_occurred_at_ms',r.decision_occurred_at_ms,'decision_received_at_ms',r.decision_received_at_ms) AS body FROM pending_consent_exchanges r WHERE EXISTS(SELECT 1 FROM (SELECT rowid,id AS user_id,whatsapp_portfolio_id AS portfolio_id,whatsapp_bsuid AS bsuid,whatsapp_verified_at_ms AS verified_at_ms FROM users WHERE whatsapp_portfolio_id IS NOT NULL) w WHERE w.user_id=? AND w.portfolio_id=r.portfolio_id AND w.bsuid=r.bsuid)",
      params: [userId],
    }),
    candidates: (userId) => ({
      sql: "SELECT CAST(r.rowid AS TEXT) AS rowRef FROM pending_consent_exchanges r WHERE EXISTS(SELECT 1 FROM (SELECT rowid,id AS user_id,whatsapp_portfolio_id AS portfolio_id,whatsapp_bsuid AS bsuid,whatsapp_verified_at_ms AS verified_at_ms FROM users WHERE whatsapp_portfolio_id IS NOT NULL) w WHERE w.user_id=? AND w.portfolio_id=r.portfolio_id AND w.bsuid=r.bsuid)",
      params: [userId],
    }),
    remaining: (userId) => ({
      sql: "SELECT 1 FROM pending_consent_exchanges r WHERE EXISTS(SELECT 1 FROM (SELECT rowid,id AS user_id,whatsapp_portfolio_id AS portfolio_id,whatsapp_bsuid AS bsuid,whatsapp_verified_at_ms AS verified_at_ms FROM users WHERE whatsapp_portfolio_id IS NOT NULL) w WHERE w.user_id=? AND w.portfolio_id=r.portfolio_id AND w.bsuid=r.bsuid)",
      params: [userId],
    }),
    remove: (scope) => [
      {
        sql: "DELETE FROM pending_consent_exchanges AS r WHERE EXISTS(SELECT 1 FROM (SELECT rowid,id AS user_id,whatsapp_portfolio_id AS portfolio_id,whatsapp_bsuid AS bsuid,whatsapp_verified_at_ms AS verified_at_ms FROM users WHERE whatsapp_portfolio_id IS NOT NULL) w WHERE w.user_id=? AND w.portfolio_id=r.portfolio_id AND w.bsuid=r.bsuid) AND CAST(r.rowid AS TEXT) IN(SELECT row_ref FROM erasure_chunk WHERE request_id=?)",
        params: [scope.userId, scope.reference],
      },
    ],
  },
  {
    id: "proactivity_consent_offers",
    dataClass: "consent",
    dependencies: ["proactivity_consent_records"],
    quiescence: { _tag: "Synchronous" },
    select: (userId) => ({
      sql: "SELECT CAST(r.rowid AS TEXT) AS rowRef,json_object('id',r.\"id\",'user_id',r.\"user_id\",'kind',r.\"kind\",'portfolio_id',r.\"portfolio_id\",'bsuid',r.\"bsuid\",'disclosure_json',r.\"disclosure_json\",'created_at_ms',r.\"created_at_ms\",'expires_at_ms',r.\"expires_at_ms\",'disclosure_message_id',r.\"disclosure_message_id\",'decision_message_id',r.\"decision_message_id\",'decision',r.\"decision\",'replaces_offer_id',r.\"replaces_offer_id\") AS body FROM consent_offers AS r WHERE r.kind<>'weekly-summary' AND r.user_id=?",
      params: [userId],
    }),
    candidates: (userId) => ({
      sql: "SELECT CAST(r.rowid AS TEXT) AS rowRef FROM consent_offers AS r WHERE r.kind<>'weekly-summary' AND r.user_id=?",
      params: [userId],
    }),
    remaining: (userId) => ({
      sql: "SELECT 1 FROM consent_offers AS r WHERE r.kind<>'weekly-summary' AND r.user_id=?",
      params: [userId],
    }),
    remove: (scope) => [
      {
        sql: "DELETE FROM consent_offers AS r WHERE kind<>'weekly-summary' AND r.user_id=? AND CAST(r.rowid AS TEXT) IN(SELECT row_ref FROM erasure_chunk WHERE request_id=?)",
        params: [scope.userId, scope.reference],
      },
    ],
  },
  {
    id: "weekly_consent_offers",
    dataClass: "consent",
    dependencies: [
      "weekly_consent_records",
      "weekly_consent_rejections",
      "weekly_consent_revocation_records",
      "weekly_governor_questions",
    ],
    quiescence: { _tag: "Synchronous" },
    select: (userId) => ({
      sql: "SELECT CAST(r.rowid AS TEXT) AS rowRef,json_object('id',r.\"id\",'user_id',r.\"user_id\",'portfolio_id',r.\"portfolio_id\",'bsuid',r.\"bsuid\",'disclosure_json',r.\"disclosure_json\",'created_at_ms',r.\"created_at_ms\",'expires_at_ms',r.\"expires_at_ms\",'disclosure_message_id',r.\"disclosure_message_id\",'disclosed_at_ms',r.\"disclosed_at_ms\",'decision_message_id',r.\"decision_message_id\",'decision',r.\"decision\",'source_id',r.\"source_id\",'rejection_id',r.\"rejection_id\") AS body FROM consent_offers AS r WHERE r.kind='weekly-summary' AND r.user_id=?",
      params: [userId],
    }),
    candidates: (userId) => ({
      sql: "SELECT CAST(r.rowid AS TEXT) AS rowRef FROM consent_offers AS r WHERE r.kind='weekly-summary' AND r.user_id=?",
      params: [userId],
    }),
    remaining: (userId) => ({
      sql: "SELECT 1 FROM consent_offers AS r WHERE r.kind='weekly-summary' AND r.user_id=?",
      params: [userId],
    }),
    remove: (scope) => [
      {
        sql: "DELETE FROM consent_offers AS r WHERE kind='weekly-summary' AND r.user_id=? AND CAST(r.rowid AS TEXT) IN(SELECT row_ref FROM erasure_chunk WHERE request_id=?)",
        params: [scope.userId, scope.reference],
      },
    ],
  },
];
