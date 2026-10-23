import { Budget, BudgetId } from "../../../src/core/budgets/contract";
import { DateTime, Effect, Schema } from "effect";

/** Decode a present retained Budget; corrupt storage is not row absence. */
export const budgetFromRow = (raw: unknown): Effect.Effect<Budget, Schema.SchemaError> =>
  Effect.gen(function* () {
    const row = yield* Schema.decodeUnknownEffect(
      Schema.Struct({
        id: BudgetId,
        category_id: Budget.fields.categoryId,
        currency: Budget.fields.cap.fields.currency,
        cap: Schema.String,
        created_at_ms: Schema.DateTimeUtcFromMillis,
        updated_at_ms: Schema.DateTimeUtcFromMillis,
        group_name: Schema.optionalKey(Schema.NullOr(Schema.String)),
      })
    )(raw);
    return yield* Schema.decodeEffect(Schema.toCodecJson(Budget))({
      id: row.id,
      categoryId: row.category_id,
      cap: { amount: row.cap, currency: row.currency },
      createdAt: DateTime.formatIso(row.created_at_ms),
      updatedAt: DateTime.formatIso(row.updated_at_ms),
      ...(row.group_name == null ? {} : { groupName: row.group_name }),
    });
  });
