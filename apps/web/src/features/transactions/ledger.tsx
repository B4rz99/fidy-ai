import {
  type ColumnDef,
  type ReactTable,
  type SortingState,
  columnVisibilityFeature,
  createSortedRowModel,
  flexRender,
  rowSortingFeature,
  sortFn_alphanumeric,
  sortFn_text,
  tableFeatures,
  useTable,
} from "@tanstack/react-table";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@/ui/components/dropdown-menu";
import { Fragment, useCallback, useDeferredValue, useMemo, useRef, useState } from "react";
import type { JSX, RefCallback } from "react";
import { BigDecimal, Option } from "effect";
import { Checkbox } from "@/ui/components/checkbox";
import { Button } from "@/ui/components/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/ui/components/table";
import { cn } from "@/ui/class-names";
import { HugeiconsIcon } from "@hugeicons/react";
import { ArrowDown01Icon, ArrowRight01Icon, PencilIcon } from "@hugeicons/core-free-icons";
import { RecordToolbar } from "@/ui/components/workspace-layout";
import { ChoiceDropdown } from "@/ui/components/choice-dropdown";
import { CategoryVisual } from "@/ui/components/category-visual";
import { DirectionIndicator } from "@/ui/components/icon-indicator";
import { formatMoneyWithCode } from "@/transport/money";
import type { HistoryState } from "./history";
import type { TransactionListRow } from "./presentation";

const features = tableFeatures({
  columnVisibilityFeature,
  rowSortingFeature,
  sortedRowModel: createSortedRowModel(),
  sortFns: { alphanumeric: sortFn_alphanumeric, text: sortFn_text },
});
type LedgerTable = ReactTable<typeof features, TransactionListRow>;
const columns: Array<ColumnDef<typeof features, TransactionListRow>> = [
  { accessorKey: "counterpartyLabel", header: "Contraparte" },
  { accessorKey: "categoryLabel", header: "Categoría" },
  { accessorKey: "transactionTypeLabel", header: "Tipo" },
  { accessorKey: "moneyText", header: "Monto", enableSorting: false },
];
type LedgerProps = Readonly<{
  locate: Option.Option<string>;
  emptyTitle: string;
  continuation: HistoryState["continuation"];
  readOnly: boolean;
  rows: ReadonlyArray<TransactionListRow>;
  selected: Option.Option<string>;
  onSelect: (id: string) => void;
  renderCategory: (row: TransactionListRow, disabled: boolean) => JSX.Element;
  disabled: boolean;
  locale: string;
  toolbar: JSX.Element;
  onEdit: () => void;
  canEdit: boolean;
  selection: Readonly<{
    summary: JSX.Element;
    active: boolean;
    ids: ReadonlyArray<string>;
    onToggle: (id: string) => void;
    onContinue: () => void;
    allSelected: boolean;
    onSelectAll: () => void;
    onClear: () => void;
  }>;
}>;
const transactionAction = (
  row: TransactionListRow,
  selection: LedgerProps["selection"]
): string => {
  if (!selection.active) return "Ver transacción";
  return `${selection.ids.includes(row.id) ? "Deseleccionar" : "Seleccionar"} transacción`;
};
const TransactionIdentity = ({
  row,
  selected,
  onSelect,
  disabled,
  selection,
}: Readonly<{ row: TransactionListRow }> &
  Pick<LedgerProps, "selected" | "onSelect" | "disabled" | "selection">): JSX.Element => (
  <TableCell>
    <div className="flex min-w-0 items-center gap-3">
      {selection.active ? (
        <Checkbox
          aria-label={`Seleccionar ${row.counterpartyLabel}`}
          checked={selection.ids.includes(row.id)}
          disabled={disabled}
          onCheckedChange={() => selection.onToggle(row.id)}
        />
      ) : null}
      <button
        type="button"
        disabled={disabled}
        onClick={() => (selection.active ? selection.onToggle(row.id) : onSelect(row.id))}
        aria-pressed={selection.active ? selection.ids.includes(row.id) : undefined}
        data-transaction-slot="transaction-identity-control"
        aria-expanded={Option.contains(selected, row.id)}
        className="flex w-full min-w-0 items-center gap-3 rounded-md py-1 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
      >
        <span className="sr-only">{transactionAction(row, selection)} </span>
        <span className="transaction-identity-icon">
          <CategoryVisual label={row.categoryLabel} bubble large={false} />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block break-words">{row.counterpartyLabel}</span>
          <span className="transaction-category-inline block break-words text-xs text-muted-foreground">
            {row.categoryLabel}
          </span>
        </span>
      </button>
    </div>
  </TableCell>
);
const TransactionClassification = ({
  row,
  onSelect,
  disabled,
  selection,
  renderCategory,
  canEdit,
}: Readonly<{ row: TransactionListRow }> &
  Pick<
    LedgerProps,
    "onSelect" | "disabled" | "selection" | "renderCategory" | "canEdit"
  >): JSX.Element => (
  <>
    <TableCell className="hidden @min-[600px]/ledger:table-cell">
      {renderCategory(row, disabled || selection.active || !canEdit)}
    </TableCell>
    <TableCell className="hidden @min-[481px]/ledger:table-cell">
      <button
        type="button"
        disabled={disabled}
        onClick={() => (selection.active ? selection.onToggle(row.id) : onSelect(row.id))}
        aria-label={`${row.transactionTypeLabel}; ${transactionAction(row, selection)} ${row.counterpartyLabel}`}
        aria-pressed={selection.active ? selection.ids.includes(row.id) : undefined}
        className="flex w-full items-center gap-2 rounded-md py-1 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
      >
        <DirectionIndicator inflow={row.direction === "inflow"} />
        {row.transactionTypeLabel}
      </button>
    </TableCell>
  </>
);
const useTransactionReveal = (
  locate: Option.Option<string>,
  id: string
): RefCallback<HTMLTableRowElement> => {
  const revealed = useRef(false);
  return useCallback<RefCallback<HTMLTableRowElement>>(
    (node): void => {
      if (node === null || revealed.current || !Option.contains(locate, id)) return;
      node.scrollIntoView({ block: "center", behavior: "instant" });
      revealed.current = true;
    },
    [locate, id]
  );
};
const TransactionAmount = ({
  row,
  disabled,
  selection,
  onSelect,
}: Readonly<{ row: TransactionListRow }> &
  Pick<LedgerProps, "disabled" | "selection" | "onSelect">): JSX.Element => (
  <TableCell className="text-right font-medium tabular-nums">
    <button
      type="button"
      disabled={disabled}
      onClick={() => (selection.active ? selection.onToggle(row.id) : onSelect(row.id))}
      aria-label={`${row.moneyText}, ${row.transactionTypeLabel}; ${transactionAction(row, selection)} ${row.counterpartyLabel}`}
      aria-pressed={selection.active ? selection.ids.includes(row.id) : undefined}
      className="flex w-full items-center justify-end gap-2 rounded-md py-1 outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
    >
      <span className="transaction-amount-direction inline-flex shrink-0 @min-[481px]/ledger:hidden">
        <DirectionIndicator inflow={row.direction === "inflow"} />
      </span>
      <span className="min-w-0 break-words">{row.moneyText}</span>
      <HugeiconsIcon
        icon={ArrowRight01Icon}
        size={16}
        strokeWidth={1.5}
        aria-hidden="true"
        className="shrink-0 text-muted-foreground"
      />
    </button>
  </TableCell>
);
const TransactionRow = ({
  row,
  selected,
  onSelect,
  disabled,
  selection,
  renderCategory,
  canEdit,
  locate,
}: Readonly<{ row: TransactionListRow }> & Omit<LedgerProps, "rows">): JSX.Element => {
  const reveal = useTransactionReveal(locate, row.id);
  return (
    <TableRow
      ref={reveal}
      className="[clip-path:inset(0_round_var(--radius-md))]"
      data-state={
        Option.contains(selected, row.id) || selection.ids.includes(row.id) ? "selected" : "idle"
      }
    >
      <TransactionIdentity
        row={row}
        selected={selected}
        onSelect={onSelect}
        disabled={disabled}
        selection={selection}
      />
      <TransactionClassification
        row={row}
        onSelect={onSelect}
        disabled={disabled}
        selection={selection}
        renderCategory={renderCategory}
        canEdit={canEdit}
      />
      <TransactionAmount row={row} disabled={disabled} selection={selection} onSelect={onSelect} />
    </TableRow>
  );
};
const LedgerHeader = ({
  table,
}: Readonly<{
  table: LedgerTable;
}>): JSX.Element => (
  <TableHeader className="sr-only">
    {table.getHeaderGroups().map((group) => (
      <TableRow key={group.id}>
        {group.headers.map((header) => (
          <TableHead
            key={header.id}
            className={cn(
              header.column.id === "categoryLabel" && "hidden @min-[600px]/ledger:table-cell",
              header.column.id === "transactionTypeLabel" &&
                "hidden @min-[481px]/ledger:table-cell",
              header.column.id === "moneyText" && "text-right"
            )}
          >
            {flexRender(header.column.columnDef.header, header.getContext())}
          </TableHead>
        ))}
      </TableRow>
    ))}
  </TableHeader>
);
const dailyTotals = (
  rows: ReadonlyArray<TransactionListRow>,
  locale: string
): ReadonlyArray<string> =>
  Array.from(new Set(rows.map((row) => row.money.currency))).map((currency) =>
    formatMoneyWithCode({
      locale,
      money: {
        currency,
        amount: BigDecimal.sumAll(
          rows.flatMap((row) => {
            if (row.money.currency !== currency) return [];
            return [
              row.direction === "inflow" ? row.money.amount : BigDecimal.negate(row.money.amount),
            ];
          })
        ),
      },
    })
  );
const sortValue = (sorting: SortingState): string =>
  Option.fromNullishOr(sorting[0]).pipe(
    Option.map((sort) => `${sort.id}:${sort.desc ? "desc" : "asc"}`),
    Option.getOrElse(() => "default")
  );
const ColumnControls = ({
  table,
  disabled,
}: Readonly<{ table: LedgerTable; disabled: boolean }>): JSX.Element => (
  <DropdownMenu>
    <DropdownMenuTrigger render={<Button variant="outline" disabled={disabled} />}>
      Columnas
      <HugeiconsIcon
        icon={ArrowDown01Icon}
        strokeWidth={1.5}
        data-icon="inline-end"
        aria-hidden="true"
      />
    </DropdownMenuTrigger>
    <DropdownMenuContent align="end">
      {table.getAllLeafColumns().flatMap((column) => {
        if (column.id !== "categoryLabel" && column.id !== "transactionTypeLabel") return [];
        return [
          <DropdownMenuCheckboxItem
            key={column.id}
            checked={column.getIsVisible()}
            disabled={disabled}
            closeOnClick={false}
            onCheckedChange={(checked) => column.toggleVisibility(checked)}
          >
            {column.id === "categoryLabel" ? "Categoría" : "Tipo"}
          </DropdownMenuCheckboxItem>,
        ];
      })}
    </DropdownMenuContent>
  </DropdownMenu>
);
const sortOptions = [
  { value: "default", label: "Ordenar" },
  { value: "counterpartyLabel:asc", label: "Contraparte A–Z" },
  { value: "counterpartyLabel:desc", label: "Contraparte Z–A" },
  { value: "categoryLabel:asc", label: "Categoría A–Z" },
];
const SortControl = ({
  sorting,
  onSorting,
  disabled,
}: Readonly<{
  sorting: SortingState;
  onSorting: (sorting: SortingState) => void;
  disabled: boolean;
}>): JSX.Element => (
  <ChoiceDropdown
    triggerLabel={Option.none()}
    id="transaction-sort"
    label="Ordenar transacciones"
    width="auto"
    leading={null}
    disabled={disabled}
    value={sortValue(sorting)}
    options={sortOptions}
    onChange={(value) => {
      const [id, order] = value.split(":");
      onSorting(id !== undefined && id !== "default" ? [{ id, desc: order === "desc" }] : []);
    }}
  />
);
const LedgerControls = ({
  table,
  sorting,
  onSorting,
  disabled,
  toolbar,
  onEdit,
  empty,
  selecting,
  readOnly,
}: Readonly<{
  readOnly: boolean;
  table: LedgerTable;
  sorting: SortingState;
  onSorting: (sorting: SortingState) => void;
  disabled: boolean;
  toolbar: JSX.Element;
  onEdit: () => void;
  empty: boolean;
  selecting: boolean;
}>): JSX.Element => (
  <RecordToolbar>
    {toolbar}
    <div className="ledger-actions contents">
      {readOnly ? null : (
        <Button variant="outline" disabled={disabled || (empty && !selecting)} onClick={onEdit}>
          <HugeiconsIcon icon={PencilIcon} size={16} strokeWidth={1.5} aria-hidden="true" />
          {selecting ? "Cancelar selección" : "Editar varias"}
        </Button>
      )}
      <SortControl sorting={sorting} onSorting={onSorting} disabled={disabled} />
      <ColumnControls table={table} disabled={disabled} />
    </div>
  </RecordToolbar>
);
const fallbackInitialRows = 32;
const estimatedRowHeightPixels = 72;
type LedgerRows = ReturnType<LedgerTable["getRowModel"]>["rows"];
const useInitialViewportRows = (
  sortedRows: LedgerRows
): Readonly<{
  visible: LedgerRows;
  measure: RefCallback<HTMLTableSectionElement>;
}> => {
  const [initial] = useState(() => ({
    all: sortedRows,
    visible: sortedRows.slice(
      0,
      typeof window === "undefined"
        ? fallbackInitialRows
        : Math.ceil(window.innerHeight / estimatedRowHeightPixels)
    ),
  }));
  const [count, setCount] = useState(initial.visible.length);
  const deferred = useDeferredValue(sortedRows, initial.visible);
  const preparing = sortedRows === initial.all && deferred === initial.visible;
  const measure = useCallback<RefCallback<HTMLTableSectionElement>>(
    (node): void => {
      if (
        node === null ||
        !preparing ||
        count >= sortedRows.length ||
        node.getClientRects().length === 0
      ) {
        return;
      }
      const shortfall = window.innerHeight - node.getBoundingClientRect().bottom;
      if (shortfall <= 0) return;
      const heights = [...node.querySelectorAll<HTMLElement>("tr[data-state]")].flatMap((row) => {
        const height = row.getBoundingClientRect().height;
        return height > 0 ? [height] : [];
      });
      if (heights.length === 0) return;
      // A commit ref fills any estimate shortfall before paint; no viewport information is skipped.
      setCount(Math.min(sortedRows.length, count + Math.ceil(shortfall / Math.min(...heights))));
    },
    [preparing, count, sortedRows.length]
  );
  // Only initial offscreen work yields. Filters and authoritative revisions always render now.
  return { visible: preparing ? sortedRows.slice(0, count) : sortedRows, measure };
};
const LedgerBody = ({
  dates,
  rows,
  sortedRows,
  locale,
  rowProps,
}: Readonly<{
  dates: ReadonlyArray<string>;
  rows: ReadonlyArray<TransactionListRow>;
  sortedRows: ReturnType<LedgerTable["getRowModel"]>["rows"];
  locale: string;
  rowProps: Omit<LedgerProps, "rows">;
}>): JSX.Element => {
  const { visible, measure } = useInitialViewportRows(sortedRows);
  const visibleDates = dates.filter((date) =>
    visible.some((item) => item.original.occurredOnText === date)
  );
  return (
    <TableBody ref={measure}>
      {visibleDates.map((date) => (
        <Fragment key={date}>
          <TableRow data-date-group="true">
            <TableCell colSpan={4}>
              <div className="flex flex-wrap items-center justify-between gap-4 rounded-md bg-muted px-3 py-2 text-sm text-muted-foreground">
                <span>{rows.find((row) => row.occurredOnText === date)?.dateLabel}</span>
                <ul
                  aria-label="Totales del día por moneda"
                  className="flex flex-wrap gap-x-4 gap-y-1 tabular-nums"
                >
                  {dailyTotals(
                    rows.filter((row) => row.occurredOnText === date),
                    locale
                  ).map((total) => (
                    <li key={total} className="whitespace-nowrap">
                      {total}
                    </li>
                  ))}
                </ul>
              </div>
            </TableCell>
          </TableRow>
          {visible.flatMap((item) =>
            item.original.occurredOnText === date
              ? [<TransactionRow key={item.id} row={item.original} {...rowProps} />]
              : []
          )}
        </Fragment>
      ))}
    </TableBody>
  );
};
const emptyDescription = (partial: boolean, readOnly: boolean): string => {
  if (partial) return "Carga más transacciones para buscar en el resto del periodo.";
  return readOnly
    ? "Prueba otros filtros para consultar tus transacciones guardadas."
    : "Prueba otros filtros o registra una transacción.";
};
const EmptyLedger = ({
  partial,
  readOnly,
  title,
}: Readonly<{ partial: boolean; readOnly: boolean; title: string }>): JSX.Element => (
  <div className="p-8">
    <h2 className="font-medium">
      {partial ? "No hay coincidencias entre las transacciones cargadas" : title}
    </h2>
    <p className="mt-2 text-sm text-muted-foreground">{emptyDescription(partial, readOnly)}</p>
  </div>
);
const SelectionBar = ({
  selection,
  disabled,
}: Pick<LedgerProps, "selection" | "disabled">): JSX.Element => (
  <>
    {selection.active ? (
      <div data-transaction-slot="transaction-selection-bar">
        <div className="flex min-w-0 basis-full flex-wrap items-center gap-2 @min-[600px]/ledger:flex-1 @min-[600px]/ledger:basis-auto">
          {selection.summary}
          <Button
            variant="outline"
            disabled={disabled || selection.allSelected}
            onClick={selection.onSelectAll}
          >
            Seleccionar todas
          </Button>
          <Button
            variant="ghost"
            disabled={disabled || selection.ids.length === 0}
            onClick={selection.onClear}
          >
            Limpiar selección
          </Button>
        </div>
        <Button
          variant="outline"
          aria-label="Editar selección de transacciones"
          disabled={disabled || selection.ids.length === 0}
          onClick={selection.onContinue}
        >
          Editar selección
        </Button>
        <p className="basis-full text-xs text-muted-foreground">
          Seleccionar todas incluye las transacciones cargadas que coinciden con tus filtros.
        </p>
      </div>
    ) : null}
  </>
);
const LedgerContents = ({
  rows,
  table,
  ...props
}: LedgerProps & Readonly<{ table: LedgerTable }>): JSX.Element => {
  const sortedRows = table.getRowModel().rows;
  const dates = Array.from(new Set(rows.map((row) => row.occurredOnText)));
  return (
    <>
      {rows.length === 0 ? (
        <>
          <EmptyLedger
            title={props.emptyTitle}
            partial={props.continuation !== "complete"}
            readOnly={props.readOnly}
          />
        </>
      ) : (
        <Table aria-label="Tabla de transacciones">
          <LedgerHeader table={table} />
          <LedgerBody
            dates={dates}
            rows={rows}
            sortedRows={sortedRows}
            locale={props.locale}
            rowProps={props}
          />
        </Table>
      )}
      {props.continuation === "loading" ? (
        <output className="sr-only" aria-label="Cargando transacciones" aria-busy="true">
          Cargando transacciones
        </output>
      ) : null}
    </>
  );
};
/** A date-grouped ledger; sorting preserves dates as the primary grouping key. */
export const TransactionLedger = ({ rows, ...props }: LedgerProps): JSX.Element => {
  const [visibility, setVisibility] = useState({});
  const [sorting, onSortingChange] = useState<SortingState>([]);
  const data = useMemo(() => Array.from(rows), [rows]);
  const table = useTable({
    features,
    data,
    columns,
    state: { sorting, columnVisibility: visibility },
    onColumnVisibilityChange: setVisibility,
    onSortingChange,
    getRowId: (row) => row.id,
  });
  return (
    <section
      aria-label={props.readOnly ? "Transacciones guardadas" : "Transacciones del mes"}
      className="transaction-ledger min-w-0"
      data-category-visible={table.getColumn("categoryLabel")?.getIsVisible()}
      data-type-visible={table.getColumn("transactionTypeLabel")?.getIsVisible()}
    >
      <LedgerControls
        table={table}
        sorting={sorting}
        onSorting={onSortingChange}
        disabled={props.disabled}
        toolbar={props.toolbar}
        onEdit={props.onEdit}
        empty={rows.length === 0 || !props.canEdit}
        selecting={props.selection.active}
        readOnly={props.readOnly}
      />
      <SelectionBar selection={props.selection} disabled={props.disabled} />
      <LedgerContents {...props} rows={rows} table={table} />
    </section>
  );
};
