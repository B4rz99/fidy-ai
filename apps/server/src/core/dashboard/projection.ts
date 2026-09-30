import { DateTime, Function } from "effect";
import type { IanaTimeZone } from "~/core/_shared/context";
import type { CategoryId } from "~/core/categories/contract";
import { resolveDashboardPeriod } from "./calculation";
import type { Widget } from "./model";

const monthCharacters = 7;
const dayCharacters = 10;

/** One UTC range whose aggregated facts form one local Dashboard chart bucket. */
export type DashboardProjectionRange = Readonly<{
  key: string;
  from: number;
  toExclusive: number;
}>;

/** Resolve requested periods and local chart buckets without consulting retained history. */
export const dashboardProjectionRanges: {
  (
    widget: Exclude<Widget, { type: "transaction-list" }>,
    now: DateTime.Utc,
    timeZone: IanaTimeZone
  ): ReadonlyArray<DashboardProjectionRange>;
  (
    now: DateTime.Utc,
    timeZone: IanaTimeZone
  ): (
    widget: Exclude<Widget, { type: "transaction-list" }>
  ) => ReadonlyArray<DashboardProjectionRange>;
} = Function.dual(
  3,
  (
    widget: Exclude<Widget, { type: "transaction-list" }>,
    now: DateTime.Utc,
    timeZone: IanaTimeZone
  ): ReadonlyArray<DashboardProjectionRange> => {
    const period = resolveDashboardPeriod({
      now,
      period: widget.type === "budget-bar" ? "this-month" : widget.period,
      timeZone,
    });
    if (widget.type !== "spending-chart" || widget.groupBy === "category") {
      return [
        {
          key: "",
          from: period.from.epochMilliseconds,
          toExclusive: period.toExclusive.epochMilliseconds,
        },
      ];
    }
    const ranges: Array<DashboardProjectionRange> = [];
    const zone = DateTime.zoneMakeNamedUnsafe(timeZone);
    let start = DateTime.setZone(period.from, zone);
    while (DateTime.Order(DateTime.toUtc(start), period.toExclusive) < 0) {
      const next = DateTime.add(start, widget.groupBy === "day" ? { days: 1 } : { months: 1 });
      const nextUtc = DateTime.toUtc(next);
      ranges.push({
        key: DateTime.formatIsoDate(start).slice(
          0,
          widget.groupBy === "day" ? dayCharacters : monthCharacters
        ),
        from: DateTime.toUtc(start).epochMilliseconds,
        toExclusive: Math.min(nextUtc.epochMilliseconds, period.toExclusive.epochMilliseconds),
      });
      start = next;
    }
    return ranges;
  }
);

type CategoryFact = Readonly<{ id: CategoryId; label: string }>;

/** One spending-chart bucket key, resolved in the User's time zone for calendar dimensions. */
export type DashboardBucket<Category extends CategoryFact> =
  | Readonly<{ kind: "category"; category: Category }>
  | Readonly<{ kind: "day"; date: string }>
  | Readonly<{ kind: "month"; month: string }>;
