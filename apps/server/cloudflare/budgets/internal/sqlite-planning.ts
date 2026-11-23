import { BudgetThresholdEvaluation } from "../contract";
import { commitLocalPlan, prepareLocalWrite } from "../../canonical-admission/operations";
import { SqliteClient } from "@effect/sql-sqlite-do/SqliteClient";
import { Array as Arr, Data, DateTime, Effect, Option, Schema } from "effect";
import type { SqlError } from "effect/sql";
import { IanaTimeZone } from "../../../src/core/_shared/context";
import { Currency, Money, encodeMoneyAmount } from "../../../src/core/_shared/money";
import { Budget, type BudgetId, type UpdateBudgetInput } from "../../../src/core/budgets/contract";
import { CategoryReference } from "../../../src/core/categories/contract";
import { currentCategoryRelease, interpretCategory } from "../../../src/core/categories/operations";
import type { UserId } from "../../../src/core/identity/contract";
import {
  CanonicalAdmissionUnavailable,
  type CanonicalRejection,
  type LocalMutationResult,
  notFoundRejection,
  validationRejection,
} from "../../canonical-admission/contract";
import { resolveLocalCategory, retainLocalCategory } from "../../categories/operations";
import { newId } from "../../secret-material/operations";
import {
  formatWhatsAppCategory,
  formatWhatsAppDate,
  formatWhatsAppMoney,
} from "../../../src/shell/channels/whatsapp/operations";
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

export const missingBudget = (): CanonicalRejection =>
  notFoundRejection("Budget or Category unavailable.");

const invalidBudget = (): CanonicalRejection => validationRejection("Budget input unavailable.");

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

  yield* Effect.forEach(
    refs,
    Effect.fnUntraced(function* (ref) {
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
    }),
    { discard: true }
  );

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

  const caps = sql`WITH selected AS (SELECT id,cap FROM budgets WHERE ${members}), caps AS (
    SELECT cap FROM selected UNION SELECT COALESCE((SELECT p.cap FROM budget_month_plan_records p
      WHERE p.kind='cap' AND p.user_id=${user} AND p.budget_id=s.id AND p.month<=${month} ORDER BY p.month DESC LIMIT 1),s.cap) FROM selected s
    UNION SELECT p.cap FROM budget_month_plan_records p JOIN selected s ON s.id=p.budget_id
    WHERE p.kind='cap' AND p.user_id=${user} AND p.month>=${month})`;

  const capsFitFrom = (
    after: Option.Option<string>
  ): Effect.Effect<boolean, SqlError.SqlError | Schema.SchemaError> =>
    sql`${caps} SELECT cap FROM caps WHERE ${Option.getOrNull(after)} IS NULL OR cap>${Option.getOrNull(after)} ORDER BY cap LIMIT ${maximumBudgets}`.pipe(
      Effect.flatMap(
        Schema.decodeUnknownEffect(Schema.Array(Schema.Struct({ cap: Schema.String })))
      ),
      Effect.flatMap((rows) => {
        if (rows.some((row) => Option.isNone(fits({ amount: row.cap, currency })))) {
          return Effect.succeed(false);
        }

        const last = Arr.last(rows);

        return rows.length < maximumBudgets || Option.isNone(last)
          ? Effect.succeed(true)
          : capsFitFrom(Option.some(last.value.cap));
      })
    );

  return yield* capsFitFrom(Option.none());
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

  if (Option.isSome(id) && Option.isNone(existing)) return yield* missingBudget();

  if (!(yield* validGroup(user, input, existing))) return yield* invalidBudget();

  const [conflict] =
    yield* sql`SELECT id FROM budgets WHERE user_id=${user} AND category_id=${input.categoryId} AND currency=${input.cap.currency} AND id<>${Option.getOrElse(id, () => "")}`;

  if (conflict !== undefined) return yield* invalidBudget();

  if (Option.isNone(id)) {
    const full =
      yield* sql`SELECT 1 FROM budgets WHERE user_id=${user} LIMIT 1 OFFSET ${maximumBudgets - 1}`;

    if (full.length > 0) return yield* invalidBudget();
  }
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
      SELECT ${budgetId},${user},${input.categoryId},${revision},${input.cap.currency},${cap},${current},${current},${group},${month}
      WHERE NOT EXISTS (SELECT 1 FROM budgets WHERE user_id=${user} LIMIT 1 OFFSET ${maximumBudgets - 1}) RETURNING id`
    : yield* sql`UPDATE budgets SET category_id=${input.categoryId}, category_revision=${revision},
      cap=CASE WHEN ${month} IS NULL THEN ${cap} ELSE cap END, group_name=COALESCE(${group},group_name),
      starts_month=CASE WHEN starts_month>${month} THEN ${month} ELSE starts_month END, updated_at_ms=${current}
      WHERE id=${budgetId} AND user_id=${user} RETURNING id`;
});

class BudgetWriteConflict extends Data.TaggedError("BudgetWriteConflict") {}

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

  if (conflicts.length > 0) return yield* new BudgetWriteConflict();
});

const budgetTargets = ({ id, input }: SaveInput): ReadonlyArray<string> => [
  "budget-category:" + input.categoryId + ":" + input.cap.currency,
  ...Option.toArray(id).map((value) => "budget:" + value),
  ...Option.toArray(Option.fromUndefinedOr(input.groupName)).map(
    (value) => "budget-group:" + value
  ),
  ...(input.groupCategoryIds ?? []).map((value) => "budget-member:" + value),
];

const budgetCategory = Effect.fnUntraced(function* (user: UserId, input: UpdateBudgetInput) {
  return yield* resolveLocalCategory({
    userId: user,
    capture: {
      caller: Option.some(input.categoryId),
      direction: "outflow",
      counterparty: Option.none(),
    },
  }).pipe(
    Effect.asSome,
    Effect.tapError(Effect.logDebug),
    Effect.catchTag("CategoryNotFound", () => Effect.succeedNone)
  );
});

const categoryLabel = (id: string): string =>
  Option.getOrElse(formatWhatsAppCategory(id), () => id);

const budgetChangeText = (input: UpdateBudgetInput): string => {
  const members = input.groupCategoryIds ?? [];

  return `Nuevo presupuesto: ${categoryLabel(input.categoryId)}, de ${formatWhatsAppMoney(input.cap)}${input.month === undefined ? "" : ` para ${formatWhatsAppDate(`${input.month}-01`).replace(/^1 de /u, "")}`}${input.groupName === undefined ? "" : `, grupo «${input.groupName}»`}${members.length === 0 ? "" : `. El grupo incluye ${members.map(categoryLabel).join(", ")}`}${input.groupCurrency === undefined ? "" : `. La moneda del grupo será ${input.groupCurrency}; se conservan los importes sin conversión`}`;
};

const budgetReview = Effect.fn(function* ({
  user,
  id,
  action,
  members,
  proposed,
}: {
  user: UserId;
  id: BudgetId;
  action: "Cambiar" | "Eliminar";
  members: ReadonlyArray<string>;
  proposed: Option.Option<string>;
}) {
  const sql = yield* SqliteClient;
  const [budget] = (yield* plannedBudgets(user, Option.none(), Option.some(id))).budgets;

  if (budget === undefined) return yield* budgetUnavailable();

  const keys = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Array(Schema.String)))(
    members
  );

  const group =
    yield* sql`SELECT id,group_name,updated_at_ms FROM budgets WHERE user_id=${user} AND category_id IN (SELECT value FROM json_each(${keys})) ORDER BY id`;

  const revision = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))({
    budget: yield* Schema.encodeEffect(Schema.toCodecJson(Budget))(budget),
    group,
  });

  return {
    revision,
    effect: `${action} ${members.length === 0 ? "el presupuesto" : "el grupo de " + members.length + " categorías y el presupuesto"} ${id}, categoría ${categoryLabel(budget.categoryId)}, límite actual ${formatWhatsAppMoney(budget.cap)}.${Option.match(proposed, { onNone: () => "", onSome: (text) => " " + text })}`,
  };
});

const changeReview = (
  { id, input }: SaveInput,
  user: UserId
): {} | { review: ReturnType<typeof budgetReview> } =>
  Option.isSome(id)
    ? {
        review: budgetReview({
          user,
          id: id.value,
          action: "Cambiar",
          members: input.groupCategoryIds ?? [],
          proposed: Option.some(budgetChangeText(input)),
        }),
      }
    : {};

export const prepareLocalBudget = Effect.fn(function* (
  save: SaveInput,
  user: UserId,
  current: number
) {
  const { id, input } = save;
  yield* validateBudget(save, user);
  const reference = yield* budgetCategory(user, input);

  if (Option.isNone(reference)) return yield* missingBudget();
  const client = yield* SqliteClient;

  const plan = prepareLocalWrite({
    targets: budgetTargets(save),
    ...changeReview(save, user),
    commit: client
      .withTransaction(
        Effect.gen(function* () {
          yield* retainLocalCategory(reference.value);

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

          if (changed.length !== 1) {
            return yield* Option.isNone(id) ? new BudgetWriteConflict() : budgetUnavailable();
          }

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
          yield* (yield* BudgetThresholdEvaluation)(user, current);

          return {
            ...budgetSuccess(yield* Schema.encodeEffect(Schema.toCodecJson(Budget))(saved)),
            status: Option.isNone(id) ? createdStatus : updatedStatus,
          } satisfies LocalMutationResult;
        })
      )
      .pipe(Effect.catchTag("BudgetWriteConflict", () => Effect.fail(invalidBudget()))),
  });

  return { ...plan, premises: ["budget-member:" + input.categoryId] };
});

export const saveLocalBudget = Effect.fn(function* (
  save: SaveInput,
  user: UserId,
  current: number
) {
  return yield* prepareLocalBudget(save, user, current).pipe(Effect.flatMap(commitLocalPlan));
});

export const prepareLocalBudgetDeletion = Effect.fn(function* (id: BudgetId, user: UserId) {
  const sql = yield* SqliteClient;

  if ((yield* plannedBudgets(user, Option.none(), Option.some(id))).budgets.length === 0) {
    return yield* missingBudget();
  }

  const plan = prepareLocalWrite({
    targets: ["budget:" + id],
    review: budgetReview({ user, id, action: "Eliminar", members: [], proposed: Option.none() }),
    commit: Effect.gen(function* () {
      const removed =
        yield* sql`DELETE FROM budgets WHERE id=${id} AND user_id=${user} RETURNING id`;

      if (removed.length !== 1) return yield* budgetUnavailable();

      return budgetSuccess(id);
    }),
  });

  return { ...plan, removedTarget: Option.some("budget:" + id) };
});

export const deleteLocalBudget = Effect.fnUntraced(function* (id: BudgetId, user: UserId) {
  return yield* prepareLocalBudgetDeletion(id, user).pipe(Effect.flatMap(commitLocalPlan));
});
