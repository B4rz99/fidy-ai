import { SqliteClient } from "@effect/sql-sqlite-do/SqliteClient";
import { Clock, Effect, Schema } from "effect";
import { ErasureHandoff, registerCaseUrl } from "../../erasure-store/contract";
import { preserveStoreAlarm, withStoreCapacity } from "../../runtime/sqlite/operations";
import { erasureRegistryName } from "../../erasure/contract";

const acknowledged = 204;

const conflictStatus = 409;

const retryMs = 60_000;

export const repairErasureHandoff = Effect.fn(function* (storage: DurableObjectStorage) {
  const sql = yield* SqliteClient;

  const [row] =
    yield* sql`SELECT handoff_due_ms FROM erasure_requests WHERE handoff_due_ms IS NOT NULL LIMIT 1`;

  return row === undefined
    ? false
    : yield* preserveStoreAlarm(
        storage,
        yield* Schema.decodeUnknownEffect(Schema.Int)(row.handoff_due_ms)
      );
});

export const offerErasureHandoff = Effect.fn(function* (
  storage: DurableObjectStorage,
  erasure: Pick<DurableObjectNamespace, "getByName">,
  owns: (id: string) => boolean
) {
  const sql = yield* SqliteClient;
  const now = yield* Clock.currentTimeMillis;

  const [row] = yield* withStoreCapacity("required")(
    Effect.gen(function* () {
      const due =
        yield* sql`UPDATE erasure_requests SET handoff_due_ms=${now + retryMs} WHERE handoff_due_ms<=${now} RETURNING id AS reference,user_id AS userId,requested_at_ms AS requestedAtMs`;

      if (due.length > 0) yield* preserveStoreAlarm(storage, now + retryMs);

      return due;
    })
  );

  if (row === undefined) return { attempted: 0, failed: 0 };
  const handoff = yield* Schema.decodeUnknownEffect(ErasureHandoff)(row);

  if (!owns(handoff.userId)) return { attempted: 0, failed: 1 };
  const body = yield* Schema.encodeEffect(Schema.fromJsonString(ErasureHandoff))(handoff);

  const accepted = yield* Effect.tryPromise((signal) =>
    erasure.getByName(erasureRegistryName).fetch(registerCaseUrl, { method: "POST", body, signal })
  ).pipe(
    Effect.map((response) => response.status === acknowledged),
    Effect.timeout("5 seconds"),
    Effect.tapError(Effect.logDebug),
    Effect.orElseSucceed(() => false)
  );

  if (accepted) {
    yield* sql`UPDATE erasure_requests SET handoff_due_ms=NULL WHERE id=${handoff.reference} AND user_id=${handoff.userId} AND requested_at_ms=${handoff.requestedAtMs}`;
  }

  return { attempted: 1, failed: Number(!accepted) };
});

export const confirmErasureHandoff = Effect.fn(function* (
  request: Request,
  owns: (id: string) => boolean
) {
  const handoff = yield* Schema.decodeUnknownEffect(ErasureHandoff)(
    yield* Effect.tryPromise(() => request.json())
  );

  const sql = yield* SqliteClient;

  const rows =
    yield* sql`SELECT 1 FROM erasure_requests WHERE user_id=${handoff.userId} AND id=${handoff.reference} AND requested_at_ms=${handoff.requestedAtMs}`;

  return new Response(null, {
    status: owns(handoff.userId) && rows.length === 1 ? acknowledged : conflictStatus,
  });
});
