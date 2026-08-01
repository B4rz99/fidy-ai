import { Effect, Schema, Struct } from "effect";
import { SqlClient, SqlSchema } from "effect/unstable/sql";
import { UserId } from "~/core/identity/reference";
import { AuditLogEntry } from "~/core/audit/model";
import { withUserTransaction } from "~/shell/db/user-transaction";

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
 * assigns the evidence id; no ordinary update/delete capability exists here,
 * only the separate all-records-before-cutoff retention operation.
 */
export const appendAuditLogEntry = Effect.fn("appendAuditLogEntry")(function* (
  subjectUserId: UserId,
  metadata: typeof AuditLogEntryMetadata.Type
) {
  const sql = yield* SqlClient.SqlClient;
  return yield* withUserTransaction(
    subjectUserId,
    SqlSchema.findOne({
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
    })({ subjectUserId, ...metadata }).pipe(Effect.orDie)
  );
});

/**
 * Typed persistence observer for tests that must prove metadata remains absent
 * from AuditLogEntry. It is not a canonical operation or an ordinary product
 * read seam; production callers have no way to expose the retained evidence.
 */
export const observeAuditLogEntries = (subjectUserId: UserId) =>
  withUserTransaction(
    subjectUserId,
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
    ).pipe(Effect.orDie)
  );

/**
 * Applies the append-only seam's sole deletion capability: retention may remove
 * every AuditLogEntry strictly older than one UTC cutoff. Callers cannot select
 * a User, token, operation, outcome, or individual evidence id for deletion.
 */
export const removeAuditLogEntriesBefore = Effect.fn("removeAuditLogEntriesBefore")(function* (
  cutoff: typeof AuditLogEntry.fields.occurredAt.Type
) {
  const sql = yield* SqlClient.SqlClient;
  const encodedCutoff = yield* Schema.encodeEffect(Schema.DateTimeUtcFromDate)(cutoff).pipe(
    Effect.orDie
  );
  yield* sql`SELECT fidy_delete_audit_log_entries_before(${encodedCutoff})`;
});
