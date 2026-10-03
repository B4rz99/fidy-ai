import { DateTime, Effect, Option, Schema } from "effect";
import { UserContext, type UserId } from "../../../src/core/identity/contract";
import {
  RecurringConfirmationId,
  RecurringSeriesConfirmed,
} from "../../../src/core/recurring/contract";
import { findRecurringSnapshot, prepareRecurringFactGuard } from "../../transactions/operations";
import { protectConsentStatement } from "../../../src/shell/consent/operations";
import {
  type RecurringConfirmation,
  type RecurringConfirmationPage,
  RecurringUnavailable,
} from "../contract";
import { pageSize } from "./models";

const Cursor = Schema.Struct({
  confirmedAt: RecurringSeriesConfirmed.fields.confirmedAt,
  id: RecurringConfirmationId,
});
const Row = Schema.Struct({
  id: RecurringConfirmationId,
  context_json: Schema.String,
  confirmation_json: Schema.String,
});
const consentGuard = (db: D1Database, userId: UserId): D1PreparedStatement => {
  const allowed = protectConsentStatement({
    subject: { _tag: "User", userId },
    requirement: "active",
    statement: { sql: "SELECT 1 WHERE 1 = 1", params: [] },
  });
  return db
    .prepare(
      `INSERT INTO recurring_assertion (id, accepted) VALUES (1, CASE WHEN EXISTS (${allowed.sql}) THEN 1 ELSE 0 END) ON CONFLICT(id) DO UPDATE SET accepted = excluded.accepted`
    )
    .bind(...allowed.params);
};
const evaluationGuard = (db: D1Database, userId: UserId, revision: number): D1PreparedStatement =>
  db
    .prepare(
      "INSERT INTO recurring_assertion (id, accepted) VALUES (1, CASE WHEN EXISTS (SELECT 1 FROM recurring_progress WHERE user_id = ? AND evaluated_revision = ? AND phase = 'complete') THEN 1 ELSE 0 END) ON CONFLICT(id) DO UPDATE SET accepted = excluded.accepted"
    )
    .bind(userId, revision);
const decodeRow = ({
  row,
  userId,
}: Readonly<{ row: typeof Row.Type; userId: UserId }>): Effect.Effect<
  RecurringConfirmation,
  Schema.SchemaError | RecurringUnavailable
> =>
  Effect.gen(function* () {
    const occurrence = yield* Schema.decodeEffect(
      Schema.fromJsonString(Schema.toCodecJson(RecurringSeriesConfirmed))
    )(row.confirmation_json);
    if (occurrence.id !== row.id) return yield* new RecurringUnavailable();
    return {
      userId,
      occurrence,
      context: yield* Schema.decodeEffect(Schema.fromJsonString(Schema.toCodecJson(UserContext)))(
        row.context_json
      ),
    };
  });
export const readConfirmations = ({
  db,
  userId,
  cursor,
}: Readonly<{ db: D1Database; userId: UserId; cursor: Option.Option<string> }>): Effect.Effect<
  RecurringConfirmationPage,
  RecurringUnavailable
> =>
  Effect.gen(function* () {
    const snapshot = yield* findRecurringSnapshot({ db, userId });
    const position = Option.isSome(cursor)
      ? yield* Schema.decodeEffect(Schema.fromJsonString(Cursor))(cursor.value).pipe(Effect.asSome)
      : Option.none<typeof Cursor.Type>();
    const after = Option.match(position, {
      onNone: () => ["", ""],
      onSome: (value) => [DateTime.formatIso(value.confirmedAt), value.id],
    });
    const protectedRead = protectConsentStatement({
      subject: { _tag: "User", userId },
      requirement: "active",
      statement: {
        sql: `SELECT c.id, c.context_json, c.confirmation_json FROM recurring_confirmations c JOIN recurring_series s ON s.user_id = c.user_id AND s.id = c.series_id WHERE c.user_id = ? AND ? = 1 AND s.valid = 1 AND (c.confirmed_at, c.id) > (?, ?)`,
        params: [userId, Option.isSome(snapshot) ? 1 : 0, ...after],
      },
    });
    const raw = yield* Effect.tryPromise({
      try: () =>
        db.batch([
          consentGuard(db, userId),
          ...Option.match(snapshot, {
            onNone: () => [],
            onSome: (value) => [
              prepareRecurringFactGuard({ db, userId, revision: value.revision }),
              evaluationGuard(db, userId, value.revision),
            ],
          }),
          db
            .prepare(`${protectedRead.sql} ORDER BY c.confirmed_at, c.id LIMIT ${pageSize + 1}`)
            .bind(...protectedRead.params),
        ]),
      catch: () => new RecurringUnavailable(),
    });
    const rows = yield* Schema.decodeUnknownEffect(Schema.Array(Row))(raw.at(-1)?.results);
    const confirmations = yield* Effect.forEach(rows.slice(0, pageSize), (row) =>
      decodeRow({ row, userId })
    );
    const last = confirmations.at(-1);
    const nextCursor =
      rows.length > pageSize && last !== undefined
        ? Option.some(
            yield* Schema.encodeEffect(Schema.fromJsonString(Cursor))({
              confirmedAt: last.occurrence.confirmedAt,
              id: last.occurrence.id,
            })
          )
        : Option.none<string>();
    return { confirmations, cursor: nextCursor };
  }).pipe(Effect.mapError(() => new RecurringUnavailable()));
