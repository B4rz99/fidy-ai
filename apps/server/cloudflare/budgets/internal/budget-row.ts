import { Budget, BudgetId } from "../../../src/core/budgets/contract";
import { Effect, Schema } from "effect";

/** Decode a present retained Budget; corrupt storage is not row absence. */
export const budgetFromRow = (raw: unknown): Effect.Effect<Budget, Schema.SchemaError> =>
  Effect.gen(function* () {
    const row = yield* Schema.decodeUnknownEffect(
      Schema.Struct({
        id: BudgetId,
        category_id: Budget.fields.categoryId,
        currency: Budget.fields.cap.fields.currency,
        cap: Schema.String,
        created_at: Schema.String,
        updated_at: Schema.String,
      })
    )(raw);
    return yield* Schema.decodeEffect(Schema.toCodecJson(Budget))({
      id: row.id,
      categoryId: row.category_id,
      cap: { amount: row.cap, currency: row.currency },
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    });
  });
