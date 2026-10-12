import { type VariantProps, cva } from "class-variance-authority";
import * as React from "react";
import { cn } from "@/ui/class-names";

type TableProps = React.ComponentProps<"table">;
type TableSectionProps = React.ComponentProps<"thead">;
type TableBodyProps = React.ComponentProps<"tbody">;
type TableFooterProps = React.ComponentProps<"tfoot">;
type TableRowProps = React.ComponentProps<"tr">;
type TableHeadProps = React.ComponentProps<"th"> & VariantProps<typeof tableHeadVariants>;
type TableCellProps = React.ComponentProps<"td"> & VariantProps<typeof tableCellVariants>;
type TableCaptionProps = React.ComponentProps<"caption">;

const Table = ({ className, ...props }: TableProps): React.JSX.Element => (
  <div data-slot="table-container" className="relative w-full overflow-x-auto">
    <table
      data-slot="table"
      className={cn("w-full caption-bottom text-sm", className)}
      {...props}
    />
  </div>
);

const TableHeader = ({ className, ...props }: TableSectionProps): React.JSX.Element => (
  <thead data-slot="table-header" className={cn("[&_tr]:border-b", className)} {...props} />
);

const TableBody = ({ className, ...props }: TableBodyProps): React.JSX.Element => (
  <tbody
    data-slot="table-body"
    className={cn("[&_tr:last-child]:border-0", className)}
    {...props}
  />
);

const TableFooter = ({ className, ...props }: TableFooterProps): React.JSX.Element => (
  <tfoot
    data-slot="table-footer"
    className={cn("border-t bg-muted/50 font-medium [&>tr]:last:border-b-0", className)}
    {...props}
  />
);

const TableRow = ({ className, ...props }: TableRowProps): React.JSX.Element => (
  <tr
    data-slot="table-row"
    className={cn(
      "border-b transition-colors hover:bg-muted/50 has-aria-expanded:bg-muted/50 data-[state=selected]:bg-muted",
      className
    )}
    {...props}
  />
);

const tableHeadVariants = cva(
  "h-11 text-left align-middle font-medium whitespace-nowrap text-foreground [&:has([role=checkbox])]:pr-0",
  {
    variants: { density: { default: "px-4", compact: "px-2 text-sm" } },
    defaultVariants: { density: "default" },
  }
);

const tableCellVariants = cva("align-middle [&:has([role=checkbox])]:pr-0", {
  variants: {
    density: { default: "px-4 py-4 text-base", compact: "px-2 py-3 text-sm" },
  },
  defaultVariants: { density: "default" },
});

const TableHead = ({ className, density, ...props }: TableHeadProps): React.JSX.Element => (
  <th data-slot="table-head" className={cn(tableHeadVariants({ density }), className)} {...props} />
);

const TableCell = ({ className, density, ...props }: TableCellProps): React.JSX.Element => (
  <td data-slot="table-cell" className={cn(tableCellVariants({ density }), className)} {...props} />
);

const TableCaption = ({ className, ...props }: TableCaptionProps): React.JSX.Element => (
  <caption
    data-slot="table-caption"
    className={cn("mt-4 text-sm text-muted-foreground", className)}
    {...props}
  />
);

export { Table, TableBody, TableCaption, TableCell, TableFooter, TableHead, TableHeader, TableRow };
