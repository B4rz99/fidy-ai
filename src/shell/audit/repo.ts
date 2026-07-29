import { Effect, Schema, Struct } from "effect";
import { SqlClient, SqlSchema } from "effect/unstable/sql";
import { UserId } from "~/core/_shared/user";
import { AuditLogEntry } from "~/core/audit/model";

const AuditLogEntryWithoutOccurredAt = AuditLogEntry.mapFields(Struct.omit(["occurredAt"]));
const AuditLogEntryRow = Schema.Struct({
  ...AuditLogEntryWithoutOccurredAt.fields,
  occurredAt: Schema.DateTimeUtcFromDate,
});

const AuditLogEntryMetadata = AuditLogEntry.mapFields(Struct.omit(["id", "subjectUserId"]));
const AppendAuditLogEntryRow = Schema.Struct({
  subjectUserId: UserId,
  ...AuditLogEntryMetadata.fields,
  occurredAt: Schema.DateTimeUtcFromDate,
});

/**
 * Appends metadata-only evidence for one User's canonical call. The database
 * assigns the evidence id; no update or delete operation exists at this seam.
 */
export const appendAuditLogEntry = Effect.fn("appendAuditLogEntry")(function* (
  subjectUserId: UserId,
  metadata: typeof AuditLogEntryMetadata.Type
) {
  const sql = yield* SqlClient.SqlClient;
  return yield* SqlSchema.findOne({
    Request: AppendAuditLogEntryRow,
    Result: AuditLogEntryRow,
    execute: (row) => sql`
      INSERT INTO audit_log_entries (
        user_id, token_id, operation, outcome, occurred_at
      )
      VALUES (
        ${row.subjectUserId}, ${row.tokenId}, ${row.operation},
        ${row.outcome}, ${row.occurredAt}
      )
      RETURNING id, user_id AS "subjectUserId", token_id AS "tokenId",
        operation, outcome, occurred_at AS "occurredAt"
    `,
  })({ subjectUserId, ...metadata }).pipe(Effect.orDie);
});

/** Lists one User's append-only canonical-call evidence in occurrence order. */
export const listAuditLogEntries = (subjectUserId: UserId) =>
  Effect.flatMap(SqlClient.SqlClient, (sql) =>
    SqlSchema.findAll({
      Request: UserId,
      Result: AuditLogEntryRow,
      execute: (userId) => sql`
        SELECT id, user_id AS "subjectUserId", token_id AS "tokenId",
          operation, outcome, occurred_at AS "occurredAt"
        FROM audit_log_entries
        WHERE user_id = ${userId}
        ORDER BY occurred_at, id
      `,
    })(subjectUserId)
  ).pipe(Effect.orDie);
