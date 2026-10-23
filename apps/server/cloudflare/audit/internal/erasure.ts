import type { ErasureProjection } from "../../erasure-store/contract";

/** Purpose identifiers keep exact erasure permits over the shared physical store. */
const entryProjection = ({
  id,
  recordType,
  dataClass,
}: Readonly<{
  id: string;
  recordType: string;
  dataClass: ErasureProjection["dataClass"];
}>): ErasureProjection => {
  const owner =
    recordType === "billing_transition"
      ? "r.attempt_id IN (SELECT a.id FROM billing_attempt_context a WHERE a.user_id=?)"
      : "r.user_id=?";
  const scope = owner + " AND r.record_type='" + recordType + "'";

  return {
    id,
    dataClass,
    dependencies: [],
    quiescence: { _tag: "Synchronous" },

    candidates: (userId) => ({
      sql: `SELECT CAST(r.sequence AS TEXT) AS rowRef FROM audit_entries r WHERE ${scope}`,
      params: [userId],
    }),
    remaining: (userId) => ({
      sql: `SELECT 1 FROM audit_entries r WHERE ${scope}`,
      params: [userId],
    }),
    remove: (subject) => [
      {
        sql: `DELETE FROM audit_entries AS r WHERE ${scope} AND CAST(r.sequence AS TEXT) IN (SELECT value AS row_ref FROM json_each(?))`,
        params: [subject.userId, subject.rowRefsJson],
      },
    ],
  };
};

export const projections: ReadonlyArray<ErasureProjection> = [
  entryProjection({
    id: "canonical_request_acceptances",
    recordType: "request_admission",
    dataClass: "schedules",
  }),
  entryProjection({
    id: "canonical_user_reads",
    recordType: "identity_read",
    dataClass: "schedules",
  }),
  entryProjection({
    id: "canonical_security_mutations",
    recordType: "security_mutation",
    dataClass: "schedules",
  }),
  entryProjection({
    id: "session_audit",
    recordType: "session_call",
    dataClass: "audit",
  }),
  entryProjection({
    id: "insight_audit",
    recordType: "insight_call",
    dataClass: "audit",
  }),
  entryProjection({
    id: "ingestion_publication_audit",
    recordType: "publication",
    dataClass: "audit",
  }),
  entryProjection({
    id: "media_submission_audit",
    recordType: "media_admission",
    dataClass: "audit",
  }),
  entryProjection({
    id: "billing_audit",
    recordType: "billing_transition",
    dataClass: "audit",
  }),
  entryProjection({
    id: "pat_audit",
    recordType: "credential_call",
    dataClass: "credentials",
  }),

  {
    id: "audit_retention_permits",
    dataClass: "audit",
    dependencies: [],
    quiescence: { _tag: "Synchronous" },

    candidates: (userId) => ({
      sql: "SELECT CAST(r.rowid AS TEXT) AS rowRef FROM audit_retention_permits r WHERE r.user_id=?",
      params: [userId],
    }),
    remaining: (userId) => ({
      sql: "SELECT 1 FROM audit_retention_permits r WHERE r.user_id=?",
      params: [userId],
    }),
    remove: (scope) => [
      {
        sql: "DELETE FROM audit_retention_permits AS r WHERE r.user_id=? AND CAST(r.rowid AS TEXT) IN(SELECT value AS row_ref FROM json_each(?))",
        params: [scope.userId, scope.rowRefsJson],
      },
    ],
  },
];
