import type { ErasureProjection } from "../../erasure-store/contract";

/** Purpose identifiers keep exact erasure permits and archive policies over the shared physical store. */
const entryProjection = ({
  id,
  recordType,
  dataClass,
  archiveFields,
}: Readonly<{
  id: string;
  recordType: string;
  dataClass: ErasureProjection["dataClass"];
  archiveFields: ReadonlyArray<string>;
}>): ErasureProjection => {
  const owner =
    recordType === "billing_transition"
      ? "r.attempt_id IN (SELECT a.id FROM billing_attempt_context a WHERE a.user_id=?)"
      : "r.user_id=?";
  const scope = owner + " AND r.record_type='" + recordType + "'";
  const body =
    "json_object(" +
    archiveFields
      .map((field) => `'${field}',r."${field === "accepted_at_ms" ? "occurred_at_ms" : field}"`)
      .join(",") +
    ")";
  return {
    id,
    dataClass,
    dependencies: [],
    quiescence: { _tag: "Synchronous" },
    select: (userId) => ({
      sql: `SELECT CAST(r.sequence AS TEXT) AS rowRef,${body} AS body FROM audit_entries r WHERE ${scope}`,
      params: [userId],
    }),
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
        sql: `DELETE FROM audit_entries AS r WHERE ${scope} AND CAST(r.sequence AS TEXT) IN (SELECT row_ref FROM erasure_chunk WHERE request_id=?)`,
        params: [subject.userId, subject.reference],
      },
    ],
  };
};

export const projections: ReadonlyArray<ErasureProjection> = [
  entryProjection({
    id: "canonical_request_acceptances",
    recordType: "request_admission",
    dataClass: "schedules",
    archiveFields: ["id", "user_id", "pat_id", "operation", "accepted_at_ms"],
  }),
  entryProjection({
    id: "canonical_user_reads",
    recordType: "identity_read",
    dataClass: "schedules",
    archiveFields: ["id", "user_id", "session_id", "occurred_at_ms"],
  }),
  entryProjection({
    id: "canonical_security_mutations",
    recordType: "security_mutation",
    dataClass: "schedules",
    archiveFields: ["id", "user_id", "session_id", "operation", "occurred_at_ms"],
  }),
  entryProjection({
    id: "session_audit",
    recordType: "session_call",
    dataClass: "audit",
    archiveFields: ["id", "user_id", "session_id", "operation", "outcome", "occurred_at_ms"],
  }),
  entryProjection({
    id: "insight_audit",
    recordType: "insight_call",
    dataClass: "audit",
    archiveFields: [
      "id",
      "user_id",
      "session_id",
      "hosted_turn_id",
      "operation",
      "outcome",
      "occurred_at_ms",
    ],
  }),
  entryProjection({
    id: "ingestion_publication_audit",
    recordType: "publication",
    dataClass: "audit",
    archiveFields: ["id", "user_id", "operation", "outcome", "occurred_at_ms"],
  }),
  entryProjection({
    id: "media_submission_audit",
    recordType: "media_admission",
    dataClass: "audit",
    archiveFields: ["id", "user_id", "outcome", "occurred_at_ms"],
  }),
  entryProjection({
    id: "billing_audit",
    recordType: "billing_transition",
    dataClass: "audit",
    archiveFields: ["attempt_id", "transition", "occurred_at_ms"],
  }),
  entryProjection({
    id: "pat_audit",
    recordType: "credential_call",
    dataClass: "credentials",
    archiveFields: [],
  }),

  {
    id: "audit_retention_permits",
    dataClass: "audit",
    dependencies: [],
    quiescence: { _tag: "Synchronous" },
    select: (userId) => ({
      sql: "SELECT CAST(r.rowid AS TEXT) AS rowRef,json_object('user_id',r.\"user_id\",'cutoff_ms',r.\"cutoff_ms\") AS body FROM audit_retention_permits r WHERE r.user_id=?",
      params: [userId],
    }),
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
        sql: "DELETE FROM audit_retention_permits AS r WHERE r.user_id=? AND CAST(r.rowid AS TEXT) IN(SELECT row_ref FROM erasure_chunk WHERE request_id=?)",
        params: [scope.userId, scope.reference],
      },
    ],
  },
];
