import { type DateTime, Effect, Option, Schema, Struct } from "effect";
import { SqlClient, SqlSchema } from "effect/unstable/sql";
import { CanonicalOperationId } from "~/core/_shared/canonical-operation";
import { type AuditCaller, AuditLogEntry } from "~/core/audit/model";
import { UserId } from "~/core/identity/reference";
import { PATId } from "~/core/tokens/reference";
import { HostedAgentSessionId } from "~/core/transcript/hosted-agent-session";
import { WebSessionId } from "~/core/web-session/reference";
import { withUserTransaction } from "~/shell/db/user-transaction";

const AuditLogEntryWithoutIdentity = AuditLogEntry.mapFields(
  Struct.omit(["id", "subjectUserId", "caller"])
);
const AuditLogEntryRow = Schema.Struct({
  id: AuditLogEntry.fields.id,
  subjectUserId: UserId,
  patId: Schema.OptionFromNullOr(PATId),
  webSessionId: Schema.OptionFromNullOr(WebSessionId),
  hostedAgentSessionId: Schema.OptionFromNullOr(HostedAgentSessionId),
  ...AuditLogEntryWithoutIdentity.fields,
  occurredAt: Schema.DateTimeUtcFromDate,
});
const AppendAuditLogEntryRow = AuditLogEntryRow.mapFields(Struct.omit(["id"]));

type CallerColumns = Readonly<{
  patId: Option.Option<PATId>;
  webSessionId: Option.Option<WebSessionId>;
  hostedAgentSessionId: Option.Option<HostedAgentSessionId>;
}>;

type SessionAuditCaller = Exclude<AuditCaller, { readonly _tag: "PAT" }>;

const RejectedOperationAdmission = Schema.Struct({
  rejectionCount: Schema.Int,
  retryAfterSeconds: Schema.Int,
});

/** Counts one User's recent rejected calls without exposing Audit persistence to another slice. */
export const getRejectedOperationAdmission = Effect.fn("Audit.getRejectedOperationAdmission")(
  function* (
    sql: SqlClient.SqlClient,
    input: Readonly<{
      userId: UserId;
      operation: CanonicalOperationId;
      attemptedAt: DateTime.Utc;
      windowMinutes: number;
    }>
  ) {
    return yield* SqlSchema.findOne({
      Request: Schema.Struct({
        userId: UserId,
        operation: CanonicalOperationId,
        attemptedAt: Schema.DateTimeUtcFromDate,
        windowMinutes: Schema.Int.check(Schema.isGreaterThan(0)),
      }),
      Result: RejectedOperationAdmission,
      execute: (request) => sql`
        SELECT count(*)::int AS "rejectionCount",
          COALESCE(CEIL(EXTRACT(EPOCH FROM (
            min(occurred_at) + (${request.windowMinutes} * interval '1 minute')
              - ${request.attemptedAt}::timestamptz
          )))::int, 1) AS "retryAfterSeconds"
        FROM audit_log_entries
        WHERE user_id = ${request.userId}::uuid
          AND operation = ${request.operation}
          AND outcome = 'rejected'
          AND hosted_agent_session_id IS NOT NULL
          AND occurred_at > ${request.attemptedAt}::timestamptz
            - (${request.windowMinutes} * interval '1 minute')
      `,
    })(input).pipe(Effect.orDie);
  }
);

const sessionCallerColumns = (caller: SessionAuditCaller): CallerColumns => {
  if (caller._tag === "WebSession") {
    return {
      patId: Option.none<PATId>(),
      webSessionId: Option.some(caller.webSessionId),
      hostedAgentSessionId: Option.none<HostedAgentSessionId>(),
    };
  }
  return {
    patId: Option.none<PATId>(),
    webSessionId: Option.none<WebSessionId>(),
    hostedAgentSessionId: Option.some(caller.hostedAgentSessionId),
  };
};

const callerColumns = (caller: AuditCaller): CallerColumns => {
  if (caller._tag !== "PAT") return sessionCallerColumns(caller);
  return {
    patId: Option.some(caller.patId),
    webSessionId: Option.none<WebSessionId>(),
    hostedAgentSessionId: Option.none<HostedAgentSessionId>(),
  };
};

/**
 * Reads the one caller a row names. A row naming multiple callers is broken evidence, not a PAT:
 * the database CHECK forbids it, so preferring a column would read a corrupted row as valid.
 */
const auditCaller = (row: typeof AuditLogEntryRow.Type): AuditCaller => {
  const named = [
    Option.map(row.patId, (patId): AuditCaller => ({ _tag: "PAT", patId })),
    Option.map(row.webSessionId, (webSessionId): AuditCaller => ({
      _tag: "WebSession",
      webSessionId,
    })),
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
          user_id, pat_id, web_session_id, hosted_agent_session_id, operation, outcome, occurred_at
        )
        VALUES (
          ${row.subjectUserId}, ${row.patId}, ${row.webSessionId}, ${row.hostedAgentSessionId},
          ${row.operation}, ${row.outcome}, ${row.occurredAt}
        )
        RETURNING id, user_id AS "subjectUserId", pat_id AS "patId",
          web_session_id AS "webSessionId",
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
            web_session_id AS "webSessionId",
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
