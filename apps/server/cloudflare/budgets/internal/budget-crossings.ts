import { DateTime, Effect, Schema } from "effect";
import { BudgetCrossing } from "../../../src/core/budgets/contract";
import { prepareConsentAction } from "../../consent/operations";
import { type BudgetCrossingRead, BudgetCrossingUnavailable } from "../contract";

const CrossingRow = Schema.Struct({
  threshold: BudgetCrossing.fields.threshold,
  crossing_json: Schema.fromJsonString(Schema.toCodecJson(BudgetCrossing)),
});
const maximumCrossings = 2;

export const readCrossings = (
  input: BudgetCrossingRead
): Effect.Effect<ReadonlyArray<typeof CrossingRow.Type>, BudgetCrossingUnavailable> =>
  Effect.gen(function* () {
    const rows = yield* Effect.tryPromise(() =>
      prepareConsentAction({
        db: input.db,
        subject: { _tag: "User", userId: input.userId },
        requirement: "active",
        statement: {
          sql: "SELECT threshold,crossing_json FROM budget_threshold_alerts WHERE user_id=? AND budget_id=? AND from_utc=? AND time_zone=?",
          params: [
            input.userId,
            input.budgetId,
            DateTime.formatIso(input.period.from),
            input.period.timeZone,
          ],
        },
      }).all()
    );
    const crossings = yield* Schema.decodeUnknownEffect(
      Schema.Array(CrossingRow).check(Schema.isMaxLength(maximumCrossings))
    )(rows.results);
    return crossings;
  }).pipe(Effect.mapError(() => new BudgetCrossingUnavailable()));
