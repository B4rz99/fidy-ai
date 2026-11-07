import { currencyChartData } from "./spending-presentation";
import { BigDecimal, Option } from "effect";
import type { JSX } from "react";
// The Dashboard owns this lazy chart boundary; another import boundary would serialize rendering.
// react-doctor-disable-next-line prefer-dynamic-import
import { Bar, BarChart, CartesianGrid, XAxis } from "recharts";
import {
  DashboardAxisTick,
  DashboardChart,
  DashboardTooltip,
} from "@/ui/components/dashboard-chart";
import { DashboardCurrency } from "@/ui/components/dashboard";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@/ui/components/empty";
import { exactChartAmount, formatCurrencyAmount } from "./money-presentation";
import type { DashboardView, DashboardWidgetView } from "./presentation";
import { periodLabel } from "./period-presentation";

type SpendingResult = Extract<DashboardWidgetView["result"], { readonly buckets: unknown }>;
type SpendingCurrency = SpendingResult["buckets"][number]["moneyGroups"][number]["currency"];
type DashboardLocale = DashboardView["context"]["locale"];

const categoryAxisHeight = 80;
const calendarAxisHeight = 30;

const CurrencySpendingChart = ({
  data,
  currency,
  locale,
}: Readonly<{
  data: SpendingResult;
  currency: SpendingCurrency;
  locale: DashboardLocale;
}>): JSX.Element => {
  const chartData = currencyChartData({ data, currency });
  const category = data.buckets.some((bucket) => bucket.key.kind === "category");
  return (
    <section className="dashboard-chart-series" key={currency} aria-label={`Serie ${currency}`}>
      <span className="dashboard-chart-currency">
        <DashboardCurrency>{currency}</DashboardCurrency>
      </span>
      <span className="dashboard-chart-legend">Gastos</span>
      <DashboardChart categoryCount={category ? chartData.length : 0}>
        <BarChart responsive width="100%" height="100%" accessibilityLayer data={chartData}>
          <CartesianGrid vertical={false} stroke="var(--application-line)" />
          <XAxis
            dataKey="key"
            interval={0}
            axisLine={false}
            tickLine={false}
            tickMargin={16}
            height={category ? categoryAxisHeight : calendarAxisHeight}
            tick={<DashboardAxisTick category={category} labels={chartData} />}
          />
          <DashboardTooltip
            labelFormatter={(key) => chartData.find((row) => row.key === key)?.label ?? ""}
            formatter={(_value: unknown, _name: unknown, item) => {
              const amount = exactChartAmount({
                payload: item.payload,
                series: "outflow",
              }).pipe(
                Option.map((exact) => formatCurrencyAmount({ amount: exact, currency, locale })),
                Option.getOrElse(() => "No disponible")
              );
              return [amount, "Gastos"];
            }}
          />
          <Bar dataKey="outflow" fill="var(--dashboard-chart-fill)" radius={4} maxBarSize={52} />
        </BarChart>
      </DashboardChart>
      <div className="dashboard-chart-footer">
        {periodLabel({ period: data.appliedPeriod, locale })} · {currency}
      </div>
    </section>
  );
};

export const SpendingChart = ({
  data,
  locale,
}: Readonly<{ data: SpendingResult; locale: DashboardLocale }>): JSX.Element => {
  const currencySet = new Set<SpendingCurrency>();
  for (const { moneyGroups } of data.buckets) {
    for (const { currency, outflow } of moneyGroups) {
      if (BigDecimal.isPositive(outflow.amount)) currencySet.add(currency);
    }
  }
  const currencies = Array.from(currencySet).sort();
  if (currencies.length === 0) {
    return (
      <Empty className="border">
        <EmptyHeader>
          <EmptyTitle>No hay transacciones en este periodo</EmptyTitle>
          <EmptyDescription>El gráfico aparecerá cuando existan datos.</EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }
  return (
    <div className="flex flex-col gap-5">
      {currencies.map((currency) => (
        <CurrencySpendingChart key={currency} data={data} currency={currency} locale={locale} />
      ))}
    </div>
  );
};
