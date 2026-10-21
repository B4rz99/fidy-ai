import type { ErasureProjection } from "../../erasure-store/contract";

export const projections: ReadonlyArray<ErasureProjection> = [
  {
    id: "billing_event_candidates",
    dataClass: "billing",
    dependencies: [],
    quiescence: { _tag: "Synchronous" },
    select: (userId) => ({
      sql: "SELECT CAST(r.rowid AS TEXT) AS rowRef,json_object('transaction_id',r.\"transaction_id\",'received_at_ms',r.\"received_at_ms\",'signed_at',r.\"signed_at\",'signed_status',r.\"signed_status\",'lookup_attempts',r.\"lookup_attempts\",'last_checked_at_ms',r.\"last_checked_at_ms\",'resolved_at_ms',r.\"resolved_at_ms\") AS body FROM billing_callback_hints r WHERE EXISTS(SELECT 1 FROM billing_provider_transactions p JOIN billing_attempts a ON a.id=p.attempt_id WHERE p.status IS NOT NULL AND p.transaction_id=r.transaction_id AND a.user_id=?)",
      params: [userId],
    }),
    candidates: (userId) => ({
      sql: "SELECT CAST(r.rowid AS TEXT) AS rowRef FROM billing_callback_hints r WHERE EXISTS(SELECT 1 FROM billing_provider_transactions p JOIN billing_attempts a ON a.id=p.attempt_id WHERE p.status IS NOT NULL AND p.transaction_id=r.transaction_id AND a.user_id=?)",
      params: [userId],
    }),
    remaining: (userId) => ({
      sql: "SELECT 1 FROM billing_callback_hints r WHERE EXISTS(SELECT 1 FROM billing_provider_transactions p JOIN billing_attempts a ON a.id=p.attempt_id WHERE p.status IS NOT NULL AND p.transaction_id=r.transaction_id AND a.user_id=?)",
      params: [userId],
    }),
    remove: (scope) => [
      {
        sql: "UPDATE billing_provider_transactions AS r SET event_row_ref=NULL,event_received_at_ms=NULL,event_signed_at=NULL,event_signed_status=NULL,event_lookup_attempts=NULL,event_last_checked_at_ms=NULL,event_resolved_at_ms=NULL WHERE r.event_received_at_ms IS NOT NULL AND EXISTS(SELECT 1 FROM billing_provider_transactions p JOIN billing_attempts a ON a.id=p.attempt_id WHERE p.status IS NOT NULL AND p.transaction_id=r.transaction_id AND a.user_id=?) AND COALESCE(r.event_row_ref,'callback:'||r.transaction_id) IN(SELECT row_ref FROM erasure_chunk WHERE request_id=?)",
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
    id: "billing_checkout_responses",
    dataClass: "billing",
    dependencies: [],
    quiescence: { _tag: "Synchronous" },
    select: (userId) => ({
      sql: "SELECT CAST(rowid AS TEXT) AS rowRef,json_object('attempt_id',id,'transaction_id',checkout_transaction_id) AS body FROM billing_attempts WHERE user_id=? AND checkout_transaction_id IS NOT NULL",
      params: [userId],
    }),
    candidates: (userId) => ({
      sql: "SELECT CAST(rowid AS TEXT) AS rowRef FROM billing_attempts WHERE user_id=? AND checkout_transaction_id IS NOT NULL",
      params: [userId],
    }),
    remaining: (userId) => ({
      sql: "SELECT 1 FROM billing_attempts WHERE user_id=? AND checkout_transaction_id IS NOT NULL",
      params: [userId],
    }),
    remove: (scope) => [
      {
        sql: "UPDATE billing_attempts SET checkout_transaction_id=NULL WHERE user_id=? AND checkout_transaction_id IS NOT NULL AND CAST(rowid AS TEXT) IN(SELECT row_ref FROM erasure_chunk WHERE request_id=?)",
        params: [scope.userId, scope.reference],
      },
    ],
  },
  {
    id: "billing_provider_transactions",
    dataClass: "billing",
    dependencies: ["billing_checkout_responses", "billing_event_candidates", "refund_attempts"],
    quiescence: { _tag: "Synchronous" },
    select: (userId) => ({
      sql: "SELECT CAST(r.rowid AS TEXT) AS rowRef,json_object('transaction_id',r.\"transaction_id\",'attempt_id',r.\"attempt_id\",'lookup_attempts',r.\"lookup_attempts\",'last_checked_at_ms',r.\"last_checked_at_ms\",'status',r.status,'first_observed_at_ms',r.first_observed_at_ms,'negative_observed_at_ms',r.negative_observed_at_ms,'finalized_at_ms',r.finalized_at_ms) AS body FROM billing_provider_transactions r WHERE EXISTS(SELECT 1 FROM billing_attempts p WHERE p.id=r.attempt_id AND p.user_id=?)",
      params: [userId],
    }),
    candidates: (userId) => ({
      sql: "SELECT CAST(r.rowid AS TEXT) AS rowRef FROM billing_provider_transactions r WHERE EXISTS(SELECT 1 FROM billing_attempts p WHERE p.id=r.attempt_id AND p.user_id=?)",
      params: [userId],
    }),
    remaining: (userId) => ({
      sql: "SELECT 1 FROM billing_provider_transactions r WHERE EXISTS(SELECT 1 FROM billing_attempts p WHERE p.id=r.attempt_id AND p.user_id=?)",
      params: [userId],
    }),
    remove: (scope) => [
      {
        sql: "DELETE FROM billing_provider_transactions AS r WHERE r.event_received_at_ms IS NULL AND EXISTS(SELECT 1 FROM billing_attempts p WHERE p.id=r.attempt_id AND p.user_id=?) AND CAST(r.rowid AS TEXT) IN(SELECT row_ref FROM erasure_chunk WHERE request_id=?)",
        params: [scope.userId, scope.reference],
      },
      {
        sql: "UPDATE billing_provider_transactions AS r SET attempt_id=NULL,lookup_attempts=0,last_checked_at_ms=NULL,status=NULL,first_observed_at_ms=NULL,negative_observed_at_ms=NULL,finalized_at_ms=NULL WHERE r.event_received_at_ms IS NOT NULL AND EXISTS(SELECT 1 FROM billing_attempts p WHERE p.id=r.attempt_id AND p.user_id=?) AND CAST(r.rowid AS TEXT) IN(SELECT row_ref FROM erasure_chunk WHERE request_id=?)",
        params: [scope.userId, scope.reference],
      },
    ],
  },

  {
    id: "card_enrollments",
    dataClass: "billing",
    dependencies: ["billing_history", "card_payment_sources"],
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
      sql: "SELECT CAST(r.rowid AS TEXT) AS rowRef,json_object('id',r.\"id\",'user_id',r.\"user_id\",'enrollment_id',r.\"enrollment_id\",'wompi_source_id',r.\"wompi_source_id\",'billing_email',r.\"billing_email\",'created_at_ms',r.\"created_at_ms\",'method',r.\"method\",'retired_at_ms',r.\"retired_at_ms\") AS body FROM verified_payment_sources r WHERE r.user_id=?",
      params: [userId],
    }),
    candidates: (userId) => ({
      sql: "SELECT CAST(r.rowid AS TEXT) AS rowRef FROM verified_payment_sources r WHERE r.user_id=?",
      params: [userId],
    }),
    remaining: (userId) => ({
      sql: "SELECT 1 FROM verified_payment_sources r WHERE r.user_id=?",
      params: [userId],
    }),
    remove: (scope) => [
      {
        sql: "UPDATE card_enrollments AS r SET source_row_ref=NULL,payment_source_id=NULL,source_wompi_id=NULL,source_billing_email=NULL,source_created_at_ms=NULL,source_retired_at_ms=NULL,source_method=NULL WHERE r.payment_source_id IS NOT NULL AND r.user_id=? AND COALESCE(r.source_row_ref,'source:'||r.payment_source_id) IN(SELECT row_ref FROM erasure_chunk WHERE request_id=?)",
        params: [scope.userId, scope.reference],
      },
    ],
  },
  {
    id: "refund_attempts",
    dataClass: "billing",
    dependencies: [],
    quiescence: {
      _tag: "Durable",
      select: ({ userId }) => ({
        sql: "SELECT 1 FROM refund_attempts WHERE user_id=? AND status='pending'",
        params: [userId],
      }),
    },
    select: (userId) => ({
      sql: "SELECT CAST(r.rowid AS TEXT) AS rowRef,json_object('id',r.\"id\",'user_id',r.\"user_id\",'subscription_id',r.\"subscription_id\",'billing_attempt_id',r.\"billing_attempt_id\",'transaction_id',r.\"transaction_id\",'request_id',r.\"request_id\",'intent_json',r.\"intent_json\",'snapshot_json',r.\"snapshot_json\",'amount_in_cents',r.\"amount_in_cents\",'original_cents',r.\"original_cents\",'kind',r.\"kind\",'operator_id',r.\"operator_id\",'created_at_ms',r.\"created_at_ms\",'status',r.\"status\",'progress',r.\"progress\",'finalized_at_ms',r.\"finalized_at_ms\",'failure',r.\"failure\",'work_version',CASE WHEN r.verification_attempts IS NOT NULL THEN 1 END,'dispatch_last_attempt_at_ms',r.dispatch_last_attempt_at_ms,'published_at_ms',r.published_at_ms,'verification_attempts',r.verification_attempts,'last_verification_at_ms',r.last_verification_at_ms,'submission_claimed_at_ms',r.submission_claimed_at_ms,'provider_refund_id',r.provider_refund_id,'verified_status',r.verified_status,'observed_at_ms',r.observed_at_ms,'adjusted_attempt_id',r.adjusted_attempt_id,'access_ends_at_ms',r.access_ends_at_ms,'renewal_stopped_user_id',r.renewal_stopped_user_id,'renewal_stopped_at_ms',r.renewal_stopped_at_ms) AS body FROM refund_attempts r WHERE r.user_id=?",
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
    id: "subscription_cancellations",
    dataClass: "billing",
    dependencies: [],
    quiescence: { _tag: "Synchronous" },
    select: (userId) => ({
      sql: "SELECT CAST(r.rowid AS TEXT) AS rowRef,json_object('user_id',r.\"user_id\",'paid_attempt_id',r.\"paid_attempt_id\",'payment_source_id',r.\"payment_source_id\",'cancelled_at_ms',r.\"cancelled_at_ms\",'paid_through_ms',r.\"paid_through_ms\",'source_cancellation',r.\"source_cancellation\",'void_started_at_ms',r.\"void_started_at_ms\",'void_verified_at_ms',r.\"void_verified_at_ms\",'verification_count',r.\"verification_count\",'last_offered_at_ms',r.\"last_offered_at_ms\") AS body FROM (SELECT rowid,id AS user_id,cancellation_paid_attempt_id AS paid_attempt_id,cancellation_payment_source_id AS payment_source_id,cancellation_cancelled_at_ms AS cancelled_at_ms,cancellation_paid_through_ms AS paid_through_ms,cancellation_source_cancellation AS source_cancellation,cancellation_void_started_at_ms AS void_started_at_ms,cancellation_void_verified_at_ms AS void_verified_at_ms,cancellation_verification_count AS verification_count,cancellation_last_offered_at_ms AS last_offered_at_ms FROM users WHERE cancellation_cancelled_at_ms IS NOT NULL) r WHERE r.user_id=?",
      params: [userId],
    }),
    candidates: (userId) => ({
      sql: "SELECT CAST(r.rowid AS TEXT) AS rowRef FROM (SELECT rowid,id AS user_id,cancellation_paid_attempt_id AS paid_attempt_id,cancellation_payment_source_id AS payment_source_id,cancellation_cancelled_at_ms AS cancelled_at_ms,cancellation_paid_through_ms AS paid_through_ms,cancellation_source_cancellation AS source_cancellation,cancellation_void_started_at_ms AS void_started_at_ms,cancellation_void_verified_at_ms AS void_verified_at_ms,cancellation_verification_count AS verification_count,cancellation_last_offered_at_ms AS last_offered_at_ms FROM users WHERE cancellation_cancelled_at_ms IS NOT NULL) r WHERE r.user_id=?",
      params: [userId],
    }),
    remaining: (userId) => ({
      sql: "SELECT 1 FROM (SELECT rowid,id AS user_id,cancellation_paid_attempt_id AS paid_attempt_id,cancellation_payment_source_id AS payment_source_id,cancellation_cancelled_at_ms AS cancelled_at_ms,cancellation_paid_through_ms AS paid_through_ms,cancellation_source_cancellation AS source_cancellation,cancellation_void_started_at_ms AS void_started_at_ms,cancellation_void_verified_at_ms AS void_verified_at_ms,cancellation_verification_count AS verification_count,cancellation_last_offered_at_ms AS last_offered_at_ms FROM users WHERE cancellation_cancelled_at_ms IS NOT NULL) r WHERE r.user_id=?",
      params: [userId],
    }),
    remove: (scope) => [
      {
        sql: "UPDATE users AS r SET cancellation_paid_attempt_id=NULL,cancellation_payment_source_id=NULL,cancellation_cancelled_at_ms=NULL,cancellation_paid_through_ms=NULL,cancellation_source_cancellation=NULL,cancellation_void_started_at_ms=NULL,cancellation_void_verified_at_ms=NULL,cancellation_verification_count=NULL,cancellation_last_offered_at_ms=NULL WHERE r.cancellation_cancelled_at_ms IS NOT NULL AND r.id=? AND CAST(r.rowid AS TEXT) IN(SELECT row_ref FROM erasure_chunk WHERE request_id=?)",
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
      sql: "SELECT CAST(r.rowid AS TEXT) AS rowRef,json_object('user_id',r.\"user_id\",'id',r.\"id\") AS body FROM (SELECT rowid,id AS user_id,subscription_id AS id FROM users WHERE subscription_id IS NOT NULL) r WHERE r.user_id=?",
      params: [userId],
    }),
    candidates: (userId) => ({
      sql: "SELECT CAST(r.rowid AS TEXT) AS rowRef FROM (SELECT rowid,id AS user_id,subscription_id AS id FROM users WHERE subscription_id IS NOT NULL) r WHERE r.user_id=?",
      params: [userId],
    }),
    remaining: (userId) => ({
      sql: "SELECT 1 FROM (SELECT rowid,id AS user_id,subscription_id AS id FROM users WHERE subscription_id IS NOT NULL) r WHERE r.user_id=?",
      params: [userId],
    }),
    remove: (scope) => [
      {
        sql: "UPDATE users AS r SET subscription_id=NULL WHERE r.id=? AND r.subscription_id IS NOT NULL AND CAST(r.rowid AS TEXT) IN(SELECT row_ref FROM erasure_chunk WHERE request_id=?)",
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
      sql: "SELECT CAST(r.rowid AS TEXT) AS rowRef,json_object('user_id',r.\"user_id\",'attempt_id',r.\"attempt_id\",'price_id',r.\"price_id\",'paid_period_ends_at_ms',r.\"paid_period_ends_at_ms\",'renewal_anchor_ms',r.\"renewal_anchor_ms\") AS body FROM subscription_standing r WHERE r.user_id=?",
      params: [userId],
    }),
    candidates: (userId) => ({
      sql: "SELECT CAST(r.rowid AS TEXT) AS rowRef FROM subscription_standing r WHERE r.user_id=?",
      params: [userId],
    }),
    remaining: (userId) => ({
      sql: "SELECT 1 FROM subscription_standing r WHERE r.user_id=?",
      params: [userId],
    }),
    remove: (scope) => [
      {
        sql: "UPDATE users AS r SET paid_attempt_id=NULL,paid_price_id=NULL,paid_period_ends_at_ms=NULL,paid_renewal_anchor_ms=NULL WHERE r.id=? AND paid_attempt_id IS NOT NULL AND CAST(r.rowid AS TEXT) IN(SELECT row_ref FROM erasure_chunk WHERE request_id=?)",
        params: [scope.userId, scope.reference],
      },
    ],
  },
  {
    id: "billing_history",
    dataClass: "billing",
    dependencies: [
      "billing_audit",
      "billing_checkout_responses",
      "billing_provider_transactions",
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
      sql: "SELECT 'attempt:'||a.id AS rowRef,json_object('id',a.id,'user_id',a.user_id,'enrollment_id',a.enrollment_id,'payment_request_id',a.payment_request_id,'payment_source_id',a.payment_source_id,'price_id',a.price_id,'amount',a.amount,'currency',a.currency,'billing_period',a.billing_period,'service_market',a.service_market,'tax_treatment',a.tax_treatment,'time_zone',a.time_zone,'wompi_environment',a.wompi_environment,'wompi_reference',a.wompi_reference,'status',a.status,'created_at_ms',a.created_at_ms,'finalized_at_ms',a.finalized_at_ms,'previous_paid_attempt_id',a.previous_paid_attempt_id,'period_starts_at_ms',a.period_starts_at_ms,'period_ends_at_ms',a.period_ends_at_ms,'attempt_number',1,'calendar_anchor_ms',a.calendar_anchor_ms,'renewal_attempt_number',a.renewal_attempt_number,'paid_starts_at_ms',a.paid_starts_at_ms,'paid_ends_at_ms',a.paid_ends_at_ms,'paid_renewal_anchor_ms',a.paid_renewal_anchor_ms,'checkout_transaction_id',a.checkout_transaction_id,'collection_state',a.collection_state,'collection_sent_at_ms',a.collection_sent_at_ms,'collection_last_attempt_at_ms',a.collection_last_attempt_at_ms,'followup_kind',CASE WHEN a.followup_due_at_ms IS NOT NULL THEN 'renewal_due' END,'followup_due_at_ms',a.followup_due_at_ms,'no_charge_reference',a.no_charge_reference,'no_charge_environment',a.no_charge_environment,'no_charge_case_id',a.no_charge_case_id,'no_charge_operator_id',a.no_charge_operator_id,'no_charge_confirmed_at_ms',a.no_charge_confirmed_at_ms,'recovery_case_id',a.recovery_case_id,'recovery_reviewed_at_ms',a.recovery_reviewed_at_ms) AS body FROM billing_attempts a WHERE a.user_id=?",
      params: [userId],
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
        sql: "DELETE FROM billing_attempts WHERE user_id=? AND id IN(SELECT row_ref FROM erasure_chunk WHERE request_id=?)",
        params: [scope.userId, scope.reference],
      },
    ],
  },
];
