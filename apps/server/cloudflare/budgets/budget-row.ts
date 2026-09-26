import { Budget, BudgetId } from "@fidy/server/budgets-runtime";
import { Option, Schema } from "effect";

/** Decode a retained Budget through its public Money and UTC timestamp contract. */
export const budgetFromRow = (raw: unknown): Option.Option<Budget> =>
  Option.flatMap(
    Schema.decodeUnknownOption(
      Schema.Struct({
        id: BudgetId,
        category_id: Budget.fields.categoryId,
        currency: Budget.fields.cap.fields.currency,
        cap: Schema.String,
        created_at: Schema.String,
        updated_at: Schema.String,
      })
    )(raw),
    (row) =>
      Schema.decodeOption(Schema.toCodecJson(Budget))({
        id: row.id,
        categoryId: row.category_id,
        cap: { amount: row.cap, currency: row.currency },
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      })
  );
