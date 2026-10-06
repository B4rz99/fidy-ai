import { Effect, Schema } from "effect";
import { UserContext, type UserId } from "../../../src/core/identity/contract";
import {
  RecurringConfirmationId,
  RecurringSeriesConfirmed,
} from "../../../src/core/recurring/contract";

import { protectConsentStatement } from "../../../src/shell/consent/operations";
import { type RecurringConfirmation, RecurringUnavailable } from "../contract";

export const Cursor = Schema.Struct({
  confirmedAt: RecurringSeriesConfirmed.fields.confirmedAt,
  id: RecurringConfirmationId,
});
export const Row = Schema.Struct({
  id: RecurringConfirmationId,
  context_json: Schema.String,
  confirmation_json: Schema.String,
});
export const consentGuard = ({
  db,
  userId,
}: Readonly<{ db: D1Database; userId: UserId }>): D1PreparedStatement => {
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
export const evaluationGuard = ({
  db,
  userId,
  revision,
}: Readonly<{ db: D1Database; userId: UserId; revision: number }>): D1PreparedStatement =>
  db
    .prepare(
      "INSERT INTO recurring_assertion (id, accepted) VALUES (1, CASE WHEN EXISTS (SELECT 1 FROM recurring_progress WHERE user_id = ? AND evaluated_revision = ? AND phase = 'complete') THEN 1 ELSE 0 END) ON CONFLICT(id) DO UPDATE SET accepted = excluded.accepted"
    )
    .bind(userId, revision);
export const decodeRow = ({
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
