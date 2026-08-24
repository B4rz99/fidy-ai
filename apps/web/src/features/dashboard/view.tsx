import { BigDecimal, Option } from "effect";
import { AsyncResult } from "effect/unstable/reactivity";
import { type JSX } from "react";
import { Bar, BarChart, CartesianGrid, XAxis } from "recharts";
import { Alert, AlertDescription, AlertTitle } from "@/ui/components/alert";
import { Badge } from "@/ui/components/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/ui/components/card";
import { type ChartConfig, ChartContainer, ChartTooltip } from "@/ui/components/chart";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@/ui/components/empty";
import { Progress, ProgressLabel } from "@/ui/components/progress";
import { Skeleton } from "@/ui/components/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/ui/components/table";
import {
  exactChartAmount,
  formatCurrencyAmount,
  formatMoney,
  moneyDecimalText,
  moneyProgressGeometry,
  moneySeriesGeometry,
} from "./money-presentation";
import {
  type DashboardLayout,
  type DashboardView,
  type DashboardWidget,
  type DashboardWidgetView,
  responsiveSplitClass,
  weightedChildStyle,
} from "./presentation";

type SpendingResult = Extract<DashboardWidgetView["result"], { readonly buckets: unknown }>;
type BudgetResult = Extract<DashboardWidgetView["result"], { readonly availability: unknown }>;
type ListResult = Extract<DashboardWidgetView["result"], { readonly transactions: unknown }>;
type MetricResult = Extract<DashboardWidgetView["result"], { readonly moneyGroups: unknown }>;
type AvailableBudgetResult = Extract<BudgetResult, { readonly availability: "available" }>;
type DashboardLocale = DashboardView["context"]["locale"];
type DashboardTimeZone = DashboardView["context"]["timeZone"];

const titleFor = (widget: DashboardWidget): string => {
  if (widget.title !== undefined) return widget.title;
  switch (widget.type) {
    case "spending-chart":
      return "Transacciones";
    case "budget-bar":
      return "Presupuesto";
    case "transaction-list":
      return "Transacciones recientes";
    case "custom-metric":
      return widget.label;
  }
};

const WidgetFrame = ({
  children,
  title,
  timeZone,
}: Readonly<{
  children: JSX.Element;
  title: string;
  timeZone: string;
}>): JSX.Element => (
  <Card className="h-full min-h-56">
    <CardHeader>
      <CardTitle>
        <h2>{title}</h2>
      </CardTitle>
      <CardDescription>
        Zona horaria aplicada: <span className="font-medium text-foreground">{timeZone}</span>
      </CardDescription>
    </CardHeader>
    <CardContent className="min-w-0 flex-1">{children}</CardContent>
  </Card>
);

const bucketLabel = (key: SpendingResult["buckets"][number]["key"]): string => {
  switch (key.kind) {
    case "category":
      return key.category.label;
    case "day":
      return key.date;
    case "month":
      return key.month;
  }
};

const chartConfig = {
  inflow: { label: "Ingresos", color: "var(--chart-2)" },
  outflow: { label: "Gastos", color: "var(--chart-4)" },
} satisfies ChartConfig;

type CurrencyChartDatum = Readonly<{
  label: string;
  inflowExact: string;
  outflowExact: string;
  inflow: number;
  outflow: number;
}>;

const currencyChartData = (
  data: SpendingResult,
  currency: string
): ReadonlyArray<CurrencyChartDatum> => {
  const zero = BigDecimal.make(0n, 0);
  const values = data.buckets.map((bucket) => {
    const group = bucket.moneyGroups.find((candidate) => candidate.currency === currency);
    return {
      label: bucketLabel(bucket.key),
      inflowExact: group === undefined ? "0" : moneyDecimalText(group.inflow),
      outflowExact: group === undefined ? "0" : moneyDecimalText(group.outflow),
      inflowAmount: group?.inflow.amount ?? zero,
      outflowAmount: group?.outflow.amount ?? zero,
    };
  });
  const amounts = values.flatMap(({ inflowAmount, outflowAmount }) => [
    inflowAmount,
    outflowAmount,
  ]);
  const geometry = moneySeriesGeometry(amounts);
  return values.map(({ inflowAmount: _inflow, outflowAmount: _outflow, ...value }, index) => ({
    ...value,
    inflow: geometry[index * 2] ?? 0,
    outflow: geometry[index * 2 + 1] ?? 0,
  }));
};

const SpendingChart = ({
  data,
  locale,
}: Readonly<{ data: SpendingResult; locale: DashboardLocale }>): JSX.Element => {
  const currencies = Array.from(
    new Set(data.buckets.flatMap(({ moneyGroups }) => moneyGroups.map(({ currency }) => currency)))
  ).sort();
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
      {currencies.map((currency) => {
        const chartData = currencyChartData(data, currency);
        return (
          <section className="flex flex-col gap-2" key={currency} aria-label={`Serie ${currency}`}>
            <div className="flex items-center justify-between gap-3">
              <Badge variant="outline">{currency}</Badge>
              <span className="text-xs text-muted-foreground">Ingresos · Gastos</span>
            </div>
            <ChartContainer config={chartConfig} className="h-48 min-h-48 w-full">
              <BarChart accessibilityLayer data={chartData}>
                <CartesianGrid vertical={false} />
                <XAxis dataKey="label" axisLine={false} tickLine={false} tickMargin={8} />
                <ChartTooltip
                  formatter={(_value: unknown, name: unknown, item) => {
                    const series = name === "inflow" ? "inflow" : "outflow";
                    const amount = exactChartAmount({ payload: item.payload, series }).pipe(
                      Option.map((exact) =>
                        formatCurrencyAmount({ amount: exact, currency, locale })
                      ),
                      Option.getOrElse(() => "No disponible")
                    );
                    return [amount, series === "inflow" ? "Ingresos" : "Gastos"];
                  }}
                />
                <Bar dataKey="inflow" fill="var(--color-inflow)" radius={4} />
                <Bar dataKey="outflow" fill="var(--color-outflow)" radius={4} />
              </BarChart>
            </ChartContainer>
          </section>
        );
      })}
    </div>
  );
};

const budgetStatusText = (data: AvailableBudgetResult, locale: DashboardLocale): string => {
  switch (data.status.type) {
    case "under":
      return `Disponible ${formatMoney({ money: data.status.remaining, locale })}`;
    case "reached":
      return "Presupuesto alcanzado";
    case "over":
      return `Excedido por ${formatMoney({ money: data.status.overBy, locale })}`;
  }
};

const BudgetBar = ({
  data,
  locale,
}: Readonly<{ data: BudgetResult; locale: DashboardLocale }>): JSX.Element => {
  if (data.availability === "missing-budget") {
    return (
      <Empty className="border">
        <EmptyHeader>
          <EmptyTitle>No hay presupuesto configurado</EmptyTitle>
          <EmptyDescription>
            {data.category.label} · {data.currency}
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }
  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between gap-3">
        <span className="font-medium">{data.category.label}</span>
        <Badge variant="outline">{data.currency}</Badge>
      </div>
      <Progress value={moneyProgressGeometry({ spent: data.spent, cap: data.cap })}>
        <ProgressLabel>{formatMoney({ money: data.spent, locale })}</ProgressLabel>
        <span className="ml-auto text-sm text-muted-foreground tabular-nums">
          {formatMoney({ money: data.cap, locale })}
        </span>
      </Progress>
      <p className="text-sm text-muted-foreground">{budgetStatusText(data, locale)}</p>
    </div>
  );
};

const TransactionList = ({
  data,
  locale,
  timeZone,
}: Readonly<{
  data: ListResult;
  locale: DashboardLocale;
  timeZone: DashboardTimeZone;
}>): JSX.Element => {
  if (data.transactions.length === 0) {
    return (
      <Empty className="border">
        <EmptyHeader>
          <EmptyTitle>No hay transacciones para mostrar</EmptyTitle>
        </EmptyHeader>
      </Empty>
    );
  }
  return (
    <Table aria-label="Transacciones del Widget">
      <TableHeader>
        <TableRow>
          <TableHead>Contraparte</TableHead>
          <TableHead>Tipo</TableHead>
          <TableHead className="text-right">Monto</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {data.transactions.map((transaction) => (
          <TableRow key={transaction.id}>
            <TableCell>
              <span className="font-medium">
                {Option.getOrElse(transaction.counterparty, () => "Sin contraparte")}
              </span>
              <span className="block text-xs text-muted-foreground">
                {transaction.category.label} ·{" "}
                {new Intl.DateTimeFormat(locale, {
                  day: "2-digit",
                  month: "short",
                  timeZone,
                }).format(transaction.occurredAt.epochMilliseconds)}
              </span>
            </TableCell>
            <TableCell>{transaction.direction === "inflow" ? "Ingreso" : "Gasto"}</TableCell>
            <TableCell className="text-right font-medium tabular-nums">
              {formatMoney({ money: transaction.money, locale })}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
};

const CustomMetric = ({
  data,
  locale,
}: Readonly<{ data: MetricResult; locale: DashboardLocale }>): JSX.Element =>
  data.moneyGroups.length === 0 ? (
    <Empty className="border">
      <EmptyHeader>
        <EmptyTitle>No hay transacciones para calcular</EmptyTitle>
      </EmptyHeader>
    </Empty>
  ) : (
    <div className="grid gap-4 sm:grid-cols-2">
      {data.moneyGroups.map((group) => (
        <section className="rounded-lg border p-4" key={group.currency}>
          <Badge variant="outline">{group.currency}</Badge>
          <dl className="mt-4 grid gap-3">
            <div>
              <dt className="text-xs text-muted-foreground">Ingresos</dt>
              <dd className="font-heading text-xl font-semibold tabular-nums">
                {formatMoney({ money: group.inflow, locale })}
              </dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">Gastos</dt>
              <dd className="font-heading text-xl font-semibold tabular-nums">
                {formatMoney({ money: group.outflow, locale })}
              </dd>
            </div>
          </dl>
        </section>
      ))}
    </div>
  );

const RenderWidget = ({
  view: { widget, result },
  context,
}: Readonly<{ view: DashboardWidgetView; context: DashboardView["context"] }>): JSX.Element => {
  let content: JSX.Element;
  let timeZone = context.timeZone;
  if ("buckets" in result) {
    content = <SpendingChart data={result} locale={context.locale} />;
    timeZone = result.appliedPeriod.timeZone;
  } else if ("availability" in result) {
    content = <BudgetBar data={result} locale={context.locale} />;
    timeZone = result.appliedPeriod.timeZone;
  } else if ("transactions" in result) {
    content = <TransactionList data={result} locale={context.locale} timeZone={timeZone} />;
  } else {
    content = <CustomMetric data={result} locale={context.locale} />;
    timeZone = result.appliedPeriod.timeZone;
  }
  return (
    <WidgetFrame title={titleFor(widget)} timeZone={timeZone}>
      {content}
    </WidgetFrame>
  );
};

const layoutKey = (layout: DashboardLayout): string =>
  layout.kind === "leaf" ? layout.widget.widget.id : layoutKey(layout.children[0].node);

const ResponsiveLayout = ({
  layout,
  context,
}: Readonly<{ layout: DashboardLayout; context: DashboardView["context"] }>): JSX.Element =>
  layout.kind === "leaf" ? (
    <RenderWidget view={layout.widget} context={context} />
  ) : (
    <div className={`flex min-h-0 min-w-0 flex-1 gap-4 ${responsiveSplitClass(layout.axis)}`}>
      {layout.children.map(({ node, weight }) => (
        <div
          className="flex min-h-0 min-w-0 flex-none md:[flex:var(--dashboard-weight)_1_0%]"
          data-testid={`responsive-weight-${weight}`}
          key={layoutKey(node)}
          style={weightedChildStyle(weight)}
        >
          <ResponsiveLayout layout={node} context={context} />
        </div>
      ))}
    </div>
  );

/** Read-only responsive projection of one schema-decoded canonical Dashboard view. */
export const DashboardViewComponent = ({
  view,
}: Readonly<{ view: DashboardView }>): JSX.Element => (
  <main className="mx-auto flex w-full max-w-7xl flex-col gap-6 px-4 py-8 sm:px-6 lg:px-8">
    <header className="flex flex-col gap-2">
      <h1 className="font-heading text-3xl font-semibold tracking-tight">{view.title}</h1>
      <p className="text-muted-foreground">Lectura actual de tus finanzas.</p>
    </header>
    <section aria-label="Diseño responsivo del tablero" className="flex min-h-[36rem] flex-col">
      <ResponsiveLayout layout={view.layout} context={view.context} />
    </section>
  </main>
);

const LoadingDashboard = (): JSX.Element => (
  <main
    className="mx-auto flex w-full max-w-7xl flex-col gap-4 px-4 py-8 sm:px-6 lg:px-8"
    aria-label="Cargando tablero"
    aria-live="polite"
  >
    <Skeleton className="h-12 w-64" />
    <Skeleton className="h-80 w-full" />
  </main>
);

const DashboardError = (): JSX.Element => (
  <main className="mx-auto w-full max-w-7xl px-4 py-8 sm:px-6 lg:px-8">
    <Alert variant="destructive">
      <AlertTitle>No pudimos cargar tu tablero</AlertTitle>
      <AlertDescription>Intenta de nuevo en unos momentos.</AlertDescription>
    </Alert>
  </main>
);

/** Dashboard chunk projection for the query started by the lightweight route interface. */
export const DashboardRouteContent = ({
  result,
}: Readonly<{
  result: AsyncResult.AsyncResult<Readonly<{ data: DashboardView }>, unknown>;
}>): JSX.Element => {
  if (AsyncResult.isFailure(result)) return <DashboardError />;
  return AsyncResult.isSuccess(result) ? (
    <DashboardViewComponent view={result.value.data} />
  ) : (
    <LoadingDashboard />
  );
};
