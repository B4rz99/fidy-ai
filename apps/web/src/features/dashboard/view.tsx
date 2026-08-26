import { BigDecimal, Option } from "effect";
import { AsyncResult } from "effect/unstable/reactivity";
import { type FormEvent, type JSX, useMemo, useState } from "react";
// Dashboard presentation is already route-lazy.
// react-doctor-disable-next-line prefer-dynamic-import
import { Bar, BarChart, CartesianGrid, XAxis } from "recharts";
import { Alert, AlertDescription, AlertTitle } from "@/ui/components/alert";
import { Badge } from "@/ui/components/badge";
import { Button } from "@/ui/components/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/ui/components/card";
import { type ChartConfig, ChartContainer, ChartTooltip } from "@/ui/components/chart";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@/ui/components/empty";
import { Input } from "@/ui/components/input";
import { Label } from "@/ui/components/label";
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
  DashboardCatalogControls,
  DashboardRegionControls,
  DashboardWidgetControls,
  type PlacementChoice,
} from "./editor-controls";
import { DashboardDragHandle, DashboardDragProvider, DashboardDropZone } from "./drag-adapter";
import { type DashboardCatalogEntry, type DashboardGesture, freshWidgetId } from "./editor-model";
import {
  type DashboardLayout,
  type DashboardView,
  type DashboardWidget,
  type DashboardWidgetView,
  responsiveSplitClass,
  weightedChildStyle,
} from "./presentation";

type SpendingResult = Extract<DashboardWidgetView["result"], { readonly buckets: unknown }>;
type SpendingCurrency = SpendingResult["buckets"][number]["moneyGroups"][number]["currency"];
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
}: Readonly<{
  children: JSX.Element;
  title: string;
}>): JSX.Element => (
  <Card className="h-full min-h-56">
    <CardHeader>
      <CardTitle>
        <h2>{title}</h2>
      </CardTitle>
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
  outflow: { label: "Gastos", color: "var(--chart-4)" },
} satisfies ChartConfig;

type CurrencyChartDatum = Readonly<{
  label: string;
  outflowExact: string;
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
      outflowExact: group === undefined ? "0" : moneyDecimalText(group.outflow),
      outflowAmount: group?.outflow.amount ?? zero,
    };
  });
  const geometry = moneySeriesGeometry(values.map(({ outflowAmount }) => outflowAmount));
  return values.map(({ outflowAmount: _outflow, ...value }, index) => ({
    ...value,
    outflow: geometry[index] ?? 0,
  }));
};

const SpendingChart = ({
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
      {currencies.map((currency) => {
        const chartData = currencyChartData(data, currency);
        return (
          <section className="flex flex-col gap-2" key={currency} aria-label={`Serie ${currency}`}>
            <div className="flex items-center justify-between gap-3">
              <Badge variant="outline">{currency}</Badge>
              <span className="text-xs text-muted-foreground">Gastos</span>
            </div>
            <ChartContainer config={chartConfig} className="h-48 min-h-48 w-full">
              <BarChart accessibilityLayer data={chartData}>
                <CartesianGrid vertical={false} />
                <XAxis dataKey="label" axisLine={false} tickLine={false} tickMargin={8} />
                <ChartTooltip
                  formatter={(_value: unknown, _name: unknown, item) => {
                    const amount = exactChartAmount({
                      payload: item.payload,
                      series: "outflow",
                    }).pipe(
                      Option.map((exact) =>
                        formatCurrencyAmount({ amount: exact, currency, locale })
                      ),
                      Option.getOrElse(() => "No disponible")
                    );
                    return [amount, "Gastos"];
                  }}
                />
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
  const dateFormatter = useMemo(
    () =>
      new Intl.DateTimeFormat(locale, {
        day: "2-digit",
        month: "short",
        timeZone,
      }),
    [locale, timeZone]
  );
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
                {dateFormatter.format(transaction.occurredAt.epochMilliseconds)}
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
  if ("buckets" in result) {
    content = <SpendingChart data={result} locale={context.locale} />;
  } else if ("availability" in result) {
    content = <BudgetBar data={result} locale={context.locale} />;
  } else if ("transactions" in result) {
    content = <TransactionList data={result} locale={context.locale} timeZone={context.timeZone} />;
  } else {
    content = <CustomMetric data={result} locale={context.locale} />;
  }
  return <WidgetFrame title={titleFor(widget)}>{content}</WidgetFrame>;
};

const layoutKey = (layout: DashboardLayout): string =>
  layout.kind === "leaf" ? layout.widget.widget.id : layoutKey(layout.children[0].node);

const collectWidgetViews = (layout: DashboardLayout): ReadonlyArray<DashboardWidgetView> =>
  layout.kind === "leaf"
    ? [layout.widget]
    : layout.children.flatMap(({ node }) => collectWidgetViews(node));

const regionWidgetIds = (
  layout: DashboardLayout
): Extract<DashboardGesture, { readonly kind: "resize-region" }>["widgetIds"] => {
  const ids = collectWidgetViews(layout).map(({ widget }) => widget.id);
  const first = ids[0];
  if (first === undefined) throw new Error("A Dashboard region must contain a Widget");
  return [first, ...ids.slice(1)];
};

const regionLabel = (layout: DashboardLayout): string => {
  const first = collectWidgetViews(layout)[0];
  if (first === undefined) throw new Error("A Dashboard region must contain a Widget");
  return titleFor(first.widget);
};

const placementChoices = (
  layout: DashboardLayout,
  excludedWidgetId: Option.Option<DashboardWidget["id"]>
): ReadonlyArray<PlacementChoice> => [
  { label: "Al inicio del tablero", target: { kind: "dashboard-edge", edge: "top" } },
  { label: "Al final del tablero", target: { kind: "dashboard-edge", edge: "bottom" } },
  ...collectWidgetViews(layout).flatMap(({ widget }) =>
    Option.exists(excludedWidgetId, (excludedId) => widget.id === excludedId)
      ? []
      : ([
          {
            label: `Arriba de ${titleFor(widget)}`,
            target: { kind: "widget-edge", widgetId: widget.id, edge: "top" },
          },
          {
            label: `A la derecha de ${titleFor(widget)}`,
            target: { kind: "widget-edge", widgetId: widget.id, edge: "right" },
          },
          {
            label: `Debajo de ${titleFor(widget)}`,
            target: { kind: "widget-edge", widgetId: widget.id, edge: "bottom" },
          },
          {
            label: `A la izquierda de ${titleFor(widget)}`,
            target: { kind: "widget-edge", widgetId: widget.id, edge: "left" },
          },
        ] as const)
  ),
];

const EditableLeaf = ({
  context,
  depth,
  editor,
  layout,
  rootLayout,
}: Readonly<{
  context: DashboardView["context"];
  depth: number;
  editor: DashboardEditor;
  layout: Extract<DashboardLayout, { readonly kind: "leaf" }>;
  rootLayout: DashboardLayout;
}>): JSX.Element => {
  const { widget } = layout.widget;
  const label = titleFor(widget);
  return (
    <div className="relative flex min-h-0 min-w-0 flex-1 flex-col gap-2">
      <div className="flex justify-end">
        <DashboardDragHandle
          disabled={editor.submitting}
          label={`Arrastrar ${label}`}
          source={{ kind: "widget", widgetId: widget.id, label }}
        />
      </div>
      <DashboardWidgetControls
        choices={placementChoices(rootLayout, Option.some(widget.id))}
        key={`${widget.id}:${label}`}
        disabled={editor.submitting}
        label={label}
        onGesture={editor.onGesture}
        widget={widget}
      />
      <div className="relative min-h-56 flex-1">
        {(["top", "right", "bottom", "left"] as const).map((edge) => (
          <DashboardDropZone
            depth={depth + 1}
            disabled={editor.submitting}
            key={edge}
            label={`Colocar ${edge} de ${label}`}
            target={{ kind: "widget-edge", widgetId: widget.id, edge }}
          />
        ))}
        <RenderWidget view={layout.widget} context={context} />
      </div>
    </div>
  );
};

const ResponsiveLayout = ({
  context,
  depth,
  editor,
  layout,
  rootLayout,
}: Readonly<{
  context: DashboardView["context"];
  depth: number;
  editor: Option.Option<DashboardEditor>;
  layout: DashboardLayout;
  rootLayout: DashboardLayout;
}>): JSX.Element => {
  if (layout.kind === "leaf") {
    return Option.isNone(editor) ? (
      <RenderWidget view={layout.widget} context={context} />
    ) : (
      <EditableLeaf
        context={context}
        depth={depth}
        editor={editor.value}
        layout={layout}
        rootLayout={rootLayout}
      />
    );
  }
  return (
    <div className={`flex min-h-0 min-w-0 flex-1 gap-4 ${responsiveSplitClass(layout.axis)}`}>
      {layout.children.map(({ node, weight }) => (
        <div
          className="flex min-h-0 min-w-0 flex-none flex-col gap-2 md:[flex:var(--dashboard-weight)_1_0%]"
          data-testid={`responsive-weight-${weight}`}
          key={layoutKey(node)}
          style={weightedChildStyle(weight)}
        >
          {Option.isNone(editor) ? null : (
            <DashboardRegionControls
              disabled={editor.value.submitting}
              label={regionLabel(node)}
              onGesture={editor.value.onGesture}
              widgetIds={regionWidgetIds(node)}
            />
          )}
          <ResponsiveLayout
            context={context}
            depth={depth + 1}
            editor={editor}
            layout={node}
            rootLayout={rootLayout}
          />
        </div>
      ))}
    </div>
  );
};

export type DashboardEditorError = Readonly<{
  message: string;
  title: string;
}>;

export type DashboardEditor = Readonly<{
  catalog: ReadonlyArray<DashboardCatalogEntry>;
  error: Option.Option<DashboardEditorError>;
  onGesture: (gesture: DashboardGesture) => void;
  submitting: boolean;
}>;

const DashboardTitleEditor = ({
  editor,
  title,
}: Readonly<{ editor: DashboardEditor; title: string }>): JSX.Element => {
  const [nextTitle, setNextTitle] = useState(title);
  const submit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    editor.onGesture({ kind: "retitle-dashboard", title: nextTitle });
  };
  return (
    <form className="flex flex-wrap items-end gap-2" onSubmit={submit}>
      <div className="grid min-w-56 flex-1 gap-1.5">
        <Label htmlFor="dashboard-title">Nuevo título del tablero</Label>
        <Input
          disabled={editor.submitting}
          id="dashboard-title"
          maxLength={80}
          onChange={(event) => setNextTitle(event.currentTarget.value)}
          value={nextTitle}
        />
      </div>
      <Button disabled={editor.submitting} type="submit" variant="outline">
        Guardar título del tablero
      </Button>
    </form>
  );
};

const CatalogDragSources = ({
  catalog,
  disabled,
}: Readonly<{ catalog: ReadonlyArray<DashboardCatalogEntry>; disabled: boolean }>): JSX.Element => (
  <ul
    aria-label="Widgets disponibles para arrastrar"
    className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4"
  >
    {catalog.map((entry) => (
      <li
        className="flex items-center justify-between gap-3 rounded-lg border bg-card p-3"
        key={entry.id}
      >
        <span>
          <span className="block text-sm font-medium">{entry.name}</span>
          <span className="block text-xs text-muted-foreground">{entry.description}</span>
        </span>
        <DashboardDragHandle
          disabled={disabled}
          label={`Arrastrar ${entry.name}`}
          source={{ kind: "catalog", entry }}
        />
      </li>
    ))}
  </ul>
);

const DashboardCanvas = ({
  editor,
  view,
}: Readonly<{
  editor: Option.Option<DashboardEditor>;
  view: DashboardView;
}>): JSX.Element => (
  <section
    aria-label="Diseño responsivo del tablero"
    className="relative flex min-h-[36rem] flex-col"
  >
    {Option.isNone(editor) ? null : (
      <DashboardDropZone
        depth={0}
        disabled={editor.value.submitting}
        label="Colocar al inicio del tablero"
        target={{ kind: "dashboard-edge", edge: "top" }}
      />
    )}
    <ResponsiveLayout
      context={view.context}
      depth={0}
      editor={editor}
      layout={view.layout}
      rootLayout={view.layout}
    />
    {Option.isNone(editor) ? null : (
      <DashboardDropZone
        depth={0}
        disabled={editor.value.submitting}
        label="Colocar al final del tablero"
        target={{ kind: "dashboard-edge", edge: "bottom" }}
      />
    )}
  </section>
);

/** Responsive projection of one schema-decoded canonical Dashboard view. */
export const DashboardViewComponent = ({
  editor,
  view,
}: Readonly<{
  editor: Option.Option<DashboardEditor>;
  view: DashboardView;
}>): JSX.Element => {
  const choices = placementChoices(view.layout, Option.none());
  const content = (
    <main className="mx-auto flex w-full max-w-7xl flex-col gap-6 px-4 py-8 sm:px-6 lg:px-8">
      <header className="flex flex-col gap-3">
        <h1 className="font-heading text-3xl font-semibold tracking-tight">{view.title}</h1>
        <p className="text-muted-foreground">Lectura actual de tus finanzas.</p>
        {Option.isNone(editor) ? null : (
          <DashboardTitleEditor editor={editor.value} key={view.title} title={view.title} />
        )}
        {Option.isNone(editor) || Option.isNone(editor.value.error) ? null : (
          <Alert variant="destructive" role="alert">
            <AlertTitle>{editor.value.error.value.title}</AlertTitle>
            <AlertDescription>{editor.value.error.value.message}</AlertDescription>
          </Alert>
        )}
      </header>
      {Option.isNone(editor) ? null : (
        <section aria-label="Catálogo de Widgets" className="grid gap-3">
          <DashboardCatalogControls
            catalog={editor.value.catalog}
            choices={choices}
            disabled={editor.value.submitting}
            makeWidgetId={freshWidgetId}
            onGesture={editor.value.onGesture}
          />
          <CatalogDragSources catalog={editor.value.catalog} disabled={editor.value.submitting} />
        </section>
      )}
      <DashboardCanvas editor={editor} view={view} />
    </main>
  );
  return Option.isNone(editor) ? (
    content
  ) : (
    <DashboardDragProvider onGesture={editor.value.onGesture}>{content}</DashboardDragProvider>
  );
};

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
    <DashboardViewComponent editor={Option.none()} view={result.value.data} />
  ) : (
    <LoadingDashboard />
  );
};
