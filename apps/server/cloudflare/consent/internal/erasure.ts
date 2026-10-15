import type { ErasureProjection } from "../../erasure-store/contract";

export const projections: ReadonlyArray<ErasureProjection> = [
  {
    id: "consent_user_revocations",
    dataClass: "consent",
    dependencies: [],
    quiescence: { _tag: "Synchronous" },
    select: (userId) => ({
      sql: "SELECT CAST(r.rowid AS TEXT) AS rowRef,json_object('id',r.\"id\",'user_id',r.\"user_id\",'grant_record_id',r.\"grant_record_id\",'session_id',r.\"session_id\",'occurred_at_ms',r.\"occurred_at_ms\") AS body FROM consent_user_revocations r WHERE r.user_id=?",
      params: [userId],
    }),
    candidates: (userId) => ({
      sql: "SELECT CAST(r.rowid AS TEXT) AS rowRef FROM consent_user_revocations r WHERE r.user_id=?",
      params: [userId],
    }),
    remaining: (userId) => ({
      sql: "SELECT 1 FROM consent_user_revocations r WHERE r.user_id=?",
      params: [userId],
    }),
    remove: (scope) => [
      {
        sql: "DELETE FROM consent_user_revocations AS r WHERE r.user_id=? AND CAST(r.rowid AS TEXT) IN(SELECT row_ref FROM erasure_chunk WHERE request_id=?)",
        params: [scope.userId, scope.reference],
      },
    ],
  },
  {
    id: "oauth_grant_consents",
    dataClass: "consent",
    dependencies: [],
    quiescence: { _tag: "Synchronous" },
    select: (userId) => ({
      sql: "SELECT CAST(r.rowid AS TEXT) AS rowRef,json_object('id',r.\"id\",'connection_id',r.\"connection_id\",'user_id',r.\"user_id\",'session_id',r.\"session_id\",'disclosure_revision',r.\"disclosure_revision\",'disclosure_text',r.\"disclosure_text\",'accepted_at_ms',r.\"accepted_at_ms\") AS body FROM oauth_grant_consents r WHERE r.user_id=?",
      params: [userId],
    }),
    candidates: (userId) => ({
      sql: "SELECT CAST(r.rowid AS TEXT) AS rowRef FROM oauth_grant_consents r WHERE r.user_id=?",
      params: [userId],
    }),
    remaining: (userId) => ({
      sql: "SELECT 1 FROM oauth_grant_consents r WHERE r.user_id=?",
      params: [userId],
    }),
    remove: (scope) => [
      {
        sql: "DELETE FROM oauth_grant_consents AS r WHERE r.user_id=? AND CAST(r.rowid AS TEXT) IN(SELECT row_ref FROM erasure_chunk WHERE request_id=?)",
        params: [scope.userId, scope.reference],
      },
    ],
  },
  {
    id: "oauth_revocation_consents",
    dataClass: "consent",
    dependencies: [],
    quiescence: { _tag: "Synchronous" },
    select: (userId) => ({
      sql: "SELECT CAST(r.rowid AS TEXT) AS rowRef,json_object('id',r.\"id\",'user_id',r.\"user_id\",'connection_id',r.\"connection_id\",'reason',r.\"reason\",'occurred_at_ms',r.\"occurred_at_ms\") AS body FROM oauth_revocation_consents r WHERE r.user_id=?",
      params: [userId],
    }),
    candidates: (userId) => ({
      sql: "SELECT CAST(r.rowid AS TEXT) AS rowRef FROM oauth_revocation_consents r WHERE r.user_id=?",
      params: [userId],
    }),
    remaining: (userId) => ({
      sql: "SELECT 1 FROM oauth_revocation_consents r WHERE r.user_id=?",
      params: [userId],
    }),
    remove: (scope) => [
      {
        sql: "DELETE FROM oauth_revocation_consents AS r WHERE r.user_id=? AND CAST(r.rowid AS TEXT) IN(SELECT row_ref FROM erasure_chunk WHERE request_id=?)",
        params: [scope.userId, scope.reference],
      },
    ],
  },
  {
    id: "oauth_user_revocation_consents",
    dataClass: "consent",
    dependencies: [],
    quiescence: { _tag: "Synchronous" },
    select: (userId) => ({
      sql: "SELECT CAST(r.rowid AS TEXT) AS rowRef,json_object('connection_id',r.\"connection_id\",'user_id',r.\"user_id\",'session_id',r.\"session_id\",'reason',r.\"reason\",'disclosure_revision',r.\"disclosure_revision\",'disclosure_text',r.\"disclosure_text\",'occurred_at_ms',r.\"occurred_at_ms\") AS body FROM oauth_user_revocation_consents r WHERE r.user_id=?",
      params: [userId],
    }),
    candidates: (userId) => ({
      sql: "SELECT CAST(r.rowid AS TEXT) AS rowRef FROM oauth_user_revocation_consents r WHERE r.user_id=?",
      params: [userId],
    }),
    remaining: (userId) => ({
      sql: "SELECT 1 FROM oauth_user_revocation_consents r WHERE r.user_id=?",
      params: [userId],
    }),
    remove: (scope) => [
      {
        sql: "DELETE FROM oauth_user_revocation_consents AS r WHERE r.user_id=? AND CAST(r.rowid AS TEXT) IN(SELECT row_ref FROM erasure_chunk WHERE request_id=?)",
        params: [scope.userId, scope.reference],
      },
    ],
  },
  {
    id: "onboarding_consent_records",
    dataClass: "consent",
    dependencies: ["consent_user_revocations"],
    quiescence: { _tag: "Synchronous" },
    select: (userId) => ({
      sql: "SELECT CAST(r.rowid AS TEXT) AS rowRef,json_object('id',r.\"id\",'user_id',r.\"user_id\",'disclosure_json',r.\"disclosure_json\",'disclosure_message_id',r.\"disclosure_message_id\",'decision_message_id',r.\"decision_message_id\",'decision_received_at_ms',r.\"decision_received_at_ms\",'accepted_at_ms',r.\"accepted_at_ms\") AS body FROM onboarding_consent_records r WHERE r.user_id=?",
      params: [userId],
    }),
    candidates: (userId) => ({
      sql: "SELECT CAST(r.rowid AS TEXT) AS rowRef FROM onboarding_consent_records r WHERE r.user_id=?",
      params: [userId],
    }),
    remaining: (userId) => ({
      sql: "SELECT 1 FROM onboarding_consent_records r WHERE r.user_id=?",
      params: [userId],
    }),
    remove: (scope) => [
      {
        sql: "DELETE FROM onboarding_consent_records AS r WHERE r.user_id=? AND CAST(r.rowid AS TEXT) IN(SELECT row_ref FROM erasure_chunk WHERE request_id=?)",
        params: [scope.userId, scope.reference],
      },
    ],
  },
  {
    id: "pat_grant_consents",
    dataClass: "consent",
    dependencies: ["pat_revocation_consents"],
    quiescence: { _tag: "Synchronous" },
    select: (userId) => ({
      sql: "SELECT CAST(r.rowid AS TEXT) AS rowRef,json_object('id',r.\"id\",'user_id',r.\"user_id\",'session_id',r.\"session_id\",'pairing_id',r.\"pairing_id\",'request_id',r.\"request_id\",'disclosure_revision',r.\"disclosure_revision\",'disclosure_text',r.\"disclosure_text\",'accepted_at_ms',r.\"accepted_at_ms\") AS body FROM pat_grant_consents r WHERE r.user_id=?",
      params: [userId],
    }),
    candidates: (userId) => ({
      sql: "SELECT CAST(r.rowid AS TEXT) AS rowRef FROM pat_grant_consents r WHERE r.user_id=?",
      params: [userId],
    }),
    remaining: (userId) => ({
      sql: "SELECT 1 FROM pat_grant_consents r WHERE r.user_id=?",
      params: [userId],
    }),
    remove: (scope) => [
      {
        sql: "DELETE FROM pat_grant_consents AS r WHERE r.user_id=? AND CAST(r.rowid AS TEXT) IN(SELECT row_ref FROM erasure_chunk WHERE request_id=?)",
        params: [scope.userId, scope.reference],
      },
    ],
  },
  {
    id: "pat_revocation_consents",
    dataClass: "consent",
    dependencies: [],
    quiescence: { _tag: "Synchronous" },
    select: (userId) => ({
      sql: "SELECT CAST(r.rowid AS TEXT) AS rowRef,json_object('id',r.\"id\",'grant_consent_id',r.\"grant_consent_id\",'user_id',r.\"user_id\",'pat_id',r.\"pat_id\",'pairing_id',r.\"pairing_id\",'session_id',r.\"session_id\",'policy_reason',r.\"policy_reason\",'disclosure_revision',r.\"disclosure_revision\",'disclosure_text',r.\"disclosure_text\",'occurred_at_ms',r.\"occurred_at_ms\") AS body FROM pat_revocation_consents r WHERE r.user_id=?",
      params: [userId],
    }),
    candidates: (userId) => ({
      sql: "SELECT CAST(r.rowid AS TEXT) AS rowRef FROM pat_revocation_consents r WHERE r.user_id=?",
      params: [userId],
    }),
    remaining: (userId) => ({
      sql: "SELECT 1 FROM pat_revocation_consents r WHERE r.user_id=?",
      params: [userId],
    }),
    remove: (scope) => [
      {
        sql: "DELETE FROM pat_revocation_consents AS r WHERE r.user_id=? AND CAST(r.rowid AS TEXT) IN(SELECT row_ref FROM erasure_chunk WHERE request_id=?)",
        params: [scope.userId, scope.reference],
      },
    ],
  },
  {
    id: "pending_consent_decisions",
    dataClass: "consent",
    dependencies: [],
    quiescence: { _tag: "Synchronous" },
    select: (userId) => ({
      sql: "SELECT CAST(r.rowid AS TEXT) AS rowRef,json_object('exchange_id',r.\"exchange_id\",'portfolio_id',r.\"portfolio_id\",'bsuid',r.\"bsuid\",'phone_number_id',r.\"phone_number_id\",'decision',r.\"decision\",'disclosure_json',r.\"disclosure_json\",'disclosure_message_id',r.\"disclosure_message_id\",'decision_message_id',r.\"decision_message_id\",'delivery_key',r.\"delivery_key\",'body_sha256',r.\"body_sha256\",'occurred_at_ms',r.\"occurred_at_ms\",'received_at_ms',r.\"received_at_ms\") AS body FROM pending_consent_decisions r WHERE EXISTS(SELECT 1 FROM pending_consent_exchanges p WHERE p.id=r.exchange_id AND EXISTS(SELECT 1 FROM whatsapp_identities w WHERE w.user_id=? AND w.portfolio_id=p.portfolio_id AND w.bsuid=p.bsuid))",
      params: [userId],
    }),
    candidates: (userId) => ({
      sql: "SELECT CAST(r.rowid AS TEXT) AS rowRef FROM pending_consent_decisions r WHERE EXISTS(SELECT 1 FROM pending_consent_exchanges p WHERE p.id=r.exchange_id AND EXISTS(SELECT 1 FROM whatsapp_identities w WHERE w.user_id=? AND w.portfolio_id=p.portfolio_id AND w.bsuid=p.bsuid))",
      params: [userId],
    }),
    remaining: (userId) => ({
      sql: "SELECT 1 FROM pending_consent_decisions r WHERE EXISTS(SELECT 1 FROM pending_consent_exchanges p WHERE p.id=r.exchange_id AND EXISTS(SELECT 1 FROM whatsapp_identities w WHERE w.user_id=? AND w.portfolio_id=p.portfolio_id AND w.bsuid=p.bsuid))",
      params: [userId],
    }),
    remove: (scope) => [
      {
        sql: "DELETE FROM pending_consent_decisions AS r WHERE EXISTS(SELECT 1 FROM pending_consent_exchanges p WHERE p.id=r.exchange_id AND EXISTS(SELECT 1 FROM whatsapp_identities w WHERE w.user_id=? AND w.portfolio_id=p.portfolio_id AND w.bsuid=p.bsuid)) AND CAST(r.rowid AS TEXT) IN(SELECT row_ref FROM erasure_chunk WHERE request_id=?)",
        params: [scope.userId, scope.reference],
      },
    ],
  },
  {
    id: "pending_consent_delivery",
    dataClass: "consent",
    dependencies: [],
    quiescence: { _tag: "Synchronous" },
    select: (userId) => ({
      sql: "SELECT CAST(r.rowid AS TEXT) AS rowRef,json_object('phone_number_id',r.\"phone_number_id\",'message_id',r.\"message_id\",'occurred_at_ms',r.\"occurred_at_ms\",'received_at_ms',r.\"received_at_ms\",'decision_not_before_ms',r.\"decision_not_before_ms\") AS body FROM pending_consent_delivery r WHERE EXISTS(SELECT 1 FROM pending_consent_exchanges p WHERE p.correlation_token=r.correlation_token AND EXISTS(SELECT 1 FROM whatsapp_identities w WHERE w.user_id=? AND w.portfolio_id=p.portfolio_id AND w.bsuid=p.bsuid))",
      params: [userId],
    }),
    candidates: (userId) => ({
      sql: "SELECT CAST(r.rowid AS TEXT) AS rowRef FROM pending_consent_delivery r WHERE EXISTS(SELECT 1 FROM pending_consent_exchanges p WHERE p.correlation_token=r.correlation_token AND EXISTS(SELECT 1 FROM whatsapp_identities w WHERE w.user_id=? AND w.portfolio_id=p.portfolio_id AND w.bsuid=p.bsuid))",
      params: [userId],
    }),
    remaining: (userId) => ({
      sql: "SELECT 1 FROM pending_consent_delivery r WHERE EXISTS(SELECT 1 FROM pending_consent_exchanges p WHERE p.correlation_token=r.correlation_token AND EXISTS(SELECT 1 FROM whatsapp_identities w WHERE w.user_id=? AND w.portfolio_id=p.portfolio_id AND w.bsuid=p.bsuid))",
      params: [userId],
    }),
    remove: (scope) => [
      {
        sql: "DELETE FROM pending_consent_delivery AS r WHERE EXISTS(SELECT 1 FROM pending_consent_exchanges p WHERE p.correlation_token=r.correlation_token AND EXISTS(SELECT 1 FROM whatsapp_identities w WHERE w.user_id=? AND w.portfolio_id=p.portfolio_id AND w.bsuid=p.bsuid)) AND CAST(r.rowid AS TEXT) IN(SELECT row_ref FROM erasure_chunk WHERE request_id=?)",
        params: [scope.userId, scope.reference],
      },
    ],
  },
  {
    id: "pending_consent_exchanges",
    dataClass: "consent",
    dependencies: [
      "pending_consent_decisions",
      "pending_consent_delivery",
      "whatsapp_provider_handoffs",
    ],
    quiescence: { _tag: "Synchronous" },
    select: (userId) => ({
      sql: "SELECT CAST(r.rowid AS TEXT) AS rowRef,json_object('id',r.\"id\",'portfolio_id',r.\"portfolio_id\",'bsuid',r.\"bsuid\",'phone_number_id',r.\"phone_number_id\",'initiating_message_id',r.\"initiating_message_id\",'initiating_body_sha256',r.\"initiating_body_sha256\",'disclosure_json',r.\"disclosure_json\",'disclosure_message_id',r.\"disclosure_message_id\",'created_at_ms',r.\"created_at_ms\",'disclosed_at_ms',r.\"disclosed_at_ms\",'decision_not_before_ms',r.\"decision_not_before_ms\",'expires_at_ms',r.\"expires_at_ms\",'state',r.\"state\",'rejected_at_ms',r.\"rejected_at_ms\",'sandbox_phone',r.\"sandbox_phone\") AS body FROM pending_consent_exchanges r WHERE EXISTS(SELECT 1 FROM whatsapp_identities w WHERE w.user_id=? AND w.portfolio_id=r.portfolio_id AND w.bsuid=r.bsuid)",
      params: [userId],
    }),
    candidates: (userId) => ({
      sql: "SELECT CAST(r.rowid AS TEXT) AS rowRef FROM pending_consent_exchanges r WHERE EXISTS(SELECT 1 FROM whatsapp_identities w WHERE w.user_id=? AND w.portfolio_id=r.portfolio_id AND w.bsuid=r.bsuid)",
      params: [userId],
    }),
    remaining: (userId) => ({
      sql: "SELECT 1 FROM pending_consent_exchanges r WHERE EXISTS(SELECT 1 FROM whatsapp_identities w WHERE w.user_id=? AND w.portfolio_id=r.portfolio_id AND w.bsuid=r.bsuid)",
      params: [userId],
    }),
    remove: (scope) => [
      {
        sql: "DELETE FROM pending_consent_exchanges AS r WHERE EXISTS(SELECT 1 FROM whatsapp_identities w WHERE w.user_id=? AND w.portfolio_id=r.portfolio_id AND w.bsuid=r.bsuid) AND CAST(r.rowid AS TEXT) IN(SELECT row_ref FROM erasure_chunk WHERE request_id=?)",
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
      sql: "SELECT CAST(r.rowid AS TEXT) AS rowRef,json_object('id',r.\"id\",'user_id',r.\"user_id\",'kind',r.\"kind\",'portfolio_id',r.\"portfolio_id\",'bsuid',r.\"bsuid\",'disclosure_json',r.\"disclosure_json\",'created_at_ms',r.\"created_at_ms\",'expires_at_ms',r.\"expires_at_ms\",'disclosure_message_id',r.\"disclosure_message_id\",'decision_message_id',r.\"decision_message_id\",'decision',r.\"decision\",'replaces_offer_id',r.\"replaces_offer_id\") AS body FROM proactivity_consent_offers r WHERE r.user_id=?",
      params: [userId],
    }),
    candidates: (userId) => ({
      sql: "SELECT CAST(r.rowid AS TEXT) AS rowRef FROM proactivity_consent_offers r WHERE r.user_id=?",
      params: [userId],
    }),
    remaining: (userId) => ({
      sql: "SELECT 1 FROM proactivity_consent_offers r WHERE r.user_id=?",
      params: [userId],
    }),
    remove: (scope) => [
      {
        sql: "DELETE FROM proactivity_consent_offers AS r WHERE r.user_id=? AND CAST(r.rowid AS TEXT) IN(SELECT row_ref FROM erasure_chunk WHERE request_id=?)",
        params: [scope.userId, scope.reference],
      },
    ],
  },
  {
    id: "proactivity_consent_records",
    dataClass: "consent",
    dependencies: [
      "proactivity_reports",
      "recurring_digest_instructions",
      "reminder_occurrence_reports",
      "reminder_schedules",
    ],
    quiescence: { _tag: "Synchronous" },
    select: (userId) => ({
      sql: "SELECT CAST(r.rowid AS TEXT) AS rowRef,json_object('id',r.\"id\",'user_id',r.\"user_id\",'kind',r.\"kind\",'grant_id',r.\"grant_id\",'offer_id',r.\"offer_id\",'decision_message_id',r.\"decision_message_id\",'record_json',r.\"record_json\",'occurred_at_ms',r.\"occurred_at_ms\") AS body FROM proactivity_consent_records r WHERE r.user_id=?",
      params: [userId],
    }),
    candidates: (userId) => ({
      sql: 'SELECT CAST(r.rowid AS TEXT) AS rowRef FROM proactivity_consent_records r WHERE r.user_id=? AND NOT EXISTS(SELECT 1 FROM proactivity_consent_records child WHERE child."grant_id"=r."id" AND child.rowid<>r.rowid)',
      params: [userId],
    }),
    remaining: (userId) => ({
      sql: "SELECT 1 FROM proactivity_consent_records r WHERE r.user_id=?",
      params: [userId],
    }),
    remove: (scope) => [
      {
        sql: "DELETE FROM proactivity_consent_records AS r WHERE r.user_id=? AND CAST(r.rowid AS TEXT) IN(SELECT row_ref FROM erasure_chunk WHERE request_id=?)",
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
      sql: "SELECT CAST(r.rowid AS TEXT) AS rowRef,json_object('id',r.\"id\",'user_id',r.\"user_id\",'portfolio_id',r.\"portfolio_id\",'bsuid',r.\"bsuid\",'disclosure_json',r.\"disclosure_json\",'created_at_ms',r.\"created_at_ms\",'expires_at_ms',r.\"expires_at_ms\",'disclosure_message_id',r.\"disclosure_message_id\",'disclosed_at_ms',r.\"disclosed_at_ms\",'decision_message_id',r.\"decision_message_id\",'decision',r.\"decision\",'source_id',r.\"source_id\",'rejection_id',r.\"rejection_id\") AS body FROM weekly_consent_offers r WHERE r.user_id=?",
      params: [userId],
    }),
    candidates: (userId) => ({
      sql: "SELECT CAST(r.rowid AS TEXT) AS rowRef FROM weekly_consent_offers r WHERE r.user_id=?",
      params: [userId],
    }),
    remaining: (userId) => ({
      sql: "SELECT 1 FROM weekly_consent_offers r WHERE r.user_id=?",
      params: [userId],
    }),
    remove: (scope) => [
      {
        sql: "DELETE FROM weekly_consent_offers AS r WHERE r.user_id=? AND CAST(r.rowid AS TEXT) IN(SELECT row_ref FROM erasure_chunk WHERE request_id=?)",
        params: [scope.userId, scope.reference],
      },
    ],
  },
  {
    id: "weekly_consent_records",
    dataClass: "consent",
    dependencies: ["weekly_consent_revocation_records"],
    quiescence: { _tag: "Synchronous" },
    select: (userId) => ({
      sql: "SELECT CAST(r.rowid AS TEXT) AS rowRef,json_object('id',r.\"id\",'user_id',r.\"user_id\",'grant_id',r.\"grant_id\",'offer_id',r.\"offer_id\",'record_json',r.\"record_json\",'occurred_at_ms',r.\"occurred_at_ms\") AS body FROM weekly_consent_records r WHERE r.user_id=?",
      params: [userId],
    }),
    candidates: (userId) => ({
      sql: 'SELECT CAST(r.rowid AS TEXT) AS rowRef FROM weekly_consent_records r WHERE r.user_id=? AND NOT EXISTS(SELECT 1 FROM weekly_consent_records child WHERE child."grant_id"=r."id" AND child.rowid<>r.rowid)',
      params: [userId],
    }),
    remaining: (userId) => ({
      sql: "SELECT 1 FROM weekly_consent_records r WHERE r.user_id=?",
      params: [userId],
    }),
    remove: (scope) => [
      {
        sql: "DELETE FROM weekly_consent_records AS r WHERE r.user_id=? AND CAST(r.rowid AS TEXT) IN(SELECT row_ref FROM erasure_chunk WHERE request_id=?)",
        params: [scope.userId, scope.reference],
      },
    ],
  },
  {
    id: "weekly_consent_rejections",
    dataClass: "consent",
    dependencies: [],
    quiescence: { _tag: "Synchronous" },
    select: (userId) => ({
      sql: "SELECT CAST(r.rowid AS TEXT) AS rowRef,json_object('sequence',r.\"sequence\",'id',r.\"id\",'user_id',r.\"user_id\",'offer_id',r.\"offer_id\",'decision_message_id',r.\"decision_message_id\",'decision',r.\"decision\") AS body FROM weekly_consent_rejections r WHERE r.user_id=?",
      params: [userId],
    }),
    candidates: (userId) => ({
      sql: "SELECT CAST(r.rowid AS TEXT) AS rowRef FROM weekly_consent_rejections r WHERE r.user_id=?",
      params: [userId],
    }),
    remaining: (userId) => ({
      sql: "SELECT 1 FROM weekly_consent_rejections r WHERE r.user_id=?",
      params: [userId],
    }),
    remove: (scope) => [
      {
        sql: "DELETE FROM weekly_consent_rejections AS r WHERE r.user_id=? AND CAST(r.rowid AS TEXT) IN(SELECT row_ref FROM erasure_chunk WHERE request_id=?)",
        params: [scope.userId, scope.reference],
      },
    ],
  },
  {
    id: "weekly_consent_revocation_records",
    dataClass: "consent",
    dependencies: [],
    quiescence: { _tag: "Synchronous" },
    select: (userId) => ({
      sql: "SELECT CAST(r.rowid AS TEXT) AS rowRef,json_object('id',r.\"id\",'user_id',r.\"user_id\",'grant_id',r.\"grant_id\",'offer_id',r.\"offer_id\",'decision_message_id',r.\"decision_message_id\",'decision',r.\"decision\",'record_json',r.\"record_json\",'occurred_at_ms',r.\"occurred_at_ms\") AS body FROM weekly_consent_revocation_records r WHERE r.user_id=?",
      params: [userId],
    }),
    candidates: (userId) => ({
      sql: "SELECT CAST(r.rowid AS TEXT) AS rowRef FROM weekly_consent_revocation_records r WHERE r.user_id=?",
      params: [userId],
    }),
    remaining: (userId) => ({
      sql: "SELECT 1 FROM weekly_consent_revocation_records r WHERE r.user_id=?",
      params: [userId],
    }),
    remove: (scope) => [
      {
        sql: "DELETE FROM weekly_consent_revocation_records AS r WHERE r.user_id=? AND CAST(r.rowid AS TEXT) IN(SELECT row_ref FROM erasure_chunk WHERE request_id=?)",
        params: [scope.userId, scope.reference],
      },
    ],
  },
];
