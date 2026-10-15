import type { ErasureProjection } from "../../erasure-store/contract";

export const projections: ReadonlyArray<ErasureProjection> = [
  {
    id: "billing_access_adjustments",
    dataClass: "billing",
    dependencies: [],
    quiescence: { _tag: "Synchronous" },
    select: (userId) => ({
      sql: "SELECT CAST(r.rowid AS TEXT) AS rowRef,json_object('refund_id',r.\"refund_id\",'attempt_id',r.\"attempt_id\",'ends_at_ms',r.\"ends_at_ms\") AS body FROM billing_access_adjustments r WHERE EXISTS(SELECT 1 FROM refund_attempts p WHERE p.id=r.refund_id AND p.user_id=?)",
      params: [userId],
    }),
    candidates: (userId) => ({
      sql: "SELECT CAST(r.rowid AS TEXT) AS rowRef FROM billing_access_adjustments r WHERE EXISTS(SELECT 1 FROM refund_attempts p WHERE p.id=r.refund_id AND p.user_id=?)",
      params: [userId],
    }),
    remaining: (userId) => ({
      sql: "SELECT 1 FROM billing_access_adjustments r WHERE EXISTS(SELECT 1 FROM refund_attempts p WHERE p.id=r.refund_id AND p.user_id=?)",
      params: [userId],
    }),
    remove: (scope) => [
      {
        sql: "DELETE FROM billing_access_adjustments AS r WHERE EXISTS(SELECT 1 FROM refund_attempts p WHERE p.id=r.refund_id AND p.user_id=?) AND CAST(r.rowid AS TEXT) IN(SELECT row_ref FROM erasure_chunk WHERE request_id=?)",
        params: [scope.userId, scope.reference],
      },
    ],
  },
  {
    id: "billing_collection_arms",
    dataClass: "billing",
    dependencies: [],
    quiescence: { _tag: "Synchronous" },
    select: (userId) => ({
      sql: "SELECT CAST(r.rowid AS TEXT) AS rowRef,json_object('attempt_id',r.\"attempt_id\",'state',r.\"state\",'sent_at_ms',r.\"sent_at_ms\") AS body FROM billing_collection_arms r WHERE EXISTS(SELECT 1 FROM billing_attempts p WHERE p.id=r.attempt_id AND p.user_id=?)",
      params: [userId],
    }),
    candidates: (userId) => ({
      sql: "SELECT CAST(r.rowid AS TEXT) AS rowRef FROM billing_collection_arms r WHERE EXISTS(SELECT 1 FROM billing_attempts p WHERE p.id=r.attempt_id AND p.user_id=?)",
      params: [userId],
    }),
    remaining: (userId) => ({
      sql: "SELECT 1 FROM billing_collection_arms r WHERE EXISTS(SELECT 1 FROM billing_attempts p WHERE p.id=r.attempt_id AND p.user_id=?)",
      params: [userId],
    }),
    remove: (scope) => [
      {
        sql: "DELETE FROM billing_collection_arms AS r WHERE EXISTS(SELECT 1 FROM billing_attempts p WHERE p.id=r.attempt_id AND p.user_id=?) AND CAST(r.rowid AS TEXT) IN(SELECT row_ref FROM erasure_chunk WHERE request_id=?)",
        params: [scope.userId, scope.reference],
      },
    ],
  },
  {
    id: "billing_collection_outbox",
    dataClass: "billing",
    dependencies: [],
    quiescence: { _tag: "Synchronous" },
    select: (userId) => ({
      sql: "SELECT CAST(r.rowid AS TEXT) AS rowRef,json_object('attempt_id',r.\"attempt_id\",'version',r.\"version\",'last_attempt_at_ms',r.\"last_attempt_at_ms\",'published_at_ms',r.\"published_at_ms\") AS body FROM billing_collection_outbox r WHERE EXISTS(SELECT 1 FROM billing_attempts p WHERE p.id=r.attempt_id AND p.user_id=?)",
      params: [userId],
    }),
    candidates: (userId) => ({
      sql: "SELECT CAST(r.rowid AS TEXT) AS rowRef FROM billing_collection_outbox r WHERE EXISTS(SELECT 1 FROM billing_attempts p WHERE p.id=r.attempt_id AND p.user_id=?)",
      params: [userId],
    }),
    remaining: (userId) => ({
      sql: "SELECT 1 FROM billing_collection_outbox r WHERE EXISTS(SELECT 1 FROM billing_attempts p WHERE p.id=r.attempt_id AND p.user_id=?)",
      params: [userId],
    }),
    remove: (scope) => [
      {
        sql: "DELETE FROM billing_collection_outbox AS r WHERE EXISTS(SELECT 1 FROM billing_attempts p WHERE p.id=r.attempt_id AND p.user_id=?) AND CAST(r.rowid AS TEXT) IN(SELECT row_ref FROM erasure_chunk WHERE request_id=?)",
        params: [scope.userId, scope.reference],
      },
    ],
  },
  {
    id: "billing_event_candidates",
    dataClass: "billing",
    dependencies: [],
    quiescence: { _tag: "Synchronous" },
    select: (userId) => ({
      sql: "SELECT CAST(r.rowid AS TEXT) AS rowRef,json_object('transaction_id',r.\"transaction_id\",'received_at_ms',r.\"received_at_ms\",'signed_at',r.\"signed_at\",'signed_status',r.\"signed_status\",'lookup_attempts',r.\"lookup_attempts\",'last_checked_at_ms',r.\"last_checked_at_ms\",'resolved_at_ms',r.\"resolved_at_ms\") AS body FROM billing_event_candidates r WHERE EXISTS(SELECT 1 FROM billing_transaction_evidence p JOIN billing_attempts a ON a.id=p.attempt_id WHERE p.transaction_id=r.transaction_id AND a.user_id=?)",
      params: [userId],
    }),
    candidates: (userId) => ({
      sql: "SELECT CAST(r.rowid AS TEXT) AS rowRef FROM billing_event_candidates r WHERE EXISTS(SELECT 1 FROM billing_transaction_evidence p JOIN billing_attempts a ON a.id=p.attempt_id WHERE p.transaction_id=r.transaction_id AND a.user_id=?)",
      params: [userId],
    }),
    remaining: (userId) => ({
      sql: "SELECT 1 FROM billing_event_candidates r WHERE EXISTS(SELECT 1 FROM billing_transaction_evidence p JOIN billing_attempts a ON a.id=p.attempt_id WHERE p.transaction_id=r.transaction_id AND a.user_id=?)",
      params: [userId],
    }),
    remove: (scope) => [
      {
        sql: "DELETE FROM billing_event_candidates AS r WHERE EXISTS(SELECT 1 FROM billing_transaction_evidence p JOIN billing_attempts a ON a.id=p.attempt_id WHERE p.transaction_id=r.transaction_id AND a.user_id=?) AND CAST(r.rowid AS TEXT) IN(SELECT row_ref FROM erasure_chunk WHERE request_id=?)",
        params: [scope.userId, scope.reference],
      },
    ],
  },
  {
    id: "billing_followup_outbox",
    dataClass: "billing",
    dependencies: [],
    quiescence: { _tag: "Synchronous" },
    select: (userId) => ({
      sql: "SELECT CAST(r.rowid AS TEXT) AS rowRef,json_object('attempt_id',r.\"attempt_id\",'kind',r.\"kind\",'due_at_ms',r.\"due_at_ms\") AS body FROM billing_followup_outbox r WHERE EXISTS(SELECT 1 FROM billing_attempts p WHERE p.id=r.attempt_id AND p.user_id=?)",
      params: [userId],
    }),
    candidates: (userId) => ({
      sql: "SELECT CAST(r.rowid AS TEXT) AS rowRef FROM billing_followup_outbox r WHERE EXISTS(SELECT 1 FROM billing_attempts p WHERE p.id=r.attempt_id AND p.user_id=?)",
      params: [userId],
    }),
    remaining: (userId) => ({
      sql: "SELECT 1 FROM billing_followup_outbox r WHERE EXISTS(SELECT 1 FROM billing_attempts p WHERE p.id=r.attempt_id AND p.user_id=?)",
      params: [userId],
    }),
    remove: (scope) => [
      {
        sql: "DELETE FROM billing_followup_outbox AS r WHERE EXISTS(SELECT 1 FROM billing_attempts p WHERE p.id=r.attempt_id AND p.user_id=?) AND CAST(r.rowid AS TEXT) IN(SELECT row_ref FROM erasure_chunk WHERE request_id=?)",
        params: [scope.userId, scope.reference],
      },
    ],
  },
  {
    id: "billing_no_charge_confirmations",
    dataClass: "billing",
    dependencies: [],
    quiescence: { _tag: "Synchronous" },
    select: (userId) => ({
      sql: "SELECT CAST(r.rowid AS TEXT) AS rowRef,json_object('attempt_id',r.\"attempt_id\",'wompi_reference',r.\"wompi_reference\",'wompi_environment',r.\"wompi_environment\",'provider_case_id',r.\"provider_case_id\",'operator_id',r.\"operator_id\",'confirmed_at_ms',r.\"confirmed_at_ms\") AS body FROM billing_no_charge_confirmations r WHERE EXISTS(SELECT 1 FROM billing_attempts p WHERE p.id=r.attempt_id AND p.user_id=?)",
      params: [userId],
    }),
    candidates: (userId) => ({
      sql: "SELECT CAST(r.rowid AS TEXT) AS rowRef FROM billing_no_charge_confirmations r WHERE EXISTS(SELECT 1 FROM billing_attempts p WHERE p.id=r.attempt_id AND p.user_id=?)",
      params: [userId],
    }),
    remaining: (userId) => ({
      sql: "SELECT 1 FROM billing_no_charge_confirmations r WHERE EXISTS(SELECT 1 FROM billing_attempts p WHERE p.id=r.attempt_id AND p.user_id=?)",
      params: [userId],
    }),
    remove: (scope) => [
      {
        sql: "DELETE FROM billing_no_charge_confirmations AS r WHERE EXISTS(SELECT 1 FROM billing_attempts p WHERE p.id=r.attempt_id AND p.user_id=?) AND CAST(r.rowid AS TEXT) IN(SELECT row_ref FROM erasure_chunk WHERE request_id=?)",
        params: [scope.userId, scope.reference],
      },
    ],
  },
  {
    id: "billing_price_notices",
    dataClass: "billing",
    dependencies: [],
    quiescence: { _tag: "Synchronous" },
    select: (userId) => ({
      sql: "SELECT CAST(r.rowid AS TEXT) AS rowRef,json_object('user_id',r.\"user_id\",'price_id',r.\"price_id\",'created_at_ms',r.\"created_at_ms\",'last_offered_at_ms',r.\"last_offered_at_ms\",'send_started_at_ms',r.\"send_started_at_ms\",'accepted_at_ms',r.\"accepted_at_ms\") AS body FROM billing_price_notices r WHERE r.user_id=?",
      params: [userId],
    }),
    candidates: (userId) => ({
      sql: "SELECT CAST(r.rowid AS TEXT) AS rowRef FROM billing_price_notices r WHERE r.user_id=?",
      params: [userId],
    }),
    remaining: (userId) => ({
      sql: "SELECT 1 FROM billing_price_notices r WHERE r.user_id=?",
      params: [userId],
    }),
    remove: (scope) => [
      {
        sql: "DELETE FROM billing_price_notices AS r WHERE r.user_id=? AND CAST(r.rowid AS TEXT) IN(SELECT row_ref FROM erasure_chunk WHERE request_id=?)",
        params: [scope.userId, scope.reference],
      },
    ],
  },
  {
    id: "billing_recovery_reviews",
    dataClass: "billing",
    dependencies: [],
    quiescence: { _tag: "Synchronous" },
    select: (userId) => ({
      sql: "SELECT CAST(r.rowid AS TEXT) AS rowRef,json_object('attempt_id',r.\"attempt_id\",'provider_case_id',r.\"provider_case_id\",'occurred_at_ms',r.\"occurred_at_ms\") AS body FROM billing_recovery_reviews r WHERE EXISTS(SELECT 1 FROM billing_attempts p WHERE p.id=r.attempt_id AND p.user_id=?)",
      params: [userId],
    }),
    candidates: (userId) => ({
      sql: "SELECT CAST(r.rowid AS TEXT) AS rowRef FROM billing_recovery_reviews r WHERE EXISTS(SELECT 1 FROM billing_attempts p WHERE p.id=r.attempt_id AND p.user_id=?)",
      params: [userId],
    }),
    remaining: (userId) => ({
      sql: "SELECT 1 FROM billing_recovery_reviews r WHERE EXISTS(SELECT 1 FROM billing_attempts p WHERE p.id=r.attempt_id AND p.user_id=?)",
      params: [userId],
    }),
    remove: (scope) => [
      {
        sql: "DELETE FROM billing_recovery_reviews AS r WHERE EXISTS(SELECT 1 FROM billing_attempts p WHERE p.id=r.attempt_id AND p.user_id=?) AND CAST(r.rowid AS TEXT) IN(SELECT row_ref FROM erasure_chunk WHERE request_id=?)",
        params: [scope.userId, scope.reference],
      },
    ],
  },
  {
    id: "billing_transaction_candidates",
    dataClass: "billing",
    dependencies: [],
    quiescence: { _tag: "Synchronous" },
    select: (userId) => ({
      sql: "SELECT CAST(r.rowid AS TEXT) AS rowRef,json_object('transaction_id',r.\"transaction_id\",'attempt_id',r.\"attempt_id\",'lookup_attempts',r.\"lookup_attempts\",'last_checked_at_ms',r.\"last_checked_at_ms\") AS body FROM billing_transaction_candidates r WHERE EXISTS(SELECT 1 FROM billing_attempts p WHERE p.id=r.attempt_id AND p.user_id=?)",
      params: [userId],
    }),
    candidates: (userId) => ({
      sql: "SELECT CAST(r.rowid AS TEXT) AS rowRef FROM billing_transaction_candidates r WHERE EXISTS(SELECT 1 FROM billing_attempts p WHERE p.id=r.attempt_id AND p.user_id=?)",
      params: [userId],
    }),
    remaining: (userId) => ({
      sql: "SELECT 1 FROM billing_transaction_candidates r WHERE EXISTS(SELECT 1 FROM billing_attempts p WHERE p.id=r.attempt_id AND p.user_id=?)",
      params: [userId],
    }),
    remove: (scope) => [
      {
        sql: "DELETE FROM billing_transaction_candidates AS r WHERE EXISTS(SELECT 1 FROM billing_attempts p WHERE p.id=r.attempt_id AND p.user_id=?) AND CAST(r.rowid AS TEXT) IN(SELECT row_ref FROM erasure_chunk WHERE request_id=?)",
        params: [scope.userId, scope.reference],
      },
    ],
  },
  {
    id: "billing_transaction_evidence",
    dataClass: "billing",
    dependencies: ["billing_event_candidates", "refund_attempts"],
    quiescence: { _tag: "Synchronous" },
    select: (userId) => ({
      sql: "SELECT CAST(r.rowid AS TEXT) AS rowRef,json_object('transaction_id',r.\"transaction_id\",'attempt_id',r.\"attempt_id\",'status',r.\"status\",'first_observed_at_ms',r.\"first_observed_at_ms\",'negative_observed_at_ms',r.\"negative_observed_at_ms\",'finalized_at_ms',r.\"finalized_at_ms\") AS body FROM billing_transaction_evidence r WHERE EXISTS(SELECT 1 FROM billing_attempts p WHERE p.id=r.attempt_id AND p.user_id=?)",
      params: [userId],
    }),
    candidates: (userId) => ({
      sql: "SELECT CAST(r.rowid AS TEXT) AS rowRef FROM billing_transaction_evidence r WHERE EXISTS(SELECT 1 FROM billing_attempts p WHERE p.id=r.attempt_id AND p.user_id=?)",
      params: [userId],
    }),
    remaining: (userId) => ({
      sql: "SELECT 1 FROM billing_transaction_evidence r WHERE EXISTS(SELECT 1 FROM billing_attempts p WHERE p.id=r.attempt_id AND p.user_id=?)",
      params: [userId],
    }),
    remove: (scope) => [
      {
        sql: "DELETE FROM billing_transaction_evidence AS r WHERE EXISTS(SELECT 1 FROM billing_attempts p WHERE p.id=r.attempt_id AND p.user_id=?) AND CAST(r.rowid AS TEXT) IN(SELECT row_ref FROM erasure_chunk WHERE request_id=?)",
        params: [scope.userId, scope.reference],
      },
    ],
  },
  {
    id: "card_enrollments",
    dataClass: "billing",
    dependencies: ["billing_history", "card_payment_sources", "payment_commit_guards"],
    quiescence: {
      _tag: "Durable",
      select: ({ userId }) => ({
        sql: "SELECT 1 FROM card_enrollments WHERE user_id=? AND status IN('preparing','creating','verifying')",
        params: [userId],
      }),
    },
    select: (userId) => ({
      sql: "SELECT CAST(r.rowid AS TEXT) AS rowRef,json_object('id',r.\"id\",'user_id',r.\"user_id\",'price_id',r.\"price_id\",'billing_email',r.\"billing_email\",'status',r.\"status\",'payment_source_mode',r.\"payment_source_mode\",'contracts_json',r.\"contracts_json\",'disclosure_json',r.\"disclosure_json\",'prepared_at_ms',r.\"prepared_at_ms\",'expires_at_ms',r.\"expires_at_ms\",'accepted_at_ms',r.\"accepted_at_ms\",'payment_request_id',r.\"payment_request_id\",'wompi_candidate_source_id',r.\"wompi_candidate_source_id\",'verification_attempts',r.\"verification_attempts\",'last_verification_at_ms',r.\"last_verification_at_ms\",'refusal_reason',r.\"refusal_reason\",'method',r.\"method\",'wompi_environment',r.\"wompi_environment\") AS body FROM card_enrollments r WHERE r.user_id=?",
      params: [userId],
    }),
    candidates: (userId) => ({
      sql: "SELECT CAST(r.rowid AS TEXT) AS rowRef FROM card_enrollments r WHERE r.user_id=?",
      params: [userId],
    }),
    remaining: (userId) => ({
      sql: "SELECT 1 FROM card_enrollments r WHERE r.user_id=?",
      params: [userId],
    }),
    remove: (scope) => [
      {
        sql: "DELETE FROM card_enrollments AS r WHERE r.user_id=? AND CAST(r.rowid AS TEXT) IN(SELECT row_ref FROM erasure_chunk WHERE request_id=?)",
        params: [scope.userId, scope.reference],
      },
    ],
  },
  {
    id: "card_payment_sources",
    dataClass: "billing",
    dependencies: ["billing_history", "subscription_cancellations"],
    quiescence: { _tag: "Synchronous" },
    select: (userId) => ({
      sql: "SELECT CAST(r.rowid AS TEXT) AS rowRef,json_object('id',r.\"id\",'user_id',r.\"user_id\",'enrollment_id',r.\"enrollment_id\",'wompi_source_id',r.\"wompi_source_id\",'billing_email',r.\"billing_email\",'created_at_ms',r.\"created_at_ms\",'method',r.\"method\") AS body FROM card_payment_sources r WHERE r.user_id=?",
      params: [userId],
    }),
    candidates: (userId) => ({
      sql: "SELECT CAST(r.rowid AS TEXT) AS rowRef FROM card_payment_sources r WHERE r.user_id=?",
      params: [userId],
    }),
    remaining: (userId) => ({
      sql: "SELECT 1 FROM card_payment_sources r WHERE r.user_id=?",
      params: [userId],
    }),
    remove: (scope) => [
      {
        sql: "DELETE FROM card_payment_sources AS r WHERE r.user_id=? AND CAST(r.rowid AS TEXT) IN(SELECT row_ref FROM erasure_chunk WHERE request_id=?)",
        params: [scope.userId, scope.reference],
      },
    ],
  },
  {
    id: "payment_commit_guards",
    dataClass: "billing",
    dependencies: [],
    quiescence: { _tag: "Synchronous" },
    select: (userId) => ({
      sql: "SELECT CAST(r.rowid AS TEXT) AS rowRef,json_object('enrollment_id',r.\"enrollment_id\",'allowed',r.\"allowed\") AS body FROM payment_commit_guards r WHERE EXISTS(SELECT 1 FROM card_enrollments p WHERE p.id=r.enrollment_id AND p.user_id=?)",
      params: [userId],
    }),
    candidates: (userId) => ({
      sql: "SELECT CAST(r.rowid AS TEXT) AS rowRef FROM payment_commit_guards r WHERE EXISTS(SELECT 1 FROM card_enrollments p WHERE p.id=r.enrollment_id AND p.user_id=?)",
      params: [userId],
    }),
    remaining: (userId) => ({
      sql: "SELECT 1 FROM payment_commit_guards r WHERE EXISTS(SELECT 1 FROM card_enrollments p WHERE p.id=r.enrollment_id AND p.user_id=?)",
      params: [userId],
    }),
    remove: (scope) => [
      {
        sql: "DELETE FROM payment_commit_guards AS r WHERE EXISTS(SELECT 1 FROM card_enrollments p WHERE p.id=r.enrollment_id AND p.user_id=?) AND CAST(r.rowid AS TEXT) IN(SELECT row_ref FROM erasure_chunk WHERE request_id=?)",
        params: [scope.userId, scope.reference],
      },
    ],
  },
  {
    id: "refund_attempts",
    dataClass: "billing",
    dependencies: [
      "billing_access_adjustments",
      "refund_outbox",
      "refund_outcome_evidence",
      "refund_submission_claims",
      "subscription_renewal_stops",
    ],
    quiescence: {
      _tag: "Durable",
      select: ({ userId }) => ({
        sql: "SELECT 1 FROM refund_attempts WHERE user_id=? AND status='pending'",
        params: [userId],
      }),
    },
    select: (userId) => ({
      sql: "SELECT CAST(r.rowid AS TEXT) AS rowRef,json_object('id',r.\"id\",'user_id',r.\"user_id\",'subscription_id',r.\"subscription_id\",'billing_attempt_id',r.\"billing_attempt_id\",'transaction_id',r.\"transaction_id\",'request_id',r.\"request_id\",'intent_json',r.\"intent_json\",'snapshot_json',r.\"snapshot_json\",'amount_in_cents',r.\"amount_in_cents\",'original_cents',r.\"original_cents\",'kind',r.\"kind\",'operator_id',r.\"operator_id\",'created_at_ms',r.\"created_at_ms\",'status',r.\"status\",'progress',r.\"progress\",'finalized_at_ms',r.\"finalized_at_ms\",'failure',r.\"failure\") AS body FROM refund_attempts r WHERE r.user_id=?",
      params: [userId],
    }),
    candidates: (userId) => ({
      sql: "SELECT CAST(r.rowid AS TEXT) AS rowRef FROM refund_attempts r WHERE r.user_id=?",
      params: [userId],
    }),
    remaining: (userId) => ({
      sql: "SELECT 1 FROM refund_attempts r WHERE r.user_id=?",
      params: [userId],
    }),
    remove: (scope) => [
      {
        sql: "DELETE FROM refund_attempts AS r WHERE r.user_id=? AND CAST(r.rowid AS TEXT) IN(SELECT row_ref FROM erasure_chunk WHERE request_id=?)",
        params: [scope.userId, scope.reference],
      },
    ],
  },
  {
    id: "refund_outbox",
    dataClass: "billing",
    dependencies: [],
    quiescence: { _tag: "Synchronous" },
    select: (userId) => ({
      sql: "SELECT CAST(r.rowid AS TEXT) AS rowRef,json_object('refund_id',r.\"refund_id\",'version',r.\"version\",'last_attempt_at_ms',r.\"last_attempt_at_ms\",'published_at_ms',r.\"published_at_ms\",'verification_attempts',r.\"verification_attempts\",'last_verification_at_ms',r.\"last_verification_at_ms\") AS body FROM refund_outbox r WHERE EXISTS(SELECT 1 FROM refund_attempts p WHERE p.id=r.refund_id AND p.user_id=?)",
      params: [userId],
    }),
    candidates: (userId) => ({
      sql: "SELECT CAST(r.rowid AS TEXT) AS rowRef FROM refund_outbox r WHERE EXISTS(SELECT 1 FROM refund_attempts p WHERE p.id=r.refund_id AND p.user_id=?)",
      params: [userId],
    }),
    remaining: (userId) => ({
      sql: "SELECT 1 FROM refund_outbox r WHERE EXISTS(SELECT 1 FROM refund_attempts p WHERE p.id=r.refund_id AND p.user_id=?)",
      params: [userId],
    }),
    remove: (scope) => [
      {
        sql: "DELETE FROM refund_outbox AS r WHERE EXISTS(SELECT 1 FROM refund_attempts p WHERE p.id=r.refund_id AND p.user_id=?) AND CAST(r.rowid AS TEXT) IN(SELECT row_ref FROM erasure_chunk WHERE request_id=?)",
        params: [scope.userId, scope.reference],
      },
    ],
  },
  {
    id: "refund_outcome_evidence",
    dataClass: "billing",
    dependencies: [],
    quiescence: { _tag: "Synchronous" },
    select: (userId) => ({
      sql: "SELECT CAST(r.rowid AS TEXT) AS rowRef,json_object('refund_id',r.\"refund_id\",'provider_id',r.\"provider_id\",'verified_status',r.\"verified_status\",'observed_at_ms',r.\"observed_at_ms\") AS body FROM refund_outcome_evidence r WHERE EXISTS(SELECT 1 FROM refund_attempts p WHERE p.id=r.refund_id AND p.user_id=?)",
      params: [userId],
    }),
    candidates: (userId) => ({
      sql: "SELECT CAST(r.rowid AS TEXT) AS rowRef FROM refund_outcome_evidence r WHERE EXISTS(SELECT 1 FROM refund_attempts p WHERE p.id=r.refund_id AND p.user_id=?)",
      params: [userId],
    }),
    remaining: (userId) => ({
      sql: "SELECT 1 FROM refund_outcome_evidence r WHERE EXISTS(SELECT 1 FROM refund_attempts p WHERE p.id=r.refund_id AND p.user_id=?)",
      params: [userId],
    }),
    remove: (scope) => [
      {
        sql: "DELETE FROM refund_outcome_evidence AS r WHERE EXISTS(SELECT 1 FROM refund_attempts p WHERE p.id=r.refund_id AND p.user_id=?) AND CAST(r.rowid AS TEXT) IN(SELECT row_ref FROM erasure_chunk WHERE request_id=?)",
        params: [scope.userId, scope.reference],
      },
    ],
  },
  {
    id: "refund_submission_claims",
    dataClass: "billing",
    dependencies: [],
    quiescence: { _tag: "Synchronous" },
    select: (userId) => ({
      sql: "SELECT CAST(r.rowid AS TEXT) AS rowRef,json_object('refund_id',r.\"refund_id\",'claimed_at_ms',r.\"claimed_at_ms\") AS body FROM refund_submission_claims r WHERE EXISTS(SELECT 1 FROM refund_attempts p WHERE p.id=r.refund_id AND p.user_id=?)",
      params: [userId],
    }),
    candidates: (userId) => ({
      sql: "SELECT CAST(r.rowid AS TEXT) AS rowRef FROM refund_submission_claims r WHERE EXISTS(SELECT 1 FROM refund_attempts p WHERE p.id=r.refund_id AND p.user_id=?)",
      params: [userId],
    }),
    remaining: (userId) => ({
      sql: "SELECT 1 FROM refund_submission_claims r WHERE EXISTS(SELECT 1 FROM refund_attempts p WHERE p.id=r.refund_id AND p.user_id=?)",
      params: [userId],
    }),
    remove: (scope) => [
      {
        sql: "DELETE FROM refund_submission_claims AS r WHERE EXISTS(SELECT 1 FROM refund_attempts p WHERE p.id=r.refund_id AND p.user_id=?) AND CAST(r.rowid AS TEXT) IN(SELECT row_ref FROM erasure_chunk WHERE request_id=?)",
        params: [scope.userId, scope.reference],
      },
    ],
  },
  {
    id: "subscription_cancellations",
    dataClass: "billing",
    dependencies: [],
    quiescence: { _tag: "Synchronous" },
    select: (userId) => ({
      sql: "SELECT CAST(r.rowid AS TEXT) AS rowRef,json_object('user_id',r.\"user_id\",'paid_attempt_id',r.\"paid_attempt_id\",'payment_source_id',r.\"payment_source_id\",'cancelled_at_ms',r.\"cancelled_at_ms\",'paid_through_ms',r.\"paid_through_ms\",'source_cancellation',r.\"source_cancellation\",'void_started_at_ms',r.\"void_started_at_ms\",'void_verified_at_ms',r.\"void_verified_at_ms\",'verification_count',r.\"verification_count\",'last_offered_at_ms',r.\"last_offered_at_ms\") AS body FROM subscription_cancellations r WHERE r.user_id=?",
      params: [userId],
    }),
    candidates: (userId) => ({
      sql: "SELECT CAST(r.rowid AS TEXT) AS rowRef FROM subscription_cancellations r WHERE r.user_id=?",
      params: [userId],
    }),
    remaining: (userId) => ({
      sql: "SELECT 1 FROM subscription_cancellations r WHERE r.user_id=?",
      params: [userId],
    }),
    remove: (scope) => [
      {
        sql: "DELETE FROM subscription_cancellations AS r WHERE r.user_id=? AND CAST(r.rowid AS TEXT) IN(SELECT row_ref FROM erasure_chunk WHERE request_id=?)",
        params: [scope.userId, scope.reference],
      },
    ],
  },
  {
    id: "subscription_identities",
    dataClass: "billing",
    dependencies: ["refund_attempts"],
    quiescence: { _tag: "Synchronous" },
    select: (userId) => ({
      sql: "SELECT CAST(r.rowid AS TEXT) AS rowRef,json_object('user_id',r.\"user_id\",'id',r.\"id\") AS body FROM subscription_identities r WHERE r.user_id=?",
      params: [userId],
    }),
    candidates: (userId) => ({
      sql: "SELECT CAST(r.rowid AS TEXT) AS rowRef FROM subscription_identities r WHERE r.user_id=?",
      params: [userId],
    }),
    remaining: (userId) => ({
      sql: "SELECT 1 FROM subscription_identities r WHERE r.user_id=?",
      params: [userId],
    }),
    remove: (scope) => [
      {
        sql: "DELETE FROM subscription_identities AS r WHERE r.user_id=? AND CAST(r.rowid AS TEXT) IN(SELECT row_ref FROM erasure_chunk WHERE request_id=?)",
        params: [scope.userId, scope.reference],
      },
    ],
  },
  {
    id: "subscription_renewal_stops",
    dataClass: "billing",
    dependencies: [],
    quiescence: { _tag: "Synchronous" },
    select: (userId) => ({
      sql: "SELECT CAST(r.rowid AS TEXT) AS rowRef,json_object('refund_id',r.\"refund_id\",'user_id',r.\"user_id\",'stopped_at_ms',r.\"stopped_at_ms\") AS body FROM subscription_renewal_stops r WHERE r.user_id=?",
      params: [userId],
    }),
    candidates: (userId) => ({
      sql: "SELECT CAST(r.rowid AS TEXT) AS rowRef FROM subscription_renewal_stops r WHERE r.user_id=?",
      params: [userId],
    }),
    remaining: (userId) => ({
      sql: "SELECT 1 FROM subscription_renewal_stops r WHERE r.user_id=?",
      params: [userId],
    }),
    remove: (scope) => [
      {
        sql: "DELETE FROM subscription_renewal_stops AS r WHERE r.user_id=? AND CAST(r.rowid AS TEXT) IN(SELECT row_ref FROM erasure_chunk WHERE request_id=?)",
        params: [scope.userId, scope.reference],
      },
    ],
  },
  {
    id: "subscriptions",
    dataClass: "billing",
    dependencies: [],
    quiescence: { _tag: "Synchronous" },
    select: (userId) => ({
      sql: "SELECT CAST(r.rowid AS TEXT) AS rowRef,json_object('user_id',r.\"user_id\",'attempt_id',r.\"attempt_id\",'price_id',r.\"price_id\",'paid_period_ends_at_ms',r.\"paid_period_ends_at_ms\",'renewal_anchor_ms',r.\"renewal_anchor_ms\") AS body FROM subscriptions r WHERE r.user_id=?",
      params: [userId],
    }),
    candidates: (userId) => ({
      sql: "SELECT CAST(r.rowid AS TEXT) AS rowRef FROM subscriptions r WHERE r.user_id=?",
      params: [userId],
    }),
    remaining: (userId) => ({
      sql: "SELECT 1 FROM subscriptions r WHERE r.user_id=?",
      params: [userId],
    }),
    remove: (scope) => [
      {
        sql: "DELETE FROM subscriptions AS r WHERE r.user_id=? AND CAST(r.rowid AS TEXT) IN(SELECT row_ref FROM erasure_chunk WHERE request_id=?)",
        params: [scope.userId, scope.reference],
      },
    ],
  },
  {
    id: "billing_history",
    dataClass: "billing",
    dependencies: [
      "billing_access_adjustments",
      "billing_audit",
      "billing_collection_arms",
      "billing_collection_outbox",
      "billing_followup_outbox",
      "billing_no_charge_confirmations",
      "billing_recovery_reviews",
      "billing_transaction_candidates",
      "billing_transaction_evidence",
      "refund_attempts",
      "subscription_cancellations",
      "subscriptions",
    ],
    quiescence: {
      _tag: "Durable",
      select: ({ userId }) => ({
        sql: "SELECT 1 FROM billing_attempts WHERE user_id=? AND status='pending'",
        params: [userId],
      }),
    },
    select: (userId) => ({
      sql: "SELECT 'attempt:'||a.id AS rowRef,json_object('id',a.\"id\",'user_id',a.\"user_id\",'enrollment_id',a.\"enrollment_id\",'payment_request_id',a.\"payment_request_id\",'payment_source_id',a.\"payment_source_id\",'price_id',a.\"price_id\",'amount',a.\"amount\",'currency',a.\"currency\",'billing_period',a.\"billing_period\",'service_market',a.\"service_market\",'tax_treatment',a.\"tax_treatment\",'time_zone',a.\"time_zone\",'wompi_environment',a.\"wompi_environment\",'wompi_reference',a.\"wompi_reference\",'status',a.\"status\",'created_at_ms',a.\"created_at_ms\",'finalized_at_ms',a.\"finalized_at_ms\",'previous_paid_attempt_id',a.\"previous_paid_attempt_id\",'period_starts_at_ms',a.\"period_starts_at_ms\",'period_ends_at_ms',a.\"period_ends_at_ms\",'attempt_number',a.\"attempt_number\",'calendar_anchor_ms',a.\"calendar_anchor_ms\",'renewal_attempt_number',a.\"renewal_attempt_number\") AS body FROM billing_attempts a WHERE a.user_id=? UNION ALL SELECT 'period:'||p.attempt_id AS rowRef,json_object('attempt_id',p.\"attempt_id\",'starts_at_ms',p.\"starts_at_ms\",'ends_at_ms',p.\"ends_at_ms\",'renewal_anchor_ms',p.\"renewal_anchor_ms\") AS body FROM billing_paid_periods p JOIN billing_attempts a ON a.id=p.attempt_id WHERE a.user_id=?",
      params: [userId, userId],
    }),
    candidates: (userId) => ({
      sql: "SELECT a.id AS rowRef FROM billing_attempts a WHERE a.user_id=? AND NOT EXISTS(SELECT 1 FROM billing_attempts later WHERE later.previous_paid_attempt_id=a.id)",
      params: [userId],
    }),
    remaining: (userId) => ({
      sql: "SELECT 1 FROM billing_attempts WHERE user_id=?",
      params: [userId],
    }),
    remove: (scope) => [
      {
        sql: "DELETE FROM billing_paid_periods WHERE attempt_id IN(SELECT id FROM billing_attempts WHERE user_id=? AND id IN(SELECT row_ref FROM erasure_chunk WHERE request_id=?))",
        params: [scope.userId, scope.reference],
      },
      {
        sql: "DELETE FROM billing_attempts WHERE user_id=? AND id IN(SELECT row_ref FROM erasure_chunk WHERE request_id=?)",
        params: [scope.userId, scope.reference],
      },
    ],
  },
];
