# React Table

Fidy uses `@tanstack/react-table` **9.3.1** for the transaction ledger. Use the
integrity-locked published `dist` exports and declarations in that package and
`@tanstack/table-core` 9.3.1 as API authority.

## Features and state

Define `tableFeatures` at module scope and pass it to `useTable`. Register only
needed optional features: the ledger uses column visibility and row sorting,
with `sortedRowModel: createSortedRowModel()`. Core rows and headers are included
by the adapter. Table and column types carry both the feature map and row type:
`ReactTable<typeof features, TransactionListRow>` and
`ColumnDef<typeof features, TransactionListRow>`.

The supported public API replaces v8's `useReactTable`, row-model options, and
single-parameter table types. Do not introduce the `/legacy` adapter for new
application code.

Keep controlled sorting and visibility with their existing React owner. Pair
`state.sorting` / `state.columnVisibility` with the matching change callbacks.
The adapter subscribes to its selected state; read `table.state` rather than
using `table.store.state` as a render subscription.

## Sorting and identity

Register both `sortFn_text` and `sortFn_alphanumeric` in the feature map's
`sortFns` registry. Automatic sorting samples values and chooses text for ordinary
labels and alphanumeric for labels containing numbers. Missing registrations can
fall back to basic comparison, changing case and natural-number ordering.

Keep `getRowId: row => row.id` so reordering retains transaction identity.
The ledger preserves date groups independently of the sorted row model and owns
bulk selection outside the table. Browser coverage verifies natural sorting,
day grouping, column visibility, and retained selection through reordering.

## Source references

Published 9.3.1 package paths:

- React adapter: `dist/useTable.d.ts` and `dist/useTable.js`.
- Core feature registration: `dist/helpers/tableFeatures.d.ts`.
- Sorting registration and fallback: `dist/features/row-sorting/createSortedRowModel.d.ts`
  and `dist/features/row-sorting/rowSortingFeature.utils.js`.
- Controlled visibility: `dist/features/column-visibility/columnVisibilityFeature.types.d.ts`.
