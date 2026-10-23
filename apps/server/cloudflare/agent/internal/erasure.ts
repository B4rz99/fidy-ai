import type { ErasureProjection } from "../../erasure-store/contract";

export const projections: ReadonlyArray<ErasureProjection> = [
  {
    id: "hosted_agent_sessions",
    dataClass: "conversation",
    dependencies: ["hosted_turns", "transcript_entries"],
    quiescence: { _tag: "Synchronous" },
    select: (userId) => ({
      sql: "SELECT CAST(r.rowid AS TEXT) AS rowRef,json_object('id',r.\"id\",'user_id',r.\"user_id\",'consent_basis_json',r.\"consent_basis_json\",'started_at_ms',r.\"started_at_ms\",'last_activity_at_ms',r.\"last_activity_at_ms\",'status',r.\"status\",'compacted_text',r.compacted_text,'compacted_through_sequence',r.compacted_through_sequence,'compacted_revision',r.compacted_revision,'compacted_at_ms',r.compacted_at_ms) AS body FROM hosted_agent_sessions r WHERE r.user_id=?",
      params: [userId],
    }),
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
        sql: "DELETE FROM hosted_agent_sessions AS r WHERE r.user_id=? AND CAST(r.rowid AS TEXT) IN(SELECT row_ref FROM erasure_chunk WHERE request_id=?)",
        params: [scope.userId, scope.reference],
      },
    ],
  },
  {
    id: "hosted_confirmations",
    dataClass: "conversation",
    dependencies: [],
    quiescence: { _tag: "Synchronous" },
    select: (userId) => ({
      sql: "SELECT CAST(r.rowid AS TEXT) AS rowRef,json_object('id',r.\"id\",'user_id',r.\"user_id\",'issued_turn_id',r.\"issued_turn_id\",'operation',r.\"operation\",'input_json',r.\"input_json\",'command',r.\"command\",'issued_at_ms',r.\"issued_at_ms\",'expires_at_ms',r.\"expires_at_ms\",'consumed_turn_id',r.\"consumed_turn_id\",'consumed_at_ms',r.\"consumed_at_ms\") AS body FROM hosted_confirmations r WHERE r.user_id=?",
      params: [userId],
    }),
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
        sql: "DELETE FROM hosted_confirmations AS r WHERE r.user_id=? AND CAST(r.rowid AS TEXT) IN(SELECT row_ref FROM erasure_chunk WHERE request_id=?)",
        params: [scope.userId, scope.reference],
      },
    ],
  },
  {
    id: "hosted_mutation_commits",
    dataClass: "conversation",
    dependencies: [],
    quiescence: { _tag: "Synchronous" },
    select: (userId) => ({
      sql: "SELECT CAST(r.rowid AS TEXT) AS rowRef,json_object('turn_id',r.\"turn_id\",'tool_call_id',r.\"tool_call_id\",'user_id',r.\"user_id\",'committed_at_ms',r.\"committed_at_ms\",'valid',1) AS body FROM hosted_mutation_commits r WHERE r.user_id=?",
      params: [userId],
    }),
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
        sql: "DELETE FROM hosted_mutation_commits AS r WHERE r.user_id=? AND CAST(r.rowid AS TEXT) IN(SELECT row_ref FROM erasure_chunk WHERE request_id=?)",
        params: [scope.userId, scope.reference],
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
    select: (userId) => ({
      sql: "SELECT CAST(r.rowid AS TEXT) AS rowRef,json_object('id',r.\"id\",'user_id',r.\"user_id\",'hosted_session_id',r.\"hosted_session_id\",'started_at_ms',r.\"started_at_ms\",'terminal_at_ms',r.\"terminal_at_ms\",'status',r.\"status\",'failure_reason',r.\"failure_reason\",'proposal_user_id',CASE WHEN r.proposed_at_ms IS NOT NULL THEN r.user_id END,'proposed_at_ms',r.proposed_at_ms,'proposal_text',r.proposal_text,'retention_user_id',CASE WHEN r.retention_terminal_at_ms IS NOT NULL THEN r.user_id END,'retention_terminal_at_ms',r.retention_terminal_at_ms) AS body FROM hosted_turns r WHERE r.user_id=?",
      params: [userId],
    }),
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
        sql: "DELETE FROM hosted_turns AS r WHERE r.user_id=? AND CAST(r.rowid AS TEXT) IN(SELECT row_ref FROM erasure_chunk WHERE request_id=?)",
        params: [scope.userId, scope.reference],
      },
    ],
  },
  {
    id: "proactive_transcript_entries",
    dataClass: "conversation",
    dependencies: ["proactive_transcript_event_links"],
    quiescence: { _tag: "Synchronous" },
    select: (userId) => ({
      sql: "SELECT CAST(r.rowid AS TEXT) AS rowRef,json_object('kind',r.\"kind\",'delivery_id',r.\"delivery_id\",'role',r.\"role\",'sequence',r.\"sequence\",'id',r.\"id\",'user_id',r.\"user_id\",'insight_event_id',r.\"insight_event_id\",'occurred_at_ms',r.\"occurred_at_ms\",'text',r.\"text\",'expires_at_ms',r.\"expires_at_ms\") AS body FROM proactive_transcript_entries r WHERE r.user_id=?",
      params: [userId],
    }),
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
        sql: "DELETE FROM proactive_transcript_entries AS r WHERE r.user_id=? AND CAST(r.rowid AS TEXT) IN(SELECT row_ref FROM erasure_chunk WHERE request_id=?)",
        params: [scope.userId, scope.reference],
      },
    ],
  },
  {
    id: "proactive_transcript_event_links",
    dataClass: "conversation",
    dependencies: [],
    quiescence: { _tag: "Synchronous" },
    select: (userId) => ({
      sql: "SELECT CAST(r.rowid AS TEXT) AS rowRef,json_object('transcript_kind',r.\"transcript_kind\",'user_id',r.\"user_id\",'transcript_id',r.\"transcript_id\",'insight_event_id',r.\"insight_event_id\") AS body FROM (SELECT rowid,user_id AS user_id,transcript_id AS transcript_id,id AS insight_event_id,transcript_kind AS transcript_kind FROM insight_events WHERE transcript_id IS NOT NULL) r WHERE r.user_id=?",
      params: [userId],
    }),
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
        sql: "UPDATE insight_events AS r SET transcript_id=NULL,transcript_kind=NULL WHERE r.user_id=? AND transcript_id IS NOT NULL AND CAST(r.rowid AS TEXT) IN(SELECT row_ref FROM erasure_chunk WHERE request_id=?)",
        params: [scope.userId, scope.reference],
      },
    ],
  },
  {
    id: "transcript_entries",
    dataClass: "conversation",
    dependencies: [],
    quiescence: { _tag: "Synchronous" },
    select: (userId) => ({
      sql: "SELECT CAST(r.rowid AS TEXT) AS rowRef,json_object('sequence',r.\"sequence\",'id',r.\"id\",'user_id',r.\"user_id\",'hosted_session_id',r.\"hosted_session_id\",'turn_id',r.\"turn_id\",'kind',r.\"kind\",'occurred_at_ms',r.\"occurred_at_ms\",'text',r.\"text\",'failure_reason',r.\"failure_reason\",'iteration',r.\"iteration\",'tool_call_id',r.\"tool_call_id\",'operation',r.\"operation\",'input_json',r.\"input_json\",'outcome_json',r.\"outcome_json\") AS body FROM transcript_entries r WHERE r.user_id=?",
      params: [userId],
    }),
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
        sql: "DELETE FROM transcript_entries AS r WHERE r.user_id=? AND CAST(r.rowid AS TEXT) IN(SELECT row_ref FROM erasure_chunk WHERE request_id=?)",
        params: [scope.userId, scope.reference],
      },
    ],
  },
];
