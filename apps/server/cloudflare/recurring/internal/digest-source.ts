import { DateTime, Effect, Option, Schema } from "effect";
import { UserContext, UserId } from "../../../src/core/identity/contract";
import { RecurringConfirmationId } from "../../../src/core/recurring/contract";
import { UtcTimestamp } from "../../../src/core/_shared/time";
import { findRecurringSnapshot, prepareRecurringFactGuard } from "../../transactions/operations";
import { type RecurringDigestSourcePage, RecurringUnavailable } from "../contract";
import { consentGuard, decodeRow, evaluationGuard } from "./confirmations";

const pageSize = 32;
const Position = Schema.Struct({
  userId: UserId,
  revision: Schema.Int.check(Schema.isGreaterThan(0)),
  evaluatedAt: UtcTimestamp,
  cutoffAt: UtcTimestamp,
  total: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  maximum: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  after: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
});
const positionCodec = Schema.fromJsonString(Schema.toCodecJson(Position));
const SourceRow = Schema.Struct({
  sequence: Schema.Int,
  id: RecurringConfirmationId,
  context_json: Schema.String,
  confirmation_json: Schema.String,
  confirmed_at_ms: Schema.DateTimeUtcFromMillis,
  valid: Schema.Literals([0, 1]),
  legacy: Schema.Literals([0, 1]),
});
type Scope = Readonly<{ db: D1Database; userId: UserId }>;

const guards = (
  input: Scope,
  position: typeof Position.Type
): ReadonlyArray<D1PreparedStatement> => [
  consentGuard(input),
  prepareRecurringFactGuard({ ...input, revision: position.revision }),
  evaluationGuard({ ...input, revision: position.revision }),
  input.db
    .prepare(`INSERT INTO sql_assertions (scope, accepted) VALUES ('recurring',CASE WHEN EXISTS (
 SELECT 1 FROM (SELECT rowid,user_id,revision,phase,cursor_at_ms,cursor_id,group_key,evaluated_at_ms,evaluated_revision,first_captured_at_ms,time_zone FROM recurring_evaluation_records WHERE kind='progress') WHERE user_id=? AND phase='complete' AND evaluated_at_ms=?
 AND (SELECT coalesce(max(confirmation_sequence),0) FROM recurring_series WHERE user_id=? AND confirmation_sequence IS NOT NULL)=? AND (SELECT count(*) FROM recurring_series WHERE user_id=? AND confirmation_sequence IS NOT NULL)=?
 ) THEN 1 ELSE 0 END) ON CONFLICT(scope) DO UPDATE SET accepted=excluded.accepted`)
    .bind(
      input.userId,
      position.evaluatedAt.epochMilliseconds,
      input.userId,
      position.maximum,
      input.userId,
      position.total
    ),
];

const readPosition = (
  input: Scope & Readonly<{ cursor: Option.Option<string> }>
): Effect.Effect<typeof Position.Type, RecurringUnavailable> =>
  Effect.gen(function* () {
    let position: typeof Position.Type;
    if (Option.isSome(input.cursor)) {
      position = yield* Schema.decodeEffect(positionCodec)(input.cursor.value);
      if (position.userId !== input.userId) return yield* new RecurringUnavailable();
    } else {
      const facts = yield* findRecurringSnapshot(input);
      if (Option.isNone(facts)) return yield* new RecurringUnavailable();
      const raw = yield* Effect.tryPromise(() =>
        input.db
          .prepare(
            "SELECT evaluated_at_ms,(SELECT coalesce(max(confirmation_sequence),0) FROM recurring_series WHERE user_id=? AND confirmation_sequence IS NOT NULL) AS maximum,(SELECT count(*) FROM recurring_series WHERE user_id=? AND confirmation_sequence IS NOT NULL) AS total FROM (SELECT rowid,user_id,revision,phase,cursor_at_ms,cursor_id,group_key,evaluated_at_ms,evaluated_revision,first_captured_at_ms,time_zone FROM recurring_evaluation_records WHERE kind='progress') WHERE user_id=? AND phase='complete' AND evaluated_revision=?"
          )
          .bind(input.userId, input.userId, input.userId, facts.value.revision)
          .first()
      );
      const snapshot = yield* Schema.decodeUnknownEffect(
        Schema.Struct({
          evaluated_at_ms: Schema.DateTimeUtcFromMillis,
          maximum: Schema.Int,
          total: Schema.Int,
        })
      )(raw);
      position = {
        userId: input.userId,
        revision: facts.value.revision,
        evaluatedAt: snapshot.evaluated_at_ms,
        cutoffAt: yield* DateTime.now,
        maximum: snapshot.maximum,
        total: snapshot.total,
        after: 0,
      };
    }
    return position;
  }).pipe(Effect.mapError(() => new RecurringUnavailable()));
export const readSource = (
  input: Scope & Readonly<{ cursor: Option.Option<string> }>
): Effect.Effect<RecurringDigestSourcePage, RecurringUnavailable> =>
  Effect.gen(function* () {
    const position = yield* readPosition(input);
    const raw = yield* Effect.tryPromise(() =>
      input.db.batch([
        ...guards(input, position),
        input.db
          .prepare(`SELECT confirmation_sequence AS sequence,confirmation_id AS id,confirmation_context_json AS context_json,confirmation_json,confirmed_at_ms,valid,
 digest_excluded AS legacy FROM recurring_series
 WHERE user_id=? AND confirmation_sequence>? AND confirmation_sequence<=? ORDER BY confirmation_sequence LIMIT ?`)
          .bind(input.userId, position.after, position.maximum, pageSize + 1),
      ])
    );
    const rows = yield* Schema.decodeUnknownEffect(Schema.Array(SourceRow))(raw.at(-1)?.results);
    const confirmations = yield* Effect.forEach(rows.slice(0, pageSize), (row) =>
      Effect.gen(function* () {
        const context = yield* Schema.decodeEffect(
          Schema.fromJsonString(Schema.toCodecJson(UserContext))
        )(row.context_json);
        const snapshot =
          row.legacy === 1
            ? Option.none()
            : Option.some(yield* decodeRow({ row, userId: input.userId }));
        if (row.confirmed_at_ms.epochMilliseconds > position.cutoffAt.epochMilliseconds) {
          return yield* new RecurringUnavailable();
        }
        return {
          id: row.id,
          confirmedAt: row.confirmed_at_ms,
          context,
          valid: row.valid === 1,
          snapshot,
        };
      })
    );
    const last = rows.slice(0, pageSize).at(-1);
    const checkpoint = yield* Schema.encodeEffect(positionCodec)(position);
    const cursor =
      rows.length > pageSize && last !== undefined
        ? Option.some(
            yield* Schema.encodeEffect(positionCodec)({ ...position, after: last.sequence })
          )
        : Option.none<string>();
    return {
      confirmations,
      total: position.total,
      sourceIdentity: `${position.revision}:${DateTime.formatIso(position.evaluatedAt)}:${position.maximum}:${position.total}`,
      checkpoint,
      cutoffAt: position.cutoffAt,
      complete: Option.isNone(cursor),
      cursor,
    };
  }).pipe(Effect.mapError(() => new RecurringUnavailable()));

export const prepareSourceGuard = (
  input: Scope & Readonly<{ checkpoint: string }>
): Effect.Effect<ReadonlyArray<D1PreparedStatement>, RecurringUnavailable> =>
  Effect.gen(function* () {
    const position = yield* Schema.decodeEffect(positionCodec)(input.checkpoint);
    if (position.userId !== input.userId) return yield* new RecurringUnavailable();
    return guards(input, position);
  }).pipe(Effect.mapError(() => new RecurringUnavailable()));
