import { BigDecimal, Option } from "effect";
import { AsyncResult } from "effect/unstable/reactivity";
import { CheckIcon, PencilIcon, XIcon } from "lucide-react";
import {
  type FormEvent,
  Fragment,
  type JSX,
  type KeyboardEvent,
  type PointerEvent,
  useMemo,
  useRef,
  useState,
} from "react";
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
import { DashboardDragHandle, DashboardDragProvider, DashboardDropZone } from "./drag-adapter";
import type { DashboardCatalogEntry, DashboardGesture } from "./editor-model";
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
  editing,
  title,
  titleEditor,
}: Readonly<{
  children: JSX.Element;
  editing: boolean;
  title: string;
  titleEditor: Option.Option<JSX.Element>;
}>): JSX.Element => (
  <Card className="min-h-72 flex-1 shadow-sm">
    <CardHeader className={editing ? "px-14 pr-20" : undefined}>
      <CardTitle>
        {Option.getOrElse(titleEditor, () => (
          <h2>{title}</h2>
        ))}
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
    <div className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,14rem),1fr))] gap-4">
      {data.moneyGroups.map((group) => (
        <section className="min-w-0 rounded-lg border p-4" key={group.currency}>
          <Badge variant="outline">{group.currency}</Badge>
          <dl className="mt-4 grid gap-3">
            <div>
              <dt className="text-xs text-muted-foreground">Ingresos</dt>
              <dd className="font-heading text-xl font-semibold break-words tabular-nums [overflow-wrap:anywhere]">
                {formatMoney({ money: group.inflow, locale })}
              </dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">Gastos</dt>
              <dd className="font-heading text-xl font-semibold break-words tabular-nums [overflow-wrap:anywhere]">
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
  editing,
  titleEditor,
}: Readonly<{
  view: DashboardWidgetView;
  context: DashboardView["context"];
  editing: boolean;
  titleEditor: Option.Option<JSX.Element>;
}>): JSX.Element => {
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
  return (
    <WidgetFrame editing={editing} title={titleFor(widget)} titleEditor={titleEditor}>
      {content}
    </WidgetFrame>
  );
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

const WidgetActions = ({
  editor,
  label,
  onRename,
  widgetId,
}: Readonly<{
  editor: DashboardEditor;
  label: string;
  onRename: () => void;
  widgetId: DashboardWidget["id"];
}>): JSX.Element => (
  <div className="absolute top-3 right-3 z-40 flex">
    <Button
      aria-label={`Renombrar ${label}`}
      disabled={editor.submitting}
      onClick={onRename}
      size="icon"
      type="button"
      variant="ghost"
    >
      <PencilIcon />
    </Button>
    <Button
      aria-label={`Eliminar ${label}`}
      disabled={editor.submitting}
      onClick={() => editor.onGesture({ kind: "remove-widget", widgetId })}
      size="icon"
      type="button"
      variant="ghost"
    >
      <XIcon />
    </Button>
  </div>
);

const maximumWidgetTitleLength = 80;

type WidgetTitleEditorProps = Readonly<{
  disabled: boolean;
  initialTitle: string;
  onCancel: () => void;
  onSave: (title: string) => void;
}>;

const WidgetTitleEditor = ({
  disabled,
  initialTitle,
  onCancel,
  onSave,
}: WidgetTitleEditorProps): JSX.Element => {
  const [title, setTitle] = useState(initialTitle);
  const submit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    const trimmedTitle = title.trim();
    if (trimmedTitle.length > 0) onSave(trimmedTitle);
  };
  return (
    <form className="flex min-w-0 items-center gap-1" onSubmit={submit}>
      <Input
        aria-label="Nuevo nombre del Widget"
        disabled={disabled}
        maxLength={maximumWidgetTitleLength}
        onChange={(event) => setTitle(event.currentTarget.value)}
        onKeyDown={(event) => {
          if (event.key === "Escape") onCancel();
        }}
        value={title}
      />
      <Button
        aria-label="Guardar nombre del Widget"
        disabled={disabled || title.trim().length === 0}
        size="icon-sm"
        type="submit"
        variant="ghost"
      >
        <CheckIcon />
      </Button>
    </form>
  );
};

const widgetDropEdges = ["top", "right", "bottom", "left", "center"] as const;
const widgetDropLabel: Record<(typeof widgetDropEdges)[number], string> = {
  top: "arriba de",
  right: "a la derecha de",
  bottom: "debajo de",
  left: "a la izquierda de",
  center: "sobre",
};

const WidgetDropTargets = ({
  depth,
  disabled,
  label,
  widgetId,
}: Readonly<{
  depth: number;
  disabled: boolean;
  label: string;
  widgetId: DashboardWidget["id"];
}>): JSX.Element => (
  <>
    {widgetDropEdges.map((edge) => (
      <DashboardDropZone
        depth={depth}
        disabled={disabled}
        key={edge}
        label={`Colocar ${widgetDropLabel[edge]} ${label}`}
        target={{ kind: "widget-edge", widgetId, edge }}
      />
    ))}
  </>
);

type EditableLeafProps = Readonly<{
  context: DashboardView["context"];
  depth: number;
  editor: DashboardEditor;
  layout: Extract<DashboardLayout, { readonly kind: "leaf" }>;
}>;

const EditableLeaf = ({ context, depth, editor, layout }: EditableLeafProps): JSX.Element => {
  const { widget } = layout.widget;
  const label = titleFor(widget);
  const [renaming, setRenaming] = useState(false);
  const saveTitle = (title: string): void => {
    editor.onGesture({ kind: "retitle-widget", title, widget });
    setRenaming(false);
  };
  return (
    <div className="relative flex min-h-0 min-w-0 flex-1 flex-col">
      <div className="absolute top-3 left-3 z-30">
        <DashboardDragHandle
          disabled={editor.submitting}
          label={`Arrastrar ${label}`}
          source={{ kind: "widget", widgetId: widget.id, label }}
        />
      </div>
      <WidgetActions
        editor={editor}
        label={label}
        onRename={() => setRenaming(true)}
        widgetId={widget.id}
      />
      <div className="relative flex min-h-72 flex-1 flex-col">
        <WidgetDropTargets
          depth={depth + 1}
          disabled={editor.submitting}
          label={label}
          widgetId={widget.id}
        />
        <RenderWidget
          editing
          view={layout.widget}
          context={context}
          titleEditor={
            renaming
              ? Option.some(
                  <WidgetTitleEditor
                    disabled={editor.submitting}
                    initialTitle={label}
                    onCancel={() => setRenaming(false)}
                    onSave={saveTitle}
                  />
                )
              : Option.none()
          }
        />
      </div>
    </div>
  );
};

const minimumResizeWeight = 0.001;
const maximumResizeWeight = 1000;
const minimumRegionPixels = 32;
const maximumMinimumShare = 0.49;
const resizeWeightPrecision = 1000;
const keyboardResizeSteps = 20;

const clampResizeWeight = (weight: number): number =>
  Math.round(
    Math.min(maximumResizeWeight, Math.max(minimumResizeWeight, weight)) * resizeWeightPrecision
  ) / resizeWeightPrecision;

const clampResizePairWeight = (weight: number, pairWeight: number): number =>
  clampResizeWeight(
    Math.min(
      maximumResizeWeight,
      pairWeight - minimumResizeWeight,
      Math.max(minimumResizeWeight, pairWeight - maximumResizeWeight, weight)
    )
  );

type ResizeBoundaryProps = Readonly<{
  axis: "row" | "column";
  childIndex: number;
  disabled: boolean;
  label: string;
  onResize: (weight: number) => void;
  siblings: Extract<DashboardLayout, { readonly kind: "split" }>["children"];
}>;

type ResizeBoundaryEvent = PointerEvent<HTMLHRElement>;

type ResizePreview = Readonly<{ adjacentWeight: number; weight: number }>;
type ResizeElements = Readonly<{ adjacent: HTMLElement; child: HTMLElement }>;

const resizeElements = (event: ResizeBoundaryEvent): Option.Option<ResizeElements> => {
  const child = event.currentTarget.previousElementSibling;
  const adjacent = event.currentTarget.nextElementSibling;
  return child instanceof HTMLElement && adjacent instanceof HTMLElement
    ? Option.some({ adjacent, child })
    : Option.none();
};

const previewResizeWeight = (
  event: ResizeBoundaryEvent,
  { axis, childIndex, siblings }: ResizeBoundaryProps
): Option.Option<ResizePreview> => {
  const elements = resizeElements(event);
  const current = Option.fromUndefinedOr(siblings[childIndex]);
  const following = Option.fromUndefinedOr(siblings[childIndex + 1]);
  if (Option.isNone(elements) || Option.isNone(current) || Option.isNone(following)) {
    return Option.none();
  }
  const childBounds = elements.value.child.getBoundingClientRect();
  const adjacentBounds = elements.value.adjacent.getBoundingClientRect();
  const start = axis === "row" ? childBounds.left : childBounds.top;
  const end = axis === "row" ? adjacentBounds.right : adjacentBounds.bottom;
  const extent = end - start;
  if (extent <= 0) return Option.none();
  const coordinate = axis === "row" ? event.clientX - start : event.clientY - start;
  const minimumShare = Math.min(maximumMinimumShare, minimumRegionPixels / extent);
  const boundaryShare = Math.min(1 - minimumShare, Math.max(minimumShare, coordinate / extent));
  const pairWeight = current.value.weight + following.value.weight;
  const nextWeight = clampResizePairWeight(pairWeight * boundaryShare, pairWeight);
  const adjacentWeight = clampResizeWeight(pairWeight - nextWeight);
  elements.value.child.style.setProperty("--dashboard-weight", String(nextWeight));
  elements.value.adjacent.style.setProperty("--dashboard-weight", String(adjacentWeight));
  return Option.some({ adjacentWeight, weight: nextWeight });
};

type ResizeBoundaryHandlers = Readonly<{
  onKeyDown: (event: KeyboardEvent<HTMLHRElement>) => void;
  onLostPointerCapture: (event: ResizeBoundaryEvent) => void;
  onPointerCancel: (event: ResizeBoundaryEvent) => void;
  onPointerDown: (event: ResizeBoundaryEvent) => void;
  onPointerMove: (event: ResizeBoundaryEvent) => void;
  onPointerUp: (event: ResizeBoundaryEvent) => void;
  weight: number;
}>;

const restoreResizePreview = (
  event: ResizeBoundaryEvent,
  weight: number,
  adjacentWeight: number
): void => {
  event.currentTarget.previousElementSibling?.setAttribute(
    "style",
    `--dashboard-weight: ${String(weight)};`
  );
  event.currentTarget.nextElementSibling?.setAttribute(
    "style",
    `--dashboard-weight: ${String(adjacentWeight)};`
  );
};

const resizeWeightAt = (props: ResizeBoundaryProps, index: number): number =>
  Option.getOrThrow(
    Option.map(Option.fromUndefinedOr(props.siblings[index]), ({ weight }) => weight)
  );

const useResizeBoundary = (props: ResizeBoundaryProps): ResizeBoundaryHandlers => {
  const pointerId = useRef(Option.none<number>());
  const weight = resizeWeightAt(props, props.childIndex);
  const adjacentWeight = resizeWeightAt(props, props.childIndex + 1);
  const pairWeight = weight + adjacentWeight;
  const onPointerDown = (event: ResizeBoundaryEvent): void => {
    pointerId.current = Option.some(event.pointerId);
    event.currentTarget.setPointerCapture(event.pointerId);
    previewResizeWeight(event, props);
  };
  const resetPointer = (event: ResizeBoundaryEvent): void => {
    pointerId.current = Option.none();
    restoreResizePreview(event, weight, adjacentWeight);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };
  const onPointerCancel = (event: ResizeBoundaryEvent): void => {
    if (Option.contains(pointerId.current, event.pointerId)) resetPointer(event);
  };
  const onLostPointerCapture = (event: ResizeBoundaryEvent): void => {
    if (Option.contains(pointerId.current, event.pointerId)) resetPointer(event);
  };
  const onPointerMove = (event: ResizeBoundaryEvent): void => {
    if (!Option.contains(pointerId.current, event.pointerId)) return;
    if (event.buttons === 0) return resetPointer(event);
    previewResizeWeight(event, props);
  };
  const onPointerUp = (event: ResizeBoundaryEvent): void => {
    if (!Option.contains(pointerId.current, event.pointerId)) return;
    const nextWeight = previewResizeWeight(event, props);
    resetPointer(event);
    if (Option.isSome(nextWeight) && nextWeight.value.weight !== weight) {
      props.onResize(nextWeight.value.weight);
    }
  };
  const onKeyDown = (event: KeyboardEvent<HTMLHRElement>): void => {
    const decrementKey = props.axis === "row" ? "ArrowLeft" : "ArrowUp";
    const incrementKey = props.axis === "row" ? "ArrowRight" : "ArrowDown";
    if (event.key !== decrementKey && event.key !== incrementKey) return;
    event.preventDefault();
    const keyboardStep = pairWeight / keyboardResizeSteps;
    props.onResize(
      clampResizePairWeight(
        weight + (event.key === incrementKey ? keyboardStep : -keyboardStep),
        pairWeight
      )
    );
  };
  return {
    onKeyDown,
    onLostPointerCapture,
    onPointerCancel,
    onPointerDown,
    onPointerMove,
    onPointerUp,
    weight,
  } as const;
};

const DashboardResizeBoundary = (props: ResizeBoundaryProps): JSX.Element => {
  const { axis, disabled, label } = props;
  const handlers = useResizeBoundary(props);
  const interactionProps = disabled
    ? {}
    : {
        onKeyDown: handlers.onKeyDown,
        onLostPointerCapture: handlers.onLostPointerCapture,
        onPointerCancel: handlers.onPointerCancel,
        onPointerDown: handlers.onPointerDown,
        onPointerMove: handlers.onPointerMove,
        onPointerUp: handlers.onPointerUp,
      };
  return (
    <hr
      {...interactionProps}
      aria-disabled={disabled}
      aria-label={`Redimensionar límite después de ${label}`}
      aria-orientation={axis === "row" ? "vertical" : "horizontal"}
      aria-valuemax={maximumResizeWeight}
      aria-valuemin={minimumResizeWeight}
      aria-valuenow={handlers.weight}
      className={
        axis === "row"
          ? "pointer-events-none h-4 w-full flex-none touch-none border-0 bg-transparent outline-none focus-visible:ring-2 focus-visible:ring-ring md:pointer-events-auto md:h-auto md:w-4 md:cursor-col-resize"
          : "h-4 w-full flex-none cursor-row-resize touch-none border-0 bg-transparent outline-none focus-visible:ring-2 focus-visible:ring-ring"
      }
      tabIndex={disabled ? -1 : 0}
    />
  );
};

const ResponsiveLayout = ({
  context,
  depth,
  editor,
  layout,
}: Readonly<{
  context: DashboardView["context"];
  depth: number;
  editor: Option.Option<DashboardEditor>;
  layout: DashboardLayout;
}>): JSX.Element => {
  if (layout.kind === "leaf") {
    return Option.isNone(editor) ? (
      <RenderWidget
        editing={false}
        view={layout.widget}
        context={context}
        titleEditor={Option.none()}
      />
    ) : (
      <EditableLeaf context={context} depth={depth} editor={editor.value} layout={layout} />
    );
  }
  const gapClassName = Option.isNone(editor) ? "gap-4" : "gap-0";
  return (
    <div
      className={`flex min-h-0 min-w-0 flex-1 ${gapClassName} ${responsiveSplitClass(layout.axis)}`}
    >
      {layout.children.map(({ node, weight }, childIndex) => (
        <Fragment key={layoutKey(node)}>
          <div
            className="relative flex min-h-0 min-w-0 flex-none flex-col md:[flex:var(--dashboard-weight)_1_0%]"
            data-testid={`responsive-weight-${weight}`}
            style={weightedChildStyle(weight)}
          >
            <ResponsiveLayout context={context} depth={depth + 1} editor={editor} layout={node} />
          </div>
          {Option.isSome(editor) && childIndex < layout.children.length - 1 ? (
            <DashboardResizeBoundary
              axis={layout.axis}
              childIndex={childIndex}
              siblings={layout.children}
              disabled={editor.value.submitting}
              label={regionLabel(node)}
              onResize={(nextWeight) =>
                editor.value.onGesture({
                  kind: "resize-region",
                  widgetIds: regionWidgetIds(node),
                  weight: nextWeight,
                })
              }
            />
          ) : null}
        </Fragment>
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

const DashboardCatalogTray = ({ editor }: Readonly<{ editor: DashboardEditor }>): JSX.Element => (
  <section className="grid gap-3 rounded-xl border bg-background p-4">
    <h2 className="font-medium">Widgets disponibles</h2>
    <CatalogDragSources catalog={editor.catalog} disabled={editor.submitting} />
  </section>
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
    className="relative flex min-h-[calc(100svh-9rem)] flex-col"
  >
    {Option.isNone(editor) ? null : (
      <DashboardDropZone
        depth={0}
        disabled={editor.value.submitting}
        label="Colocar al inicio del tablero"
        target={{ kind: "dashboard-edge", edge: "top" }}
      />
    )}
    <ResponsiveLayout context={view.context} depth={0} editor={editor} layout={view.layout} />
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
  const [editing, setEditing] = useState(false);
  const activeEditor = Option.filter(editor, () => editing);
  const content = (
    <main className="flex w-full flex-col gap-5 p-4 sm:p-6">
      <header className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="font-heading text-3xl font-semibold tracking-tight">Tablero</h1>
          <p className="text-muted-foreground">Lectura actual de tus finanzas.</p>
        </div>
        {Option.isNone(editor) ? null : (
          <Button
            onClick={() => setEditing((current) => !current)}
            type="button"
            variant={editing ? "outline" : "default"}
          >
            {editing ? "Guardar" : "Personalizar"}
          </Button>
        )}
      </header>
      {Option.isNone(editor) || Option.isNone(editor.value.error) ? null : (
        <Alert variant="destructive" role="alert">
          <AlertTitle>{editor.value.error.value.title}</AlertTitle>
          <AlertDescription>{editor.value.error.value.message}</AlertDescription>
        </Alert>
      )}
      {Option.isNone(activeEditor) ? null : <DashboardCatalogTray editor={activeEditor.value} />}
      <DashboardCanvas editor={activeEditor} view={view} />
    </main>
  );
  return Option.isNone(activeEditor) ? (
    content
  ) : (
    <DashboardDragProvider onGesture={activeEditor.value.onGesture}>
      {content}
    </DashboardDragProvider>
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
