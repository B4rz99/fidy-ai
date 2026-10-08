import { Clock, DateTime, Effect, Option, Schema } from "effect";
import { ConnectionContinuationReview } from "../../../src/shell/connections/contract";
import { Connection } from "../../../src/core/connections/contract";
import {
  prepareAuditQueryCall,
  prepareAuthorizedAuditCall,
  refusedByAuditBudget,
} from "../../../src/shell/audit/operations";
import {
  type TransactionAuthority,
  callerAuthority,
  transactionId,
  transactionNoStore,
} from "../../canonical-work/operations";
import type { AuthenticatedWebSession } from "../../web-session/contract";
import type { ConnectionBrowserAdmission } from "../contract";

const missingStatus = 404;
const unavailableStatus = 503;
const limitedStatus = 429;
const ContinuationRow = Schema.Struct({
  ...Connection.fields,
  expiresAtMilliseconds: Schema.Int,
  phase: Schema.Literals(["ready", "prepared"]),
});
export const continuationFailure = (status: number): Response =>
  Response.json(
    { error: { code: "continuation_unavailable" } },
    { status, headers: transactionNoStore }
  );
const databaseFailure = (cause: unknown): Response => {
  if (refusedByAuditBudget(cause)) return continuationFailure(limitedStatus);
  return continuationFailure(
    cause instanceof Error && cause.message.includes("connection_browser_commit")
      ? missingStatus
      : unavailableStatus
  );
};
const query = `SELECT c.id, c.institution_id AS institutionId, c.state, a.expires_at_ms AS expiresAtMilliseconds,
  CASE WHEN a.status = 'pending' THEN 'ready' ELSE 'prepared' END AS phase
  FROM connection_attempts a JOIN connections c ON c.user_id = a.user_id AND c.id = a.connection_id
  WHERE a.public_reference = ? AND a.user_id = ? AND a.expires_at_ms > ? AND c.state = 'Connecting'
    AND (a.status = 'pending' OR (a.status = 'consumed' AND EXISTS (SELECT 1 FROM connection_authorization_executions e WHERE e.attempt_id = a.id)))
    AND NOT EXISTS (SELECT 1 FROM connection_attempts newer WHERE newer.user_id = a.user_id AND newer.connection_id = a.connection_id AND newer.rowid > a.rowid)
    AND EXISTS (SELECT 1 FROM connection_institution_gate WHERE institution_id = a.institution_id AND enabled = 1)`;
const present = (candidate: unknown): Effect.Effect<Response, Schema.SchemaError> =>
  Effect.gen(function* () {
    const rows = yield* Schema.decodeUnknownEffect(Schema.Array(ContinuationRow))(candidate);
    const row = Option.fromUndefinedOr(rows[0]);
    if (Option.isNone(row)) return continuationFailure(missingStatus);
    const body = yield* Schema.encodeEffect(Schema.toCodecJson(ConnectionContinuationReview))({
      connection: {
        id: row.value.id,
        institutionId: row.value.institutionId,
        state: row.value.state,
      },
      institutionName: "Bancolombia",
      expiresAt: DateTime.makeUnsafe(row.value.expiresAtMilliseconds),
      phase: row.value.phase,
    });
    return Response.json(body, { headers: transactionNoStore });
  });
const assertion = (db: D1Database): D1PreparedStatement =>
  db.prepare(
    "INSERT INTO connection_browser_atomic_assertion VALUES (1,CASE WHEN changes() = 1 THEN 1 ELSE 0 END) ON CONFLICT(id) DO UPDATE SET accepted = excluded.accepted"
  );
const guardedQuery = (authority: TransactionAuthority): string =>
  `${query} AND EXISTS (SELECT 1 FROM ${authority.table} WHERE ${authority.predicate})`;
/** Review and its metadata-only Audit use the same authoritative snapshot. */
export const reviewContinuation = (
  input: Readonly<{
    db: D1Database;
    subject: AuthenticatedWebSession;
    attempt: string;
    current: number;
  }>
): Effect.Effect<Response> =>
  Effect.gen(function* () {
    const authority = callerAuthority(input);
    const sql = guardedQuery(authority);
    const bindings = [input.attempt, input.subject.userId, input.current, ...authority.bindings];
    const result = yield* Effect.tryPromise({
      try: () =>
        input.db.batch([
          input.db.prepare(sql).bind(...bindings),
          prepareAuditQueryCall({
            db: input.db,
            authority,
            id: transactionId(),
            operation: "connections.reviewContinuation",
            current: input.current,
            missingWhen: { sql: `SELECT 1 WHERE NOT EXISTS (${sql})`, params: bindings },
          }),
          assertion(input.db),
        ]),
      catch: databaseFailure,
    });
    return yield* present(result[0]?.results);
  }).pipe(
    Effect.catch((response) =>
      Effect.succeed(
        response instanceof Response ? response : continuationFailure(unavailableStatus)
      )
    )
  );

/** Consume and prepare once under fresh same-User authority; no bank effect can run in this slice. */
export const beginContinuation = (
  input: Readonly<{ db: D1Database; admission: ConnectionBrowserAdmission; signal: AbortSignal }>
): Effect.Effect<Response> =>
  Effect.gen(function* () {
    const current = yield* Clock.currentTimeMillis;
    if (input.signal.aborted || current >= input.admission.deadlineMilliseconds) {
      return continuationFailure(unavailableStatus);
    }
    const { admission, db } = input;
    const live = callerAuthority({
      subject: {
        id: admission.sessionId,
        userId: admission.userId,
        digest: new Uint8Array(admission.digest),
      },
      current,
    });
    const authority = {
      ...live,
      predicate: `${live.predicate} AND fresh_until_ms > ?`,
      bindings: [...live.bindings, current],
    };
    const result = yield* Effect.tryPromise({
      try: () =>
        db.batch([
          db
            .prepare(`UPDATE connection_attempts SET status = 'consumed', consumed_at_ms = ?
      WHERE public_reference = ? AND user_id = ? AND status = 'pending' AND expires_at_ms > ?
      AND EXISTS (SELECT 1 FROM connections c WHERE c.id = connection_attempts.connection_id AND c.user_id = connection_attempts.user_id AND c.state = 'Connecting')
      AND EXISTS (SELECT 1 FROM connection_institution_gate WHERE institution_id = connection_attempts.institution_id AND enabled = 1)
      AND EXISTS (SELECT 1 FROM ${authority.table} WHERE ${authority.predicate})`)
            .bind(current, admission.attempt, admission.userId, current, ...authority.bindings),
          db
            .prepare(`INSERT INTO connection_authorization_executions (attempt_id,session_id,prepared_at_ms)
      SELECT id,?,? FROM connection_attempts WHERE public_reference = ? AND user_id = ? AND changes() = 1`)
            .bind(admission.sessionId, current, admission.attempt, admission.userId),
          prepareAuthorizedAuditCall({
            db,
            authority,
            id: transactionId(),
            operation: "connections.beginContinuation",
            current,
            outcome: "accepted",
            afterOwnerWrite: true,
          }),
          assertion(db),
          db
            .prepare(guardedQuery(authority))
            .bind(admission.attempt, admission.userId, current, ...authority.bindings),
        ]),
      catch: databaseFailure,
    });
    return yield* present(result.at(-1)?.results);
  }).pipe(
    Effect.catch((response) =>
      Effect.succeed(
        response instanceof Response ? response : continuationFailure(unavailableStatus)
      )
    )
  );
