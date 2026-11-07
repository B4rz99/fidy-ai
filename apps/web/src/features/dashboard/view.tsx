import { DashboardSpendingPresentation } from "./chart-renderer";
import { dashboardResizePreview } from "./resize-presentation";
import { PendingRead } from "@/ui/components/pending-read";
import { Link, lazyRouteComponent } from "@tanstack/react-router";
import { ConfigureBudgetButton } from "./budget-configuration";
import type { BudgetWidget } from "./editor-model";
import { formatMoneyWithCode } from "@/transport/money";
import { RefreshButton } from "@/ui/components/refresh-button";
import type { DashboardEditorError } from "./editing";
import { PencilIcon, Settings01Icon, Tick02Icon, XIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { DateTime, Option } from "effect";
import type { AsyncResult } from "effect/reactivity";
import {
  type FormEvent,
  Fragment,
  type JSX,
  type PointerEvent,
  type RefCallback,
  Suspense,
  useContext,
  useMemo,
  useRef,
  useState,
} from "react";
import { Alert, AlertDescription, AlertTitle } from "@/ui/components/alert";
import { Button } from "@/ui/components/button";
import {
  DashboardBudget,
  DashboardCard,
  DashboardCustomizeAction,
  DashboardFigures,
  DashboardPeriod,
  type DashboardRecentGroup,
  DashboardRecentList,
} from "@/ui/components/dashboard";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@/ui/components/empty";
import { Input } from "@/ui/components/input";
import { presentCanonicalQuery } from "@/transport/canonical-query";
import { maximumSplitWeight, minimumSplitWeight } from "@/transport/dashboard-contract";
import { CanonicalQueryRetry } from "@/ui/canonical-query-feedback";
import { formatMoney, moneyProgressGeometry, moneyUtilizationLabel } from "./money-presentation";
import { type DashboardCatalogEntry, type DashboardGesture } from "./editor-model";
import {
  type DashboardLayout,
  type DashboardView,
  type DashboardWidget,
  type DashboardWidgetView,
  responsiveSplitClass,
  weightedChildStyle,
} from "./presentation";
import { type PlacementLayout } from "./placement-preview";

import { periodLabel } from "./period-presentation";

const SpendingChart = lazyRouteComponent(() => import("./spending-chart"), "SpendingChart");

const DashboardDragHandle = lazyRouteComponent(
  () => import("./drag-adapter"),
  "DashboardDragHandle"
);
const DashboardDragProvider = lazyRouteComponent(
  () => import("./drag-adapter"),
  "DashboardDragProvider"
);
const DashboardDropZone = lazyRouteComponent(() => import("./drag-adapter"), "DashboardDropZone");

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
  kind,
  title,
  titleEditor,
}: Readonly<{
  children: JSX.Element;
  editing: boolean;
  kind: DashboardWidget["type"];
  title: string;
  titleEditor: Option.Option<JSX.Element>;
}>): JSX.Element => (
  <DashboardCard
    editing={editing}
    kind={kind}
    title={Option.getOrElse(titleEditor, () => (
      <h2>{title}</h2>
    ))}
  >
    {children}
  </DashboardCard>
);

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
  widget,
}: Readonly<{
  data: BudgetResult;
  locale: DashboardLocale;
  widget: BudgetWidget;
}>): JSX.Element => {
  if (data.availability === "missing-budget") {
    return (
      <Empty>
        <EmptyHeader>
          <EmptyTitle>No hay presupuesto para este mes</EmptyTitle>
          <EmptyDescription>
            {data.category.label} · {data.currency}. Elige otro presupuesto o créalo en
            Presupuestos.
          </EmptyDescription>
        </EmptyHeader>
        <ConfigureBudgetButton widget={widget} compact={false} />
        <Link to="/app/budgets">Ir a Presupuestos</Link>
      </Empty>
    );
  }
  return (
    <>
      <DashboardBudget
        category={data.category.label}
        currency={data.currency}
        spent={formatMoney({ money: data.spent, locale })}
        cap={formatMoney({ money: data.cap, locale })}
        progress={moneyProgressGeometry({ spent: data.spent, cap: data.cap })}
        utilization={moneyUtilizationLabel({ spent: data.spent, cap: data.cap })}
        status={budgetStatusText(data, locale)}
        over={data.status.type === "over"}
      />
      <DashboardPeriod>{periodLabel({ period: data.appliedPeriod, locale })}</DashboardPeriod>
    </>
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
      new Intl.DateTimeFormat(locale, { day: "numeric", month: "long", year: "numeric", timeZone }),
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
  const formatRecentMoney =
    new Set(data.transactions.map((transaction) => transaction.money.currency)).size > 1
      ? formatMoneyWithCode
      : formatMoney;
  const groups: Array<{ date: string; rows: Array<DashboardRecentGroup["rows"][number]> }> = [];
  for (const transaction of data.transactions) {
    const date = dateFormatter.format(transaction.occurredAt.epochMilliseconds);
    const row = {
      id: transaction.id,
      date: DateTime.formatIsoDate(
        DateTime.setZone(transaction.occurredAt, DateTime.zoneMakeNamedUnsafe(timeZone))
      ),
      counterparty: Option.getOrElse(transaction.counterparty, () => "Sin contraparte"),
      category: transaction.category.label,
      inflow: transaction.direction === "inflow",
      money: formatRecentMoney({ money: transaction.money, locale }),
      currency: transaction.money.currency,
    };
    const previous = groups.at(-1);
    if (previous?.date === date) previous.rows.push(row);
    else groups.push({ date, rows: [row] });
  }
  return <DashboardRecentList groups={groups} />;
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
    <div className="flex flex-col gap-4">
      {data.moneyGroups.map((group) => (
        <DashboardFigures
          key={group.currency}
          currency={group.currency}
          inflow={formatMoney({ money: group.inflow, locale })}
          outflow={formatMoney({ money: group.outflow, locale })}
        />
      ))}
      <DashboardPeriod>{periodLabel({ period: data.appliedPeriod, locale })}</DashboardPeriod>
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
  const ChartPresentation = useContext(DashboardSpendingPresentation);
  let content: JSX.Element;
  if ("buckets" in result) {
    content = Option.match(ChartPresentation, {
      onSome: (render) => render({ data: result, locale: context.locale }),
      onNone: () => (
        <Suspense fallback={<PendingRead label="Cargando gráfico" />}>
          <SpendingChart data={result} locale={context.locale} />
        </Suspense>
      ),
    });
  } else if ("availability" in result) {
    content =
      widget.type === "budget-bar" ? (
        <BudgetBar data={result} locale={context.locale} widget={widget} />
      ) : (
        <></>
      );
  } else if ("transactions" in result) {
    content = <TransactionList data={result} locale={context.locale} timeZone={context.timeZone} />;
  } else {
    content = <CustomMetric data={result} locale={context.locale} />;
  }
  return (
    <WidgetFrame
      editing={editing}
      kind={widget.type}
      title={titleFor(widget)}
      titleEditor={titleEditor}
    >
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
  widget,
}: Readonly<{
  editor: DashboardEditor;
  label: string;
  onRename: () => void;
  widget: DashboardWidget;
}>): JSX.Element => (
  <div className="absolute top-3 right-3 z-40 flex">
    {widget.type === "budget-bar" ? <ConfigureBudgetButton widget={widget} compact /> : null}
    <Button
      aria-label={`Renombrar ${label}`}
      data-dashboard-rename={widget.id}
      disabled={editor.disabled}
      onClick={onRename}
      size="icon"
      type="button"
      variant="ghost"
    >
      <HugeiconsIcon icon={PencilIcon} strokeWidth={2} />
    </Button>
    <Button
      aria-label={`Eliminar ${label}`}
      data-dashboard-remove={widget.id}
      disabled={editor.disabled}
      onClick={() => editor.onGesture({ kind: "remove-widget", widgetId: widget.id })}
      size="icon"
      type="button"
      variant="destructive"
    >
      <HugeiconsIcon icon={XIcon} strokeWidth={2} />
    </Button>
  </div>
);

const maximumTitleLength = 80;

type TitleEditorProps = Readonly<{
  disabled: boolean;
  initialTitle: string;
  target: "tablero" | "Widget";
  onCancel: () => void;
  onSave: (title: string) => void;
}>;

const focusTitleInput: RefCallback<HTMLInputElement> = (input) => {
  input?.focus();
  input?.select();
};

export const TitleEditor = ({
  disabled,
  initialTitle,
  target,
  onCancel,
  onSave,
}: TitleEditorProps): JSX.Element => {
  const [title, setTitle] = useState(initialTitle);
  const submit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    const trimmedTitle = title.trim();
    if (!disabled && trimmedTitle.length > 0) onSave(trimmedTitle);
  };
  return (
    <form className="flex min-w-0 items-center gap-1" onSubmit={submit}>
      <Input
        aria-label={`Nuevo nombre del ${target}`}
        disabled={disabled}
        maxLength={maximumTitleLength}
        ref={focusTitleInput}
        onChange={(event) => setTitle(event.currentTarget.value)}
        onKeyDown={(event) => {
          if (event.key === "Escape") onCancel();
        }}
        value={title}
      />
      <Button
        aria-label={`Guardar nombre del ${target}`}
        disabled={disabled || title.trim().length === 0}
        size="icon-sm"
        type="submit"
        variant="ghost"
      >
        <HugeiconsIcon icon={Tick02Icon} strokeWidth={2} />
      </Button>
      <Button
        aria-label={`Cancelar cambio de nombre del ${target}`}
        onClick={onCancel}
        size="icon-sm"
        type="button"
        variant="ghost"
      >
        <HugeiconsIcon icon={XIcon} strokeWidth={2} />
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
    <div
      className="relative flex min-h-0 min-w-0 flex-1 flex-col"
      data-dashboard-widget-id={widget.id}
    >
      <div className="absolute top-3 left-3 z-30">
        <DashboardDragHandle
          disabled={editor.disabled}
          label={`Arrastrar ${label}`}
          source={{ kind: "widget", widgetId: widget.id, label }}
        />
      </div>
      <WidgetActions
        editor={editor}
        label={label}
        onRename={() => setRenaming(true)}
        widget={widget}
      />
      <div className="relative flex min-h-72 flex-1 flex-col">
        <WidgetDropTargets
          depth={depth + 1}
          disabled={editor.disabled}
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
                  <TitleEditor
                    disabled={editor.disabled}
                    initialTitle={label}
                    target="Widget"
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
  const preview = dashboardResizePreview({
    coordinate: axis === "row" ? event.clientX : event.clientY,
    start,
    end,
    weight: current.value.weight,
    adjacentWeight: following.value.weight,
    minimumWeight: minimumSplitWeight,
    maximumWeight: maximumSplitWeight,
  });
  if (preview._tag === "Unavailable") return Option.none();
  const { weight: nextWeight, adjacentWeight } = preview;
  elements.value.child.style.setProperty("--dashboard-weight", String(nextWeight));
  elements.value.adjacent.style.setProperty("--dashboard-weight", String(adjacentWeight));
  return Option.some({ adjacentWeight, weight: nextWeight });
};

type ResizeBoundaryHandlers = Readonly<{
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

const noPointer = Option.none<number>();

const useResizeBoundary = (props: ResizeBoundaryProps): ResizeBoundaryHandlers => {
  const pointerId = useRef(noPointer);
  const weight = resizeWeightAt(props, props.childIndex);
  const adjacentWeight = resizeWeightAt(props, props.childIndex + 1);
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
  return {
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
        onLostPointerCapture: handlers.onLostPointerCapture,
        onPointerCancel: handlers.onPointerCancel,
        onPointerDown: handlers.onPointerDown,
        onPointerMove: handlers.onPointerMove,
        onPointerUp: handlers.onPointerUp,
      };
  return (
    <hr
      {...interactionProps}
      data-dashboard-resize={JSON.stringify({
        axis,
        weight: handlers.weight,
        adjacentWeight: resizeWeightAt(props, props.childIndex + 1),
        widgetIds: regionWidgetIds(
          Option.getOrThrow(Option.fromUndefinedOr(props.siblings[props.childIndex])).node
        ),
        minimumWeight: minimumSplitWeight,
        maximumWeight: maximumSplitWeight,
      })}
      aria-disabled={disabled}
      aria-label={`Redimensionar límite después de ${label}`}
      aria-orientation={axis === "row" ? "vertical" : "horizontal"}
      aria-valuemax={maximumSplitWeight}
      aria-valuemin={minimumSplitWeight}
      aria-valuenow={handlers.weight}
      className={
        axis === "row"
          ? "pointer-events-none h-4 w-full flex-none touch-none border-0 bg-transparent outline-none focus-visible:ring-2 focus-visible:ring-ring md:pointer-events-auto md:h-auto md:w-4 md:cursor-col-resize"
          : "h-4 w-full flex-none cursor-row-resize touch-none border-0 bg-transparent outline-none focus-visible:ring-2 focus-visible:ring-ring"
      }
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
  const gapClassName = Option.isNone(editor) ? "gap-5.5" : "gap-0";
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
              disabled={editor.value.disabled}
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

export type DashboardEditor = Readonly<{
  catalog: ReadonlyArray<DashboardCatalogEntry>;
  error: Option.Option<DashboardEditorError>;
  onGesture: (gesture: DashboardGesture) => void;
  submitting: boolean;
  disabled: boolean;
  pendingPlacement: Option.Option<PlacementLayout>;
}>;

const CatalogDragSources = ({
  catalog,
  disabled,
}: Readonly<{ catalog: ReadonlyArray<DashboardCatalogEntry>; disabled: boolean }>): JSX.Element => (
  <ul
    aria-label="Widgets disponibles para arrastrar"
    className="grid min-w-0 grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-4"
  >
    {catalog.map((entry) => (
      <li
        className="flex min-w-0 items-center justify-between gap-3 rounded-lg border bg-card p-3"
        key={entry.id}
      >
        <span className="min-w-0 wrap-anywhere">
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
  <section className="grid min-w-0 grid-cols-1 gap-3 rounded-xl border bg-background p-4">
    <h2 className="font-medium">Widgets disponibles</h2>
    <CatalogDragSources catalog={editor.catalog} disabled={editor.disabled} />
  </section>
);

const PlacementPreview = ({
  layout,
  context,
}: Readonly<{ layout: PlacementLayout; context: DashboardView["context"] }>): JSX.Element => {
  if (layout.kind === "leaf") {
    return "kind" in layout.widget ? (
      <WidgetFrame
        editing
        kind={layout.widget.widget.type}
        title={titleFor(layout.widget.widget)}
        titleEditor={Option.none()}
      >
        <p className="text-muted-foreground">Los datos se calculan al guardar.</p>
      </WidgetFrame>
    ) : (
      <RenderWidget editing view={layout.widget} context={context} titleEditor={Option.none()} />
    );
  }
  return (
    <div className={`flex min-h-0 min-w-0 flex-1 gap-4 ${responsiveSplitClass(layout.axis)}`}>
      {layout.children.map(({ node, weight }) => (
        <div
          key={placementKey(node)}
          className="relative flex min-h-0 min-w-0 flex-none flex-col md:[flex:var(--dashboard-weight)_1_0%]"
          style={weightedChildStyle(weight)}
        >
          <PlacementPreview layout={node} context={context} />
        </div>
      ))}
    </div>
  );
};
const placementKey = (layout: PlacementLayout): string =>
  layout.kind === "leaf"
    ? layout.widget.widget.id
    : layout.children.map(({ node }) => placementKey(node)).join(":");

const DashboardCanvas = ({
  editor,
  preview,
  view,
}: Readonly<{
  editor: Option.Option<DashboardEditor>;
  preview: Option.Option<PlacementLayout>;
  view: DashboardView;
}>): JSX.Element => (
  <section
    aria-label="Diseño responsivo del tablero"
    className="relative flex min-h-[calc(100svh-11.25rem)] flex-col"
  >
    {Option.isNone(editor) ? null : (
      <DashboardDropZone
        depth={0}
        disabled={editor.value.disabled}
        label="Colocar al inicio del tablero"
        target={{ kind: "dashboard-edge", edge: "top" }}
      />
    )}
    <div className={`flex min-h-0 flex-1 flex-col ${Option.isSome(preview) ? "opacity-20" : ""}`}>
      <ResponsiveLayout context={view.context} depth={0} editor={editor} layout={view.layout} />
    </div>
    {Option.isSome(preview) ? (
      <div
        aria-hidden="true"
        inert
        aria-label="Vista previa de la distribución"
        className="pointer-events-none absolute inset-x-0 top-0 flex min-h-full flex-col"
      >
        <PlacementPreview context={view.context} layout={preview.value} />
      </div>
    ) : null}
    {Option.isNone(editor) ? null : (
      <DashboardDropZone
        depth={0}
        disabled={editor.value.disabled}
        label="Colocar al final del tablero"
        target={{ kind: "dashboard-edge", edge: "bottom" }}
      />
    )}
  </section>
);

const DashboardEditorNotice = ({
  error,
}: Readonly<{ error: DashboardEditorError }>): JSX.Element => (
  <Alert variant="destructive" role="alert">
    <AlertTitle>{error.title}</AlertTitle>
    <AlertDescription>
      {error.message}
      {Option.match(error.onRefresh, {
        onNone: () => null,
        onSome: (refresh) => (
          <RefreshButton
            onClick={refresh}
            type="button"
            variant="outline"
            label="Actualizar tablero"
          />
        ),
      })}
    </AlertDescription>
  </Alert>
);

const EditableDashboardTitle = ({
  editor,
  title,
}: Readonly<{ editor: DashboardEditor; title: string }>): JSX.Element => {
  const [renaming, setRenaming] = useState(false);
  const renameButton = useRef<HTMLButtonElement>(null);
  const cancel = (): void => {
    setRenaming(false);
    requestAnimationFrame(() => renameButton.current?.focus());
  };
  return (
    <div className="flex min-w-0 items-center gap-2">
      {renaming ? (
        <TitleEditor
          disabled={editor.disabled}
          initialTitle={title}
          target="tablero"
          onCancel={cancel}
          onSave={(nextTitle) => {
            if (nextTitle !== title) {
              editor.onGesture({ kind: "retitle-dashboard", title: nextTitle });
            }
            setRenaming(false);
          }}
        />
      ) : (
        <h1 className="font-heading text-3xl font-semibold tracking-tight break-words">{title}</h1>
      )}
      <Button
        aria-label="Renombrar tablero"
        className={renaming ? "hidden" : undefined}
        disabled={editor.disabled}
        onClick={() => setRenaming(true)}
        ref={renameButton}
        size="icon-sm"
        type="button"
        variant="ghost"
      >
        <HugeiconsIcon icon={PencilIcon} strokeWidth={2} />
      </Button>
    </div>
  );
};

export const DashboardViewComponent = ({
  editor,
  view,
  initialEditing,
}: Readonly<{
  editor: Option.Option<DashboardEditor>;
  view: DashboardView;
  initialEditing: boolean;
}>): JSX.Element => {
  const [editing, setEditing] = useState(initialEditing);
  const activeEditor = Option.filter(editor, () => editing);
  const pending = Option.flatMap(activeEditor, (current) => current.pendingPlacement);
  const editorError = Option.flatMap(editor, (current) => current.error);
  const content = (
    <main className="dashboard-surface">
      <header className="dashboard-header">
        <div className="min-w-0 max-w-full">
          {Option.match(activeEditor, {
            onSome: (current) => <EditableDashboardTitle editor={current} title={view.title} />,
            onNone: () => (
              <h1 className="font-heading text-3xl font-semibold tracking-tight break-words">
                {view.title}
              </h1>
            ),
          })}
        </div>
        {Option.isNone(editor) ? null : (
          <DashboardCustomizeAction
            disabled={editor.value.disabled}
            onClick={() => setEditing((current) => !current)}
            type="button"
          >
            <HugeiconsIcon icon={Settings01Icon} size={20} strokeWidth={1.5} aria-hidden="true" />
            {editing ? "Guardar" : "Personalizar"}
          </DashboardCustomizeAction>
        )}
      </header>
      {Option.isNone(editorError) ? null : <DashboardEditorNotice error={editorError.value} />}
      {Option.isNone(activeEditor) ? null : <DashboardCatalogTray editor={activeEditor.value} />}
      {Option.exists(editor, (current) => current.submitting) ? (
        <output>Guardando cambio…</output>
      ) : null}
      <DashboardCanvas editor={activeEditor} preview={pending} view={view} />
    </main>
  );
  return Option.isNone(activeEditor) ? (
    content
  ) : (
    <Suspense fallback={<PendingRead label="Cargando personalización" />}>
      <DashboardDragProvider onGesture={activeEditor.value.onGesture}>
        {content}
      </DashboardDragProvider>
    </Suspense>
  );
};

const DashboardError = ({
  boundaryFailure,
  onRefresh,
  waiting,
}: Readonly<{
  boundaryFailure: boolean;
  onRefresh: () => void;
  waiting: boolean;
}>): JSX.Element => (
  <main className="mx-auto w-full max-w-7xl px-4 py-8 sm:px-6 lg:px-8">
    <CanonicalQueryRetry
      description="Intenta de nuevo en unos momentos."
      onRetry={onRefresh}
      retryLabel="Reintentar carga del tablero"
      retryingLabel="Reintentando…"
      title={boundaryFailure ? "No pudimos comunicarnos con Fidy" : "No pudimos cargar tu tablero"}
      waiting={waiting}
    />
  </main>
);

export const DashboardRouteContent = ({
  onRefresh,
  result,
}: Readonly<{
  onRefresh: () => void;
  result: AsyncResult.AsyncResult<Readonly<{ data: DashboardView }>, unknown>;
}>): JSX.Element => {
  const state = presentCanonicalQuery(result);
  switch (state._tag) {
    case "Initial":
      return <PendingRead label="Cargando tablero" />;
    case "Failure":
      return (
        <DashboardError
          boundaryFailure={state.failure._tag !== "DeclaredFailure"}
          onRefresh={onRefresh}
          waiting={state.waiting}
        />
      );
    case "Ready":
      return (
        <DashboardViewComponent
          initialEditing={false}
          editor={Option.none()}
          view={state.value.data}
        />
      );
  }
};

DashboardViewComponent.preloadInteractions = (): Promise<void> =>
  Promise.all([
    DashboardDragHandle.preload?.(),
    DashboardDragProvider.preload?.(),
    DashboardDropZone.preload?.(),
  ]).then(() => undefined);

DashboardViewComponent.preloadPresentation = (): Promise<void> =>
  Promise.resolve(SpendingChart.preload?.()).then(() => undefined);
