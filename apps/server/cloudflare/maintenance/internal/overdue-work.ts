import { SqliteClient } from "@effect/sql-sqlite-do/SqliteClient";
import { Clock, Effect, Option, Schema } from "effect";
import { SecureRandom } from "effect/crypto";
import { directoryName } from "../../directory/contract";
import { withStoreAdmission } from "../../runtime/sqlite/operations";
import {
  RecoveryOwner,
  recoveryAlarmHeader,
  recoveryGenerationHeader,
  recoveryGraceMs,
  recoveryOwnerHeader,
  reserveRecoveryUrl,
} from "../contract";

const decodeReservation = Schema.decodeUnknownOption(
  Schema.Struct({
    userId: RecoveryOwner,
    generation: Schema.String.check(Schema.isUUID()),
  })
);

const decodeAlarm = Schema.decodeUnknownOption(
  Schema.Union([
    Schema.Literal("idle"),
    Schema.NumberFromString.check(Schema.isInt(), Schema.isGreaterThan(0)),
  ])
);

export const settleRecovery = Effect.fnUntraced(function* (
  userId: string,
  generation: Option.Option<string>,
  next: Option.Option<number>
) {
  const sql = yield* SqliteClient;

  if (userId === directoryName) {
    const now = yield* Clock.currentTimeMillis;
    const due = Option.getOrNull(Option.map(next, (wake) => Math.max(wake, now) + recoveryGraceMs));
    yield* sql`UPDATE directory_recovery SET generation=${SecureRandom.uuidV4Unsafe()},due_ms=${due},uncertain=0
      WHERE singleton=1 AND generation IS ${Option.getOrNull(generation)}`;

    return;
  }

  yield* sql.withTransaction(
    Effect.gen(function* () {
      const [current] = yield* sql`SELECT generation FROM user_recovery WHERE user_id=${userId}`;

      if ((current?.generation ?? null) !== Option.getOrNull(generation)) return;

      yield* sql`UPDATE lifetime_registry SET recovery_seeded=1 WHERE user_id=${userId} AND retired=0 AND recovery_seeded=0`;

      if (Option.isNone(next)) {
        yield* sql`DELETE FROM user_recovery WHERE user_id=${userId}`;

        return;
      }

      const due = Math.max(next.value, yield* Clock.currentTimeMillis) + recoveryGraceMs;
      yield* sql`INSERT INTO user_recovery(user_id,generation,due_ms,uncertain)
      SELECT user_id,${SecureRandom.uuidV4Unsafe()},${due},0 FROM lifetime_registry WHERE user_id=${userId} AND retired=0
      ON CONFLICT(user_id) DO UPDATE SET generation=excluded.generation,due_ms=excluded.due_ms,uncertain=0`;
    })
  );
});

export const handleRecoveryIndex = Effect.fnUntraced(function* (request: Request) {
  const parsed = decodeReservation({
    userId: request.headers.get(recoveryOwnerHeader),
    generation: request.headers.get(recoveryGenerationHeader),
  });

  if (Option.isNone(parsed)) return new Response(null, { status: 400 });

  const input = parsed.value;
  const sql = yield* SqliteClient;

  if (request.url !== reserveRecoveryUrl) {
    const next = decodeAlarm(request.headers.get(recoveryAlarmHeader));

    if (Option.isNone(next)) return new Response(null, { status: 400 });
    yield* settleRecovery(
      input.userId,
      Option.some(input.generation),
      next.value === "idle" ? Option.none() : Option.some(next.value)
    );

    return new Response(null, { status: 204 });
  }

  if (input.userId === directoryName) return yield* reserveDirectory(input.generation);

  return yield* withStoreAdmission((admitGrowth) =>
    Effect.gen(function* () {
      const [owner] =
        yield* sql`SELECT recovery_seeded AS seeded FROM lifetime_registry WHERE user_id=${input.userId} AND retired=0`;

      if (owner === undefined) return new Response(null, { status: 409 });

      const [previous] =
        yield* sql`SELECT uncertain FROM user_recovery WHERE user_id=${input.userId}`;

      if (previous === undefined) yield* admitGrowth;

      const due = (yield* Clock.currentTimeMillis) + recoveryGraceMs;
      yield* sql`INSERT INTO user_recovery(user_id,generation,due_ms,uncertain) VALUES(${input.userId},${input.generation},${due},1)
      ON CONFLICT(user_id) DO UPDATE SET generation=excluded.generation,due_ms=min(due_ms,excluded.due_ms),uncertain=1`;

      return Response.json({
        clean: owner.seeded === 1 && previous?.uncertain !== 1,
        hadDeadline: previous !== undefined,
      });
    })
  );
});

const reserveDirectory = Effect.fnUntraced(function* (generation: string) {
  const sql = yield* SqliteClient;
  const due = (yield* Clock.currentTimeMillis) + recoveryGraceMs;

  return yield* sql.withTransaction(
    Effect.gen(function* () {
      const [previous] =
        yield* sql`SELECT due_ms,uncertain FROM directory_recovery WHERE singleton=1`;

      if (previous === undefined) return new Response(null, { status: 503 });

      yield* sql`UPDATE directory_recovery SET generation=${generation},due_ms=min(coalesce(due_ms,${due}),${due}),uncertain=1 WHERE singleton=1`;

      return Response.json({
        clean: previous.due_ms !== 0 && previous.uncertain === 0,
        hadDeadline: previous.due_ms !== null,
      });
    })
  );
});
