import type { DashboardWidgetView } from "./presentation";

type SpendingResult = Extract<DashboardWidgetView["result"], { readonly buckets: unknown }>;
export const periodLabel = ({
  period,
  locale,
}: Readonly<{ period: SpendingResult["appliedPeriod"]; locale: string }>): string => {
  const month = period.requested === "this-month" || period.requested === "last-month";
  const format = new Intl.DateTimeFormat(locale, {
    month: month ? "long" : "short",
    year: "numeric",
    ...(month ? {} : { day: "numeric" }),
    timeZone: period.timeZone,
  });
  const start = format.format(period.from.epochMilliseconds);
  return month ? start : `${start} – ${format.format(period.toExclusive.epochMilliseconds - 1)}`;
};
