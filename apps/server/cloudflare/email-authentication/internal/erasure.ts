import type { ErasureProjection } from "../../erasure-store/contract";

export const projections: ReadonlyArray<ErasureProjection> = [
  {
    id: "browser_pairing_email_outbox",
    dataClass: "credentials",
    dependencies: [],
    quiescence: { _tag: "Synchronous" },
    select: (userId) => ({
      sql: "SELECT CAST(r.rowid AS TEXT) AS rowRef,'{}' AS body FROM browser_pairing_email_outbox r WHERE EXISTS(SELECT 1 FROM browser_pairing_email_proofs p WHERE p.work_id=r.id AND p.user_id=?)",
      params: [userId],
    }),
    candidates: (userId) => ({
      sql: "SELECT CAST(r.rowid AS TEXT) AS rowRef FROM browser_pairing_email_outbox r WHERE EXISTS(SELECT 1 FROM browser_pairing_email_proofs p WHERE p.work_id=r.id AND p.user_id=?)",
      params: [userId],
    }),
    remaining: (userId) => ({
      sql: "SELECT 1 FROM browser_pairing_email_outbox r WHERE EXISTS(SELECT 1 FROM browser_pairing_email_proofs p WHERE p.work_id=r.id AND p.user_id=?)",
      params: [userId],
    }),
    remove: (scope) => [
      {
        sql: "DELETE FROM browser_pairing_email_outbox AS r WHERE EXISTS(SELECT 1 FROM browser_pairing_email_proofs p WHERE p.work_id=r.id AND p.user_id=?) AND CAST(r.rowid AS TEXT) IN(SELECT row_ref FROM erasure_chunk WHERE request_id=?)",
        params: [scope.userId, scope.reference],
      },
    ],
  },
  {
    id: "browser_pairing_email_proofs",
    dataClass: "credentials",
    dependencies: ["browser_pairing_email_outbox"],
    quiescence: {
      _tag: "Durable",
      select: ({ current, userId }) => ({
        sql: "SELECT 1 FROM browser_pairing_email_proofs WHERE user_id=? AND state IN('awaiting_delivery','sending') AND expires_at_ms>?",
        params: [userId, current],
      }),
    },
    select: (userId) => ({
      sql: "SELECT CAST(r.rowid AS TEXT) AS rowRef,'{}' AS body FROM browser_pairing_email_proofs r WHERE r.user_id=?",
      params: [userId],
    }),
    candidates: (userId) => ({
      sql: "SELECT CAST(r.rowid AS TEXT) AS rowRef FROM browser_pairing_email_proofs r WHERE r.user_id=?",
      params: [userId],
    }),
    remaining: (userId) => ({
      sql: "SELECT 1 FROM browser_pairing_email_proofs r WHERE r.user_id=?",
      params: [userId],
    }),
    remove: (scope) => [
      {
        sql: "DELETE FROM browser_pairing_email_proofs AS r WHERE r.user_id=? AND CAST(r.rowid AS TEXT) IN(SELECT row_ref FROM erasure_chunk WHERE request_id=?)",
        params: [scope.userId, scope.reference],
      },
    ],
  },
  {
    id: "browser_pairing_email_user_limits",
    dataClass: "credentials",
    dependencies: [],
    quiescence: { _tag: "Synchronous" },
    select: (userId) => ({
      sql: "SELECT CAST(r.rowid AS TEXT) AS rowRef,'{}' AS body FROM browser_pairing_email_user_limits r WHERE r.user_id=?",
      params: [userId],
    }),
    candidates: (userId) => ({
      sql: "SELECT CAST(r.rowid AS TEXT) AS rowRef FROM browser_pairing_email_user_limits r WHERE r.user_id=?",
      params: [userId],
    }),
    remaining: (userId) => ({
      sql: "SELECT 1 FROM browser_pairing_email_user_limits r WHERE r.user_id=?",
      params: [userId],
    }),
    remove: (scope) => [
      {
        sql: "DELETE FROM browser_pairing_email_user_limits AS r WHERE r.user_id=? AND CAST(r.rowid AS TEXT) IN(SELECT row_ref FROM erasure_chunk WHERE request_id=?)",
        params: [scope.userId, scope.reference],
      },
    ],
  },
  {
    id: "email_replacement_limits",
    dataClass: "credentials",
    dependencies: [],
    quiescence: { _tag: "Synchronous" },
    select: (userId) => ({
      sql: "SELECT CAST(r.rowid AS TEXT) AS rowRef,'{}' AS body FROM email_replacement_limits r WHERE r.user_id=?",
      params: [userId],
    }),
    candidates: (userId) => ({
      sql: "SELECT CAST(r.rowid AS TEXT) AS rowRef FROM email_replacement_limits r WHERE r.user_id=?",
      params: [userId],
    }),
    remaining: (userId) => ({
      sql: "SELECT 1 FROM email_replacement_limits r WHERE r.user_id=?",
      params: [userId],
    }),
    remove: (scope) => [
      {
        sql: "DELETE FROM email_replacement_limits AS r WHERE r.user_id=? AND CAST(r.rowid AS TEXT) IN(SELECT row_ref FROM erasure_chunk WHERE request_id=?)",
        params: [scope.userId, scope.reference],
      },
    ],
  },
  {
    id: "email_replacement_outbox",
    dataClass: "credentials",
    dependencies: [],
    quiescence: { _tag: "Synchronous" },
    select: (userId) => ({
      sql: "SELECT CAST(r.rowid AS TEXT) AS rowRef,'{}' AS body FROM email_replacement_outbox r WHERE EXISTS(SELECT 1 FROM email_replacements p WHERE p.work_id=r.id AND p.user_id=?)",
      params: [userId],
    }),
    candidates: (userId) => ({
      sql: "SELECT CAST(r.rowid AS TEXT) AS rowRef FROM email_replacement_outbox r WHERE EXISTS(SELECT 1 FROM email_replacements p WHERE p.work_id=r.id AND p.user_id=?)",
      params: [userId],
    }),
    remaining: (userId) => ({
      sql: "SELECT 1 FROM email_replacement_outbox r WHERE EXISTS(SELECT 1 FROM email_replacements p WHERE p.work_id=r.id AND p.user_id=?)",
      params: [userId],
    }),
    remove: (scope) => [
      {
        sql: "DELETE FROM email_replacement_outbox AS r WHERE EXISTS(SELECT 1 FROM email_replacements p WHERE p.work_id=r.id AND p.user_id=?) AND CAST(r.rowid AS TEXT) IN(SELECT row_ref FROM erasure_chunk WHERE request_id=?)",
        params: [scope.userId, scope.reference],
      },
    ],
  },
  {
    id: "email_replacements",
    dataClass: "credentials",
    dependencies: ["email_replacement_outbox"],
    quiescence: {
      _tag: "Durable",
      select: ({ current, userId }) => ({
        sql: "SELECT 1 FROM email_replacements WHERE user_id=? AND state IN('awaiting_delivery','sending') AND expires_at_ms>?",
        params: [userId, current],
      }),
    },
    select: (userId) => ({
      sql: "SELECT CAST(r.rowid AS TEXT) AS rowRef,'{}' AS body FROM email_replacements r WHERE r.user_id=?",
      params: [userId],
    }),
    candidates: (userId) => ({
      sql: "SELECT CAST(r.rowid AS TEXT) AS rowRef FROM email_replacements r WHERE r.user_id=?",
      params: [userId],
    }),
    remaining: (userId) => ({
      sql: "SELECT 1 FROM email_replacements r WHERE r.user_id=?",
      params: [userId],
    }),
    remove: (scope) => [
      {
        sql: "DELETE FROM email_replacements AS r WHERE r.user_id=? AND CAST(r.rowid AS TEXT) IN(SELECT row_ref FROM erasure_chunk WHERE request_id=?)",
        params: [scope.userId, scope.reference],
      },
    ],
  },
  {
    id: "verified_email_credentials",
    dataClass: "credentials",
    dependencies: [],
    quiescence: { _tag: "Synchronous" },
    select: (userId) => ({
      sql: "SELECT CAST(r.rowid AS TEXT) AS rowRef,'{}' AS body FROM verified_email_credentials r WHERE r.user_id=?",
      params: [userId],
    }),
    candidates: (userId) => ({
      sql: "SELECT CAST(r.rowid AS TEXT) AS rowRef FROM verified_email_credentials r WHERE r.user_id=?",
      params: [userId],
    }),
    remaining: (userId) => ({
      sql: "SELECT 1 FROM verified_email_credentials r WHERE r.user_id=?",
      params: [userId],
    }),
    remove: (scope) => [
      {
        sql: "DELETE FROM verified_email_credentials AS r WHERE r.user_id=? AND CAST(r.rowid AS TEXT) IN(SELECT row_ref FROM erasure_chunk WHERE request_id=?)",
        params: [scope.userId, scope.reference],
      },
    ],
  },
];
