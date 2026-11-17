import { SqliteClient } from "@effect/sql-sqlite-do/SqliteClient";
import { Data, DateTime, Effect, Option, Schema } from "effect";
import { IanaTimeZone } from "../../../src/core/_shared/context";
import { Currency, Money, encodeMoneyAmount } from "../../../src/core/_shared/money";
import { Budget, type BudgetId, type UpdateBudgetInput } from "../../../src/core/budgets/contract";
import { CategoryReference } from "../../../src/core/categories/contract";
import { currentCategoryRelease, interpretCategory } from "../../../src/core/categories/operations";
import type { UserId } from "../../../src/core/identity/contract";
import {
  CanonicalAdmissionUnavailable,
  type LocalMutationResult,
} from "../../canonical-admission/contract";
import { categorizeLocalCapture } from "../../categories/operations";
import { newId } from "../../secret-material/operations";
import { budgetsFromRows } from "./budget-row";

const maximumBudgets = 128;
const monthLength = 7;
const updatedStatus = 200;
const createdStatus = 201;
const latestMonth = "9999-12";
export const budgetUnavailable = (): CanonicalAdmissionUnavailable =>
  new CanonicalAdmissionUnavailable({ cause: "budget_state" });
export const budgetSuccess = (data: Schema.Json): LocalMutationResult => ({
  status: 200,
  outcome: "success",
  body: { data, next: [] },
});
export const missingBudget = (): LocalMutationResult => ({
  status: 404,
  outcome: "not_found",
  body: { error: { code: "not_found", message: "Budget or Category unavailable." }, next: [] },
});
const invalid = (): LocalMutationResult => ({
  status: 400,
  outcome: "validation_failed",
  body: {
    error: { code: "validation_failed", message: "Budget input unavailable.", fields: [] },
    next: [],
  },
});

export const localMonth = ({
  now,
  zone,
}: Readonly<{ now: DateTime.Utc; zone: IanaTimeZone }>): string =>
  DateTime.formatIsoDate(DateTime.setZone(now, DateTime.zoneMakeNamedUnsafe(zone))).slice(
    0,
    monthLength
  );
export const currentUserMonth = Effect.fn(function* (user: UserId, current: number) {
  const sql = yield* SqliteClient;
  const [row] = yield* sql`SELECT time_zone FROM users WHERE id=${user}`;
  const { time_zone } = yield* Schema.decodeUnknownEffect(
    Schema.Struct({ time_zone: IanaTimeZone })
  )(row);
  return localMonth({ now: DateTime.makeUnsafe(current), zone: time_zone });
});

/** Resolve the active group denomination and inherited cap under the same User transaction. */
export const plannedBudgets = Effect.fn(function* (
  user: UserId,
  planned: Option.Option<string>,
  target: Option.Option<BudgetId>
) {
  const sql = yield* SqliteClient;
  const month = Option.getOrNull(planned);
  const id = Option.getOrNull(target);
  const rows =
    yield* sql`SELECT b.id,b.category_id,b.category_revision,b.created_at_ms,b.updated_at_ms,b.group_name,
    COALESCE((SELECT g.currency FROM budget_month_plan_records g WHERE g.kind='currency' AND g.user_id=b.user_id AND g.group_name=b.group_name AND g.month<=${month ?? latestMonth} ORDER BY g.month DESC LIMIT 1),b.currency) AS currency,
    COALESCE((SELECT p.cap FROM budget_month_plan_records p WHERE p.kind='cap' AND p.user_id=b.user_id AND p.budget_id=b.id AND p.month<=${month} ORDER BY p.month DESC LIMIT 1),b.cap) AS cap,
    (b.starts_month IS NULL OR b.starts_month<=${month}) AS active
    FROM budgets b WHERE b.user_id=${user} AND (${id} IS NULL OR b.id=${id}) ORDER BY currency,b.category_id,b.id LIMIT ${maximumBudgets + 1}`;
  if (rows.length > maximumBudgets) return yield* budgetUnavailable();
  const refs = yield* Schema.decodeUnknownEffect(
    Schema.Array(
      Schema.Struct({
        category_id: CategoryReference.fields.categoryId,
        category_revision: CategoryReference.fields.revision,
        active: Schema.NullOr(Schema.Literals([0, 1])),
      })
    )
  )(rows);
  for (const ref of refs) {
    if (
      Option.isNone(
        interpretCategory({
          release: currentCategoryRelease,
          reference: { revision: ref.category_revision, categoryId: ref.category_id },
        })
      )
    ) {
      return yield* budgetUnavailable();
    }
  }
  const budgets = yield* budgetsFromRows(rows);
  return { budgets, active: budgets.filter((_, index) => refs[index]?.active === 1) };
});

type CurrencyChange = Readonly<{
  ids: ReadonlyArray<string>;
  name: string;
  month: string;
  currency: Currency;
  amount: string;
}>;
const groupPrecision = Effect.fn(function* (
  user: UserId,
  { ids, name, month, currency, amount }: CurrencyChange
) {
  const sql = yield* SqliteClient;
  const selected = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Array(Schema.String)))(
    ids
  );
  const members = sql`user_id=${user} AND (group_name=${name} OR category_id IN (SELECT value FROM json_each(${selected})))`;
  const [duplicate] =
    yield* sql`SELECT 1 FROM budgets WHERE ${members} GROUP BY category_id HAVING count(*)>1 LIMIT 1`;
  if (duplicate !== undefined) return false;
  const fits = Schema.decodeUnknownOption(Schema.toCodecJson(Money));
  if (Option.isNone(fits({ amount, currency }))) return false;
  // A future month can hold a different cap. Validate every distinct nominal amount in bounded pages.
  const caps = sql`WITH selected AS (SELECT id,cap FROM budgets WHERE ${members}), caps AS (
    SELECT cap FROM selected UNION SELECT COALESCE((SELECT p.cap FROM budget_month_plan_records p
      WHERE p.kind='cap' AND p.user_id=${user} AND p.budget_id=s.id AND p.month<=${month} ORDER BY p.month DESC LIMIT 1),s.cap) FROM selected s
    UNION SELECT p.cap FROM budget_month_plan_records p JOIN selected s ON s.id=p.budget_id
    WHERE p.kind='cap' AND p.user_id=${user} AND p.month>=${month})`;
  let cursor = Option.none<string>();
  for (;;) {
    const after = Option.getOrNull(cursor);
    const rows = yield* Schema.decodeUnknownEffect(
      Schema.Array(Schema.Struct({ cap: Schema.String }))
    )(
      yield* sql`${caps} SELECT cap FROM caps WHERE ${after} IS NULL OR cap>${after} ORDER BY cap LIMIT ${maximumBudgets}`
    );
    for (const row of rows) {
      if (Option.isNone(fits({ amount: row.cap, currency }))) return false;
      cursor = Option.some(row.cap);
    }
    if (rows.length < maximumBudgets) return true;
  }
});
const groupDenomination = Effect.fn(function* (user: UserId, name: string, month: string) {
  const sql = yield* SqliteClient;
  const [version] =
    yield* sql`SELECT currency FROM budget_month_plan_records WHERE kind='currency' AND user_id=${user} AND group_name=${name} AND month<=${month} ORDER BY month DESC LIMIT 1`;
  const inherited =
    version === undefined
      ? yield* sql`SELECT DISTINCT currency FROM budgets WHERE user_id=${user} AND group_name=${name} LIMIT 2`
      : [version];
  if (inherited.length === 0) {
    return Option.none<Currency>();
  }
  const [group] = yield* Schema.decodeUnknownEffect(
    Schema.Tuple([Schema.Struct({ currency: Currency })])
  )(inherited);
  return Option.some(group.currency);
});
const validGroup = Effect.fn(function* (
  user: UserId,
  input: UpdateBudgetInput,
  existing: Option.Option<Budget>
) {
  const sameCurrency = !Option.exists(
    existing,
    (budget) => budget.cap.currency !== input.cap.currency
  );
  if (input.groupCurrency !== undefined) {
    return (
      sameCurrency &&
      (yield* groupPrecision(user, {
        ids: input.groupCategoryIds ?? [],
        name: input.groupName ?? "",
        month: input.month ?? latestMonth,
        currency: input.groupCurrency,
        amount: encodeMoneyAmount(input.cap.amount),
      }))
    );
  }
  if (input.groupName === undefined) {
    return sameCurrency;
  }
  const denomination = yield* groupDenomination(user, input.groupName, input.month ?? latestMonth);
  return Option.match(denomination, {
    onSome: (currency) => currency === input.cap.currency,
    onNone: () =>
      !Option.exists(existing, (budget) => budget.groupName === input.groupName) || sameCurrency,
  });
});

const freezeMonth = Effect.fn(function* (user: UserId, month: string) {
  const sql = yield* SqliteClient;
  const first =
    yield* sql`INSERT INTO budget_month_plan_records(kind,user_id,month) VALUES('plan',${user},${month}) ON CONFLICT DO NOTHING RETURNING month`;
  if (first.length === 0) return;
  yield* sql`INSERT INTO budget_month_plan_records(kind,user_id,budget_id,month,cap) SELECT 'cap',b.user_id,b.id,${month},
    COALESCE((SELECT p.cap FROM budget_month_plan_records p WHERE p.kind='cap' AND p.user_id=b.user_id AND p.budget_id=b.id AND p.month<${month} ORDER BY p.month DESC LIMIT 1),b.cap)
    FROM budgets b WHERE b.user_id=${user} AND (b.starts_month IS NULL OR b.starts_month<=${month})`;
});
const updateGroup = Effect.fn(function* (user: UserId, input: UpdateBudgetInput, current: number) {
  if (input.groupName === undefined) return;
  const sql = yield* SqliteClient;
  const ids = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Array(Schema.String)))(
    input.groupCategoryIds ?? []
  );
  if (input.month !== undefined) {
    yield* sql`INSERT INTO budget_month_plan_records(kind,user_id,group_name,month,currency)
      SELECT 'currency',g.user_id,${input.groupName},g.month,g.currency FROM budget_month_plan_records g WHERE g.kind='currency' AND g.user_id=${user}
      AND g.group_name IN (SELECT group_name FROM budgets WHERE user_id=${user} AND category_id IN (SELECT value FROM json_each(${ids}))) AND g.group_name<>${input.groupName}
      ORDER BY g.group_name,g.month ON CONFLICT DO NOTHING`;
    yield* sql`INSERT INTO budget_month_plan_records(kind,user_id,group_name,month,currency) VALUES('currency',${user},${input.groupName},${input.month},${input.groupCurrency ?? input.cap.currency})
      ON CONFLICT(user_id,group_name,month) WHERE kind='currency' DO UPDATE SET currency=excluded.currency WHERE ${input.groupCurrency ?? null} IS NOT NULL`;
  }
  if (input.groupCategoryIds !== undefined) {
    yield* sql`UPDATE budgets SET group_name=${input.groupName},updated_at_ms=${current} WHERE user_id=${user} AND category_id IN (SELECT value FROM json_each(${ids}))`;
  }
});

type SaveInput = Readonly<{ id: Option.Option<BudgetId>; input: UpdateBudgetInput }>;
const validateBudget = Effect.fn(function* ({ id, input }: SaveInput, user: UserId) {
  const sql = yield* SqliteClient;
  const existing = Option.isNone(id)
    ? Option.none<Budget>()
    : Option.fromUndefinedOr(
        (yield* plannedBudgets(user, Option.fromUndefinedOr(input.month), id)).budgets[0]
      );
  if (Option.isSome(id) && Option.isNone(existing)) return Option.some(missingBudget());
  if (!(yield* validGroup(user, input, existing))) return Option.some(invalid());
  const [conflict] =
    yield* sql`SELECT id FROM budgets WHERE user_id=${user} AND category_id=${input.categoryId} AND currency=${input.cap.currency} AND id<>${Option.getOrElse(id, () => "")}`;
  if (conflict !== undefined) return Option.some(invalid());
  if (Option.isNone(id)) {
    const full =
      yield* sql`SELECT 1 FROM budgets WHERE user_id=${user} LIMIT 1 OFFSET ${maximumBudgets - 1}`;
    if (full.length > 0) return Option.some(invalid());
  }
  return Option.none<LocalMutationResult>();
});
const writeBudget = Effect.fn(function* (
  save: SaveInput,
  user: UserId,
  facts: Readonly<{ budgetId: BudgetId; current: number; revision: string }>
) {
  const sql = yield* SqliteClient;
  const { input, id } = save;
  const { budgetId, current, revision } = facts;
  const month = input.month ?? null;
  const group = input.groupName ?? null;
  const cap = encodeMoneyAmount(input.cap.amount);
  return Option.isNone(id)
    ? yield* sql`INSERT INTO budgets(id,user_id,category_id,category_revision,currency,cap,created_at_ms,updated_at_ms,group_name,starts_month)
      VALUES(${budgetId},${user},${input.categoryId},${revision},${input.cap.currency},${cap},${current},${current},${group},${month}) RETURNING id`
    : yield* sql`UPDATE budgets SET category_id=${input.categoryId}, category_revision=${revision},
      cap=CASE WHEN ${month} IS NULL THEN ${cap} ELSE cap END, group_name=COALESCE(${group},group_name),
      starts_month=CASE WHEN starts_month>${month} THEN ${month} ELSE starts_month END, updated_at_ms=${current}
      WHERE id=${budgetId} AND user_id=${user} RETURNING id`;
});
class MonthlyBudgetConflict extends Data.TaggedError("MonthlyBudgetConflict") {}

/** Only a Budget start or a group Currency change can introduce a monthly Category/Currency collision. */
const checkMonthlyDenominations = Effect.fn(function* (user: UserId) {
  const sql = yield* SqliteClient;
  const conflicts = yield* sql`WITH repeated_categories AS (
    SELECT category_id FROM budgets WHERE user_id=${user} GROUP BY category_id HAVING COUNT(*)>1
  ), members AS (
    SELECT category_id,group_name,currency,COALESCE(starts_month,'') AS start FROM budgets
    WHERE user_id=${user} AND category_id IN (SELECT category_id FROM repeated_categories)
  ), periods AS (
    SELECT category_id,start AS month FROM members UNION
    SELECT b.category_id,g.month FROM members b JOIN budget_month_plan_records g ON g.group_name=b.group_name
    WHERE g.kind='currency' AND g.user_id=${user} AND g.month>=b.start
  ), monthly AS (
    SELECT p.month,b.category_id,COALESCE((SELECT g.currency FROM budget_month_plan_records g
      WHERE g.kind='currency' AND g.user_id=${user} AND g.group_name=b.group_name AND g.month<=p.month
      ORDER BY g.month DESC LIMIT 1),b.currency) AS denomination
    FROM periods p JOIN members b ON b.category_id=p.category_id AND b.start<=p.month
  ) SELECT 1 FROM monthly GROUP BY month,category_id,denomination HAVING COUNT(*)>1 LIMIT 1`;
  if (conflicts.length > 0) return yield* new MonthlyBudgetConflict();
});
const saveBudgetPlan = Effect.fn(function* (save: SaveInput, user: UserId, current: number) {
  const { id, input } = save;
  const failure = yield* validateBudget(save, user);
  if (Option.isSome(failure)) return failure.value;
  const reference = yield* categorizeLocalCapture({
    userId: user,
    capture: {
      caller: Option.some(input.categoryId),
      direction: "outflow",
      counterparty: Option.none(),
    },
  }).pipe(
    Effect.asSome,
    Effect.catchTag("CategoryNotFound", () => Effect.succeedNone)
  );
  if (Option.isNone(reference)) return missingBudget();
  if (input.month !== undefined) yield* freezeMonth(user, input.month);
  yield* updateGroup(user, input, current);
  const sql = yield* SqliteClient;
  const budgetId = Option.getOrElse(id, () => Budget.fields.id.make(newId()));
  const cap = encodeMoneyAmount(input.cap.amount);
  const changed = yield* writeBudget(save, user, {
    budgetId,
    current,
    revision: reference.value.revision,
  });
  if (changed.length !== 1) return yield* budgetUnavailable();
  if (input.month !== undefined) {
    yield* sql`INSERT INTO budget_month_plan_records(kind,user_id,budget_id,month,cap) VALUES('cap',${user},${budgetId},${input.month},${cap})
    ON CONFLICT(user_id,budget_id,month) WHERE kind='cap' DO UPDATE SET cap=excluded.cap`;
  }
  yield* checkMonthlyDenominations(user);
  const [saved] = (yield* plannedBudgets(
    user,
    Option.fromUndefinedOr(input.month),
    Option.some(budgetId)
  )).budgets;
  if (saved === undefined) return yield* budgetUnavailable();
  return {
    ...budgetSuccess(yield* Schema.encodeEffect(Schema.toCodecJson(Budget))(saved)),
    status: Option.isNone(id) ? createdStatus : updatedStatus,
  };
});
export const saveLocalBudget = Effect.fn(function* (
  save: SaveInput,
  user: UserId,
  current: number
) {
  const sql = yield* SqliteClient;
  return yield* sql
    .withTransaction(saveBudgetPlan(save, user, current))
    .pipe(Effect.catchTag("MonthlyBudgetConflict", () => Effect.succeed(invalid())));
});
export const deleteLocalBudget = Effect.fn(function* (id: BudgetId, user: UserId) {
  const sql = yield* SqliteClient;
  if ((yield* plannedBudgets(user, Option.none(), Option.some(id))).budgets.length === 0) {
    return missingBudget();
  }
  const removed = yield* sql`DELETE FROM budgets WHERE id=${id} AND user_id=${user} RETURNING id`;
  if (removed.length !== 1) return yield* budgetUnavailable();
  return budgetSuccess(id);
});
