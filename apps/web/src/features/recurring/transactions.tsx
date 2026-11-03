import { PendingRead } from "@/ui/components/pending-read";

import { RefreshButton } from "@/ui/components/refresh-button";
import { useAtomRefresh, useAtomValue } from "@effect/atom-react";
import { useRouter } from "@tanstack/react-router";
import { Option, Schema } from "effect";
import { type JSX, type ReactNode, useState } from "react";
import { type CanonicalSuccess, TransactionQueryValues } from "@/transport/client";
import { presentCanonicalQuery } from "@/transport/canonical-query";
import { revalidateWorkspaceQuery, workspaceQueryRetention } from "@/transport/workspace-query";
import { Button } from "@/ui/components/button";
import { TransactionCandidate } from "@/ui/components/transaction-candidate";
import { TransactionSearchForm } from "./transaction-search-form";
import {
  type TransactionFilters,
  type TransactionSearch,
  emptyTransactionFilters,
  transactionDate,
  transactionScope,
  transactionSearch,
} from "./transaction-filters";
import { money } from "./model";

type Transaction = CanonicalSuccess<"transactions.listTransactions">["data"][number];
type BrowserView = Readonly<{
  filters: ReactNode;
  results: ReactNode;
  selected: Option.Option<Transaction>;
  blocked: boolean;
  clear: () => void;
}>;
type BrowserProps = Readonly<{
  disabled: boolean;
  timeZone: string;
  initial: TransactionFilters;
  children: (view: BrowserView) => ReactNode;
}>;
const continuation = (
  page: CanonicalSuccess<"transactions.listTransactions">
): Option.Option<string> => {
  const suggestion = page.next.find(
    (entry) =>
      entry.tool === "transactions.listTransactions" ||
      entry.tool === "transactions.searchTransactions"
  );
  if (suggestion === undefined || !("args" in suggestion) || Option.isNone(suggestion.args)) {
    return Option.none();
  }
  return Schema.decodeUnknownOption(
    Schema.Struct({ query: Schema.Struct({ cursor: TransactionQueryValues.fields.cursor }) })
  )(suggestion.args.value).pipe(Option.map((value) => value.query.cursor));
};
export const TransactionBrowser = (props: BrowserProps): JSX.Element => {
  const [draft, setDraft] = useState(props.initial);
  const [query, setQuery] = useState(() =>
    Option.getOrThrow(transactionSearch({ draft: props.initial, timeZone: props.timeZone }))
  );
  const [cursors, setCursors] = useState<ReadonlyArray<string>>([]);
  const cursor = cursors.at(-1);
  const apply = (value: TransactionSearch): void => {
    setQuery(value);
    setCursors([]);
  };
  const filters = (
    <TransactionSearchForm
      draft={draft}
      setDraft={setDraft}
      timeZone={props.timeZone}
      apply={apply}
    />
  );
  return (
    <TransactionPage
      key={JSON.stringify(query)}
      {...props}
      query={query}
      cursor={Option.fromUndefinedOr(cursor)}
      filters={filters}
      next={(value) => setCursors([...cursors, value])}
      previous={
        cursors.length === 0 ? Option.none() : Option.some(() => setCursors(cursors.slice(0, -1)))
      }
    />
  );
};
type PageProps = BrowserProps &
  Readonly<{
    query: TransactionSearch;
    cursor: Option.Option<string>;
    filters: ReactNode;
    next: (cursor: string) => void;
    previous: Option.Option<() => void>;
  }>;
const TransactionPage = (props: PageProps): JSX.Element => (
  <TransactionRequest key={Option.getOrElse(props.cursor, () => "first")} {...props} />
);
const TransactionRequest = (props: PageProps): JSX.Element => {
  const client = useRouter().options.context.apiClient;
  const [resource] = useState(() => {
    const { text, filters } = props.query;
    const query = {
      ...filters,
      ...(Option.isNone(props.cursor) ? {} : { cursor: props.cursor.value }),
    };
    return (
      Option.isNone(text)
        ? client.query("transactions", "listTransactions", { query, ...workspaceQueryRetention })
        : client.query("transactions", "searchTransactions", {
            query: { ...query, q: text.value },
            ...workspaceQueryRetention,
          })
    ).pipe(revalidateWorkspaceQuery);
  });
  const [selectedId, setSelectedId] = useState<Option.Option<Transaction["id"]>>(() =>
    Option.none()
  );
  const state = useAtomValue(resource).pipe(presentCanonicalQuery);
  const refresh = useAtomRefresh(resource);
  const blocked =
    props.disabled ||
    state._tag !== "Ready" ||
    state.waiting ||
    Option.isSome(state.refreshFailure);
  const selected =
    state._tag === "Ready"
      ? Option.flatMap(selectedId, (id) =>
          Option.fromUndefinedOr(state.value.data.find((transaction) => transaction.id === id))
        )
      : Option.none();
  const results = (
    <SearchResults
      {...props}
      state={state}
      refresh={refresh}
      blocked={blocked}
      selected={selectedId}
      choose={(transaction) => setSelectedId(Option.some(transaction.id))}
    />
  );
  return (
    <>
      {props.children({
        filters: props.filters,
        results,
        selected,
        blocked,
        clear: () => setSelectedId(Option.none()),
      })}
    </>
  );
};
type ResultsProps = PageProps &
  Readonly<{
    state: ReturnType<
      typeof presentCanonicalQuery<CanonicalSuccess<"transactions.listTransactions">, unknown>
    >;
    refresh: () => void;
    blocked: boolean;
    selected: Option.Option<Transaction["id"]>;
    choose: (transaction: Transaction) => void;
  }>;
const SearchResults = (props: ResultsProps): JSX.Element => {
  const { state, refresh } = props;
  if (state._tag === "Failure") {
    return (
      <div className="grid gap-3 py-6">
        <p>No pudimos cargar las transacciones. Tus filtros se conservaron.</p>
        <Button contentLayout="wrap" variant="outline" onClick={refresh}>
          Reintentar transacciones
        </Button>
      </div>
    );
  }
  if (state._tag !== "Ready") return <PendingRead label="Cargando transacciones" />;
  return (
    <section
      aria-label="Resultados de transacciones"
      className="mt-6 grid min-w-0 gap-3 [overflow-wrap:anywhere]"
    >
      <h2 className="text-lg font-semibold">Transacciones</h2>
      <p aria-live="polite" className="min-w-0 text-xs text-muted-foreground">
        {state.value.data.length} en esta página ·{" "}
        {transactionScope({ query: props.query, timeZone: props.timeZone })} · Más recientes primero
      </p>
      {Option.isSome(state.refreshFailure) ? (
        <RefreshButton variant="outline" onClick={refresh} label="Actualizar transacciones" />
      ) : null}
      <ul className="list-none p-0">
        {state.value.data.map((transaction) => (
          <li key={transaction.id}>
            <TransactionCandidate
              name={Option.getOrElse(transaction.counterparty, () => "Contraparte no identificada")}
              date={transactionDate({ transaction, timeZone: props.timeZone })}
              notes={Option.getOrElse(transaction.notes, () => "")}
              amount={money(transaction.money)}
              inflow={transaction.direction === "inflow"}
              selected={Option.contains(props.selected, transaction.id)}
              disabled={props.blocked}
              onSelect={() => props.choose(transaction)}
            />
          </li>
        ))}
      </ul>
      {state.value.data.length === 0 ? (
        <p className="py-6 text-sm text-muted-foreground">
          Sin coincidencias. Prueba otra contraparte o amplía las fechas.
        </p>
      ) : null}
      <PageNavigation {...props} page={state.value} />
    </section>
  );
};
const PageNavigation = ({
  page,
  blocked,
  next,
  previous,
}: Pick<ResultsProps, "blocked" | "next" | "previous"> &
  Readonly<{ page: CanonicalSuccess<"transactions.listTransactions"> }>): JSX.Element => {
  const more = continuation(page);
  return (
    <div className="flex flex-wrap items-center gap-3 py-4">
      {Option.isSome(previous) ? (
        <Button contentLayout="wrap" variant="outline" disabled={blocked} onClick={previous.value}>
          Página anterior
        </Button>
      ) : null}
      {Option.isSome(more) ? (
        <>
          <Button
            contentLayout="wrap"
            variant="outline"
            disabled={blocked}
            onClick={() => next(more.value)}
          >
            Ver más transacciones
          </Button>
          <span className="text-xs text-muted-foreground">
            Hay más resultados para estos filtros.
          </span>
        </>
      ) : (
        <p className="text-xs text-muted-foreground">Fin de los resultados para estos filtros.</p>
      )}
    </div>
  );
};
export const TransactionPicker = ({
  choose,
  disabled,
  timeZone,
}: Readonly<{
  choose: (transaction: Transaction) => void;
  disabled: boolean;
  timeZone: string;
}>): JSX.Element => (
  <TransactionBrowser disabled={disabled} initial={emptyTransactionFilters} timeZone={timeZone}>
    {(view) => (
      <div className="grid gap-4">
        {view.filters}
        {view.results}
        {Option.isSome(view.selected) ? (
          <Button
            contentLayout="wrap"
            disabled={view.blocked}
            onClick={() => {
              if (Option.isSome(view.selected)) choose(view.selected.value);
            }}
          >
            Usar esta transacción
          </Button>
        ) : null}
      </div>
    )}
  </TransactionBrowser>
);
