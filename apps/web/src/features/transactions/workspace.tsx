import { Toaster, toast } from "sonner";
import { useState } from "react";
import type { JSX, ReactNode } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import { FilterHorizontalIcon, Search01Icon } from "@hugeicons/core-free-icons";
import { Array, DateTime, Option } from "effect";
import { Button } from "@/ui/components/button";
import { Input } from "@/ui/components/input";
import { TransactionDropdown } from "./dropdown";
import { TransactionDateFilter } from "./date-filter";
import { type FidyClient, maximumAtomicBatchCalls } from "@/transport/client";
import { BulkTransactionCorrection } from "./bulk-correction";
import { TransactionDetail } from "./detail";
import { TransactionSummary } from "./summary";
import { InlineTransactionCategory } from "./inline-category";
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
const emptyFilters: WorkspaceFilters = {
  search: "",
  direction: "all",
  categoryId: "all",
  date: "",
};
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
  <TransactionDropdown
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
  <div className="contents">
    <TransactionDropdown
      triggerLabel={filters.direction === "all" ? Option.some("Transacciones") : Option.none()}
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
    {tool === "category" ? (
      <CategoryFilter
        categories={categories}
        value={filters.categoryId}
        disabled={disabled}
        onChange={(categoryId) => onFilters({ ...filters, categoryId })}
      />
    ) : null}
    {hasFilters(filters) ? (
      <Button variant="ghost" disabled={disabled} onClick={() => onFilters(emptyFilters)}>
        Limpiar filtros
      </Button>
    ) : null}
  </div>
);
const panelLocked = (panel: TransactionPanel): boolean =>
  (panel._tag === "Bulk" && panel.stage === "editing" && panel.status === "saving") ||
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
const beginBulkEditing = (
  selected: ReadonlyArray<Transaction>,
  onPanel: (panel: TransactionPanel) => void
): void => {
  if (Array.isReadonlyArrayNonEmpty(selected)) {
    onPanel({ _tag: "Bulk", stage: "editing", transactions: selected, status: "idle" });
  }
};
const BulkPanel = (
  props: PanelProps & Readonly<{ panel: Extract<TransactionPanel, { _tag: "Bulk" }> }>
): JSX.Element => {
  const { panel } = props;
  const close = (): void => props.onPanel({ _tag: "Summary" });
  if (panel.stage === "selecting") {
    const selected = props.transactions.filter((record) => panel.ids.includes(record.id));
    return props.renderPanel(
      <section aria-label="Selección de transacciones" className="flex flex-col gap-5">
        <h2 className="text-xl font-semibold">Editar varias transacciones</h2>
        <p>
          Selecciona las transacciones que quieres corregir. Puedes elegir hasta{" "}
          {maximumAtomicBatchCalls}.
        </p>
        <p aria-live="polite">{selected.length} seleccionadas</p>
        <ul className="flex flex-col gap-2">
          {selected.map((record) => (
            <li key={record.id}>
              {Option.getOrElse(record.counterparty, () => "Contraparte no identificada")}
            </li>
          ))}
        </ul>
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
      apiClient={props.apiClient}
      timeZone={props.currentUser.timeZone}
      status={panel.status}
      onStatus={(status) => props.onPanel({ ...panel, status })}
      onCancel={close}
      onRefresh={() => {
        close();
        props.onRefresh();
      }}
      onSaved={() => {
        toast.success("Cambios guardados");
        close();
        props.onRefresh();
      }}
    />
  );
};
const WorkspacePanel = (props: PanelProps): JSX.Element => {
  if (props.panel._tag === "Bulk") return <BulkPanel {...props} panel={props.panel} />;
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
const focusSearch: React.RefCallback<HTMLInputElement> = (element): void => {
  element?.focus();
};
const HeaderSearch = ({
  search,
  onSearch,
  searching,
  onSearchOpen,
  disabled,
}: Readonly<{
  search: string;
  onSearch: (value: string) => void;
  searching: boolean;
  onSearchOpen: (value: boolean) => void;
  disabled: boolean;
}>): JSX.Element => (
  <>
    {" "}
    {searching ? (
      <Input
        ref={focusSearch}
        aria-label="Buscar transacciones"
        placeholder="Buscar transacciones"
        value={search}
        disabled={disabled}
        className="min-w-0 sm:w-52"
        onChange={(event) => onSearch(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Escape") onSearchOpen(false);
        }}
      />
    ) : (
      <Button variant="outline" disabled={disabled} onClick={() => onSearchOpen(true)}>
        <HugeiconsIcon
          icon={Search01Icon}
          strokeWidth={1.5}
          data-icon="inline-start"
          aria-hidden="true"
        />
        Buscar
      </Button>
    )}
  </>
);
const WorkspaceHeader = ({
  period,
  disabled,
  onCapture,
  onTool,
  search,
  onSearch,
  searching,
  onSearchOpen,
  date,
  onDate,
}: Readonly<{
  onTool: (tool: FilterTool) => void;
  search: string;
  searching: boolean;
  onSearch: (value: string) => void;
  onSearchOpen: (value: boolean) => void;
  date: string;
  onDate: (date: string) => void;
  period: WorkspaceProps["period"];
  disabled: boolean;
  onCapture: () => void;
}>): JSX.Element => (
  <header className="flex min-h-18 flex-wrap items-center justify-between gap-4 border-b px-5 py-3">
    <div>
      <h1 className="text-3xl font-semibold tracking-tight">Transacciones</h1>
      <span className="sr-only">
        {period.monthLabel} · {period.timeZone}
      </span>
    </div>
    <div className="grid w-full grid-cols-2 gap-2 sm:flex sm:w-auto sm:flex-wrap sm:items-center">
      <HeaderSearch
        search={search}
        onSearch={onSearch}
        searching={searching}
        onSearchOpen={onSearchOpen}
        disabled={disabled}
      />
      <TransactionDateFilter
        value={date}
        timeZone={period.timeZone}
        disabled={disabled}
        onChange={onDate}
      />
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
const renderResponsivePanel = (
  content: JSX.Element,
  panel: TransactionPanel,
  controls: Readonly<{ locked: boolean; onPanel: (panel: TransactionPanel) => void }>
): JSX.Element => (
  <ResponsiveTransactionPanel
    open={panel._tag !== "Summary" && !(panel._tag === "Bulk" && panel.stage === "selecting")}
    locked={controls.locked}
    title={panelTitle(panel)}
    onClose={() => controls.onPanel({ _tag: "Summary" })}
  >
    {content}
  </ResponsiveTransactionPanel>
);
const panelEditing = (panel: TransactionPanel): boolean => {
  if (panel._tag === "Capture") return true;
  if (panel._tag === "Bulk") return panel.stage === "editing";
  return panel._tag === "Detail" && panel.mode._tag === "Editing";
};
const bulkIds = (panel: TransactionPanel): ReadonlyArray<string> => {
  if (panel._tag !== "Bulk") return [];
  if (panel.stage === "selecting") return panel.ids;
  return panel.transactions.map((record) => record.id);
};
const bulkSelection = (
  panel: TransactionPanel,
  onPanel: (panel: TransactionPanel) => void
): React.ComponentProps<typeof TransactionLedger>["selection"] => ({
  active: panel._tag === "Bulk",
  ids: bulkIds(panel),
  limit: maximumAtomicBatchCalls,
  onToggle: (id) => {
    if (panel._tag !== "Bulk" || panel.stage !== "selecting") return;
    if (panel.ids.includes(id)) {
      onPanel({ ...panel, ids: panel.ids.filter((item) => item !== id) });
    } else if (panel.ids.length < maximumAtomicBatchCalls) {
      onPanel({ ...panel, ids: [...panel.ids, id] });
    }
  },
});
const panelTitle = (panel: TransactionPanel): string => {
  if (panel._tag === "Capture") return "Registrar transacción";
  if (panel._tag === "Bulk") return "Editar transacciones";
  return "Detalle de transacción";
};
const detailPanel = (id: string, editable: boolean): TransactionPanel => ({
  _tag: "Detail",
  id,
  mode: editable ? { _tag: "Editing", status: "idle" } : { _tag: "Viewing" },
});
const selectionPanel = (panel: TransactionPanel): TransactionPanel =>
  panel._tag === "Bulk" ? { _tag: "Summary" } : { _tag: "Bulk", ids: [], stage: "selecting" };
const renderCategoryCell = (
  row: React.ComponentProps<typeof InlineTransactionCategory>["row"],
  disabled: boolean,
  props: WorkspaceProps
): JSX.Element => (
  <InlineTransactionCategory
    row={row}
    disabled={disabled}
    apiClient={props.apiClient}
    transactions={props.transactions}
    categories={props.categories}
    onRefresh={props.onRefresh}
    onSaved={() => {
      toast.success("Categoría guardada");
      props.onRefresh();
    }}
  />
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
  const editing = panelEditing(panel);
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
          onEdit={() => onPanel(selectionPanel(panel))}
          selection={bulkSelection(panel, onPanel)}
          rows={rows}
          locale={props.currentUser.locale}
          selected={panel._tag === "Detail" ? Option.some(panel.id) : Option.none()}
          disabled={locked || (editing && panel._tag !== "Detail")}
          renderCategory={(row, disabled) => renderCategoryCell(row, disabled, props)}
          onSelect={(id) => onPanel(detailPanel(id, props.editable))}
        />
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
  const [searching, onSearchOpen] = useState(false);
  const [tool, setTool] = useState<FilterTool | "closed">("closed");
  const [panel, onPanel] = useState<TransactionPanel>({ _tag: "Summary" });
  const [filters, onFilters] = useState<WorkspaceFilters>(emptyFilters);
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
      <main className="flex w-full flex-col">
        <WorkspaceHeader
          search={filters.search}
          onSearch={(search) => onFilters({ ...filters, search })}
          searching={searching}
          onSearchOpen={onSearchOpen}
          date={filters.date}
          onDate={(date) => onFilters({ ...filters, date })}
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
