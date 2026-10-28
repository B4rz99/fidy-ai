import { RefreshButton } from "@/ui/components/refresh-button";
import { Toaster, toast } from "sonner";
import { use, useState } from "react";
import type { TransactionCorrections } from "./corrections";
import { TransactionCorrectionContext } from "./correction-context";
import type { JSX, ReactNode, RefCallback } from "react";
import { observeContinuation } from "./scroll-continuation";
import { HugeiconsIcon } from "@hugeicons/react";
import { FilterHorizontalIcon } from "@hugeicons/core-free-icons";
import { Array, DateTime, Option } from "effect";
import { Button } from "@/ui/components/button";
import { Input } from "@/ui/components/input";
import { CalendarField } from "@/ui/components/calendar-field";
import { Label } from "@/ui/components/label";
import { CategoryVisual } from "@/ui/components/category-visual";
import { TransactionContextPanel, TransactionSurface } from "@/ui/components/transactions";
import { ChoiceDropdown } from "@/ui/components/choice-dropdown";
import { TransactionDateFilter } from "./date-filter";
import { type FidyClient, maximumAtomicBatchCalls } from "@/transport/client";
import { BulkTransactionCorrection } from "./bulk-correction";
import { TransactionDetail } from "./detail";
import { TransactionSummary } from "./summary";
import { InlineTransactionCategory } from "./inline-category";
import { TransactionLedger } from "./ledger";
import { ManualTransactionCapture } from "./manual-capture";
import type { TransactionPanel } from "./panel-state";
import type { HistoryState } from "./history";
import {
  type Category,
  type CurrentUser,
  type Transaction,
  formatOccurrence,
  presentTransactionRows,
} from "./presentation";

type WorkspaceProps = Readonly<{
  apiClient: FidyClient;
  categories: ReadonlyArray<Category>;
  currentUser: Pick<CurrentUser, "locale" | "timeZone">;
  transactions: ReadonlyArray<Transaction>;
  period: Readonly<{ monthLabel: string; timeZone: string }>;
  queryNotice: ReactNode;
  dateFilter: Readonly<{ value: string; onChange: (date: string) => void }>;
  onRefresh: () => void;
  continuation: HistoryState["continuation"];
  onMore: () => void;
  onRetryMore: () => void;
}> &
  (
    | Readonly<{ readOnly: true; editable: false }>
    | Readonly<{
        readOnly: false;
        editable: boolean;
      }>
  );
type WorkspaceFilters = Readonly<{
  search: string;
  direction: string;
  categoryId: string;
  date: string;
}>;
const emptyLocalFilters = { search: "", direction: "all", categoryId: "all" };
const emptyFilters: WorkspaceFilters = { ...emptyLocalFilters, date: "" };
const hasFilters = (filters: WorkspaceFilters): boolean =>
  filters.search.trim() !== "" ||
  filters.direction !== "all" ||
  filters.categoryId !== "all" ||
  filters.date !== "";
type FilterTool = "category";
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
  <ChoiceDropdown
    triggerLabel={value === "all" ? Option.some("Categorías") : Option.none()}
    width="auto"
    leading={null}
    id="transaction-category-filter"
    label="Filtrar por categoría"
    value={value}
    disabled={disabled}
    onChange={onChange}
    options={[
      { value: "all", label: "Todas las categorías" },
      ...categories.map((category) => ({ value: category.id, label: category.label })),
    ]}
  />
);
const WorkspaceToolbar = ({
  filters,
  onFilters,
  disabled,
}: Readonly<{
  filters: WorkspaceFilters;
  onFilters: (filters: WorkspaceFilters) => void;
  disabled: boolean;
}>): JSX.Element => (
  <div className="contents">
    <ChoiceDropdown
      triggerLabel={Option.none()}
      width="auto"
      leading={null}
      id="transaction-type-filter"
      label="Filtrar por tipo"
      value={filters.direction}
      disabled={disabled}
      onChange={(direction) => onFilters({ ...filters, direction })}
      options={[
        { value: "all", label: "Todas las transacciones" },
        { value: "outflow", label: "Gastos" },
        { value: "inflow", label: "Ingresos" },
      ]}
    />
    {hasFilters(filters) ? (
      <Button variant="ghost" disabled={disabled} onClick={() => onFilters(emptyFilters)}>
        Limpiar filtros
      </Button>
    ) : null}
  </div>
);
const panelLocked = (panel: TransactionPanel): boolean => {
  switch (panel._tag) {
    case "Bulk":
      return false;
    case "Capture":
      return panel.status === "saving";
    case "Detail":
      if (panel.mode._tag === "Deleting") return panel.mode.status !== "idle";
      return false;
    case "Summary":
      return false;
  }
};
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
    categories={props.categories}
    onCancel={() => onPanel({ _tag: "Summary" })}
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
              aria-label="Cerrar registro"
            >
              ×
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
    onCreated={(transaction) => {
      toast.success("Transacción registrada", {
        description: `${Option.getOrElse(transaction.counterparty, () => "Contraparte no identificada")} · ${formatOccurrence({ locale: props.currentUser.locale, timeZone: props.currentUser.timeZone, occurredAt: transaction.occurredAt })}`,
      });
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
      onDeleted={() => {
        toast.success("Transacción eliminada");
        close();
        props.onRefresh();
      }}
    />
  );
};
const beginBulkEditing = (
  selected: ReadonlyArray<Transaction>,
  onPanel: (panel: TransactionPanel) => void
): void => {
  if (Array.isReadonlyArrayNonEmpty(selected)) {
    onPanel({ _tag: "Bulk", stage: "editing", transactions: selected });
  }
};
const SelectedTransactions = ({
  selected,
  categories,
}: Readonly<{
  selected: ReadonlyArray<Transaction>;
  categories: ReadonlyArray<Category>;
}>): JSX.Element => (
  <ul className="flex flex-col gap-2">
    {selected.map((record) => (
      <li key={record.id} data-transaction-slot="transaction-selected-item">
        <CategoryVisual
          label={categories.find((category) => category.id === record.categoryId)?.label ?? ""}
          bubble
          large={false}
        />
        {Option.getOrElse(record.counterparty, () => "Contraparte no identificada")}
      </li>
    ))}
  </ul>
);
const BulkPanel = (
  props: PanelProps & Readonly<{ panel: Extract<TransactionPanel, { _tag: "Bulk" }> }>
): JSX.Element => {
  const { panel } = props;
  const close = (): void => props.onPanel({ _tag: "Summary" });
  if (panel.stage === "selecting") {
    const selectedIds = new Set(panel.ids);
    const selected = props.transactions.filter((record) => selectedIds.has(record.id));
    return props.renderPanel(
      <section aria-label="Selección de transacciones" className="flex flex-col gap-5">
        <h2 className="text-xl font-semibold">Editar varias transacciones</h2>
        <p>
          Selecciona las transacciones que quieres corregir. Puedes elegir hasta{" "}
          {maximumAtomicBatchCalls}.
        </p>
        <p aria-live="polite">{selected.length} seleccionadas</p>
        <SelectedTransactions selected={selected} categories={props.categories} />
        <Button
          disabled={selected.length === 0}
          onClick={() => beginBulkEditing(selected, props.onPanel)}
        >
          Editar selección
        </Button>
        <Button variant="outline" onClick={close}>
          Cancelar
        </Button>
      </section>
    );
  }
  return (
    <BulkTransactionCorrection
      renderForm={props.renderPanel}
      transactions={panel.transactions}
      categories={props.categories}
      timeZone={props.currentUser.timeZone}
      onCancel={close}
    />
  );
};
const WorkspacePanel = (props: PanelProps): JSX.Element => {
  if (props.panel._tag === "Bulk") return <BulkPanel {...props} panel={props.panel} />;
  if (props.panel._tag === "Capture") return <CapturePanel {...props} panel={props.panel} />;
  if (props.panel._tag === "Detail") return <DetailPanel {...props} panel={props.panel} />;
  return props.renderPanel(
    <TransactionSummary
      partial={props.continuation !== "complete"}
      transactions={props.transactions}
      locale={props.currentUser.locale}
      timeZone={props.currentUser.timeZone}
    />
  );
};
const FilterButton = ({
  disabled,
  onClick,
}: Readonly<{ disabled: boolean; onClick: () => void }>): JSX.Element => (
  <Button variant="outline" disabled={disabled} onClick={onClick}>
    <HugeiconsIcon
      icon={FilterHorizontalIcon}
      strokeWidth={1.5}
      data-icon="inline-start"
      aria-hidden="true"
    />
    Filtros
  </Button>
);
const WorkspaceHeader = ({
  disabled,
  readOnly,
  onCapture,
}: Readonly<{
  disabled: boolean;
  readOnly: boolean;
  onCapture: () => void;
}>): JSX.Element => (
  <header data-transaction-slot="transaction-page-header">
    <h1>Transacciones</h1>
    {readOnly ? null : (
      <Button disabled={disabled} onClick={onCapture}>
        + Registrar
      </Button>
    )}
  </header>
);
type FilterExpansionProps = Readonly<{
  props: WorkspaceProps;
  filters: WorkspaceFilters;
  onFilters: (filters: WorkspaceFilters) => void;
  tool: FilterTool | "closed";
  disabled: boolean;
}>;
const FilterExpansion = ({
  props,
  filters,
  onFilters,
  tool,
  disabled,
}: FilterExpansionProps): JSX.Element => (
  <>
    {tool === "category" ? (
      <div data-transaction-slot="transaction-filter-expansion">
        <div>
          <Label htmlFor="transaction-expanded-date">Fecha</Label>
          <CalendarField
            id="transaction-expanded-date"
            label="Fecha del filtro"
            value={filters.date}
            timeZone={props.period.timeZone}
            disabled={disabled}
            required={false}
            appearance="field"
            onChange={(date) => onFilters({ ...filters, date })}
          />
        </div>
        <div>
          <span>Categoría</span>
          <CategoryFilter
            categories={props.categories}
            value={filters.categoryId}
            disabled={disabled}
            onChange={(categoryId) => onFilters({ ...filters, categoryId })}
          />
        </div>
        <Button variant="outline" disabled={disabled} onClick={() => onFilters(emptyFilters)}>
          Limpiar filtros
        </Button>
      </div>
    ) : null}
  </>
);
const TransactionFilters = ({
  props,
  filters,
  onFilters,
  tool,
  onTool,
  disabled,
  refreshDisabled,
}: Readonly<{
  props: WorkspaceProps;
  filters: WorkspaceFilters;
  onFilters: (filters: WorkspaceFilters) => void;
  tool: FilterTool | "closed";
  onTool: () => void;
  disabled: boolean;
  refreshDisabled: boolean;
}>): JSX.Element => (
  <>
    <div data-transaction-slot="transaction-search-toolbar">
      <Input
        type="search"
        aria-label="Buscar transacciones"
        placeholder="Buscar transacciones"
        value={filters.search}
        disabled={disabled}
        onChange={(event) => onFilters({ ...filters, search: event.target.value })}
      />
      <TransactionDateFilter
        value={filters.date}
        timeZone={props.period.timeZone}
        disabled={disabled}
        onChange={(date) => onFilters({ ...filters, date })}
      />
      <FilterButton disabled={disabled} onClick={onTool} />
      <RefreshButton
        disabled={refreshDisabled}
        onClick={props.onRefresh}
        label="Actualizar transacciones"
      />
    </div>
    <FilterExpansion
      props={props}
      filters={filters}
      onFilters={onFilters}
      tool={tool}
      disabled={disabled}
    />
  </>
);
const panelEditing = (panel: TransactionPanel): boolean => {
  if (panel._tag === "Capture") return true;
  if (panel._tag === "Bulk") return panel.stage === "editing";
  return panel._tag === "Detail" && panel.mode._tag !== "Viewing";
};
const bulkIds = (panel: TransactionPanel): ReadonlyArray<string> => {
  if (panel._tag !== "Bulk") return [];
  if (panel.stage === "selecting") return panel.ids;
  return panel.transactions.map((record) => record.id);
};
const bulkSelection = (
  panel: TransactionPanel,
  onPanel: (panel: TransactionPanel) => void,
  transactions: ReadonlyArray<Transaction>
): React.ComponentProps<typeof TransactionLedger>["selection"] => {
  const ids = bulkIds(panel);
  const selected = new Set(ids);
  return {
    active: panel._tag === "Bulk",
    ids,
    limit: maximumAtomicBatchCalls,
    onContinue: () => {
      if (panel._tag === "Bulk" && panel.stage === "selecting") {
        beginBulkEditing(
          transactions.filter((record) => selected.has(record.id)),
          onPanel
        );
      }
    },
    onToggle: (id) => {
      if (panel._tag !== "Bulk" || panel.stage !== "selecting") return;
      if (selected.has(id)) {
        onPanel({ ...panel, ids: panel.ids.filter((item) => item !== id) });
      } else if (panel.ids.length < maximumAtomicBatchCalls) {
        onPanel({ ...panel, ids: [...panel.ids, id] });
      }
    },
  };
};
const panelTitle = (panel: TransactionPanel): string => {
  if (panel._tag === "Summary") return "Resumen";
  if (panel._tag === "Capture") return "Registrar transacción";
  if (panel._tag === "Bulk") return "Editar transacciones";
  return "Detalle de transacción";
};
const detailPanel = (id: string, editable: boolean): TransactionPanel => ({
  _tag: "Detail",
  id,
  mode: editable ? { _tag: "Editing" } : { _tag: "Viewing" },
});
const selectionPanel = (panel: TransactionPanel): TransactionPanel =>
  panel._tag === "Bulk" ? { _tag: "Summary" } : { _tag: "Bulk", ids: [], stage: "selecting" };
const renderCategoryCell = (
  row: React.ComponentProps<typeof InlineTransactionCategory>["row"],
  disabled: boolean,
  props: WorkspaceProps
): JSX.Element =>
  props.readOnly === true ? (
    <span>{row.categoryLabel}</span>
  ) : (
    <InlineTransactionCategory
      row={row}
      disabled={disabled}
      transactions={props.transactions}
      categories={props.categories}
    />
  );
const ledgerDisabled = (panel: TransactionPanel): boolean =>
  panelLocked(panel) ||
  (panelEditing(panel) && panel._tag !== "Detail") ||
  (panel._tag === "Detail" && panel.mode._tag === "Deleting");
const WorkspaceContext = ({
  panel,
  onPanel,
  children,
  busy,
}: Readonly<{
  panel: TransactionPanel;
  onPanel: (panel: TransactionPanel) => void;
  children: JSX.Element;
  busy: boolean;
}>): JSX.Element => (
  <TransactionContextPanel
    active={panel._tag !== "Summary" && !(panel._tag === "Bulk" && panel.stage === "selecting")}
    identity={panel._tag === "Detail" ? `${panel.id}:${panel.mode._tag}` : panel._tag}
    locked={panelLocked(panel) || busy}
    onClose={() => onPanel({ _tag: "Summary" })}
    title={panelTitle(panel)}
  >
    {children}
  </TransactionContextPanel>
);
type WorkspaceContentProps = Readonly<{
  onTool: () => void;
  tool: FilterTool | "closed";
  props: WorkspaceProps;
  panel: TransactionPanel;
  onPanel: (panel: TransactionPanel) => void;
  filters: WorkspaceFilters;
  onFilters: (filters: WorkspaceFilters) => void;
  visible: ReadonlyArray<Transaction>;
  rows: ReturnType<typeof presentTransactionRows>;
}>;
const refreshLocked = (
  panel: TransactionPanel,
  corrections: Option.Option<TransactionCorrections>
): boolean =>
  panelLocked(panel) ||
  Option.match(corrections, {
    onNone: () => panelEditing(panel),
    onSome: (owner) =>
      owner.status === "saving" ||
      owner.status === "recovering" ||
      (panelEditing(panel) && owner.status === "idle"),
  });
const WorkspaceContent = ({
  props,
  panel,
  onPanel,
  filters,
  onFilters,
  visible,
  rows,
  tool,
  onTool,
}: WorkspaceContentProps): JSX.Element => {
  const corrections = use(TransactionCorrectionContext);
  const correctionBusy = Option.exists(
    corrections,
    (owner) => owner.status === "saving" || owner.status === "recovering"
  );
  const locked = panelLocked(panel) || correctionBusy;
  return (
    <div data-transaction-slot="transaction-columns">
      <div data-transaction-slot="transaction-records">
        <TransactionFilters
          props={props}
          filters={filters}
          onFilters={onFilters}
          tool={tool}
          onTool={onTool}
          disabled={panelEditing(panel) || (!props.editable && !props.readOnly)}
          refreshDisabled={refreshLocked(panel, corrections)}
        />
        <TransactionLedger
          partial={props.continuation !== "complete"}
          toolbar={<WorkspaceToolbar filters={filters} onFilters={onFilters} disabled={locked} />}
          readOnly={props.readOnly === true}
          canEdit={props.editable}
          onEdit={() => onPanel(selectionPanel(panel))}
          selection={bulkSelection(panel, onPanel, props.transactions)}
          rows={rows}
          locale={props.currentUser.locale}
          selected={panel._tag === "Detail" ? Option.some(panel.id) : Option.none()}
          disabled={ledgerDisabled(panel) || correctionBusy}
          renderCategory={(row, disabled) => renderCategoryCell(row, disabled, props)}
          onSelect={(id) => onPanel(detailPanel(id, props.editable))}
        />
      </div>
      <WorkspaceContext panel={panel} onPanel={onPanel} busy={correctionBusy}>
        <WorkspacePanel
          {...props}
          panel={panel}
          onPanel={onPanel}
          transactions={panel._tag === "Summary" ? visible : props.transactions}
          renderPanel={(content) => content}
        />
      </WorkspaceContext>
    </div>
  );
};
const ContinuationNotice = (props: WorkspaceProps): JSX.Element =>
  props.continuation === "complete" ? (
    <></>
  ) : (
    <output className="px-4 py-2 text-sm text-muted-foreground">
      {props.transactions.length} transacciones cargadas. Filtros y resumen aplican a las
      transacciones cargadas.
    </output>
  );
const continuationLabels = {
  complete: "",
  loading: "Cargando más transacciones…",
  failure: "Reintentar carga de más transacciones",
  available: "Al seguir bajando cargaremos más transacciones.",
};
const ContinuationControl = (
  props: WorkspaceProps & Readonly<{ editing: boolean }>
): JSX.Element => {
  const attachContinuation: RefCallback<HTMLDivElement> = (element) => {
    if (
      element === null ||
      props.continuation !== "available" ||
      props.editing ||
      (!props.editable && props.readOnly !== true)
    ) {
      return;
    }
    return observeContinuation({ element, onMore: props.onMore });
  };
  if (props.continuation === "complete") return <></>;
  return (
    <div
      ref={attachContinuation}
      aria-label="Continuación de transacciones"
      aria-live="polite"
      aria-busy={props.continuation === "loading"}
      className="flex flex-col items-start gap-2 px-4 py-4"
    >
      {props.continuation === "failure" ? (
        <p role="alert">
          No pudimos cargar más transacciones. Conservamos las transacciones cargadas.
        </p>
      ) : null}
      {props.continuation === "failure" ? (
        <Button
          variant="outline"
          disabled={props.editing || (!props.editable && props.readOnly !== true)}
          onClick={props.onRetryMore}
        >
          {continuationLabels[props.continuation]}
        </Button>
      ) : (
        <span>{continuationLabels[props.continuation]}</span>
      )}
    </div>
  );
};
export const TransactionWorkspace = (props: WorkspaceProps): JSX.Element => {
  const [tool, setTool] = useState<FilterTool | "closed">("closed");
  const [panel, onPanel] = useState<TransactionPanel>({ _tag: "Summary" });
  const [localFilters, setFilters] = useState(emptyLocalFilters);
  const filters = {
    ...localFilters,
    date: props.dateFilter.value,
  };
  const onFilters = (next: WorkspaceFilters): void => {
    setFilters({ search: next.search, direction: next.direction, categoryId: next.categoryId });
    props.dateFilter.onChange(next.date);
    if (panel._tag === "Bulk") onPanel({ _tag: "Summary" });
  };
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
  const editing = panelEditing(panel);
  return (
    <>
      <Toaster position="bottom-right" richColors />
      <TransactionSurface panelOpen={panelEditing(panel) || panel._tag === "Detail"}>
        <WorkspaceHeader
          disabled={editing || (!props.editable && !props.readOnly)}
          readOnly={props.readOnly}
          onCapture={() => onPanel({ _tag: "Capture", status: "idle" })}
        />
        {props.queryNotice}
        <ContinuationNotice {...props} />
        <WorkspaceContent
          onTool={() => setTool(tool === "closed" ? "category" : "closed")}
          tool={tool}
          props={props}
          panel={panel}
          onPanel={onPanel}
          filters={filters}
          onFilters={onFilters}
          visible={visible}
          rows={rows}
        />
        <ContinuationControl {...props} editing={editing} />
      </TransactionSurface>
    </>
  );
};
