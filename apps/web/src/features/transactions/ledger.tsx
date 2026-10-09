import {
  type ColumnDef,
  type Table as ReactTable,
  type SortingState,
  flexRender,
  getCoreRowModel,
  getSortedRowModel,
  useReactTable,
} from "@tanstack/react-table";
import { Fragment, useState } from "react";
import type { JSX } from "react";
import { Option } from "effect";
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
import type { TransactionListRow } from "./presentation";

const columns: ReadonlyArray<ColumnDef<TransactionListRow>> = [
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
        <span
          aria-hidden="true"
          className="flex size-8 shrink-0 items-center justify-center rounded-full bg-muted text-xs font-medium"
        >
          {row.counterpartyLabel.slice(0, 2).toLocaleUpperCase("es-CO")}
        </span>
        <span className="min-w-0">
          <span className="block truncate">{row.counterpartyLabel}</span>
          <span className="block truncate text-xs text-muted-foreground lg:hidden">
            {row.categoryLabel}
          </span>
        </span>
      </button>
    </TableCell>
    <TableCell className="hidden lg:table-cell">{row.categoryLabel}</TableCell>
    <TableCell className="hidden md:table-cell">{row.transactionTypeLabel}</TableCell>
    <TableCell className="text-right font-medium tabular-nums">
      {row.direction === "inflow" ? "+" : "−"}
      {row.moneyText}
    </TableCell>
  </TableRow>
);
const sortingIndicator = (sort: false | "asc" | "desc"): string => {
  if (sort === false) return "";
  return sort === "asc" ? " ↑" : " ↓";
};
const LedgerHeader = ({
  table,
  disabled,
}: Readonly<{
  table: ReactTable<TransactionListRow>;
  disabled: boolean;
}>): JSX.Element => (
  <TableHeader>
    {table.getHeaderGroups().map((group) => (
      <TableRow key={group.id}>
        {group.headers.map((header) => (
          <TableHead
            key={header.id}
            className={cn(
              header.column.id === "categoryLabel" && "hidden lg:table-cell",
              header.column.id === "transactionTypeLabel" && "hidden md:table-cell",
              header.column.id === "moneyText" && "text-right"
            )}
          >
            {header.column.getCanSort() ? (
              <Button
                variant="ghost"
                size="sm"
                disabled={disabled}
                onClick={header.column.getToggleSortingHandler()}
              >
                {flexRender(header.column.columnDef.header, header.getContext())}
                {sortingIndicator(header.column.getIsSorted())}
              </Button>
            ) : (
              flexRender(header.column.columnDef.header, header.getContext())
            )}
          </TableHead>
        ))}
      </TableRow>
    ))}
  </TableHeader>
);
/** A date-grouped ledger; sorting preserves dates as the primary grouping key. */
export const TransactionLedger = ({ rows, ...props }: LedgerProps): JSX.Element => {
  const [sorting, onSortingChange] = useState<SortingState>([]);
  const table = useReactTable({
    data: Array.from(rows),
    columns: Array.from(columns),
    state: { sorting },
    onSortingChange,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getRowId: (row) => row.id,
  });
  const sortedRows = table.getRowModel().rows;
  const dates = Array.from(new Set(rows.map((row) => row.occurredOnText)));
  return (
    <section aria-label="Transacciones del mes" className="min-w-0">
      {rows.length === 0 ? (
        <div className="p-8">
          <h2 className="font-medium">No hay transacciones para mostrar</h2>
          <p className="mt-2 text-sm text-muted-foreground">
            Prueba otros filtros o registra una transacción.
          </p>
        </div>
      ) : (
        <Table aria-label="Tabla de transacciones">
          <LedgerHeader table={table} disabled={props.disabled} />
          <TableBody>
            {dates.map((date) => (
              <Fragment key={date}>
                <TableRow>
                  <TableCell colSpan={4}>
                    <span className="text-sm font-medium text-muted-foreground">{date}</span>
                  </TableCell>
                </TableRow>
                {sortedRows
                  .filter((item) => item.original.occurredOnText === date)
                  .map((item) => (
                    <TransactionRow key={item.id} row={item.original} {...props} />
                  ))}
              </Fragment>
            ))}
          </TableBody>
        </Table>
      )}
    </section>
  );
};
