# TanStack Table

How TanStack Table v9 works, read from the checked-out main source. The subtree currently
identifies itself as v9.1.2 (`.repos/table/packages/react-table/package.json:1-4`). When the
installed package trails the subtree, compile against the installed package types and verify that
a referenced API exists in that version. Citations are relative to `.repos/table/`.

## Adoption threshold

TanStack Table is a headless row-model and table-state engine. It earns its place when a table
needs behavior such as sorting, filtering, pagination, column visibility, selection, or grouping.
A fixed set of rows and columns can remain semantic table markup; adding a state engine before it
hides meaningful complexity only adds another interface.

V9 differs substantially from v8. Use the v9 source and installed types rather than recalling
`useReactTable` or `getCoreRowModel` setup from v8.

## V9 construction

V9 makes features explicit. Define a `tableFeatures(...)` object statically outside the component.
It carries feature modules, row-model factories, function registries, and typed metadata; the
source explicitly recommends static definition
(`packages/table-core/src/helpers/tableFeatures.ts:6-49`). A plain table starts with
`tableFeatures({})`. Add only the feature modules and row-model factories needed for the selected
behavior.

Create typed columns from both the feature type and row type. `createColumnHelper` infers cell
values from accessor keys and functions; `display`, `group`, and `columns` preserve their
corresponding definition types. At runtime the helper only constructs column-definition objects
(`packages/table-core/src/helpers/columnHelper.ts:80-121`). Give accessor functions an explicit
`id`; key accessors derive one from the key, as the upstream basic example demonstrates
(`examples/react/basic-use-table/src/main.tsx:63-94`).

Keep feature and column definitions static unless they genuinely depend on render state. Keep
`data` referentially stable: the core row model memo depends directly on `table.options.data`
(`packages/table-core/src/core/row-models/createCoreRowModel.ts:19-35`). When data may be absent,
reuse a stable empty-array fallback instead of allocating one during every render.

Create the instance with `useTable({ features, columns, data }, selector?)`. It constructs the
underlying table once, updates options during later renders, and shallow-subscribes React to the
selected state (`packages/react-table/src/useTable.ts:149-225`). Omit the selector to subscribe to
all feature state, or select only the slices rendered by that component. `table.Subscribe` can
localize subscriptions lower in the tree when measured rendering behavior warrants it
(`packages/react-table/src/useTable.ts:35-65`,
`packages/react-table/src/useTable.ts:126-147`).

## Identity and rendering

Provide `getRowId` when rows have a stable domain identifier. Index IDs are the fallback, but the
upstream contract recommends a stable server or database ID when rows participate in network
operations (`packages/table-core/src/core/rows/coreRowsFeature.types.ts:107-119`). Stable IDs keep
selection and row-local state attached to the same row when ordering changes.

Render semantic table markup from the model:

- headers from `table.getHeaderGroups()`;
- rows from `table.getRowModel().rows`;
- cells from `row.getAllCells()` for fixed columns or `row.getVisibleCells()` when visibility is a
  feature;
- header, cell, and footer content through `table.FlexRender`.

The upstream basic v9 example shows the complete header, row, and footer traversal
(`examples/react/basic-use-table/src/main.tsx:118-159`), and the visibility example switches to
`getVisibleCells()` (`examples/react/column-visibility/src/main.tsx:129-145`). Table is headless:
the application still owns semantic markup, accessibility, empty states, responsive behavior,
and styling.

## Client-side behavior

A feature module adds state and APIs; a row-model factory performs client-side data processing.
For example, client sorting registers `rowSortingFeature`,
`sortedRowModel: createSortedRowModel()`, and only the sort functions used by columns. The sorted
model memoizes on sorting state and the pre-sorted model
(`packages/table-core/src/features/row-sorting/createSortedRowModel.ts:13-46`). Pagination
similarly slices the pre-paginated rows from pagination state
(`packages/table-core/src/features/row-pagination/createPaginatedRowModel.ts:13-58`).

Control a state slice only when something outside Table needs to own it. Pair each controlled
state value with its corresponding `on*Change` callback. The upstream external-state example
shows these pairs (`examples/react/basic-external-state/src/main.tsx:67-105`). Do not pass a change
callback without feeding the resulting value back, and do not mirror internal state merely to
observe it; select it from `table.state` instead.

## Server-side behavior

When a server owns sorting, filtering, or pagination:

1. Own that state outside Table.
2. Include every state coordinate in the request identity.
3. Fetch already processed rows from the request boundary.
4. Pass the rows and available count metadata to Table.
5. Enable the corresponding manual mode.
6. Omit the client row-model factory for that operation.

The option contracts confirm that manual modes expect already processed rows
(`packages/table-core/src/features/column-filtering/columnFilteringFeature.types.ts:258-268`,
`packages/table-core/src/features/row-sorting/rowSortingFeature.types.ts:241-257`,
`packages/table-core/src/features/row-pagination/rowPaginationFeature.types.ts:18-34`). Do not run
the same transformation on both server and client.

## Test seam

Test pure formatting and data transformation independently of Table. When Table behavior is
present, exercise a small fixture through rendered semantic markup and assert user-visible order,
filtering, pagination, and stable row identity rather than private store fields. `useTable` is an
adapter over a separately constructed core table
(`packages/react-table/src/useTable.ts:149-187`), so row-model behavior can be tested through the
headless layer when React rendering adds no value.
