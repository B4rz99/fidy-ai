import { UserContext, UserId } from "../../../src/core/identity/contract";
import { DateTime, Effect, Option, Schema } from "effect";
import { prepareUserContext } from "../../identity/user-context/operations";
import type { Category } from "../../../src/core/categories/contract";
import {
  type DashboardDocument,
  type DashboardProjectionRange,
  type ProjectedRange,
} from "../../../src/core/dashboard/contract";
import {
  collectLayoutWidgets,
  dashboardProjectionRanges,
} from "../../../src/core/dashboard/operations";
import type { DashboardFacts } from "../../../src/shell/dashboard/contract";
import type { Budget } from "../../../src/core/budgets/contract";
import type { DashboardTransactionSnapshot } from "../../transactions/contract";
import { prepareBudgetCaps } from "../../budgets/operations";
import { readDashboardTransactions } from "../../transactions/operations";

export type DashboardReadContext = Readonly<{
  context: UserContext;
  categories: ReadonlyArray<Category>;
}>;
type LayoutWidgets = ReturnType<typeof collectLayoutWidgets>;
type RangePlan = Readonly<{
  plans: ReadonlyArray<Readonly<{ id: string; ranges: ReadonlyArray<DashboardProjectionRange> }>>;
  unique: ReadonlyMap<string, Readonly<{ from: number; toExclusive: number }>>;
}>;
type FinancialSnapshot = DashboardTransactionSnapshot<ReadonlyArray<Budget>>;
const monthLabelLength = 7;
const sameContext = Schema.toEquivalence(UserContext);

const planRanges = (widgets: LayoutWidgets, now: DateTime.Utc, context: UserContext): RangePlan => {
  const plans = widgets
    .filter((widget) => widget.type !== "transaction-list")
    .map((widget) => ({
      id: widget.id,
      ranges: dashboardProjectionRanges(widget, now, context.timeZone),
    }));
  const unique = new Map<string, Readonly<{ from: number; toExclusive: number }>>();
  for (const plan of plans) {
    for (const range of plan.ranges) unique.set(`${range.from}:${range.toExclusive}`, range);
  }
  return { plans, unique };
};

const readFinancialSnapshot = ({
  db,
  userId,
  initial,
  widgets,
  plan,
  now,
}: Readonly<{
  db: D1Database;
  userId: string;
  initial: DashboardReadContext;
  widgets: LayoutWidgets;
  plan: RangePlan;
  now: DateTime.Utc;
}>): Effect.Effect<Option.Option<FinancialSnapshot>> => {
  const { context, categories } = initial;
  const month = DateTime.formatIsoDate(
    DateTime.setZone(now, DateTime.zoneMakeNamedUnsafe(context.timeZone))
  ).slice(0, monthLabelLength);
  const caps = prepareBudgetCaps({ db, userId, month });
  if (Option.isNone(caps)) return Effect.succeedNone;
  return readDashboardTransactions({
    db,
    userId,
    categories,
    lists: widgets
      .filter((widget) => widget.type === "transaction-list")
      .map((widget) => ({
        categories: widget.categories ?? [],
        search: Option.fromUndefinedOr(widget.search),
        limit: widget.limit,
      })),
    ranges: [...plan.unique.values()],
    snapshot: {
      statements: [
        prepareUserContext({
          db,
          userId: UserId.make(userId),
          statement: {
            sql: "SELECT serviceMarket, locale, timeZone FROM identity_user_context",
            params: [],
          },
        }),
        caps.value.statement,
      ],
      accepts: (rows): boolean => {
        if (rows.length !== 1) return false;
        const decoded = Schema.decodeUnknownOption(UserContext)(rows[0]);
        return Option.isSome(decoded) && sameContext(decoded.value, context);
      },
      decode: (rows): Effect.Effect<Option.Option<ReadonlyArray<Budget>>> =>
        rows[1] === undefined ? Effect.succeedNone : caps.value.decode(rows[1].results),
    },
  });
};

const restoreGroups = (
  plan: RangePlan,
  selected: FinancialSnapshot
): Option.Option<DashboardFacts["groups"]> => {
  if (selected.ranges.length !== plan.unique.size) return Option.none();
  const facts = new Map([...plan.unique.keys()].map((key, index) => [key, selected.ranges[index]]));
  const groups = new Map<string, ReadonlyArray<ProjectedRange>>();
  for (const widget of plan.plans) {
    const buckets: Array<ProjectedRange> = [];
    for (const range of widget.ranges) {
      const contributions = facts.get(`${range.from}:${range.toExclusive}`);
      if (contributions === undefined) return Option.none();
      buckets.push({ key: range.key, contributions });
    }
    groups.set(widget.id, buckets);
  }
  return Option.some(groups);
};

/** Read all bounded financial facts at one revision, with one captured calendar interpretation. */
export const loadDashboardFacts = ({
  db,
  userId,
  document,
  now,
  initial,
}: Readonly<{
  db: D1Database;
  userId: string;
  document: DashboardDocument;
  now: DateTime.Utc;
  initial: DashboardReadContext;
}>): Effect.Effect<Option.Option<DashboardFacts>> =>
  Effect.gen(function* () {
    const widgets = collectLayoutWidgets(document.layout);
    const plan = planRanges(widgets, now, initial.context);
    const selected = yield* readFinancialSnapshot({ db, userId, initial, widgets, plan, now });
    if (Option.isNone(selected)) return Option.none();
    const groups = restoreGroups(plan, selected.value);
    const listFacts = Option.all(
      widgets
        .filter((widget) => widget.type === "transaction-list")
        .map((widget, index) =>
          Option.map(
            Option.fromUndefinedOr(selected.value.lists[index]),
            (rows) => [widget.id, rows] as const
          )
        )
    );
    if (Option.isNone(groups) || Option.isNone(listFacts)) return Option.none();
    return Option.some({
      context: initial.context,
      categories: new Map(initial.categories.map((category) => [category.id, category])),
      lists: new Map(listFacts.value),
      budgets: selected.value.snapshot,
      groups: groups.value,
    });
  }).pipe(Effect.orElseSucceed(() => Option.none()));
