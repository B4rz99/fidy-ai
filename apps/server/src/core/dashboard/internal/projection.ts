import { type DashboardProjectionRange, type Widget } from "~/core/dashboard/contract";
import { DateTime, Function } from "effect";
import type { IanaTimeZone } from "~/core/_shared/context";
import { resolveDashboardPeriod } from "./calculation";

const monthCharacters = 7;
const dayCharacters = 10;

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
