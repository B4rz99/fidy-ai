import { DateTime, Function, Option } from "effect";
import type { IanaTimeZone } from "~/core/_shared/context";
import { type MoneyGroups, type ReadonlyMoney } from "~/core/_shared/money";
import type { CategoryId } from "~/core/categories/reference";
import { dashboardMoneyGroupsFromSums } from "./calculation";
import type { AppliedDashboardPeriod, SpendingGroupBy, Widget } from "./model";

const monthCharacters = 7;

type Selection = Readonly<{
  categoryId: CategoryId;
  occurredAt: number;
  counterparty: Option.Option<string>;
  notes: Option.Option<string>;
}>;

type Criteria = Readonly<{
  categories: Option.Option<ReadonlyArray<CategoryId>>;
  period: Option.Option<Readonly<{ from: number; toExclusive: number }>>;
  search: Option.Option<string>;
}>;

/** Selects decoded Transaction fields against optional category, period, and search criteria. */
export const includesDashboardTransaction: {
  (transaction: Selection, criteria: Criteria): boolean;
  (criteria: Criteria): (transaction: Selection) => boolean;
} = Function.dual(2, (transaction: Selection, criteria: Criteria): boolean => {
  if (
    Option.isSome(criteria.categories) &&
    !criteria.categories.value.includes(transaction.categoryId)
  ) {
    return false;
  }
  if (
    Option.isSome(criteria.period) &&
    (transaction.occurredAt < criteria.period.value.from ||
      transaction.occurredAt >= criteria.period.value.toExclusive)
  ) {
    return false;
  }
  if (Option.isNone(criteria.search)) return true;
  const text = `${Option.getOrElse(transaction.counterparty, () => "")} ${Option.getOrElse(transaction.notes, () => "")}`;
  return text.toLocaleLowerCase("es-CO").includes(criteria.search.value.toLocaleLowerCase("es-CO"));
});

type PresentationTransaction = Readonly<{
  categoryId: CategoryId;
  occurredAt: DateTime.Utc;
  counterparty: Option.Option<string>;
  notes: Option.Option<string>;
}>;

/** Selects the effective Transaction facts needed by a Widget and its applied period. */
export const selectDashboardFacts: {
  <Fact extends Readonly<{ transaction: PresentationTransaction }>>(
    facts: ReadonlyArray<Fact>,
    widget: Widget,
    period: Option.Option<AppliedDashboardPeriod>
  ): ReadonlyArray<Fact>;
  (
    widget: Widget,
    period: Option.Option<AppliedDashboardPeriod>
  ): <Fact extends Readonly<{ transaction: PresentationTransaction }>>(
    facts: ReadonlyArray<Fact>
  ) => ReadonlyArray<Fact>;
} = Function.dual(
  3,
  <Fact extends Readonly<{ transaction: PresentationTransaction }>>(
    facts: ReadonlyArray<Fact>,
    widget: Widget,
    period: Option.Option<AppliedDashboardPeriod>
  ): ReadonlyArray<Fact> => {
    const categories =
      widget.type === "budget-bar"
        ? Option.some([widget.categoryId])
        : Option.fromUndefinedOr(widget.categories);
    const search =
      widget.type === "transaction-list" ? Option.fromUndefinedOr(widget.search) : Option.none();
    const interval = Option.map(period, ({ from, toExclusive }) => ({
      from: from.epochMilliseconds,
      toExclusive: toExclusive.epochMilliseconds,
    }));
    return facts.filter(({ transaction }) =>
      includesDashboardTransaction(
        {
          categoryId: transaction.categoryId,
          occurredAt: transaction.occurredAt.epochMilliseconds,
          counterparty: transaction.counterparty,
          notes: transaction.notes,
        },
        { categories, period: interval, search }
      )
    );
  }
);

type CategoryFact = Readonly<{ id: CategoryId; label: string }>;

/** One spending-chart bucket key, resolved in the User's time zone for calendar dimensions. */
export type DashboardBucket<Category extends CategoryFact> =
  | Readonly<{ kind: "category"; category: Category }>
  | Readonly<{ kind: "day"; date: string }>
  | Readonly<{ kind: "month"; month: string }>;

/** Assigns a selected Transaction to its canonical Category or local calendar bucket. */
export const dashboardBucket = <Category extends CategoryFact>(
  input: Readonly<{
    groupBy: SpendingGroupBy;
    category: Category;
    occurredAt: number;
    timeZone: IanaTimeZone;
  }>
): Readonly<{ id: string; key: DashboardBucket<Category> }> => {
  if (input.groupBy === "category") {
    return { id: input.category.id, key: { kind: "category", category: input.category } };
  }
  const local = DateTime.setZone(
    DateTime.makeUnsafe(input.occurredAt),
    DateTime.zoneMakeNamedUnsafe(input.timeZone)
  );
  const day = DateTime.formatIsoDate(local);
  if (input.groupBy === "day") return { id: day, key: { kind: "day", date: day } };
  const month = day.slice(0, monthCharacters);
  return { id: month, key: { kind: "month", month } };
};

type ChartFact<Category extends CategoryFact> = Readonly<{
  category: Category;
  occurredAt: number;
  direction: "inflow" | "outflow";
  money: ReadonlyMoney;
}>;

type ChartPlan = Readonly<{ groupBy: SpendingGroupBy; timeZone: IanaTimeZone }>;
type ChartGroup<Category extends CategoryFact> = Readonly<{
  key: DashboardBucket<Category>;
  moneyGroups: MoneyGroups;
}>;

/** Groups selected canonical Money facts by local chart dimension, then by Currency and direction. */
export const groupDashboardChart: {
  <Category extends CategoryFact>(
    facts: ReadonlyArray<ChartFact<Category>>,
    plan: ChartPlan
  ): ReadonlyArray<ChartGroup<Category>>;
  (
    plan: ChartPlan
  ): <Category extends CategoryFact>(
    facts: ReadonlyArray<ChartFact<Category>>
  ) => ReadonlyArray<ChartGroup<Category>>;
} = Function.dual(
  2,
  <Category extends CategoryFact>(
    facts: ReadonlyArray<ChartFact<Category>>,
    plan: ChartPlan
  ): ReadonlyArray<ChartGroup<Category>> => {
    const buckets = new Map<
      string,
      { key: DashboardBucket<Category>; facts: Array<ChartFact<Category>> }
    >();
    for (const fact of facts) {
      const { id, key } = dashboardBucket({
        groupBy: plan.groupBy,
        category: fact.category,
        occurredAt: fact.occurredAt,
        timeZone: plan.timeZone,
      });
      const bucket = buckets.get(id);
      if (bucket === undefined) buckets.set(id, { key, facts: [fact] });
      else bucket.facts.push(fact);
    }
    return [...buckets.keys()].sort().map((id) => {
      const bucket = buckets.get(id);
      if (bucket === undefined) throw new Error("A chart bucket vanished during projection");
      return { key: bucket.key, moneyGroups: dashboardMoneyGroupsFromSums(bucket.facts) };
    });
  }
);
