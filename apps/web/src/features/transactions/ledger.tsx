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
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/ui/components/dropdown-menu";
import { Fragment, useMemo, useState } from "react";
import type { JSX } from "react";
import { BigDecimal, Option } from "effect";
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
import { ArrowRight01Icon } from "@hugeicons/core-free-icons";
import { CategoryVisual, DirectionVisual } from "./visuals";
import { formatMoney } from "@/ui/money";
import type { TransactionListRow } from "./presentation";

const columns: Array<ColumnDef<TransactionListRow>> = [
  { accessorKey: "counterpartyLabel", header: "Contraparte" },
  { accessorKey: "categoryLabel", header: "Categoría" },
  { accessorKey: "transactionTypeLabel", header: "Tipo" },
  { accessorKey: "moneyText", header: "Monto", enableSorting: false },
];
type LedgerProps = Readonly<{
  rows: ReadonlyArray<TransactionListRow>;
  selected: Option.Option<string>;
  onSelect: (id: string) => void;
  disabled: boolean;
  locale: string;
  toolbar: JSX.Element;
  onEdit: () => void;
  canEdit: boolean;
}>;
const TransactionRow = ({
  row,
  selected,
  onSelect,
  disabled,
}: Readonly<{ row: TransactionListRow }> & Omit<LedgerProps, "rows">): JSX.Element => (
  <TableRow data-state={Option.contains(selected, row.id) ? "selected" : "idle"}>
    <TableCell>
      <button
        type="button"
        disabled={disabled}
        onClick={() => onSelect(row.id)}
        aria-label={`Ver transacción ${row.counterpartyLabel}`}
        aria-expanded={Option.contains(selected, row.id)}
        className="flex w-full min-w-0 items-center gap-3 rounded-md py-1 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
      >
        <CategoryVisual label={row.categoryLabel} bubble large={false} />
        <span className="w-0 min-w-0 flex-1">
          <span className="block truncate">{row.counterpartyLabel}</span>
          <span className="transaction-category-inline block truncate text-xs text-muted-foreground">
            {row.categoryLabel}
          </span>
        </span>
      </button>
    </TableCell>
    <TableCell className="hidden @min-[800px]/ledger:table-cell">
      <span className="flex items-center gap-4">
        <CategoryVisual label={row.categoryLabel} bubble={false} large={false} />
        <span className="truncate">{row.categoryLabel}</span>
      </span>
    </TableCell>
    <TableCell className="hidden @min-[640px]/ledger:table-cell">
      <span className="flex items-center gap-4">
        <DirectionVisual inflow={row.direction === "inflow"} />
        {row.transactionTypeLabel}
      </span>
    </TableCell>
    <TableCell className="text-right font-medium tabular-nums">
      <span className="flex items-center justify-end gap-2">
        <span className="min-w-0 break-words">{row.moneyText}</span>
        <HugeiconsIcon
          icon={ArrowRight01Icon}
          size={16}
          strokeWidth={1.5}
          aria-hidden="true"
          className="shrink-0 text-muted-foreground"
        />
      </span>
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
              header.column.id === "categoryLabel" && "hidden @min-[800px]/ledger:table-cell",
              header.column.id === "transactionTypeLabel" &&
                "hidden @min-[640px]/ledger:table-cell",
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
            rows
              .filter((row) => row.money.currency === currency)
              .map((row) =>
                row.direction === "inflow" ? row.money.amount : BigDecimal.negate(row.money.amount)
              )
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
    </DropdownMenuTrigger>
    <DropdownMenuContent align="end">
      {table
        .getAllLeafColumns()
        .filter((column) => column.id === "categoryLabel" || column.id === "transactionTypeLabel")
        .map((column) => (
          <DropdownMenuCheckboxItem
            key={column.id}
            checked={column.getIsVisible()}
            disabled={disabled}
            closeOnClick={false}
            onCheckedChange={(checked) => column.toggleVisibility(checked)}
          >
            {column.id === "categoryLabel" ? "Categoría" : "Tipo"}
          </DropdownMenuCheckboxItem>
        ))}
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
  <DropdownMenu>
    <DropdownMenuTrigger
      render={<Button variant="outline" disabled={disabled} />}
      aria-label="Ordenar transacciones"
    >
      {sortOptions.find((option) => option.value === sortValue(sorting))?.label ?? "Ordenar"}
    </DropdownMenuTrigger>
    <DropdownMenuContent align="end" className="min-w-56">
      <DropdownMenuRadioGroup
        value={sortValue(sorting)}
        onValueChange={(value: unknown) => {
          if (typeof value !== "string") return;
          const [id, order] = value.split(":");
          onSorting(id !== undefined && id !== "default" ? [{ id, desc: order === "desc" }] : []);
        }}
      >
        {sortOptions.map((option) => (
          <DropdownMenuRadioItem key={option.value} value={option.value} closeOnClick>
            {option.label}
          </DropdownMenuRadioItem>
        ))}
      </DropdownMenuRadioGroup>
    </DropdownMenuContent>
  </DropdownMenu>
);
const LedgerControls = ({
  table,
  sorting,
  onSorting,
  disabled,
  toolbar,
  onEdit,
  empty,
}: Readonly<{
  table: ReactTable<TransactionListRow>;
  sorting: SortingState;
  onSorting: (sorting: SortingState) => void;
  disabled: boolean;
  toolbar: JSX.Element;
  onEdit: () => void;
  empty: boolean;
}>): JSX.Element => (
  <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
    {toolbar}
    <div className="flex flex-wrap items-center gap-3">
      <Button variant="outline" disabled={disabled || empty} onClick={onEdit}>
        Editar
      </Button>
      <SortControl sorting={sorting} onSorting={onSorting} disabled={disabled} />
      <ColumnControls table={table} disabled={disabled} />
    </div>
  </div>
);
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
}>): JSX.Element => (
  <TableBody>
    {dates.map((date) => (
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
        {sortedRows
          .filter((item) => item.original.occurredOnText === date)
          .map((item) => (
            <TransactionRow key={item.id} row={item.original} {...rowProps} />
          ))}
      </Fragment>
    ))}
  </TableBody>
);
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
  const sortedRows = table.getRowModel().rows;
  const dates = Array.from(new Set(rows.map((row) => row.occurredOnText)));
  return (
    <section
      aria-label="Transacciones del mes"
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
      />
      {rows.length === 0 ? (
        <div className="p-8">
          <h2 className="font-medium">No hay transacciones para mostrar</h2>
          <p className="mt-2 text-sm text-muted-foreground">
            Prueba otros filtros o registra una transacción.
          </p>
        </div>
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
    </section>
  );
};
