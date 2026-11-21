import { Clock, Effect, Schema, Struct } from "effect";
import { Hex } from "effect/encoding";
import { SqliteClient } from "@effect/sql-sqlite-do/SqliteClient";
import { DirectoryWriteUnavailable, RecoveryRotation, RecoveryRouteDecision } from "../contract";
import { withStoreCapacity } from "../../runtime/sqlite/operations";

const acknowledgedStatus = 204;

const conflictStatus = 409;

const conflict = (): Response => new Response(null, { status: 409 });

const acknowledged = (): Response => new Response(null, { status: 204 });

const settle = Effect.fn(function* ({
  row,
  value,
  prior,
  next,
}: Readonly<{
  row: unknown;
  value: typeof RecoveryRouteDecision.Type;
  prior: Uint8Array;
  next: Uint8Array;
}>) {
  const sql = yield* SqliteClient;
  const saved = yield* Schema.decodeUnknownEffect(RecoveryRotation)(row);
  const match = Struct.keys(RecoveryRotation.fields).every((key) => saved[key] === value[key]);

  if (!match) return conflict();

  const { state } = yield* Schema.decodeUnknownEffect(Schema.Struct({ state: Schema.Unknown }))(
    row
  );

  if (state !== "reserved") {
    return state === value.decision ? acknowledged() : conflict();
  }

  const [fence] =
    yield* sql`SELECT 1 AS present FROM erasure_barriers WHERE user_id=${value.user_id}`;

  if (value.decision === "reserve") {
    return new Response(null, {
      status: fence === undefined ? acknowledgedStatus : conflictStatus,
    });
  }

  const target =
    value.decision === "committed"
      ? sql`code_digest=${prior} AND user_id=${value.user_id} AND revision=${value.revision} AND attempt_id=(SELECT prior_reservation FROM recovery_rotations WHERE id=${value.id})`
      : sql`code_digest=${next} AND user_id=${value.user_id} AND revision=${value.revision + 1} AND attempt_id=${value.id}`;

  const held = Number(fence !== undefined);
  yield* sql`DELETE FROM recovery_routes WHERE ${target} AND ${held}=0`;

  const marked =
    yield* sql`UPDATE recovery_rotations SET state=${value.decision} WHERE id=${value.id} AND user_id=${value.user_id} AND state='reserved' AND (${held}=1 OR NOT EXISTS(SELECT 1 FROM recovery_routes WHERE ${target})) RETURNING 1`;

  if (marked.length !== 1) return yield* new DirectoryWriteUnavailable();

  return acknowledged();
});

const canReserve = (value: typeof RecoveryRouteDecision.Type, now: number): boolean =>
  value.expires_at_ms > now &&
  value.decision === "reserve" &&
  value.prior_digest !== value.next_digest;

export const recoveryRouteDecision = Effect.fn(function* (request: Request) {
  const value = yield* Schema.decodeUnknownEffect(RecoveryRouteDecision)(
    yield* Effect.tryPromise(() => request.json())
  );

  const sql = yield* SqliteClient;
  const prior = yield* Effect.fromResult(Hex.decode(value.prior_digest));
  const next = yield* Effect.fromResult(Hex.decode(value.next_digest));

  return yield* Effect.gen(function* () {
    const [row] = yield* sql`SELECT * FROM recovery_rotations WHERE id=${value.id}`;

    if (row !== undefined) return yield* settle({ row, value, prior, next });
    const now = yield* Clock.currentTimeMillis;

    if (value.decision !== "reserve" && value.expires_at_ms <= now) return acknowledged();

    if (value.decision === "cancelled") {
      yield* sql`INSERT INTO recovery_rotations VALUES(${value.id},${value.user_id},${value.prior_digest},${value.next_digest},NULL,${value.revision},${value.expires_at_ms},'cancelled') RETURNING 1`.pipe(
        Effect.filterOrFail(
          (rows) => rows.length === 1,
          () => new DirectoryWriteUnavailable()
        )
      );

      return acknowledged();
    }

    if (!canReserve(value, now)) return conflict();

    const [source] =
      yield* sql`SELECT attempt_id FROM recovery_routes WHERE code_digest=${prior} AND user_id=${value.user_id} AND revision=${value.revision}`;

    if (source === undefined) return conflict();
    const reservation = yield* Schema.decodeUnknownEffect(Schema.String)(source.attempt_id);

    const assigned =
      yield* sql`INSERT INTO recovery_routes VALUES(${next},${value.user_id},${value.id},${value.revision + 1},1) ON CONFLICT DO NOTHING RETURNING 1`;

    if (assigned.length !== 1) return conflict();
    yield* sql`INSERT INTO recovery_rotations VALUES(${value.id},${value.user_id},${value.prior_digest},${value.next_digest},${reservation},${value.revision},${value.expires_at_ms},'reserved') RETURNING 1`.pipe(
      Effect.filterOrFail(
        (rows) => rows.length === 1,
        () => new DirectoryWriteUnavailable()
      )
    );

    return acknowledged();
  }).pipe(withStoreCapacity(value.decision === "reserve" ? "growth" : "required"));
});
