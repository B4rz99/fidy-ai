import { type Cause, Effect, Option, Schema } from "effect";
import { Currency, Money } from "../../../src/core/_shared/money";
import type {
  Budget,
  CreateBudgetInput,
  UpdateBudgetInput,
} from "../../../src/core/budgets/contract";
import { type TransactionCaller, callerAuthority } from "../../canonical-work/operations";

/** Currency is a group fact; an unconfigured group inherits its first retained member's currency. */
export const findGroupCurrency = ({
  db,
  userId,
  groupName,
  month,
}: Readonly<{
  db: D1Database;
  userId: string;
  groupName: string;
  month: string;
}>): Effect.Effect<Option.Option<Currency>, Cause.UnknownError | Schema.SchemaError> =>
  Effect.gen(function* () {
    const raw = yield* Effect.tryPromise(() =>
      db
        .prepare(`SELECT currency FROM (SELECT rowid,user_id,group_name,month,currency FROM budget_month_plan_records WHERE kind='currency')
    WHERE user_id=? AND group_name=? AND month<=? ORDER BY month DESC LIMIT 1`)
        .bind(userId, groupName, month)
        .first()
    );
    if (raw !== null) {
      return Option.some(
        (yield* Schema.decodeUnknownEffect(Schema.Struct({ currency: Currency }))(raw)).currency
      );
    }
    const rows = yield* Effect.tryPromise(() =>
      db
        .prepare("SELECT DISTINCT currency FROM budgets WHERE user_id=? AND group_name=? LIMIT 2")
        .bind(userId, groupName)
        .all()
    );
    if (rows.results.length === 0) return Option.none<Currency>();
    const decoded = yield* Schema.decodeUnknownEffect(
      Schema.Array(Schema.Struct({ currency: Currency })).check(Schema.isMaxLength(1))
    )(rows.results);
    return Option.fromUndefinedOr(decoded[0]?.currency);
  });

/** The requested currency must belong to the chosen group; individual category edits cannot change it. */
export const acceptsGroupCurrency = ({
  db,
  userId,
  payload,
  existing,
}: Readonly<{
  db: D1Database;
  userId: string;
  payload: CreateBudgetInput | UpdateBudgetInput;
  existing: Option.Option<Budget>;
}>): Effect.Effect<boolean, Cause.UnknownError | Schema.SchemaError> =>
  Effect.gen(function* () {
    if ("groupCurrency" in payload && payload.groupCurrency !== undefined) {
      return Option.isSome(existing) && existing.value.cap.currency === payload.cap.currency;
    }
    if (payload.groupName === undefined) {
      return Option.isNone(existing) || existing.value.cap.currency === payload.cap.currency;
    }
    const expected = yield* findGroupCurrency({
      db,
      userId,
      groupName: payload.groupName,
      month: payload.month ?? "9999-12",
    });
    return Option.match(expected, {
      onNone: () =>
        Option.isNone(existing) ||
        existing.value.groupName !== payload.groupName ||
        existing.value.cap.currency === payload.cap.currency,
      onSome: (currency) => currency === payload.cap.currency,
    });
  });

/** Setting a group currency preserves exact cap values; incompatible precision is refused. */
export const acceptsGroupCapPrecision = ({
  db,
  userId,
  payload,
}: Readonly<{ db: D1Database; userId: string; payload: UpdateBudgetInput }>): Effect.Effect<
  boolean,
  Cause.UnknownError | Schema.SchemaError
> =>
  Effect.gen(function* () {
    if (payload.groupCurrency === undefined) return true;
    const ids = payload.groupCategoryIds ?? [];
    const selection = `user_id=? AND (group_name=? OR category_id IN (${ids.map(() => "?").join(",")}))`;
    const collision = yield* Effect.tryPromise(() =>
      db
        .prepare(
          `SELECT category_id FROM budgets WHERE ${selection} GROUP BY category_id HAVING COUNT(*)>1 LIMIT 1`
        )
        .bind(userId, payload.groupName, ...ids)
        .first()
    );
    if (collision !== null) return false;
    const raw = yield* Effect.tryPromise(() =>
      db
        .prepare(
          `SELECT cap FROM budgets WHERE ${selection}
       UNION ALL SELECT m.cap FROM (SELECT rowid,user_id,budget_id,month,cap FROM budget_month_plan_records WHERE kind='cap') m JOIN budgets b ON b.id=m.budget_id AND b.user_id=m.user_id
       WHERE b.${selection.replaceAll("group_name", "b.group_name").replaceAll("category_id", "b.category_id")} AND m.month>=?`
        )
        .bind(userId, payload.groupName, ...ids, userId, payload.groupName, ...ids, payload.month)
        .all()
    );
    const rows = yield* Schema.decodeUnknownEffect(
      Schema.Array(Schema.Struct({ cap: Schema.String }))
    )(raw.results);
    const decode = Schema.decodeUnknownOption(Schema.toCodecJson(Money));
    return rows.every((row) =>
      Option.isSome(decode({ amount: row.cap, currency: payload.groupCurrency }))
    );
  });

/** Version the group's currency and preserve source history before a collection rename. */
export const prepareGroupCurrency = ({
  db,
  subject,
  current,
  payload,
}: Readonly<{
  db: D1Database;
  subject: TransactionCaller;
  current: number;
  payload: CreateBudgetInput | UpdateBudgetInput;
}>): ReadonlyArray<D1PreparedStatement> => {
  if (payload.groupName === undefined || payload.month === undefined) return [];
  const authority = callerAuthority({ subject, current });
  const groupCurrency = "groupCurrency" in payload ? payload.groupCurrency : undefined;
  const groupCategoryIds = "groupCategoryIds" in payload ? payload.groupCategoryIds : undefined;
  return [
    ...(groupCategoryIds === undefined
      ? []
      : [
          db
            .prepare(`INSERT INTO budget_month_plan_records(kind,user_id,group_name,month,currency) SELECT 'currency',g.user_id,?,g.month,g.currency FROM (SELECT rowid,user_id,group_name,month,currency FROM budget_month_plan_records WHERE kind='currency') g
      WHERE g.user_id=? AND g.group_name IN (SELECT group_name FROM budgets WHERE user_id=? AND category_id IN (${groupCategoryIds.map(() => "?").join(",")}))
      AND g.group_name<>? AND EXISTS(SELECT 1 FROM ${authority.table} WHERE ${authority.predicate})
      ON CONFLICT(user_id,group_name,month) WHERE kind='currency' DO NOTHING`)
            .bind(
              payload.groupName,
              subject.userId,
              subject.userId,
              ...groupCategoryIds,
              payload.groupName,
              ...authority.bindings
            ),
        ]),
    db
      .prepare(`INSERT INTO budget_month_plan_records(kind,user_id,group_name,month,currency) SELECT 'currency',?,?,?,? WHERE EXISTS(SELECT 1 FROM ${authority.table} WHERE ${authority.predicate})
      ON CONFLICT(user_id,group_name,month) WHERE kind='currency' ${groupCurrency === undefined ? "DO NOTHING" : "DO UPDATE SET currency=excluded.currency"}`)
      .bind(
        subject.userId,
        payload.groupName,
        payload.month,
        groupCurrency ?? payload.cap.currency,
        ...authority.bindings
      ),
  ];
};
