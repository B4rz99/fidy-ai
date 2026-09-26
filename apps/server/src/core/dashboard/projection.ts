import { DateTime, Function, Option } from "effect";
import type { IanaTimeZone } from "~/core/_shared/context";
import type { Category } from "~/core/categories/model";
import type { CategoryId } from "~/core/categories/reference";
import type { SpendingGroupBy } from "./model";

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

/** One spending-chart bucket key, resolved in the User's time zone for calendar dimensions. */
export type DashboardBucket =
  | Readonly<{ kind: "category"; category: Category }>
  | Readonly<{ kind: "day"; date: string }>
  | Readonly<{ kind: "month"; month: string }>;

/** Assigns a selected Transaction to its canonical Category or local calendar bucket. */
export const dashboardBucket = (
  input: Readonly<{
    groupBy: SpendingGroupBy;
    category: Category;
    occurredAt: number;
    timeZone: IanaTimeZone;
  }>
): Readonly<{ id: string; key: DashboardBucket }> => {
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
