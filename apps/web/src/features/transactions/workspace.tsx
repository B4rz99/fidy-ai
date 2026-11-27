import { lazyRouteComponent } from "@tanstack/react-router";
import { useRecurringTransactionMonth } from "@/browser/recurring-transaction-origin";
import { formatMoneyWithCode } from "@/transport/money";
import { type CaptureHistoryVersion, ManualCaptureContext } from "./manual-capture-context";
import { TransactionPeriodControls } from "./period-controls";
import { RefreshButton } from "@/ui/components/refresh-button";
import { WorkspaceHeader as SharedHeader } from "@/ui/components/workspace-layout";
import { Toaster, toast } from "sonner";
import { Suspense, use, useState } from "react";
import { PendingRead } from "@/ui/components/pending-read";
import type { TransactionCorrections } from "./corrections";
import { TransactionCorrectionContext } from "./correction-context";
import type { JSX, ReactNode, RefCallback } from "react";
import { observeContinuation } from "./scroll-continuation";
import { HugeiconsIcon } from "@hugeicons/react";
import { FilterHorizontalIcon } from "@hugeicons/core-free-icons";
import { Array, type Data, DateTime, Match, Option, Predicate } from "effect";
import { Button } from "@/ui/components/button";
import { SelectionScopeDialog } from "@/ui/components/selection-scope-dialog";
import { SelectionSummary } from "@/ui/components/selection-summary";
import { Input } from "@/ui/components/input";
import { CalendarField } from "@/ui/components/calendar-field";
import { Label } from "@/ui/components/label";
import { CategoryVisual } from "@/ui/components/category-visual";
import { TransactionContextPanel, TransactionSurface } from "@/ui/components/transactions";
import { ChoiceDropdown } from "@/ui/components/choice-dropdown";
import { TransactionDateFilter } from "./date-filter";
import { type FidyClient } from "@/transport/client";
import { TransactionSummary } from "./summary";
import {
  emptyTransactionFilters,
  matchesTransactionFilters,
  transactionSearchLimit,
  useTransactionFilters,
} from "./view-state";
import { InlineTransactionCategory } from "./inline-category";
import { TransactionLedger } from "./ledger";
import { RecurringReturnLink } from "./destination";
import {
  BulkSelection,
  DetailMode,
  TransactionPanel,
  reconciliationFinished,
  reconciliationLocked,
} from "./panel-state";
import type { HistoryState } from "./history";
import {
  type Category,
  type CurrentUser,
  type Transaction,
  formatOccurrence,
  presentTransactionRows,
} from "./presentation";

const BulkTransactionCorrection = lazyRouteComponent(
  () => import("./bulk-correction"),
  "BulkTransactionCorrection"
);

const TransactionDetail = lazyRouteComponent(() => import("./detail"), "TransactionDetail");

const ManualCapturePanel = lazyRouteComponent(
  () => import("./manual-capture-panel"),
  "ManualCapturePanel"
);

type WorkspaceProps = Readonly<{
  generation: number;
  locate: Option.Option<string>;
  captureHistoryVersion: Option.Option<CaptureHistoryVersion>;
  apiClient: FidyClient;
  categories: ReadonlyArray<Category>;
  currentUser: Pick<CurrentUser, "locale" | "timeZone">;
  transactions: ReadonlyArray<Transaction>;
  period: Readonly<{ monthLabel: string; timeZone: string }>;
  monthFilter: Option.Option<Readonly<{ value: string; onChange: (month: string) => void }>>;
  queryNotice: ReactNode;
  dateFilter: Readonly<{ value: string; onChange: (date: string) => void }>;
  onRefresh: () => void;
  continuation: HistoryState["continuation"];
  location: HistoryState["location"];
  onMore: () => void;
  onRetryMore: () => void;
}> &
  (
    | Readonly<{ readOnly: true; editable: false }>
    | Readonly<{
        readOnly: false;
        editable: boolean;
        capture: boolean;
      }>
  );

type WorkspaceFilters = Readonly<{
  search: string;
  direction: string;
  categoryId: string;
  date: string;
}>;

const emptyLocalFilters = emptyTransactionFilters;

const emptyFilters: WorkspaceFilters = { ...emptyLocalFilters, date: "" };

const hasFilters = (filters: WorkspaceFilters): boolean =>
  filters.search.trim() !== "" ||
  filters.direction !== "all" ||
  filters.categoryId !== "all" ||
  filters.date !== "";

type FilterTool = "category";

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
        { value: "all", label: "Todas" },
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

const panelLocked: (panel: TransactionPanel) => boolean = TransactionPanel.$match({
  Bulk: () => false,
  Capture: ({ status }) => status === "saving",
  Detail: ({ mode }) =>
    Match.valueTags(mode, {
      Deleting: ({ status }) => status !== "idle",
      Reconciling: (reconciling) => reconciliationLocked(reconciling),
      Viewing: () => false,
      Editing: () => false,
    }),
  Summary: () => false,
});

type PanelProps = WorkspaceProps &
  Readonly<{
    panel: TransactionPanel;
    onPanel: (panel: TransactionPanel) => void;
    renderPanel: (content: JSX.Element) => JSX.Element;
  }>;

const CapturePanel = ({ onPanel, renderPanel, ...props }: PanelProps): JSX.Element => {
  const corrections = use(TransactionCorrectionContext);

  return renderPanel(
    <ManualCapturePanel
      apiClient={props.apiClient}
      categories={props.categories}
      currentUser={props.currentUser}
      version={Option.getOrElse(props.captureHistoryVersion, () => ({
        month: "",
        timeZone: props.currentUser.timeZone,
        generation: 0,
      }))}
      editable={props.editable}
      waiting={Option.exists(corrections, (owner) => owner.status === "recovering")}
      onClose={() => onPanel(TransactionPanel.Summary())}
      onRefresh={props.onRefresh}
      onCreated={(transaction) => {
        toast.success("Transacción registrada", {
          description: `${formatMoneyWithCode({ money: transaction.money, locale: props.currentUser.locale })} · ${Option.getOrElse(transaction.counterparty, () => "Contraparte no identificada")} · ${formatOccurrence({ locale: props.currentUser.locale, timeZone: props.currentUser.timeZone, occurredAt: transaction.occurredAt })}`,
        });
      }}
    />
  );
};

const closeTransactionPanel = (
  panel: TransactionPanel,
  onPanel: (panel: TransactionPanel) => void,
  onRefresh: () => void
): void => {
  onPanel(TransactionPanel.Summary());

  if (
    Predicate.isTagged(panel, "Detail") &&
    Predicate.isTagged(panel.mode, "Reconciling") &&
    reconciliationFinished(panel.mode)
  ) {
    onRefresh();
  }
};

const DetailPanel = ({
  panel,
  onPanel,
  renderPanel,
  ...props
}: PanelProps &
  Readonly<{
    panel: Data.TaggedEnum.Value<TransactionPanel, "Detail">;
  }>): JSX.Element => {
  const transaction = Option.fromNullishOr(
    props.transactions.find((record) => record.id === panel.id)
  );

  const originMonth = useRecurringTransactionMonth();
  const addressed = Option.contains(props.locate, panel.id);
  const recurringMonth = Option.filter(originMonth, () => addressed);
  const close = (): void => closeTransactionPanel(panel, onPanel, props.onRefresh);

  if (Option.isNone(transaction)) {
    return renderPanel(
      <div className="flex flex-col gap-3">
        <p>Esta transacción ya no aparece en el periodo seleccionado.</p>
        {Option.match(recurringMonth, {
          onSome: (month) => <RecurringReturnLink month={month} />,
          onNone: () => (
            <Button variant="outline" onClick={close}>
              Volver al resumen
            </Button>
          ),
        })}
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
      inspectable={props.readOnly !== true}
      fromReview={addressed && Option.isNone(recurringMonth) && props.dateFilter.value === ""}
      recurringMonth={recurringMonth}
      mode={panel.mode}
      onMode={(mode) => onPanel(TransactionPanel.Detail({ id: panel.id, mode }))}
      onClose={close}
      onRefresh={props.onRefresh}
      onDeleted={() => {
        toast.success("Transacción eliminada");
        close();
      }}
    />
  );
};

const beginBulkEditing = (
  selected: ReadonlyArray<Transaction>,
  onPanel: (panel: TransactionPanel) => void
): void => {
  if (Array.isReadonlyArrayNonEmpty(selected)) {
    onPanel(
      TransactionPanel.Bulk({ selection: BulkSelection.Editing({ transactions: selected }) })
    );
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
  props: PanelProps & Readonly<{ panel: Data.TaggedEnum.Value<TransactionPanel, "Bulk"> }>
): JSX.Element => {
  const { selection } = props.panel;
  const close = (): void => props.onPanel(TransactionPanel.Summary());

  if (Predicate.isTagged(selection, "Selecting")) {
    const selectedIds = new Set(selection.ids);
    const selected = props.transactions.filter((record) => selectedIds.has(record.id));

    return props.renderPanel(
      <section aria-label="Selección de transacciones" className="flex flex-col gap-5">
        <h2 className="text-xl font-semibold">Editar varias transacciones</h2>
        <p>Selecciona las transacciones que quieres corregir.</p>
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
      transactions={Array.map(
        selection.transactions,
        (selected) => props.transactions.find((record) => record.id === selected.id) ?? selected
      )}
      categories={props.categories}
      timeZone={props.currentUser.timeZone}
      onCancel={close}
    />
  );
};

const scopeLabel = (props: WorkspaceProps): string => {
  if (props.dateFilter.value !== "") {
    const date = DateTime.format(DateTime.makeUnsafe(`${props.dateFilter.value}T12:00:00Z`), {
      locale: props.currentUser.locale,
      timeZone: "UTC",
      dateStyle: "long",
    });

    return `para el ${date}`;
  }

  return props.readOnly ? "en el historial guardado" : `en ${props.period.monthLabel}`;
};

const WorkspacePanel = (props: PanelProps): JSX.Element => {
  if (Predicate.isTagged(props.panel, "Bulk")) {
    return (
      <Suspense fallback={<PendingRead label="Cargando edición" />}>
        <BulkPanel {...props} panel={props.panel} />
      </Suspense>
    );
  }

  if (Predicate.isTagged(props.panel, "Capture")) {
    return (
      <Suspense fallback={<PendingRead label="Cargando formulario" />}>
        <CapturePanel {...props} />
      </Suspense>
    );
  }

  if (Predicate.isTagged(props.panel, "Detail")) {
    return (
      <Suspense fallback={<PendingRead label="Cargando detalle" />}>
        <DetailPanel {...props} panel={props.panel} />
      </Suspense>
    );
  }

  return props.renderPanel(
    <TransactionSummary
      scope={scopeLabel(props)}
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
  <SharedHeader title="Transacciones" context={null}>
    {readOnly ? null : (
      <Button disabled={disabled} onClick={onCapture}>
        + Registrar
      </Button>
    )}
  </SharedHeader>
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
            appearance="filter"
            month={Option.map(props.monthFilter, (filter) => filter.value)}
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
      {Option.isNone(props.monthFilter) ? null : (
        <TransactionPeriodControls
          {...props.monthFilter.value}
          label={props.period.monthLabel}
          disabled={disabled}
        />
      )}
      <Input
        type="search"
        aria-label="Buscar transacciones"
        maxLength={transactionSearchLimit}
        placeholder="Buscar transacciones"
        value={filters.search}
        disabled={disabled}
        onChange={(event) => onFilters({ ...filters, search: event.target.value })}
      />
      <TransactionDateFilter
        month={Option.map(props.monthFilter, (filter) => filter.value)}
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

const panelEditing: (panel: TransactionPanel) => boolean = TransactionPanel.$match({
  Capture: () => true,
  Bulk: ({ selection }) => Predicate.isTagged(selection, "Editing"),
  Detail: ({ mode }) => !Predicate.isTagged(mode, "Viewing"),
  Summary: () => false,
});

const bulkIds: (panel: TransactionPanel) => ReadonlyArray<string> = TransactionPanel.$match({
  Bulk: ({ selection }) =>
    BulkSelection.$match(selection, {
      Selecting: ({ ids }) => ids,
      Editing: ({ transactions }) => transactions.map((record) => record.id),
    }),
  Summary: () => [],
  Capture: () => [],
  Detail: () => [],
});

const bulkSelecting = (panel: TransactionPanel): Option.Option<ReadonlyArray<string>> =>
  Predicate.isTagged(panel, "Bulk") && Predicate.isTagged(panel.selection, "Selecting")
    ? Option.some(panel.selection.ids)
    : Option.none();

const selectingPanel = (ids: ReadonlyArray<string>): TransactionPanel =>
  TransactionPanel.Bulk({ selection: BulkSelection.Selecting({ ids }) });

const selectedTransactionItems = (
  props: WorkspaceProps,
  selected: ReadonlySet<string>,
  visible: ReadonlyArray<Transaction>
): React.ComponentProps<typeof SelectionSummary>["items"] => {
  const visibleIds = new Set<string>(visible.map((record) => record.id));

  return presentTransactionRows({
    transactions: props.transactions.filter((record) => selected.has(record.id)),
    categories: props.categories,
    locale: props.currentUser.locale,
    timeZone: props.currentUser.timeZone,
    counterpartyFallback: "Contraparte no identificada",
  }).map((record) => ({
    id: record.id,
    label: record.counterpartyLabel,
    description: `${record.transactionTypeLabel} · ${record.moneyText} · ${record.occurredOnText}`,
    hidden: !visibleIds.has(record.id),
  }));
};

type BulkSelectionProps = Readonly<{
  panel: TransactionPanel;
  onPanel: (panel: TransactionPanel) => void;
  props: WorkspaceProps;
  visible: ReadonlyArray<Transaction>;
  disabled: boolean;
}>;

const TransactionSelectionSummary = ({
  panel,
  onPanel,
  props,
  visible,
  disabled,
}: BulkSelectionProps): JSX.Element => {
  const ids = bulkIds(panel);
  const selected = new Set(ids);

  return (
    <SelectionSummary
      showClear={false}
      clearFocusId="transaction-type-filter"
      items={selectedTransactionItems(props, selected, visible)}
      label={`${ids.length} seleccionadas`}
      disabled={disabled || Option.isNone(bulkSelecting(panel))}
      onClear={() => onPanel(selectingPanel([]))}
      onRemove={(id) => {
        Option.map(bulkSelecting(panel), (current) =>
          onPanel(selectingPanel(current.filter((item) => item !== id)))
        );
      }}
    />
  );
};

const bulkSelection = ({
  panel,
  onPanel,
  props,
  visible,
  disabled,
}: BulkSelectionProps): React.ComponentProps<typeof TransactionLedger>["selection"] => {
  const transactions = props.transactions;
  const ids = bulkIds(panel);
  const selected = new Set(ids);

  return {
    summary: <TransactionSelectionSummary {...{ panel, onPanel, props, visible, disabled }} />,
    active: Predicate.isTagged(panel, "Bulk"),
    ids,
    allSelected: visible.every((record) => selected.has(record.id)),
    onSelectAll: () => {
      Option.map(bulkSelecting(panel), (current) =>
        onPanel(selectingPanel([...new Set([...current, ...visible.map((record) => record.id)])]))
      );
    },
    onClear: () => {
      if (Option.isNone(bulkSelecting(panel))) return;
      document.getElementById("transaction-type-filter")?.focus();
      onPanel(selectingPanel([]));
    },
    onContinue: () => {
      if (Option.isSome(bulkSelecting(panel))) {
        beginBulkEditing(
          transactions.filter((record) => selected.has(record.id)),
          onPanel
        );
      }
    },
    onToggle: (id) => {
      const current = bulkSelecting(panel);

      if (Option.isNone(current)) return;

      onPanel(
        selectingPanel(
          selected.has(id) ? current.value.filter((item) => item !== id) : [...current.value, id]
        )
      );
    },
  };
};

const panelTitle: (panel: TransactionPanel) => string = TransactionPanel.$match({
  Summary: () => "Resumen",
  Capture: () => "Registrar transacción",
  Bulk: () => "Editar transacciones",
  Detail: () => "Detalle de transacción",
});

const detailPanel = (id: string, editable: boolean): TransactionPanel =>
  TransactionPanel.Detail({ id, mode: editable ? DetailMode.Editing() : DetailMode.Viewing() });

const selectionPanel = (panel: TransactionPanel): TransactionPanel =>
  Predicate.isTagged(panel, "Bulk") ? TransactionPanel.Summary() : selectingPanel([]);

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
  (panelEditing(panel) && !Predicate.isTagged(panel, "Detail")) ||
  (Predicate.isTagged(panel, "Detail") &&
    (Predicate.isTagged(panel.mode, "Deleting") || Predicate.isTagged(panel.mode, "Reconciling")));

const WorkspaceContext = ({
  panel,
  onClose,
  children,
  busy,
}: Readonly<{
  panel: TransactionPanel;
  onClose: () => void;
  children: JSX.Element;
  busy: boolean;
}>): JSX.Element => (
  <TransactionContextPanel
    active={!Predicate.isTagged(panel, "Summary") && Option.isNone(bulkSelecting(panel))}
    identity={Predicate.isTagged(panel, "Detail") ? `${panel.id}:${panel.mode._tag}` : panel._tag}
    locked={panelLocked(panel) || busy}
    onClose={onClose}
    title={panelTitle(panel)}
    returnFocusId={
      Predicate.isTagged(panel, "Detail") ? Option.some(`transaction-${panel.id}`) : Option.none()
    }
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
      owner.status === "refreshing" ||
      (panelEditing(panel) && !owner.locked),
  });

const correctionPending = (corrections: Option.Option<TransactionCorrections>): boolean =>
  Option.exists(
    corrections,
    (owner) =>
      owner.status === "saving" || owner.status === "recovering" || owner.status === "refreshing"
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
  onTool,
}: WorkspaceContentProps): JSX.Element => {
  const corrections = use(TransactionCorrectionContext);
  const correctionBusy = correctionPending(corrections);
  const locked = panelLocked(panel) || correctionBusy;
  const closePanel = (): void => closeTransactionPanel(panel, onPanel, props.onRefresh);

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
          emptyTitle={`${hasFilters({ ...filters, date: "" }) ? "No hay coincidencias" : "No hay transacciones"} ${scopeLabel(props)}`}
          continuation={props.continuation}
          toolbar={<WorkspaceToolbar filters={filters} onFilters={onFilters} disabled={locked} />}
          readOnly={props.readOnly === true}
          canEdit={props.editable}
          onEdit={() => onPanel(selectionPanel(panel))}
          selection={bulkSelection({ panel, onPanel, props, visible, disabled: locked })}
          locate={props.locate}
          rows={rows}
          locale={props.currentUser.locale}
          selected={Predicate.isTagged(panel, "Detail") ? Option.some(panel.id) : Option.none()}
          disabled={ledgerDisabled(panel) || correctionBusy}
          renderCategory={(row, disabled) => renderCategoryCell(row, disabled, props)}
          onSelect={(id) => onPanel(detailPanel(id, props.editable))}
        />
        <ContinuationControl {...props} editing={panelEditing(panel)} />
      </div>
      <WorkspaceContext panel={panel} onClose={closePanel} busy={correctionBusy}>
        <WorkspacePanel
          {...props}
          panel={panel}
          onPanel={onPanel}
          transactions={Predicate.isTagged(panel, "Summary") ? visible : props.transactions}
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
  failure: "Reintentar carga de más transacciones",
  available: "Al seguir bajando cargaremos más transacciones.",
};

const continuationHint = (props: Pick<WorkspaceProps, "location" | "continuation">): string => {
  if (props.location === "BoundReached") return "Para cargar otra página, usa «Seguir buscando».";

  if (props.location === "LookupFailed") return "Reintenta la búsqueda para continuar.";

  if (props.continuation === "loading") return "";

  return continuationLabels[props.continuation];
};

const ContinuationControl = (
  props: WorkspaceProps & Readonly<{ editing: boolean }>
): JSX.Element => {
  const attachContinuation: RefCallback<HTMLDivElement> = (element) => {
    if (
      element === null ||
      props.continuation !== "available" ||
      (props.location !== "None" && props.location !== "Located") ||
      props.editing ||
      (!props.editable && props.readOnly !== true)
    ) {
      return;
    }

    return observeContinuation({ element, onMore: props.onMore });
  };

  if (props.continuation === "complete") return <></>;

  const continuation =
    props.continuation === "loading" ? null : <span>{continuationHint(props)}</span>;

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
        <Button variant="outline" disabled={props.editing} onClick={props.onRetryMore}>
          {continuationLabels[props.continuation]}
        </Button>
      ) : (
        continuation
      )}
    </div>
  );
};

const CaptureNotice = ({
  panel,
  onPanel,
}: Pick<WorkspaceContentProps, "panel" | "onPanel">): JSX.Element => {
  const capture = use(ManualCaptureContext);

  if (
    Predicate.isTagged(panel, "Capture") ||
    !Option.exists(capture, (owner) => Option.isSome(owner.attempt))
  ) {
    return <></>;
  }

  return (
    <div className="flex flex-wrap items-center gap-3 px-4 py-2">
      <p>Hay un borrador por revisar. El guardado original sigue sin confirmar.</p>
      <Button
        variant="outline"
        onClick={() => onPanel(TransactionPanel.Capture({ status: "uncertain" }))}
      >
        Ver borrador
      </Button>
    </div>
  );
};

const capturePanelStatus = (
  panel: TransactionPanel,
  capture: React.ContextType<typeof ManualCaptureContext>
): TransactionPanel => {
  if (!Predicate.isTagged(panel, "Capture") || Option.isNone(capture)) return panel;

  if (capture.value.saving) return TransactionPanel.Capture({ status: "saving" });

  return TransactionPanel.Capture({ status: capture.value.uncertain ? "uncertain" : "idle" });
};

const initialWorkspacePanel = (
  props: WorkspaceProps,
  defaultPanel: TransactionPanel,
  located: Option.Option<string>
): TransactionPanel => {
  if (!Predicate.isTagged(defaultPanel, "Summary")) return defaultPanel;

  if (Option.isSome(located)) {
    return TransactionPanel.Detail({ id: located.value, mode: DetailMode.Viewing() });
  }

  return !props.readOnly && props.capture && props.editable
    ? TransactionPanel.Capture({ status: "idle" })
    : defaultPanel;
};

type WorkspacePanelState = Readonly<{
  panel: TransactionPanel;
  onPanel: (panel: TransactionPanel) => void;
}>;

const useWorkspacePanel = (props: WorkspaceProps): WorkspacePanelState => {
  const generation = props.generation;
  const capture = use(ManualCaptureContext);
  const corrections = use(TransactionCorrectionContext);
  const recurringMonth = useRecurringTransactionMonth();

  const defaultPanel: TransactionPanel = Option.exists(capture, (owner) => owner.uncertain)
    ? TransactionPanel.Capture({ status: "uncertain" })
    : TransactionPanel.Summary();

  const [interaction, setInteraction] = useState<
    Readonly<{ generation: number; panel: Option.Option<TransactionPanel> }>
  >({ generation, panel: Option.none() });

  if (interaction.generation !== generation) {
    setInteraction({
      generation,
      panel: Option.isSome(recurringMonth) ? Option.none() : Option.some(defaultPanel),
    });
  }

  const located = Option.filter(
    props.locate,
    (id) =>
      props.location === "Located" &&
      props.transactions.some((transaction) => transaction.id === id)
  );

  const initialPanel = initialWorkspacePanel(props, defaultPanel, located);

  const panel: TransactionPanel =
    interaction.generation === generation
      ? Option.getOrElse(interaction.panel, () => initialPanel)
      : defaultPanel;

  const onPanel = (next: TransactionPanel): void => {
    if (
      Predicate.isTagged(panel, "Detail") &&
      Predicate.isTagged(panel.mode, "Deleting") &&
      !(
        Predicate.isTagged(next, "Detail") &&
        Predicate.isTagged(next.mode, "Deleting") &&
        next.id === panel.id
      )
    ) {
      Option.map(corrections, (owner) => owner.cancelDeletion());
    }

    setInteraction({ generation, panel: Option.some(next) });
  };

  return { panel: capturePanelStatus(panel, capture), onPanel };
};

type PeriodChoice = Readonly<{ kind: "date" | "month"; value: string }>;

type PeriodSelection = Readonly<{ props: WorkspaceProps; confirmation: JSX.Element }>;

const usePeriodSelection = (
  source: WorkspaceProps,
  panel: TransactionPanel,
  onPanel: (panel: TransactionPanel) => void
): PeriodSelection => {
  const [pending, setPending] = useState<Option.Option<PeriodChoice>>(Option.none);
  const count = bulkIds(panel).length;

  const apply = (next: PeriodChoice): void => {
    if (next.kind === "date") source.dateFilter.onChange(next.value);
    else if (Option.isSome(source.monthFilter)) source.monthFilter.value.onChange(next.value);
  };

  const request = (next: PeriodChoice): void => {
    const replacesPeriod = Option.exists(source.monthFilter, ({ value }) =>
      next.kind === "month"
        ? next.value !== value
        : next.value !== "" && !next.value.startsWith(`${value}-`)
    );

    const replacesDestination =
      next.kind === "date" &&
      Option.isSome(source.locate) &&
      next.value !== source.dateFilter.value;

    if (count > 0 && (replacesPeriod || replacesDestination)) setPending(Option.some(next));
    else apply(next);
  };

  return {
    props: {
      ...source,
      dateFilter: { ...source.dateFilter, onChange: (value) => request({ kind: "date", value }) },
      monthFilter: Option.map(source.monthFilter, (month) => ({
        ...month,
        onChange: (value: string) => request({ kind: "month", value }),
      })),
    },
    confirmation: (
      <SelectionScopeDialog
        returnFocusId="transaction-type-filter"
        open={Option.isSome(pending)}
        count={count}
        onKeep={() => setPending(Option.none())}
        onDiscard={() => {
          if (Option.isNone(pending)) return;
          onPanel(TransactionPanel.Summary());
          apply(pending.value);
          setPending(Option.none());
        }}
      />
    ),
  };
};

export const TransactionWorkspace = (source: WorkspaceProps): JSX.Element => {
  const [tool, setTool] = useState<FilterTool | "closed">("closed");
  const { panel: activePanel, onPanel } = useWorkspacePanel(source);
  const { props, confirmation } = usePeriodSelection(source, activePanel, onPanel);

  const month = Option.getOrElse(
    Option.map(props.monthFilter, (filter) => filter.value),
    () => "history"
  );

  const { filters: localFilters, change: setFilters } = useTransactionFilters(
    `${props.readOnly ? "privacy" : month}:${props.currentUser.timeZone}`
  );

  const filters = {
    ...localFilters,
    date: props.dateFilter.value,
  };

  const onFilters = (next: WorkspaceFilters): void => {
    setFilters({ search: next.search, direction: next.direction, categoryId: next.categoryId });
    props.dateFilter.onChange(next.date);
  };

  const visible = props.transactions.filter((transaction) =>
    matchesTransactionFilters({ transaction, filters, timeZone: props.currentUser.timeZone })
  );

  const rows = presentTransactionRows({
    transactions: visible,
    categories: props.categories,
    locale: props.currentUser.locale,
    timeZone: props.currentUser.timeZone,
    counterpartyFallback: "Contraparte no identificada",
  });

  const editing = panelEditing(activePanel);

  return (
    <>
      {confirmation}
      <Toaster position="bottom-right" richColors />
      <TransactionSurface panelOpen={editing || Predicate.isTagged(activePanel, "Detail")}>
        <WorkspaceHeader
          disabled={editing || (!props.editable && !props.readOnly)}
          readOnly={props.readOnly}
          onCapture={() => onPanel(TransactionPanel.Capture({ status: "idle" }))}
        />
        {props.queryNotice}
        <CaptureNotice panel={activePanel} onPanel={onPanel} />
        <ContinuationNotice {...props} />
        <WorkspaceContent
          onTool={() => setTool(tool === "closed" ? "category" : "closed")}
          tool={tool}
          props={props}
          panel={activePanel}
          onPanel={onPanel}
          filters={filters}
          onFilters={onFilters}
          visible={visible}
          rows={rows}
        />
      </TransactionSurface>
    </>
  );
};

TransactionWorkspace.preloadInteractions = (): Promise<void> =>
  Promise.all([
    BulkTransactionCorrection.preload?.(),
    TransactionDetail.preload?.(),
    ManualCapturePanel.preload?.(),
  ]).then(() => undefined);
