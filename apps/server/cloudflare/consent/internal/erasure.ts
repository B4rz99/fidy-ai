import type { ErasureProjection } from "../../erasure-store/contract";

/** A logical Consent purpose keeps its dependency order and exact erasure permit in the shared store. */
const historyProjection = ({
  id,
  recordType,
  dependencies,

  hasChildren,
}: Readonly<{
  id: string;
  recordType: string;
  dependencies: ReadonlyArray<string>;

  hasChildren: boolean;
}>): ErasureProjection => {
  const scope = "r.user_id=? AND r.record_type='" + recordType + "'";

  return {
    id,
    dataClass: "consent",
    dependencies,
    quiescence: { _tag: "Synchronous" },

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
        sql: `DELETE FROM consent_history AS r WHERE ${scope} AND CAST(r.sequence AS TEXT) IN(SELECT value AS row_ref FROM json_each(?))`,
        params: [subject.userId, subject.rowRefsJson],
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
  }),
  historyProjection({
    hasChildren: false,
    id: "processing_consent_renewals",
    recordType: "processing_renewal",
    dependencies: [],
  }),
  historyProjection({
    hasChildren: false,
    id: "oauth_grant_consents",
    recordType: "oauth_grant",
    dependencies: [],
  }),
  historyProjection({
    hasChildren: false,
    id: "oauth_revocation_consents",
    recordType: "oauth_replay_revocation",
    dependencies: [],
  }),
  historyProjection({
    hasChildren: false,
    id: "oauth_user_revocation_consents",
    recordType: "oauth_user_revocation",
    dependencies: [],
  }),
  historyProjection({
    hasChildren: false,
    id: "onboarding_consent_records",
    recordType: "processing_grant",
    dependencies: ["processing_consent_withdrawal_records", "processing_consent_renewals"],
  }),
  historyProjection({
    hasChildren: false,
    id: "pat_grant_consents",
    recordType: "pat_grant",
    dependencies: ["pat_revocation_consents"],
  }),
  historyProjection({
    hasChildren: false,
    id: "pat_revocation_consents",
    recordType: "pat_revocation",
    dependencies: [],
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

    hasChildren: true,
  }),
  historyProjection({
    id: "weekly_consent_records",
    recordType: "weekly_grant",
    dependencies: ["weekly_consent_revocation_records", "insight_reports"],

    hasChildren: true,
  }),
  historyProjection({
    hasChildren: false,
    id: "weekly_consent_rejections",
    recordType: "weekly_rejection",
    dependencies: [],
  }),
  historyProjection({
    hasChildren: false,
    id: "weekly_consent_revocation_records",
    recordType: "weekly_revocation",
    dependencies: [],
  }),

  {
    id: "pending_consent_exchanges",
    dataClass: "consent",
    dependencies: ["whatsapp_provider_handoffs"],
    quiescence: { _tag: "Synchronous" },

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
        sql: "DELETE FROM pending_consent_exchanges AS r WHERE EXISTS(SELECT 1 FROM (SELECT rowid,id AS user_id,whatsapp_portfolio_id AS portfolio_id,whatsapp_bsuid AS bsuid,whatsapp_verified_at_ms AS verified_at_ms FROM users WHERE whatsapp_portfolio_id IS NOT NULL) w WHERE w.user_id=? AND w.portfolio_id=r.portfolio_id AND w.bsuid=r.bsuid) AND CAST(r.rowid AS TEXT) IN(SELECT value AS row_ref FROM json_each(?))",
        params: [scope.userId, scope.rowRefsJson],
      },
    ],
  },
  {
    id: "proactivity_consent_offers",
    dataClass: "consent",
    dependencies: ["proactivity_consent_records"],
    quiescence: { _tag: "Synchronous" },

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
        sql: "DELETE FROM consent_offers AS r WHERE kind<>'weekly-summary' AND r.user_id=? AND CAST(r.rowid AS TEXT) IN(SELECT value AS row_ref FROM json_each(?))",
        params: [scope.userId, scope.rowRefsJson],
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
        sql: "DELETE FROM consent_offers AS r WHERE kind='weekly-summary' AND r.user_id=? AND CAST(r.rowid AS TEXT) IN(SELECT value AS row_ref FROM json_each(?))",
        params: [scope.userId, scope.rowRefsJson],
      },
    ],
  },
];
