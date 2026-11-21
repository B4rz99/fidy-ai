import { SqliteClient } from "@effect/sql-sqlite-do/SqliteClient";
import { Effect, Option, Schema } from "effect";
import { AuditUnavailable } from "../../src/shell/audit/contract";
import { preserveStoreAlarm, withStoreCapacity } from "../runtime/sqlite/operations";
import { auditDeadlineExpression, retainedAuditKinds } from "./contract";

const pageSize = 64;

const deadline = auditDeadlineExpression("");

const candidates = `FROM audit_entries INDEXED BY local_audit_retention WHERE record_type IN (${retainedAuditKinds}) AND NOT EXISTS(SELECT 1 FROM erasure_requests)`;

const next = Effect.gen(function* () {
  const sql = yield* SqliteClient;

  const [row] = yield* sql.unsafe(
    `SELECT user_id,${deadline} AS due ${candidates} ORDER BY ${deadline},id LIMIT 1`
  );

  return yield* Schema.decodeUnknownEffect(
    Schema.OptionFromUndefinedOr(Schema.Struct({ user_id: Schema.String, due: Schema.Int }))
  )(row);
});

export const repairLocalAuditAlarm = Effect.fn(function* (
  now: number,
  storage: DurableObjectStorage
) {
  const row = yield* next;

  return Option.isSome(row)
    ? yield* preserveStoreAlarm(storage, Math.max(now, row.value.due))
    : false;
});

export const recoverLocalAudit = Effect.fn(function* (
  now: number,
  storage: DurableObjectStorage,
  owns: (user: string) => boolean
) {
  const earliest = yield* next;

  if (Option.isNone(earliest)) return { attempted: 0, failed: 0 };
  const { user_id: user, due } = earliest.value;

  if (!owns(user)) return yield* new AuditUnavailable({ cause: undefined });

  if (due > now) {
    yield* preserveStoreAlarm(storage, due);

    return { attempted: 0, failed: 0 };
  }

  const sql = yield* SqliteClient;

  const removed = yield* withStoreCapacity("required")(
    Effect.gen(function* () {
      const opened =
        yield* sql`INSERT INTO audit_retention_permits(user_id,checked_ms) VALUES(${user},${now}) RETURNING user_id`;

      if (opened.length !== 1) return yield* new AuditUnavailable({ cause: undefined });

      const rows = yield* sql.unsafe(
        `DELETE FROM audit_entries WHERE user_id=? AND id IN(SELECT id ${candidates} AND user_id=? AND ${deadline}<=? ORDER BY ${deadline},id LIMIT ?) RETURNING id`,
        [user, user, now, pageSize]
      );

      const closed =
        yield* sql`DELETE FROM audit_retention_permits WHERE user_id=${user} AND checked_ms=${now} RETURNING user_id`;

      if (closed.length !== 1) return yield* new AuditUnavailable({ cause: undefined });

      return rows.length;
    })
  );

  yield* repairLocalAuditAlarm(now, storage);

  return { attempted: removed, failed: 0 };
});
