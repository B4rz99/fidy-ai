import { TransactionSkeletonRows } from "@/ui/components/transaction-loading";
import {
  type ColumnDef,
  type Table as ReactTable,
  type SortingState,
  flexRender,
  getCoreRowModel,
  getSortedRowModel,
  useReactTable,
} from "@tanstack/react-table";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@/ui/components/dropdown-menu";
import { Fragment, useCallback, useDeferredValue, useMemo, useState } from "react";
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
import { formatMoney } from "@/transport/money";
import type { HistoryState } from "./history";
import type { TransactionListRow } from "./presentation";

const columns: Array<ColumnDef<TransactionListRow>> = [
  { accessorKey: "counterpartyLabel", header: "Contraparte" },
  { accessorKey: "categoryLabel", header: "Categoría" },
  { accessorKey: "transactionTypeLabel", header: "Tipo" },
  { accessorKey: "moneyText", header: "Monto", enableSorting: false },
];
type LedgerProps = Readonly<{
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
    active: boolean;
    ids: ReadonlyArray<string>;
    onToggle: (id: string) => void;
    onContinue: () => void;
    limit: number;
  }>;
}>;
const TransactionIdentity = ({
  row,
  selected,
  onSelect,
  disabled,
  selection,
}: Readonly<{ row: TransactionListRow }> &
  Pick<LedgerProps, "selected" | "onSelect" | "disabled" | "selection">): JSX.Element => {
  const atLimit = selection.ids.length >= selection.limit && !selection.ids.includes(row.id);
  return (
    <TableCell>
      <div className="flex min-w-0 items-center gap-3">
        {selection.active ? (
          <Checkbox
            aria-label={`Seleccionar ${row.counterpartyLabel}`}
            checked={selection.ids.includes(row.id)}
            disabled={disabled || atLimit}
            onCheckedChange={() => selection.onToggle(row.id)}
          />
        ) : null}
        <button
          type="button"
          disabled={disabled || (selection.active && atLimit)}
          onClick={() => (selection.active ? selection.onToggle(row.id) : onSelect(row.id))}
          aria-label={`Ver transacción ${row.counterpartyLabel}`}
          aria-expanded={Option.contains(selected, row.id)}
          className="flex w-full min-w-0 items-center gap-3 rounded-md py-1 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
        >
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
};
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
        disabled={
          disabled ||
          (selection.active &&
            selection.ids.length >= selection.limit &&
            !selection.ids.includes(row.id))
        }
        onClick={() => (selection.active ? selection.onToggle(row.id) : onSelect(row.id))}
        aria-label={`Ver tipo de ${row.counterpartyLabel}`}
        className="flex w-full items-center gap-2 rounded-md py-1 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
      >
        <DirectionIndicator inflow={row.direction === "inflow"} />
        {row.transactionTypeLabel}
      </button>
    </TableCell>
  </>
);
const TransactionRow = ({
  row,
  selected,
  onSelect,
  disabled,
  selection,
  renderCategory,
  canEdit,
}: Readonly<{ row: TransactionListRow }> & Omit<LedgerProps, "rows">): JSX.Element => (
  <TableRow
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
    <TableCell className="text-right font-medium tabular-nums">
      <button
        type="button"
        disabled={
          disabled ||
          (selection.active &&
            selection.ids.length >= selection.limit &&
            !selection.ids.includes(row.id))
        }
        onClick={() => (selection.active ? selection.onToggle(row.id) : onSelect(row.id))}
        aria-label={`Ver monto de ${row.counterpartyLabel}`}
        title={row.transactionTypeLabel}
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
  </TableRow>
);
const LedgerHeader = ({
  table,
}: Readonly<{
  table: ReactTable<TransactionListRow>;
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
const dailyTotals = (rows: ReadonlyArray<TransactionListRow>, locale: string): string =>
  Array.from(new Set(rows.map((row) => row.money.currency)))
    .map((currency) =>
      formatMoney({
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
    )
    .join(" · ");
const sortValue = (sorting: SortingState): string =>
  Option.fromNullishOr(sorting[0]).pipe(
    Option.map((sort) => `${sort.id}:${sort.desc ? "desc" : "asc"}`),
    Option.getOrElse(() => "default")
  );
const ColumnControls = ({
  table,
  disabled,
}: Readonly<{ table: ReactTable<TransactionListRow>; disabled: boolean }>): JSX.Element => (
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
  table: ReactTable<TransactionListRow>;
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
        <Button variant="outline" disabled={disabled || empty} onClick={onEdit}>
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
type LedgerRows = ReturnType<ReactTable<TransactionListRow>["getRowModel"]>["rows"];
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
  sortedRows: ReturnType<ReactTable<TransactionListRow>["getRowModel"]>["rows"];
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
              <div className="flex items-center justify-between gap-4 rounded-md bg-muted px-3 py-2 text-sm text-muted-foreground">
                <span>{rows.find((row) => row.occurredOnText === date)?.dateLabel}</span>
                <span className="tabular-nums">
                  {dailyTotals(
                    rows.filter((row) => row.occurredOnText === date),
                    locale
                  )}
                </span>
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
      {rowProps.continuation === "loading" ? (
        <TransactionSkeletonRows phase="continuation" />
      ) : null}
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
}: Readonly<{ partial: boolean; readOnly: boolean }>): JSX.Element => (
  <div className="p-8">
    <h2 className="font-medium">
      {partial
        ? "No hay coincidencias entre las transacciones cargadas"
        : "No hay transacciones para mostrar"}
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
        <span aria-live="polite">{selection.ids.length} seleccionadas</span>
        <Button
          variant="outline"
          aria-label="Editar selección de transacciones"
          disabled={disabled || selection.ids.length === 0}
          onClick={selection.onContinue}
        >
          Editar selección
        </Button>
      </div>
    ) : null}
  </>
);
const LedgerContents = ({
  rows,
  table,
  ...props
}: LedgerProps & Readonly<{ table: ReactTable<TransactionListRow> }>): JSX.Element => {
  const sortedRows = table.getRowModel().rows;
  const dates = Array.from(new Set(rows.map((row) => row.occurredOnText)));
  return (
    <>
      {rows.length === 0 ? (
        <>
          <EmptyLedger partial={props.continuation !== "complete"} readOnly={props.readOnly} />
          {props.continuation === "loading" ? (
            <Table>
              <TableBody>
                <TransactionSkeletonRows phase="initial" />
              </TableBody>
            </Table>
          ) : null}
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
  const table = useReactTable({
    data,
    columns,
    autoResetPageIndex: false,
    state: { sorting, columnVisibility: visibility },
    onColumnVisibilityChange: setVisibility,
    onSortingChange,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
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
