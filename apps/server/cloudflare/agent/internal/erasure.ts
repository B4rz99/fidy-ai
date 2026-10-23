import type { ErasureProjection } from "../../erasure-store/contract";

export const projections: ReadonlyArray<ErasureProjection> = [
  {
    id: "hosted_agent_sessions",
    dataClass: "conversation",
    dependencies: ["hosted_turns", "transcript_entries"],
    quiescence: { _tag: "Synchronous" },

    candidates: (userId) => ({
      sql: "SELECT CAST(r.rowid AS TEXT) AS rowRef FROM hosted_agent_sessions r WHERE r.user_id=?",
      params: [userId],
    }),
    remaining: (userId) => ({
      sql: "SELECT 1 FROM hosted_agent_sessions r WHERE r.user_id=?",
      params: [userId],
    }),
    remove: (scope) => [
      {
        sql: "DELETE FROM hosted_agent_sessions AS r WHERE r.user_id=? AND CAST(r.rowid AS TEXT) IN(SELECT value AS row_ref FROM json_each(?))",
        params: [scope.userId, scope.rowRefsJson],
      },
    ],
  },
  {
    id: "hosted_confirmations",
    dataClass: "conversation",
    dependencies: [],
    quiescence: { _tag: "Synchronous" },

    candidates: (userId) => ({
      sql: "SELECT CAST(r.rowid AS TEXT) AS rowRef FROM hosted_confirmations r WHERE r.user_id=?",
      params: [userId],
    }),
    remaining: (userId) => ({
      sql: "SELECT 1 FROM hosted_confirmations r WHERE r.user_id=?",
      params: [userId],
    }),
    remove: (scope) => [
      {
        sql: "DELETE FROM hosted_confirmations AS r WHERE r.user_id=? AND CAST(r.rowid AS TEXT) IN(SELECT value AS row_ref FROM json_each(?))",
        params: [scope.userId, scope.rowRefsJson],
      },
    ],
  },
  {
    id: "hosted_mutation_commits",
    dataClass: "conversation",
    dependencies: [],
    quiescence: { _tag: "Synchronous" },

    candidates: (userId) => ({
      sql: "SELECT CAST(r.rowid AS TEXT) AS rowRef FROM hosted_mutation_commits r WHERE r.user_id=?",
      params: [userId],
    }),
    remaining: (userId) => ({
      sql: "SELECT 1 FROM hosted_mutation_commits r WHERE r.user_id=?",
      params: [userId],
    }),
    remove: (scope) => [
      {
        sql: "DELETE FROM hosted_mutation_commits AS r WHERE r.user_id=? AND CAST(r.rowid AS TEXT) IN(SELECT value AS row_ref FROM json_each(?))",
        params: [scope.userId, scope.rowRefsJson],
      },
    ],
  },
  {
    id: "hosted_turns",
    dataClass: "conversation",
    dependencies: [
      "dashboard_projection_leaf",
      "hosted_confirmations",
      "hosted_mutation_commits",
      "hosted_whatsapp_inbound",
      "insight_audit",
      "pat_audit",
      "statement_whatsapp_documents",
      "transaction_reconciliation_decisions",
      "transaction_reconciliation_members",
      "transactions",
      "transcript_entries",
    ],
    quiescence: {
      _tag: "Durable",
      select: ({ userId }) => ({
        sql: "SELECT 1 FROM hosted_turns WHERE user_id=? AND status='pending'",
        params: [userId],
      }),
    },

    candidates: (userId) => ({
      sql: "SELECT CAST(r.rowid AS TEXT) AS rowRef FROM hosted_turns r WHERE r.user_id=?",
      params: [userId],
    }),
    remaining: (userId) => ({
      sql: "SELECT 1 FROM hosted_turns r WHERE r.user_id=?",
      params: [userId],
    }),
    remove: (scope) => [
      {
        sql: "DELETE FROM hosted_turns AS r WHERE r.user_id=? AND CAST(r.rowid AS TEXT) IN(SELECT value AS row_ref FROM json_each(?))",
        params: [scope.userId, scope.rowRefsJson],
      },
    ],
  },
  {
    id: "proactive_transcript_entries",
    dataClass: "conversation",
    dependencies: ["proactive_transcript_event_links"],
    quiescence: { _tag: "Synchronous" },

    candidates: (userId) => ({
      sql: "SELECT CAST(r.rowid AS TEXT) AS rowRef FROM proactive_transcript_entries r WHERE r.user_id=?",
      params: [userId],
    }),
    remaining: (userId) => ({
      sql: "SELECT 1 FROM proactive_transcript_entries r WHERE r.user_id=?",
      params: [userId],
    }),
    remove: (scope) => [
      {
        sql: "DELETE FROM proactive_transcript_entries AS r WHERE r.user_id=? AND CAST(r.rowid AS TEXT) IN(SELECT value AS row_ref FROM json_each(?))",
        params: [scope.userId, scope.rowRefsJson],
      },
    ],
  },
  {
    id: "proactive_transcript_event_links",
    dataClass: "conversation",
    dependencies: [],
    quiescence: { _tag: "Synchronous" },

    candidates: (userId) => ({
      sql: "SELECT CAST(r.rowid AS TEXT) AS rowRef FROM (SELECT rowid,user_id AS user_id,transcript_id AS transcript_id,id AS insight_event_id,transcript_kind AS transcript_kind FROM insight_events WHERE transcript_id IS NOT NULL) r WHERE r.user_id=?",
      params: [userId],
    }),
    remaining: (userId) => ({
      sql: "SELECT 1 FROM (SELECT rowid,user_id AS user_id,transcript_id AS transcript_id,id AS insight_event_id,transcript_kind AS transcript_kind FROM insight_events WHERE transcript_id IS NOT NULL) r WHERE r.user_id=?",
      params: [userId],
    }),
    remove: (scope) => [
      {
        sql: "UPDATE insight_events AS r SET transcript_id=NULL,transcript_kind=NULL WHERE r.user_id=? AND transcript_id IS NOT NULL AND CAST(r.rowid AS TEXT) IN(SELECT value AS row_ref FROM json_each(?))",
        params: [scope.userId, scope.rowRefsJson],
      },
    ],
  },
  {
    id: "transcript_entries",
    dataClass: "conversation",
    dependencies: [],
    quiescence: { _tag: "Synchronous" },

    candidates: (userId) => ({
      sql: "SELECT CAST(r.rowid AS TEXT) AS rowRef FROM transcript_entries r WHERE r.user_id=?",
      params: [userId],
    }),
    remaining: (userId) => ({
      sql: "SELECT 1 FROM transcript_entries r WHERE r.user_id=?",
      params: [userId],
    }),
    remove: (scope) => [
      {
        sql: "DELETE FROM transcript_entries AS r WHERE r.user_id=? AND CAST(r.rowid AS TEXT) IN(SELECT value AS row_ref FROM json_each(?))",
        params: [scope.userId, scope.rowRefsJson],
      },
    ],
  },
];
