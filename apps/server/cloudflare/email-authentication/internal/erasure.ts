import type { ErasureProjection } from "../../erasure-store/contract";

export const projections: ReadonlyArray<ErasureProjection> = [
  {
    id: "browser_pairing_email_proofs",
    dataClass: "credentials",
    dependencies: [],
    quiescence: {
      _tag: "Durable",
      select: ({ current, userId }) => ({
        sql: "SELECT 1 FROM (SELECT rowid,id AS pairing_id,email_work_id AS work_id,email_user_id AS user_id,email_address,email_credential_verified_at_ms AS credential_verified_at_ms,email_state AS state,email_public_code AS public_code,email_proof_digest AS proof_digest,email_proof_expires_at_ms AS proof_expires_at_ms,email_expires_at_ms AS expires_at_ms,email_generation AS generation,email_wrong_attempts AS wrong_attempts,email_last_requested_at_ms AS last_requested_at_ms,email_dispatch_attempted_at_ms AS dispatch_attempted_at_ms FROM browser_login_pairings WHERE email_work_id IS NOT NULL) AS browser_pairing_email_proofs WHERE user_id=? AND state IN('awaiting_delivery','sending') AND expires_at_ms>?",
        params: [userId, current],
      }),
    },
    select: (userId) => ({
      sql: "SELECT CAST(r.rowid AS TEXT) AS rowRef,'{}' AS body FROM (SELECT rowid,id AS pairing_id,email_work_id AS work_id,email_user_id AS user_id,email_address,email_credential_verified_at_ms AS credential_verified_at_ms,email_state AS state,email_public_code AS public_code,email_proof_digest AS proof_digest,email_proof_expires_at_ms AS proof_expires_at_ms,email_expires_at_ms AS expires_at_ms,email_generation AS generation,email_wrong_attempts AS wrong_attempts,email_last_requested_at_ms AS last_requested_at_ms,email_dispatch_attempted_at_ms AS dispatch_attempted_at_ms FROM browser_login_pairings WHERE email_work_id IS NOT NULL) r WHERE r.user_id=?",
      params: [userId],
    }),
    candidates: (userId) => ({
      sql: "SELECT CAST(r.rowid AS TEXT) AS rowRef FROM (SELECT rowid,id AS pairing_id,email_work_id AS work_id,email_user_id AS user_id,email_address,email_credential_verified_at_ms AS credential_verified_at_ms,email_state AS state,email_public_code AS public_code,email_proof_digest AS proof_digest,email_proof_expires_at_ms AS proof_expires_at_ms,email_expires_at_ms AS expires_at_ms,email_generation AS generation,email_wrong_attempts AS wrong_attempts,email_last_requested_at_ms AS last_requested_at_ms,email_dispatch_attempted_at_ms AS dispatch_attempted_at_ms FROM browser_login_pairings WHERE email_work_id IS NOT NULL) r WHERE r.user_id=?",
      params: [userId],
    }),
    remaining: (userId) => ({
      sql: "SELECT 1 FROM (SELECT rowid,id AS pairing_id,email_work_id AS work_id,email_user_id AS user_id,email_address,email_credential_verified_at_ms AS credential_verified_at_ms,email_state AS state,email_public_code AS public_code,email_proof_digest AS proof_digest,email_proof_expires_at_ms AS proof_expires_at_ms,email_expires_at_ms AS expires_at_ms,email_generation AS generation,email_wrong_attempts AS wrong_attempts,email_last_requested_at_ms AS last_requested_at_ms,email_dispatch_attempted_at_ms AS dispatch_attempted_at_ms FROM browser_login_pairings WHERE email_work_id IS NOT NULL) r WHERE r.user_id=?",
      params: [userId],
    }),
    remove: (scope) => [
      {
        sql: "UPDATE browser_login_pairings AS r SET email_work_id=NULL,email_user_id=NULL,email_address=NULL,email_credential_verified_at_ms=NULL,email_state=NULL,email_public_code=NULL,email_proof_digest=NULL,email_proof_expires_at_ms=NULL,email_expires_at_ms=NULL,email_generation=NULL,email_wrong_attempts=NULL,email_last_requested_at_ms=NULL,email_dispatch_attempted_at_ms=NULL WHERE email_work_id IS NOT NULL AND r.email_user_id=? AND CAST(r.rowid AS TEXT) IN(SELECT value AS row_ref FROM json_each(?))",
        params: [scope.userId, scope.rowRefsJson],
      },
    ],
  },
  {
    id: "email_replacements",
    dataClass: "credentials",
    dependencies: [],
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
        sql: "DELETE FROM email_replacements AS r WHERE r.user_id=? AND CAST(r.rowid AS TEXT) IN(SELECT value AS row_ref FROM json_each(?))",
        params: [scope.userId, scope.rowRefsJson],
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
        sql: "DELETE FROM verified_email_credentials AS r WHERE r.user_id=? AND CAST(r.rowid AS TEXT) IN(SELECT value AS row_ref FROM json_each(?))",
        params: [scope.userId, scope.rowRefsJson],
      },
    ],
  },
];
