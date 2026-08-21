import { Effect, Option, Schema, Struct } from "effect";
import { SqlClient, SqlSchema } from "effect/unstable/sql";
import { type AuditCaller, AuditLogEntry } from "~/core/audit/model";
import { UserId } from "~/core/identity/reference";
import { PATId } from "~/core/tokens/reference";
import { HostedAgentSessionId } from "~/core/transcript/hosted-agent-session";
import { withUserTransaction } from "~/shell/db/user-transaction";

const AuditLogEntryWithoutIdentity = AuditLogEntry.mapFields(
  Struct.omit(["id", "subjectUserId", "caller"])
);
const AuditLogEntryRow = Schema.Struct({
  id: AuditLogEntry.fields.id,
  subjectUserId: UserId,
  patId: Schema.OptionFromNullOr(PATId),
  hostedAgentSessionId: Schema.OptionFromNullOr(HostedAgentSessionId),
  ...AuditLogEntryWithoutIdentity.fields,
  occurredAt: Schema.DateTimeUtcFromDate,
});
const AppendAuditLogEntryRow = AuditLogEntryRow.mapFields(Struct.omit(["id"]));

const callerColumns = (
  caller: AuditCaller
): Readonly<{
  patId: Option.Option<PATId>;
  hostedAgentSessionId: Option.Option<HostedAgentSessionId>;
}> =>
  caller._tag === "PAT"
    ? {
        patId: Option.some(caller.patId),
        hostedAgentSessionId: Option.none<HostedAgentSessionId>(),
      }
    : {
        patId: Option.none<PATId>(),
        hostedAgentSessionId: Option.some(caller.hostedAgentSessionId),
      };

/**
 * Reads the one caller a row names. A row naming both is broken evidence, not a PAT: the database
 * CHECK forbids it, so preferring either column here would read a corrupted row as a valid one.
 */
const auditCaller = (row: typeof AuditLogEntryRow.Type): AuditCaller => {
  const named = [
    Option.map(row.patId, (patId): AuditCaller => ({ _tag: "PAT", patId })),
    Option.map(row.hostedAgentSessionId, (hostedAgentSessionId): AuditCaller => ({
      _tag: "HostedAgentSession",
      hostedAgentSessionId,
    })),
  ].filter(Option.isSome);
  const [caller] = named;
  if (caller === undefined || named.length !== 1) {
    throw new Error("Audit evidence must name exactly one caller");
  }
  return caller.value;
};

const toAuditLogEntry = (row: typeof AuditLogEntryRow.Type): AuditLogEntry =>
  AuditLogEntry.make({
    id: row.id,
    subjectUserId: row.subjectUserId,
    caller: auditCaller(row),
    operation: row.operation,
    outcome: row.outcome,
    occurredAt: row.occurredAt,
  });

/**
 * Appends metadata-only evidence for one User's canonical call. The database
 * assigns the evidence id; no ordinary update/delete capability exists here.
 */
export const appendAuditLogEntry = Effect.fn("appendAuditLogEntry")(function* (
  subjectUserId: UserId,
  metadata: Omit<AuditLogEntry, "id" | "subjectUserId">
) {
  const sql = yield* SqlClient.SqlClient;
  const row = yield* withUserTransaction(
    subjectUserId,
    SqlSchema.findOne({
      Request: AppendAuditLogEntryRow,
      Result: AuditLogEntryRow,
      execute: (row) => sql`
        INSERT INTO audit_log_entries (
          user_id, pat_id, hosted_agent_session_id, operation, outcome, occurred_at
        )
        VALUES (
          ${row.subjectUserId}, ${row.patId}, ${row.hostedAgentSessionId}, ${row.operation},
          ${row.outcome}, ${row.occurredAt}
        )
        RETURNING id, user_id AS "subjectUserId", pat_id AS "patId",
          hosted_agent_session_id AS "hostedAgentSessionId", operation, outcome,
          occurred_at AS "occurredAt"
      `,
    })({ subjectUserId, ...callerColumns(metadata.caller), ...metadata }).pipe(Effect.orDie)
  );
  return toAuditLogEntry(row);
});

/** Typed persistence observer for metadata-only AuditLogEntry evidence. */
export const observeAuditLogEntries = (
  subjectUserId: UserId
): Effect.Effect<ReadonlyArray<AuditLogEntry>, never, SqlClient.SqlClient> =>
  withUserTransaction(
    subjectUserId,
    Effect.flatMap(SqlClient.SqlClient, (sql) =>
      SqlSchema.findAll({
        Request: UserId,
        Result: AuditLogEntryRow,
        execute: (userId) => sql`
          SELECT id, user_id AS "subjectUserId", pat_id AS "patId",
            hosted_agent_session_id AS "hostedAgentSessionId", operation, outcome,
            occurred_at AS "occurredAt"
          FROM audit_log_entries
          WHERE user_id = ${userId}
          ORDER BY occurred_at, id
        `,
      })(subjectUserId)
    ).pipe(
      Effect.orDie,
      Effect.map((rows) => rows.map(toAuditLogEntry))
    )
  );

/** Removes every AuditLogEntry strictly older than one UTC retention cutoff. */
export const removeAuditLogEntriesBefore = Effect.fn("removeAuditLogEntriesBefore")(function* (
  cutoff: typeof AuditLogEntry.fields.occurredAt.Type
) {
  const sql = yield* SqlClient.SqlClient;
  const encodedCutoff = yield* Schema.encodeEffect(Schema.DateTimeUtcFromDate)(cutoff).pipe(
    Effect.orDie
  );
  yield* sql`SELECT fidy_delete_audit_log_entries_before(${encodedCutoff})`;
});
