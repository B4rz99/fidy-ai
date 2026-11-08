import { type RegisteredRouter, useRouter, useRouterState } from "@tanstack/react-router";
import { DateTime, Option, Schema } from "effect";
import type { Transaction } from "./presentation";

export const transactionSearchLimit = 500;
const maximumCategoryLength = 120;
const maximumRestoredPages = 20;
const LocalFilters = Schema.Struct({
  search: Schema.String.check(Schema.isMaxLength(transactionSearchLimit)),
  direction: Schema.String.check(
    Schema.makeFilter((value) => value === "all" || value === "outflow" || value === "inflow")
  ),
  categoryId: Schema.String.check(Schema.isMaxLength(maximumCategoryLength)),
});
export type TransactionFilters = typeof LocalFilters.Type;
export const emptyTransactionFilters: TransactionFilters = {
  search: "",
  direction: "all",
  categoryId: "all",
};
const SavedView = Schema.Struct({
  version: Schema.Literal(1),
  binding: Schema.String,
  scope: Schema.String,
  filters: LocalFilters,
  pages: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: maximumRestoredPages })),
});

const HistoryView = Schema.Struct({ transactionView: SavedView });

export const readTransactionView = ({
  state,
  binding,
  scope,
}: Readonly<{ state: unknown; binding: string; scope: string }>): Readonly<{
  filters: TransactionFilters;
  pages: number;
}> =>
  Schema.decodeUnknownOption(HistoryView)(state).pipe(
    Option.match({
      onNone: () => ({ filters: emptyTransactionFilters, pages: 1 }),
      onSome: ({ transactionView: view }) =>
        view.binding === binding && view.scope === scope
          ? { filters: view.filters, pages: view.pages }
          : { filters: emptyTransactionFilters, pages: 1 },
    })
  );

export const rememberTransactionPages = ({
  router,
  scope,
  pages,
}: Readonly<{ router: RegisteredRouter; scope: string; pages: number }>): void => {
  const binding = router.options.context.sessionBinding;
  const view = readTransactionView({ state: router.latestLocation.state, binding, scope });
  saveTransactionView(router, scope, { ...view, pages: Math.min(pages, maximumRestoredPages) });
};

const saveTransactionView = (
  router: RegisteredRouter,
  scope: string,
  view: Readonly<{ filters: TransactionFilters; pages: number }>
): void => {
  router
    .navigate({
      to: ".",
      search: true,
      replace: true,
      resetScroll: false,
      state: (previous) => ({
        ...previous,
        transactionView: {
          version: 1,
          binding: router.options.context.sessionBinding,
          scope,
          ...view,
        },
      }),
    })
    .catch(() => undefined);
};

export const matchesTransactionFilters = ({
  transaction,
  filters,
  timeZone,
}: Readonly<{
  transaction: Transaction;
  filters: TransactionFilters & Readonly<{ date: string }>;
  timeZone: string;
}>): boolean => {
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

export const useTransactionFilters = (
  scope: string
): Readonly<{
  filters: TransactionFilters;
  change: (filters: TransactionFilters) => void;
}> => {
  const router = useRouter();
  const binding = router.options.context.sessionBinding;
  const saved = useRouterState({ select: (state) => state.location.state });
  const view = readTransactionView({ state: saved, binding, scope });
  return {
    filters: view.filters,
    change: (filters) => saveTransactionView(router, scope, { ...view, filters }),
  };
};
