import { BigDecimal, Schema } from "effect";
import { Currency, Money, type ReadonlyMoney } from "~/core/_shared/money";
import { WeeklyPeriods } from "~/core/insights/contract";
import { CategoryId } from "~/core/categories/contract";

const changeFor = (order: number): "Increased" | "Decreased" | "Unchanged" => {
  if (order > 0) return "Increased";
  return order < 0 ? "Decreased" : "Unchanged";
};
/** Exact same-Currency directional comparison; the delta never carries a sign or a percentage. */
export const WeeklyComparison = Schema.Struct({
  current: Money,
  previous: Money,
  change: Schema.Literals(["Increased", "Decreased", "Unchanged"]),
  absoluteDelta: Money,
}).check(
  Schema.makeFilter<
    Readonly<{
      current: ReadonlyMoney;
      previous: ReadonlyMoney;
      change: string;
      absoluteDelta: ReadonlyMoney;
    }>
  >((value) => {
    const order = BigDecimal.Order(value.current.amount, value.previous.amount);
    return (
      value.current.currency === value.previous.currency &&
      value.current.currency === value.absoluteDelta.currency &&
      value.change === changeFor(order) &&
      BigDecimal.equals(
        value.absoluteDelta.amount,
        BigDecimal.abs(BigDecimal.subtract(value.current.amount, value.previous.amount))
      )
    );
  })
);
export type WeeklyComparison = typeof WeeklyComparison.Type;

/** One positive current-period outflow total for a stable Category, independent of mutable labels. */
export const WeeklyCategory = Schema.Struct({ categoryId: CategoryId, outflow: Money }).check(
  Schema.makeFilter<Readonly<{ outflow: ReadonlyMoney }>>((value) =>
    BigDecimal.isPositive(value.outflow.amount)
  )
);
export type WeeklyCategory = typeof WeeklyCategory.Type;
type CategoryView = Readonly<{ categoryId: CategoryId; outflow: ReadonlyMoney }>;
const categoryPrecedes = (left: CategoryView, right: CategoryView): boolean => {
  const order = BigDecimal.Order(left.outflow.amount, right.outflow.amount);
  return order > 0 || (order === 0 && left.categoryId < right.categoryId);
};
const categoryCoverage = (
  categories: ReadonlyArray<CategoryView>,
  current: ReadonlyMoney
): boolean =>
  BigDecimal.Order(
    BigDecimal.sumAll(categories.map((category) => category.outflow.amount)),
    current.amount
  ) <= 0 &&
  (!BigDecimal.isPositive(current.amount) || categories.length > 0);
const categoriesOrdered = (
  categories: ReadonlyArray<CategoryView>,
  current: ReadonlyMoney
): boolean => {
  const seen = new Set<CategoryId>();
  for (const [index, category] of categories.entries()) {
    if (
      category.outflow.currency !== current.currency ||
      seen.has(category.categoryId) ||
      BigDecimal.Order(category.outflow.amount, current.amount) > 0
    ) {
      return false;
    }
    seen.add(category.categoryId);
    const previous = categories[index - 1];
    if (previous === undefined) continue;
    if (!categoryPrecedes(previous, category)) return false;
  }
  return categoryCoverage(categories, current);
};
type ComparisonView = Readonly<{ current: ReadonlyMoney; previous: ReadonlyMoney }>;
type GroupView = Readonly<{
  currency: Currency;
  inflow: ComparisonView;
  outflow: ComparisonView;
  topOutflowCategories: ReadonlyArray<CategoryView>;
}>;
/** Current outflow leaders use descending Money then ascending stable Category identity, never label order. */
export const WeeklyCurrencyGroup = Schema.Struct({
  currency: Currency,
  inflow: WeeklyComparison,
  outflow: WeeklyComparison,
  topOutflowCategories: Schema.Array(WeeklyCategory).check(Schema.isMaxLength(3)),
}).check(
  Schema.makeFilter<GroupView>((value) => {
    if (
      value.inflow.current.currency !== value.currency ||
      value.outflow.current.currency !== value.currency
    ) {
      return false;
    }
    if (
      [
        value.inflow.current,
        value.inflow.previous,
        value.outflow.current,
        value.outflow.previous,
      ].every((money: ReadonlyMoney) => BigDecimal.isZero(money.amount))
    ) {
      return false;
    }
    return categoriesOrdered(value.topOutflowCategories, value.outflow.current);
  })
);
const groupsOrdered = (groups: ReadonlyArray<GroupView>): boolean =>
  groups.every((group, index) => {
    const previous = groups[index - 1];
    return previous === undefined || previous.currency < group.currency;
  });
/** Frozen financial facts for one occurrence; all Currency groups are retained without conversion or commentary. */
export const WeeklySummaryPayload = Schema.Struct({
  periods: WeeklyPeriods,
  financialRevision: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  groups: Schema.NonEmptyArray(WeeklyCurrencyGroup),
})
  .check(
    Schema.makeFilter<Readonly<{ groups: ReadonlyArray<GroupView> }>>(
      (value) =>
        groupsOrdered(value.groups) &&
        value.groups.some(
          (group) =>
            !BigDecimal.isZero(group.inflow.current.amount) ||
            !BigDecimal.isZero(group.outflow.current.amount)
        )
    )
  )
  .annotate({ identifier: "WeeklySummaryPayload" });
export type WeeklySummaryPayload = typeof WeeklySummaryPayload.Type;

/** Deterministic visible facts before channel framing; every Currency group is preserved and Category labels are captured by the caller. */
export type WeeklySummaryPresentation = Readonly<{
  period: string;
  currencies: ReadonlyArray<Currency>;
  sections: ReadonlyArray<Readonly<{ currency: Currency; text: string }>>;
}>;

/** Empty current history advances execution without generating a report or send intent. */
export type WeeklySummaryOutcome =
  | Readonly<{ _tag: "NoActivity" }>
  | Readonly<{ _tag: "Summary"; payload: WeeklySummaryPayload }>;
