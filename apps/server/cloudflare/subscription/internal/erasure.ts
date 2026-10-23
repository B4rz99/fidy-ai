import type { ErasureProjection } from "../../erasure-store/contract";

export const projections: ReadonlyArray<ErasureProjection> = [
  {
    id: "billing_event_candidates",
    dataClass: "billing",
    dependencies: [],
    quiescence: { _tag: "Synchronous" },

    candidates: (userId) => ({
      sql: "SELECT CAST(r.rowid AS TEXT) AS rowRef FROM billing_callback_hints r WHERE EXISTS(SELECT 1 FROM billing_provider_transactions p JOIN billing_attempt_context a ON a.id=p.attempt_id WHERE p.status IS NOT NULL AND p.transaction_id=r.transaction_id AND a.user_id=?)",
      params: [userId],
    }),
    remaining: (userId) => ({
      sql: "SELECT 1 FROM billing_callback_hints r WHERE EXISTS(SELECT 1 FROM billing_provider_transactions p JOIN billing_attempt_context a ON a.id=p.attempt_id WHERE p.status IS NOT NULL AND p.transaction_id=r.transaction_id AND a.user_id=?)",
      params: [userId],
    }),
    remove: (scope) => [
      {
        sql: "UPDATE billing_provider_transactions AS r SET event_row_ref=NULL,event_received_at_ms=NULL,event_signed_at=NULL,event_signed_status=NULL,event_lookup_attempts=NULL,event_last_checked_at_ms=NULL,event_resolved_at_ms=NULL WHERE r.event_received_at_ms IS NOT NULL AND EXISTS(SELECT 1 FROM billing_provider_transactions p JOIN billing_attempt_context a ON a.id=p.attempt_id WHERE p.status IS NOT NULL AND p.transaction_id=r.transaction_id AND a.user_id=?) AND COALESCE(r.event_row_ref,'callback:'||r.transaction_id) IN(SELECT value AS row_ref FROM json_each(?))",
        params: [scope.userId, scope.rowRefsJson],
      },
    ],
  },

  {
    id: "billing_price_notices",
    dataClass: "billing",
    dependencies: [],
    quiescence: { _tag: "Synchronous" },

    candidates: (userId) => ({
      sql: "SELECT CAST(r.rowid AS TEXT) AS rowRef FROM billing_price_notice_context r WHERE r.user_id=?",
      params: [userId],
    }),
    remaining: (userId) => ({
      sql: "SELECT 1 FROM billing_price_notice_context r WHERE r.user_id=?",
      params: [userId],
    }),
    remove: (scope) => [
      {
        sql: "DELETE FROM billing_price_notices AS r WHERE r.subscription_id=(SELECT id FROM subscriptions WHERE user_id=?) AND CAST(r.rowid AS TEXT) IN(SELECT value AS row_ref FROM json_each(?))",
        params: [scope.userId, scope.rowRefsJson],
      },
    ],
  },

  {
    id: "billing_checkout_responses",
    dataClass: "billing",
    dependencies: [],
    quiescence: { _tag: "Synchronous" },

    candidates: (userId) => ({
      sql: "SELECT CAST(rowid AS TEXT) AS rowRef FROM billing_attempt_context WHERE user_id=? AND checkout_transaction_id IS NOT NULL",
      params: [userId],
    }),
    remaining: (userId) => ({
      sql: "SELECT 1 FROM billing_attempt_context WHERE user_id=? AND checkout_transaction_id IS NOT NULL",
      params: [userId],
    }),
    remove: (scope) => [
      {
        sql: "UPDATE billing_attempts SET checkout_transaction_id=NULL WHERE subscription_id=(SELECT id FROM subscriptions WHERE user_id=?) AND checkout_transaction_id IS NOT NULL AND CAST(rowid AS TEXT) IN(SELECT value AS row_ref FROM json_each(?))",
        params: [scope.userId, scope.rowRefsJson],
      },
    ],
  },
  {
    id: "billing_provider_transactions",
    dataClass: "billing",
    dependencies: ["billing_checkout_responses", "billing_event_candidates", "refund_attempts"],
    quiescence: { _tag: "Synchronous" },

    candidates: (userId) => ({
      sql: "SELECT CAST(r.rowid AS TEXT) AS rowRef FROM billing_provider_transactions r WHERE EXISTS(SELECT 1 FROM billing_attempt_context p WHERE p.id=r.attempt_id AND p.user_id=?)",
      params: [userId],
    }),
    remaining: (userId) => ({
      sql: "SELECT 1 FROM billing_provider_transactions r WHERE EXISTS(SELECT 1 FROM billing_attempt_context p WHERE p.id=r.attempt_id AND p.user_id=?)",
      params: [userId],
    }),
    remove: (scope) => [
      {
        sql: "DELETE FROM billing_provider_transactions AS r WHERE r.event_received_at_ms IS NULL AND EXISTS(SELECT 1 FROM billing_attempt_context p WHERE p.id=r.attempt_id AND p.user_id=?) AND CAST(r.rowid AS TEXT) IN(SELECT value AS row_ref FROM json_each(?))",
        params: [scope.userId, scope.rowRefsJson],
      },
      {
        sql: "UPDATE billing_provider_transactions AS r SET attempt_id=NULL,lookup_attempts=0,last_checked_at_ms=NULL,status=NULL,first_observed_at_ms=NULL,negative_observed_at_ms=NULL,finalized_at_ms=NULL WHERE r.event_received_at_ms IS NOT NULL AND EXISTS(SELECT 1 FROM billing_attempt_context p WHERE p.id=r.attempt_id AND p.user_id=?) AND CAST(r.rowid AS TEXT) IN(SELECT value AS row_ref FROM json_each(?))",
        params: [scope.userId, scope.rowRefsJson],
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
        sql: "SELECT 1 FROM payment_enrollment_context WHERE user_id=? AND status IN('preparing','creating','verifying')",
        params: [userId],
      }),
    },

    candidates: (userId) => ({
      sql: "SELECT CAST(r.rowid AS TEXT) AS rowRef FROM payment_enrollment_context r WHERE r.user_id=?",
      params: [userId],
    }),
    remaining: (userId) => ({
      sql: "SELECT 1 FROM payment_enrollment_context r WHERE r.user_id=?",
      params: [userId],
    }),
    remove: (scope) => [
      {
        sql: "DELETE FROM payment_enrollments AS r WHERE r.subscription_id=(SELECT id FROM subscriptions WHERE user_id=?) AND CAST(r.rowid AS TEXT) IN(SELECT value AS row_ref FROM json_each(?))",
        params: [scope.userId, scope.rowRefsJson],
      },
    ],
  },
  {
    id: "card_payment_sources",
    dataClass: "billing",
    dependencies: ["billing_history", "subscription_cancellations"],
    quiescence: { _tag: "Synchronous" },

    candidates: (userId) => ({
      sql: "SELECT CAST(r.rowid AS TEXT) AS rowRef FROM payment_source_context r WHERE r.user_id=?",
      params: [userId],
    }),
    remaining: (userId) => ({
      sql: "SELECT 1 FROM payment_source_context r WHERE r.user_id=?",
      params: [userId],
    }),
    remove: (scope) => [
      {
        sql: "UPDATE payment_enrollments SET payment_source_id=NULL WHERE subscription_id=(SELECT id FROM subscriptions WHERE user_id=?) AND payment_source_id IN(SELECT id FROM payment_sources WHERE archive_row_ref IN(SELECT value AS row_ref FROM json_each(?)))",
        params: [scope.userId, scope.rowRefsJson],
      },
      {
        sql: "DELETE FROM payment_sources WHERE subscription_id=(SELECT id FROM subscriptions WHERE user_id=?) AND archive_row_ref IN(SELECT value AS row_ref FROM json_each(?))",
        params: [scope.userId, scope.rowRefsJson],
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
        sql: "DELETE FROM refund_attempts AS r WHERE r.user_id=? AND CAST(r.rowid AS TEXT) IN(SELECT value AS row_ref FROM json_each(?))",
        params: [scope.userId, scope.rowRefsJson],
      },
    ],
  },

  {
    id: "subscription_cancellations",
    dataClass: "billing",
    dependencies: [],
    quiescence: { _tag: "Synchronous" },

    candidates: (userId) => ({
      sql: "SELECT CAST(r.rowid AS TEXT) AS rowRef FROM subscription_cancellation_context r WHERE r.user_id=?",
      params: [userId],
    }),
    remaining: (userId) => ({
      sql: "SELECT 1 FROM subscription_cancellation_context r WHERE r.user_id=?",
      params: [userId],
    }),
    remove: (scope) => [
      {
        sql: "DELETE FROM subscription_cancellations AS r WHERE r.subscription_id=(SELECT id FROM subscriptions WHERE user_id=?) AND CAST(r.rowid AS TEXT) IN(SELECT value AS row_ref FROM json_each(?))",
        params: [scope.userId, scope.rowRefsJson],
      },
    ],
  },
  {
    id: "subscription_identities",
    dataClass: "billing",
    dependencies: [
      "billing_history",
      "refund_attempts",
      "billing_price_notices",
      "card_enrollments",
      "card_payment_sources",
    ],
    quiescence: { _tag: "Synchronous" },

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
        sql: "DELETE FROM subscriptions AS r WHERE r.user_id=? AND CAST(r.rowid AS TEXT) IN(SELECT value AS row_ref FROM json_each(?))",
        params: [scope.userId, scope.rowRefsJson],
      },
    ],
  },

  {
    id: "subscriptions",
    dataClass: "billing",
    dependencies: [],
    quiescence: { _tag: "Synchronous" },

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
        sql: "UPDATE subscriptions AS r SET current_paid_attempt_id=NULL WHERE r.user_id=? AND current_paid_attempt_id IS NOT NULL AND CAST((SELECT rowid FROM users WHERE id=r.user_id) AS TEXT) IN(SELECT value AS row_ref FROM json_each(?))",
        params: [scope.userId, scope.rowRefsJson],
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
        sql: "SELECT 1 FROM billing_attempt_context WHERE user_id=? AND status='pending'",
        params: [userId],
      }),
    },

    candidates: (userId) => ({
      sql: "SELECT a.id AS rowRef FROM billing_attempt_context a WHERE a.user_id=? AND NOT EXISTS(SELECT 1 FROM billing_attempt_context later WHERE later.previous_paid_attempt_id=a.id)",
      params: [userId],
    }),
    remaining: (userId) => ({
      sql: "SELECT 1 FROM billing_attempt_context WHERE user_id=?",
      params: [userId],
    }),
    remove: (scope) => [
      {
        sql: "DELETE FROM billing_attempts WHERE subscription_id=(SELECT id FROM subscriptions WHERE user_id=?) AND id IN(SELECT value AS row_ref FROM json_each(?))",
        params: [scope.userId, scope.rowRefsJson],
      },
    ],
  },
];
