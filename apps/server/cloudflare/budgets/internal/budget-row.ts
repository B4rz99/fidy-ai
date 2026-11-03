import { Budget, BudgetId } from "../../../src/core/budgets/contract";
import { Effect, Schema } from "effect";

const Row = Schema.Struct({
  id: BudgetId,
  category_id: Budget.fields.categoryId,
  currency: Budget.fields.cap.fields.currency,
  cap: Budget.fields.cap.fields.amount,
  created_at_ms: Schema.DateTimeUtcFromMillis,
  updated_at_ms: Schema.DateTimeUtcFromMillis,
  group_name: Schema.optionalKey(Schema.NullOr(Schema.String)),
});
const decodeRow = Schema.decodeUnknownEffect(Row);
const decodeRows = Schema.decodeUnknownEffect(Schema.Array(Row));
const decodeBudgets = Schema.decodeUnknownEffect(Schema.Array(Schema.toType(Budget)));
const toBudget = (row: typeof Row.Type): Budget => ({
  id: row.id,
  categoryId: row.category_id,
  cap: { amount: row.cap, currency: row.currency },
  createdAt: row.created_at_ms,
  updatedAt: row.updated_at_ms,
  ...(row.group_name == null ? {} : { groupName: row.group_name }),
});
const decodeBudget = Schema.decodeUnknownEffect(Schema.toType(Budget));

/** Decode a present retained Budget; corrupt storage is not row absence. */
export const budgetFromRow = (raw: unknown): Effect.Effect<Budget, Schema.SchemaError> =>
  Effect.gen(function* () {
    const row = yield* decodeRow(raw);
    return yield* decodeBudget(toBudget(row));
  });

/** Decode the retained cap columns together before validating complete Budget values. */
export const budgetsFromRows = (
  raw: ReadonlyArray<unknown>
): Effect.Effect<ReadonlyArray<Budget>, Schema.SchemaError> =>
  decodeRows(raw).pipe(Effect.flatMap((rows) => decodeBudgets(rows.map(toBudget))));
