import { DateTime, Effect, Option, Schema } from "effect";
import { ConnectInstitutionResult, Connection } from "../../../src/core/connections/contract";
import { prepareAuthorizedAuditCall } from "../../../src/shell/audit/operations";
import { recordLivePATUse } from "../../../src/shell/tokens/operations";
import { prepareOwnedStatement } from "../../database/operations";
import { callerAuthority, isPATCaller, transactionId } from "../../canonical-work/operations";
import type {
  CanonicalPreparationWork,
  CommittedMutationValue,
} from "../../canonical-operations/contract";

const operation = "connections.connectInstitution";
const attemptLifetimeMilliseconds = 600000;
const retentionMilliseconds = 86400000;
const PendingAttempt = Schema.Struct({
  public_reference: Schema.String.check(Schema.isUUID()),
  expires_at_ms: Schema.Int,
});

export const readInitiationResult = (
  db: D1Database,
  userId: string
): Effect.Effect<Option.Option<CommittedMutationValue>> =>
  Effect.gen(function* () {
    const raw = yield* Effect.tryPromise(() =>
      db
        .prepare(
          "SELECT id, institution_id AS institutionId, state FROM connections WHERE user_id = ? AND institution_id = 'bancolombia'"
        )
        .bind(userId)
        .first()
    );
    const connection = yield* Schema.decodeUnknownEffect(Schema.toType(Connection))(raw);
    let value: ConnectInstitutionResult;
    if (connection.state === "Active") {
      value = { type: "already_connected", connection: { ...connection, state: "Active" } };
    } else {
      if (connection.state !== "Connecting") return Option.none();
      const attempt = yield* Effect.tryPromise(() =>
        db
          .prepare(
            "SELECT public_reference, expires_at_ms FROM connection_attempts WHERE user_id = ? AND connection_id = ? AND status = 'pending'"
          )
          .bind(userId, connection.id)
          .first()
      );
      const pending = yield* Schema.decodeUnknownEffect(PendingAttempt)(attempt);
      value = {
        type: "continue_in_browser",
        connection: { ...connection, state: "Connecting" },
        continuation: {
          url: `https://app.fidyapp.com/connections/continue?attempt=${pending.public_reference}`,
          expiresAt: DateTime.makeUnsafe(pending.expires_at_ms),
        },
      };
    }
    return Option.some<CommittedMutationValue>({
      _tag: "Owner",
      payload: value,
      encode: () => Schema.encodeEffect(Schema.toCodecJson(ConnectInstitutionResult))(value),
    });
  }).pipe(Effect.orElseSucceed(() => Option.none()));

export const initiationStatements = (
  work: CanonicalPreparationWork
): ReadonlyArray<D1PreparedStatement> => {
  const { db, subject, current } = work;
  const authority = callerAuthority(work);
  const live = `EXISTS (SELECT 1 FROM ${authority.table} WHERE ${authority.predicate}) AND EXISTS (SELECT 1 FROM connection_institution_gate WHERE institution_id = 'bancolombia' AND enabled = 1)`;
  return [
    ...(isPATCaller(subject)
      ? [prepareOwnedStatement({ db, statement: recordLivePATUse({ subject, current }) })]
      : []),
    db
      .prepare(
        `UPDATE connection_attempts SET status = 'invalidated' WHERE user_id = ? AND institution_id = 'bancolombia' AND status = 'pending' AND (expires_at_ms <= ? OR EXISTS (SELECT 1 FROM connections c WHERE c.user_id = connection_attempts.user_id AND c.id = connection_attempts.connection_id AND c.state IN ('Action required','Ended'))) AND ${live}`
      )
      .bind(subject.userId, current, ...authority.bindings),
    db
      .prepare(`INSERT INTO connections (id,user_id,institution_id,state,created_at_ms,updated_at_ms)
      SELECT ?,?,'bancolombia','Connecting',?,? WHERE ${live}
      ON CONFLICT(user_id,institution_id) DO UPDATE SET
        state = CASE WHEN connections.state = 'Active' THEN 'Active' ELSE 'Connecting' END,
        updated_at_ms = CASE WHEN connections.state IN ('Connecting','Active') THEN connections.updated_at_ms ELSE excluded.updated_at_ms END`)
      .bind(transactionId(), subject.userId, current, current, ...authority.bindings),
    db
      .prepare(
        `DELETE FROM connection_attempts WHERE user_id = ? AND expires_at_ms <= ? AND status != 'pending' AND ${live}`
      )
      .bind(subject.userId, current - retentionMilliseconds, ...authority.bindings),
    db
      .prepare(`INSERT INTO connection_attempts (id,user_id,connection_id,institution_id,public_reference,status,created_at_ms,expires_at_ms)
      SELECT ?,user_id,id,institution_id,?,'pending',?,? FROM connections
      WHERE user_id = ? AND institution_id = 'bancolombia' AND state = 'Connecting' AND ${live}
      AND NOT EXISTS (SELECT 1 FROM connection_attempts WHERE user_id = ? AND connection_id = connections.id AND status = 'pending')`)
      .bind(
        transactionId(),
        transactionId(),
        current,
        current + attemptLifetimeMilliseconds,
        subject.userId,
        ...authority.bindings,
        subject.userId
      ),
    // A reused attempt or Active Connection still proves exactly one guarded owner row before Audit.
    db
      .prepare(`UPDATE connections SET state = state WHERE user_id = ? AND institution_id = 'bancolombia' AND ${live}
      AND (state = 'Active' OR (state = 'Connecting' AND EXISTS (SELECT 1 FROM connection_attempts a WHERE a.user_id = connections.user_id AND a.connection_id = connections.id AND a.status = 'pending' AND a.expires_at_ms > ?)))`)
      .bind(subject.userId, ...authority.bindings, current),
    prepareAuthorizedAuditCall({
      db,
      authority,
      id: transactionId(),
      operation,
      current,
      outcome: "accepted",
      afterOwnerWrite: true,
    }),
  ];
};
