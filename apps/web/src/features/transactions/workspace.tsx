import { Toaster, toast } from "sonner";
import { useState } from "react";
import type { JSX, ReactNode } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import { Calendar03Icon, FilterHorizontalIcon, Search01Icon } from "@hugeicons/core-free-icons";
import { DateTime, Option } from "effect";
import { Button } from "@/ui/components/button";
import { Input } from "@/ui/components/input";
import { NativeSelect, NativeSelectOption } from "@/ui/components/native-select";
import type { FidyClient } from "@/transport/client";
import { TransactionDetail } from "./detail";
import { TransactionSummary } from "./summary";
import { TransactionLedger } from "./ledger";
import { ManualTransactionCapture } from "./manual-capture";
import { ResponsiveTransactionPanel } from "./responsive-panel";
import type { TransactionPanel } from "./panel-state";
import {
  type Category,
  type CurrentUser,
  type Transaction,
  presentTransactionRows,
} from "./presentation";

type WorkspaceProps = Readonly<{
  apiClient: FidyClient;
  categories: ReadonlyArray<Category>;
  currentUser: CurrentUser;
  transactions: ReadonlyArray<Transaction>;
  period: Readonly<{ monthLabel: string; timeZone: string }>;
  queryNotice: ReactNode;
  onRefresh: () => void;
  editable: boolean;
}>;
type WorkspaceFilters = Readonly<{
  search: string;
  direction: string;
  categoryId: string;
  date: string;
}>;
type FilterTool = "search" | "date" | "category";
const matchesFilters = (
  transaction: Transaction,
  filters: WorkspaceFilters,
  timeZone: string
): boolean => {
  const text =
    `${Option.getOrElse(transaction.counterparty, () => "")} ${Option.getOrElse(transaction.notes, () => "")}`.toLocaleLowerCase(
      "es-CO"
    );
  return (
    text.includes(filters.search.trim().toLocaleLowerCase("es-CO")) &&
    (filters.direction === "all" || transaction.direction === filters.direction) &&
    (filters.categoryId === "all" || transaction.categoryId === filters.categoryId) &&
    (filters.date === "" ||
      DateTime.formatIsoDate(
        DateTime.setZone(transaction.occurredAt, DateTime.zoneMakeNamedUnsafe(timeZone))
      ) === filters.date)
  );
};
const CategoryFilter = ({
  categories,
  value,
  disabled,
  onChange,
}: Readonly<{
  categories: ReadonlyArray<Category>;
  value: string;
  disabled: boolean;
  onChange: (value: string) => void;
}>): JSX.Element => (
  <NativeSelect
    aria-label="Filtrar por categoría"
    size="default"
    value={value}
    disabled={disabled}
    onChange={(event) => onChange(event.target.value)}
  >
    <NativeSelectOption value="all">Todas las categorías</NativeSelectOption>
    {categories.map((category) => (
      <NativeSelectOption key={category.id} value={category.id}>
        {category.label}
      </NativeSelectOption>
    ))}
  </NativeSelect>
);
const WorkspaceToolbar = ({
  filters,
  onFilters,
  categories,
  disabled,
  tool,
}: Readonly<{
  tool: FilterTool | "closed";
  filters: WorkspaceFilters;
  onFilters: (filters: WorkspaceFilters) => void;
  categories: ReadonlyArray<Category>;
  disabled: boolean;
}>): JSX.Element => (
  <div className="flex flex-wrap items-center gap-3">
    {tool === "search" ? (
      <Input
        aria-label="Buscar transacciones"
        placeholder="Buscar"
        className="min-w-40 flex-1"
        value={filters.search}
        disabled={disabled}
        onChange={(event) => onFilters({ ...filters, search: event.target.value })}
      />
    ) : null}
    <NativeSelect
      aria-label="Filtrar por tipo"
      size="default"
      value={filters.direction}
      disabled={disabled}
      onChange={(event) => onFilters({ ...filters, direction: event.target.value })}
    >
      <NativeSelectOption value="all">Todas las transacciones</NativeSelectOption>
      <NativeSelectOption value="outflow">Gastos</NativeSelectOption>
      <NativeSelectOption value="inflow">Ingresos</NativeSelectOption>
    </NativeSelect>
    {tool === "category" ? (
      <CategoryFilter
        categories={categories}
        value={filters.categoryId}
        disabled={disabled}
        onChange={(categoryId) => onFilters({ ...filters, categoryId })}
      />
    ) : null}
    {tool === "date" ? (
      <Input
        aria-label="Filtrar por fecha"
        type="date"
        value={filters.date}
        disabled={disabled}
        onChange={(event) => onFilters({ ...filters, date: event.target.value })}
      />
    ) : null}
  </div>
);
const panelLocked = (panel: TransactionPanel): boolean =>
  (panel._tag === "Capture" && panel.status === "saving") ||
  (panel._tag === "Detail" && panel.mode._tag === "Editing" && panel.mode.status === "saving");
type PanelProps = WorkspaceProps &
  Readonly<{
    panel: TransactionPanel;
    onPanel: (panel: TransactionPanel) => void;
    renderPanel: (content: JSX.Element) => JSX.Element;
  }>;
const CapturePanel = ({
  panel,
  onPanel,
  renderPanel,
  ...props
}: PanelProps &
  Readonly<{
    panel: Extract<TransactionPanel, { _tag: "Capture" }>;
  }>): JSX.Element => (
  <ManualTransactionCapture
    renderForm={(form) =>
      renderPanel(
        <section className="flex flex-col gap-6">
          <header className="flex items-center justify-between gap-3">
            <h2 className="text-lg font-semibold">Registrar transacción</h2>
            <Button
              size="sm"
              variant="ghost"
              disabled={panel.status === "saving"}
              onClick={() => onPanel({ _tag: "Summary" })}
            >
              Cancelar
            </Button>
          </header>
          {form}
        </section>
      )
    }
    apiClient={props.apiClient}
    timeZone={props.currentUser.timeZone}
    status={panel.status}
    onStatus={(status) => onPanel({ _tag: "Capture", status })}
    onCheckHistory={props.onRefresh}
    onCreated={() => {
      toast.success("Transacción registrada");
      onPanel({ _tag: "Summary" });
      props.onRefresh();
    }}
  />
);
const DetailPanel = ({
  panel,
  onPanel,
  renderPanel,
  ...props
}: PanelProps &
  Readonly<{
    panel: Extract<TransactionPanel, { _tag: "Detail" }>;
  }>): JSX.Element => {
  const transaction = Option.fromNullishOr(
    props.transactions.find((record) => record.id === panel.id)
  );
  const close = (): void => onPanel({ _tag: "Summary" });
  if (Option.isNone(transaction)) {
    return renderPanel(
      <div className="flex flex-col gap-3">
        <p>Esta transacción ya no aparece en el periodo seleccionado.</p>
        <Button variant="outline" onClick={close}>
          Volver al resumen
        </Button>
      </div>
    );
  }
  return (
    <TransactionDetail
      renderPanel={renderPanel}
      key={panel.id}
      transaction={transaction.value}
      apiClient={props.apiClient}
      categories={props.categories}
      locale={props.currentUser.locale}
      timeZone={props.currentUser.timeZone}
      editable={props.editable}
      mode={panel.mode}
      onMode={(mode) => onPanel({ ...panel, mode })}
      onClose={close}
      onRefresh={props.onRefresh}
      onSaved={() => {
        toast.success("Cambios guardados");
        props.onRefresh();
      }}
    />
  );
};
const WorkspacePanel = (props: PanelProps): JSX.Element => {
  if (props.panel._tag === "Capture") return <CapturePanel {...props} panel={props.panel} />;
  if (props.panel._tag === "Detail") return <DetailPanel {...props} panel={props.panel} />;
  return props.renderPanel(
    <TransactionSummary
      transactions={props.transactions}
      locale={props.currentUser.locale}
      timeZone={props.currentUser.timeZone}
    />
  );
};
const WorkspaceHeader = ({
  period,
  disabled,
  onCapture,
  onTool,
}: Readonly<{
  onTool: (tool: FilterTool) => void;
  period: WorkspaceProps["period"];
  disabled: boolean;
  onCapture: () => void;
}>): JSX.Element => (
  <header className="flex min-h-18 flex-wrap items-center justify-between gap-4 border-b px-5 py-3">
    <div>
      <h1 className="text-3xl font-semibold tracking-tight">Transacciones</h1>
      <p className="sr-only">
        <span className="capitalize">{period.monthLabel}</span>
        {" · "}
        {period.timeZone}
      </p>
    </div>
    <div className="flex flex-wrap items-center gap-2">
      <Button variant="outline" disabled={disabled} onClick={() => onTool("search")}>
        <HugeiconsIcon
          icon={Search01Icon}
          strokeWidth={1.5}
          data-icon="inline-start"
          aria-hidden="true"
        />
        Buscar
      </Button>
      <Button variant="outline" disabled={disabled} onClick={() => onTool("date")}>
        <HugeiconsIcon
          icon={Calendar03Icon}
          strokeWidth={1.5}
          data-icon="inline-start"
          aria-hidden="true"
        />
        Fecha
      </Button>
      <Button variant="outline" disabled={disabled} onClick={() => onTool("category")}>
        <HugeiconsIcon
          icon={FilterHorizontalIcon}
          strokeWidth={1.5}
          data-icon="inline-start"
          aria-hidden="true"
        />
        Filtros
      </Button>
      <Button disabled={disabled} onClick={onCapture}>
        + Registrar
      </Button>
    </div>
  </header>
);
const editSelected = (
  panel: TransactionPanel,
  rows: ReturnType<typeof presentTransactionRows>,
  onPanel: (panel: TransactionPanel) => void
): void => {
  const selected =
    panel._tag === "Detail"
      ? Option.some(panel.id)
      : Option.fromNullishOr(rows[0]).pipe(Option.map((row) => row.id));
  Option.map(selected, (id) =>
    onPanel({ _tag: "Detail", id, mode: { _tag: "Editing", status: "idle" } })
  );
};
const renderResponsivePanel = (
  content: JSX.Element,
  panel: TransactionPanel,
  controls: Readonly<{ locked: boolean; onPanel: (panel: TransactionPanel) => void }>
): JSX.Element => (
  <ResponsiveTransactionPanel
    open={panel._tag !== "Summary"}
    locked={controls.locked}
    title={panel._tag === "Capture" ? "Registrar transacción" : "Detalle de transacción"}
    onClose={() => controls.onPanel({ _tag: "Summary" })}
  >
    {content}
  </ResponsiveTransactionPanel>
);
const WorkspaceContent = ({
  props,
  panel,
  onPanel,
  filters,
  onFilters,
  visible,
  rows,
  tool,
}: Readonly<{
  tool: FilterTool | "closed";
  props: WorkspaceProps;
  panel: TransactionPanel;
  onPanel: (panel: TransactionPanel) => void;
  filters: WorkspaceFilters;
  onFilters: (filters: WorkspaceFilters) => void;
  visible: ReadonlyArray<Transaction>;
  rows: ReturnType<typeof presentTransactionRows>;
}>): JSX.Element => {
  const locked = panelLocked(panel);
  const editing =
    panel._tag === "Capture" || (panel._tag === "Detail" && panel.mode._tag === "Editing");
  return (
    <div className="grid items-stretch xl:grid-cols-[minmax(0,1fr)_24rem]">
      <div className="min-w-0 p-5">
        <TransactionLedger
          toolbar={
            <WorkspaceToolbar
              tool={tool}
              filters={filters}
              onFilters={onFilters}
              categories={props.categories}
              disabled={locked}
            />
          }
          canEdit={props.editable}
          onEdit={() => editSelected(panel, rows, onPanel)}
          rows={rows}
          locale={props.currentUser.locale}
          selected={panel._tag === "Detail" ? Option.some(panel.id) : Option.none()}
          disabled={locked || editing}
          onSelect={(id) => onPanel({ _tag: "Detail", id, mode: { _tag: "Viewing" } })}
        />
        <p aria-live="polite" className="mt-3 text-xs text-muted-foreground">
          {visible.length} de {props.transactions.length} transacciones del mes
        </p>
      </div>
      <WorkspacePanel
        {...props}
        panel={panel}
        onPanel={onPanel}
        transactions={panel._tag === "Summary" ? visible : props.transactions}
        renderPanel={(content) => renderResponsivePanel(content, panel, { locked, onPanel })}
      />
    </div>
  );
};
/** Owns filters and panel interaction; canonical records remain in the authentication-lifetime registry. */
export const TransactionWorkspace = (props: WorkspaceProps): JSX.Element => {
  const [tool, setTool] = useState<FilterTool | "closed">("closed");
  const [panel, onPanel] = useState<TransactionPanel>({ _tag: "Summary" });
  const [filters, onFilters] = useState<WorkspaceFilters>({
    search: "",
    direction: "all",
    categoryId: "all",
    date: "",
  });
  const visible = props.transactions.filter((transaction) =>
    matchesFilters(transaction, filters, props.currentUser.timeZone)
  );
  const rows = presentTransactionRows({
    transactions: visible,
    categories: props.categories,
    locale: props.currentUser.locale,
    timeZone: props.currentUser.timeZone,
    counterpartyFallback: "Contraparte no identificada",
  });
  const editing =
    panel._tag === "Capture" || (panel._tag === "Detail" && panel.mode._tag === "Editing");
  return (
    <>
      <Toaster position="bottom-right" richColors />
      <main className="flex w-full flex-col">
        <WorkspaceHeader
          onTool={(next) => setTool(tool === next ? "closed" : next)}
          period={props.period}
          disabled={editing || !props.editable}
          onCapture={() => onPanel({ _tag: "Capture", status: "idle" })}
        />
        {props.queryNotice}
        <WorkspaceContent
          tool={tool}
          props={props}
          panel={panel}
          onPanel={onPanel}
          filters={filters}
          onFilters={onFilters}
          visible={visible}
          rows={rows}
        />
      </main>
    </>
  );
};
