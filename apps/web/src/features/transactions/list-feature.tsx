import { ManualCaptureProvider } from "./manual-capture";
import { TransactionWorkspace } from "./workspace-component";
import { TransactionPeriodControls } from "./period-controls";
import { PendingRead } from "@/ui/components/pending-read";
import { TransactionLocationNotice } from "./location-notice";
import { TransactionDestination } from "./destination";
import { destinationMonth, transactionDestinationQuery } from "./destination-query";
import { TransactionSearch, selectedTransactionPeriod, transactionMonth } from "./period";
import {
  matchesTransactionFilters,
  readTransactionView,
  rememberTransactionPages,
} from "./view-state";
import { transactionFirstPage } from "./query";
import { prepareQuery } from "@/transport/query-preparation";
import type { AtomRegistry } from "effect/reactivity";
import type { FidyClient } from "@/transport/client";
import { workspaceCategoriesQuery, workspaceProfileQuery } from "@/transport/workspace-query";
import { useAtomRefresh, useAtomSet, useAtomValue } from "@effect/atom-react";
import { type RegisteredRouter, useNavigate, useRouter, useSearch } from "@tanstack/react-router";
import { DateTime, Effect, Option, Schema } from "effect";
import { type RefCallback, Suspense, useState } from "react";
import { toast } from "sonner";
import { TransactionCorrectionContext } from "./correction-context";
import { type TransactionCorrections, makeTransactionCorrections } from "./corrections";
import type { JSX, ReactNode } from "react";

import { CanonicalQueryRetry } from "@/ui/canonical-query-feedback";
import { type CanonicalQueryState, presentCanonicalQuery } from "@/transport/canonical-query";
import { type HistoryCommand, type HistoryState, transactionHistory } from "./history";
import { useTransactionScrollRestoration } from "./scroll-restoration";
import {
  type Category,
  type CurrentMonthPeriod,
  type CurrentUser,
  type Transaction,
  presentPeriod,
} from "./presentation";

type FailurePeriod = Readonly<{
  value: string;
  label: string;
  onChange: (month: string) => void;
}>;
type QueryActivity =
  | Readonly<{
      _tag: "Current";
    }>
  | Readonly<{
      _tag: "Refreshing";
    }>
  | Readonly<{
      _tag: "RefreshFailure";
      onRetry: () => void;
      waiting: boolean;
    }>;
export type TransactionPageState =
  | Readonly<{
      _tag: "Initial";
    }>
  | Readonly<{
      _tag: "Loading";
    }>
  | Readonly<{
      _tag: "CanonicalError" | "BoundaryError";
      period: Option.Option<FailurePeriod>;
      onRetry: () => void;
      waiting: boolean;
    }>;
const QueryError = ({
  boundary,
  onRetry,
  period,
  waiting,
}: Readonly<{
  boundary: boolean;
  onRetry: () => void;
  period: Option.Option<FailurePeriod>;
  waiting: boolean;
}>): JSX.Element => (
  <CanonicalQueryRetry
    description={Option.match(period, {
      onNone: () => "Intenta de nuevo en unos momentos.",
      onSome: ({ label }) => `No se cargaron los movimientos de ${label}. Intenta de nuevo.`,
    })}
    onRetry={onRetry}
    retryLabel="Reintentar carga"
    variant="default"
    retryingLabel="Reintentando…"
    title={boundary ? "No pudimos comunicarnos con Fidy" : "No pudimos cargar tus transacciones"}
    waiting={waiting}
  />
);
const QueryActivityNotice = ({
  query,
  monthLabel,
}: Readonly<{
  query: QueryActivity;
  monthLabel: string;
}>): JSX.Element => {
  switch (query._tag) {
    case "Current":
    case "Refreshing":
      return <></>;
    case "RefreshFailure":
      return (
        <CanonicalQueryRetry
          description={`Mostramos las últimas transacciones disponibles de ${monthLabel}.`}
          onRetry={query.onRetry}
          retryLabel="Reintentar actualización"
          variant="default"
          retryingLabel="Reintentando…"
          title="No pudimos actualizar las transacciones"
          waiting={query.waiting}
        />
      );
  }
};
const TransactionPageContent = ({
  state,
}: Readonly<{
  state: TransactionPageState;
}>): JSX.Element => {
  switch (state._tag) {
    case "Initial":
    case "Loading":
      return <PendingRead label="Cargando transacciones" />;
    case "CanonicalError":
    case "BoundaryError":
      return (
        <QueryError
          boundary={state._tag === "BoundaryError"}
          onRetry={state.onRetry}
          period={state.period}
          waiting={state.waiting}
        />
      );
  }
};
export const TransactionListView = ({
  state,
}: Readonly<{
  state: TransactionPageState;
}>): JSX.Element =>
  state._tag === "Initial" || state._tag === "Loading" ? (
    <main>
      <PendingRead label="Cargando transacciones" />
    </main>
  ) : (
    <main className="mx-auto flex w-full max-w-6xl flex-col gap-6 px-4 py-8 sm:px-6 lg:px-8">
      <header className="flex flex-col gap-2">
        <h1 className="font-heading text-3xl font-semibold tracking-tight">Transacciones</h1>
        <p className="text-muted-foreground">
          {Option.match(state.period, {
            onNone: () => "Consulta tus movimientos.",
            onSome: ({ label }) => `Movimientos de ${label}.`,
          })}
        </p>
      </header>
      {Option.match(state.period, {
        onNone: () => null,
        onSome: (period) => (
          <TransactionPeriodControls {...period} disabled={false} className="p-0" />
        ),
      })}
      <TransactionPageContent state={state} />
    </main>
  );
const FailedTransactionQuery = ({
  boundary,
  onRetry,
  period,
  waiting,
}: Readonly<{
  boundary: boolean;
  onRetry: () => void;
  period: FailurePeriod;
  waiting: boolean;
}>): JSX.Element => (
  <TransactionListView
    state={{
      _tag: boundary ? "BoundaryError" : "CanonicalError",
      onRetry,
      period: Option.some(period),
      waiting,
    }}
  />
);
const queryActivity = ({
  categoryFailed,
  categoryWaiting,
  onRetry,
  transactionFailed,
  transactionWaiting,
}: Readonly<{
  categoryFailed: boolean;
  categoryWaiting: boolean;
  onRetry: () => void;
  transactionFailed: boolean;
  transactionWaiting: boolean;
}>): QueryActivity => {
  if (categoryFailed || transactionFailed) {
    return {
      _tag: "RefreshFailure",
      onRetry,
      waiting: categoryWaiting || transactionWaiting,
    };
  }
  if (categoryWaiting || transactionWaiting) return { _tag: "Refreshing" };
  return { _tag: "Current" };
};
type TransactionQueries = Readonly<{
  categoryState: CanonicalQueryState<
    Readonly<{
      data: ReadonlyArray<Category>;
    }>,
    unknown
  >;
  period: CurrentMonthPeriod;
  transactionState: CanonicalQueryState<
    Readonly<{
      data: ReadonlyArray<Transaction>;
    }>,
    unknown
  >;
  history: HistoryState;
  corrections: TransactionCorrections;
  mount: () => () => void;
  onMore: () => void;
  onRetryMore: () => void;
}>;
const notifySavedCorrection = (
  router: RegisteredRouter,
  period: CurrentMonthPeriod,
  transactions: ReadonlyArray<Transaction>
): void => {
  const { filters } = readTransactionView({
    state: router.latestLocation.state,
    binding: router.options.context.sessionBinding,
    scope: `${transactionMonth(period)}:${period.timeZone}`,
  });
  const search = Schema.decodeOption(TransactionSearch)(router.latestLocation.search);
  const date = Option.getOrElse(
    Option.map(search, (value) => value.date ?? ""),
    () => ""
  );
  const excluded = transactions.filter(
    (record) =>
      !matchesTransactionFilters({
        transaction: record,
        filters: { ...filters, date },
        timeZone: period.timeZone,
      }) ||
      DateTime.toEpochMillis(record.occurredAt) < DateTime.toEpochMillis(period.from) ||
      DateTime.toEpochMillis(record.occurredAt) >= DateTime.toEpochMillis(period.to)
  ).length;
  let description = Option.none<string>();
  if (excluded === 1) {
    description = Option.some("La transacción guardada ya no coincide con tus filtros.");
  } else if (excluded > 1) {
    description = Option.some(
      `${excluded} transacciones guardadas ya no coinciden con tus filtros.`
    );
  }
  toast.success("Cambios guardados", { description: Option.getOrUndefined(description) });
};
const mountTransactionView = ({
  router,
  scope,
  corrections,
  restore,
}: Readonly<{
  router: RegisteredRouter;
  scope: string;
  corrections: TransactionCorrections;
  restore: (command: HistoryCommand) => void;
}>): (() => void) => {
  let entry = router.latestLocation.state.__TSR_index;
  const disposeCorrections = corrections.mount();
  const unsubscribe = router.subscribe("onResolved", ({ toLocation }) => {
    if (toLocation.pathname !== "/app/transactions" || toLocation.state.__TSR_index === entry) {
      return;
    }
    entry = toLocation.state.__TSR_index;
    const view = readTransactionView({
      state: toLocation.state,
      binding: router.options.context.sessionBinding,
      scope,
    });
    restore({ restorePages: view.pages });
  });
  return () => {
    unsubscribe();
    disposeCorrections();
  };
};
const useTransactionQueries = (
  period: TransactionQueries["period"],
  locate: Option.Option<string>
): TransactionQueries => {
  const router = useRouter();
  const client = router.options.context.apiClient;
  const scope = `${transactionMonth(period)}:${period.timeZone}`;
  const [categories] = useState(() => workspaceCategoriesQuery(client).view);
  const [transactions] = useState(() =>
    transactionFirstPage({
      client,
      period,
    })
  );
  const [historyResource] = useState(() =>
    transactionHistory({
      apiClient: client,
      firstPage: transactions,
      period: { from: period.from, to: period.to },
      locate,
      initialPages: readTransactionView({
        state: router.latestLocation.state,
        binding: router.options.context.sessionBinding,
        scope,
      }).pages,
    })
  );
  const [correctionOwner] = useState(() =>
    makeTransactionCorrections({
      client,
      firstPage: transactions,
      categories,
      history: historyResource.state,
      historyAction: historyResource.action,
      saved: (transactions) => notifySavedCorrection(router, period, transactions),
    })
  );
  const corrections = useAtomValue(correctionOwner);
  const history = useAtomValue(historyResource.state);
  const dispatch = useAtomSet(historyResource.action);
  return {
    categoryState: useAtomValue(categories).pipe(presentCanonicalQuery),
    period,
    transactionState: history.query,
    history,
    corrections,
    mount: () => mountTransactionView({ router, scope, corrections, restore: dispatch }),
    onMore: () => {
      if (history.continuation !== "available") return;
      rememberTransactionPages({ router, scope, pages: history.loadedPages + 1 });
      dispatch("more");
    },
    onRetryMore: () => dispatch("retry"),
  };
};
const readyQueryActivity = (
  categoryState: Extract<
    TransactionQueries["categoryState"],
    {
      readonly _tag: "Ready";
    }
  >,
  transactionState: Extract<
    TransactionQueries["transactionState"],
    {
      readonly _tag: "Ready";
    }
  >,
  retry: () => void
): QueryActivity =>
  queryActivity({
    categoryFailed: Option.isSome(categoryState.refreshFailure),
    categoryWaiting: categoryState.waiting,
    onRetry: retry,
    transactionFailed: Option.isSome(transactionState.refreshFailure),
    transactionWaiting: transactionState.waiting,
  });
type TransactionResourceProps = Readonly<{
  children: ReactNode;
  locate: Option.Option<string>;
  currentUser: CurrentUser;
  profileCurrent: boolean;
  period: TransactionQueries["period"];
  dateFilter: Readonly<{
    value: string;
    onChange: (date: string) => void;
    month: string;
    onMonth: (month: string) => void;
  }>;
}>;
const TransactionResources = (props: TransactionResourceProps): JSX.Element => {
  const queries = useTransactionQueries(props.period, props.locate);
  useTransactionScrollRestoration(
    Option.isNone(props.locate) &&
      queries.categoryState._tag === "Ready" &&
      queries.transactionState._tag === "Ready" &&
      !queries.transactionState.waiting &&
      (queries.history.continuation === "complete" || queries.history.continuation === "available")
  );
  const { corrections } = queries;
  const [lifetime] = useState<RefCallback<HTMLDivElement>>(
    () => (): ReturnType<RefCallback<HTMLDivElement>> => queries.mount()
  );
  return (
    <TransactionCorrectionContext value={Option.some(corrections)}>
      <div ref={lifetime} className="contents">
        <TransactionResourceContent {...props} queries={queries} />
      </div>
    </TransactionCorrectionContext>
  );
};
const TransactionResourceContent = (
  props: TransactionResourceProps &
    Readonly<{
      queries: TransactionQueries;
    }>
): JSX.Element => {
  const { categoryState, transactionState, corrections } = props.queries;
  const retry = corrections.recover;
  const failurePeriod: FailurePeriod = {
    value: props.dateFilter.month,
    label: presentPeriod({ locale: props.currentUser.locale, period: props.period }).monthLabel,
    onChange: props.dateFilter.onMonth,
  };
  if (categoryState._tag === "Failure") {
    return (
      <FailedTransactionQuery
        boundary={categoryState.failure._tag !== "DeclaredFailure"}
        period={failurePeriod}
        onRetry={retry}
        waiting={categoryState.waiting}
      />
    );
  }
  if (transactionState._tag === "Failure") {
    return (
      <FailedTransactionQuery
        boundary={transactionState.failure._tag !== "DeclaredFailure"}
        period={failurePeriod}
        onRetry={retry}
        waiting={transactionState.waiting}
      />
    );
  }
  if (categoryState._tag !== "Ready") {
    return <TransactionListView state={{ _tag: categoryState.waiting ? "Loading" : "Initial" }} />;
  }
  if (transactionState._tag !== "Ready") {
    return (
      <TransactionListView state={{ _tag: transactionState.waiting ? "Loading" : "Initial" }} />
    );
  }
  return (
    <ReadyTransactionResources
      {...props}
      queries={{ ...props.queries, categoryState, transactionState }}
    />
  );
};
type ReadyQueries = Omit<TransactionQueries, "categoryState" | "transactionState"> &
  Readonly<{
    categoryState: Extract<
      TransactionQueries["categoryState"],
      {
        _tag: "Ready";
      }
    >;
    transactionState: Extract<
      TransactionQueries["transactionState"],
      {
        _tag: "Ready";
      }
    >;
  }>;
const ReadyTransactionResources = ({
  children,
  currentUser,
  profileCurrent,
  dateFilter,
  locate,
  queries,
}: TransactionResourceProps &
  Readonly<{
    queries: ReadyQueries;
  }>): JSX.Element => {
  const router = useRouter();
  const { categoryState, period, transactionState, history, corrections, onMore, onRetryMore } =
    queries;
  const retry = corrections.recover;
  const activity = readyQueryActivity(categoryState, transactionState, retry);
  const presentation = presentPeriod({ locale: currentUser.locale, period });
  return (
    <Suspense fallback={<TransactionListView state={{ _tag: "Loading" }} />}>
      <TransactionWorkspace
        key={Option.getOrElse(locate, () => "browse")}
        generation={corrections.workspaceGeneration}
        locate={locate}
        captureHistoryVersion={Option.some({
          month: dateFilter.month,
          generation: history.generation,
        })}
        readOnly={false}
        dateFilter={dateFilter}
        monthFilter={Option.some({ value: dateFilter.month, onChange: dateFilter.onMonth })}
        continuation={history.continuation}
        onMore={onMore}
        onRetryMore={onRetryMore}
        editable={profileCurrent && !corrections.locked && activity._tag === "Current"}
        apiClient={router.options.context.apiClient}
        currentUser={currentUser}
        categories={categoryState.value.data}
        transactions={transactionState.value.data}
        period={presentation}
        queryNotice={
          <>
            <QueryActivityNotice query={activity} monthLabel={presentation.monthLabel} />
            <TransactionLocationNotice
              locate={locate}
              history={history}
              onMore={onMore}
              onRetry={onRetryMore}
            />
          </>
        }
        onRefresh={corrections.recover}
      />
      {profileCurrent && activity._tag === "Current" ? children : null}
    </Suspense>
  );
};
const TransactionPeriodView = ({
  children,
  currentUser,
  profileCurrent,
  search,
  locate,
}: Readonly<{
  currentUser: CurrentUser;
  profileCurrent: boolean;
  children: ReactNode;
  search: TransactionSearch;
  locate: Option.Option<string>;
}>): JSX.Element => {
  const navigate = useNavigate();
  const [now] = useState(() => Effect.runSync(DateTime.now));
  const period = selectedTransactionPeriod({ search, now, timeZone: currentUser.timeZone });
  const month = transactionMonth(period);
  const change = (next: TransactionSearch): void => {
    navigate({ to: "/app/transactions", search: next, state: true }).catch(() => undefined);
  };
  return (
    <TransactionResources
      key={`${DateTime.toEpochMillis(period.from)}:${Option.getOrElse(locate, () => "browse")}`}
      locate={locate}
      currentUser={currentUser}
      profileCurrent={profileCurrent}
      period={period}
      dateFilter={{
        value: search.date ?? "",
        month,
        onMonth: (next) => change({ month: next }),
        onChange: (date) => {
          if (date === (search.date ?? "")) return;
          change(date === "" ? { month } : { date });
        },
      }}
    >
      {children}
    </TransactionResources>
  );
};
const TransactionPeriod = (
  props: Readonly<{
    currentUser: CurrentUser;
    profileCurrent: boolean;
    children: ReactNode;
  }>
): JSX.Element => {
  const search = useSearch({ from: "/independent-application/app/transactions" });
  return (
    <ManualCaptureProvider timeZone={props.currentUser.timeZone}>
      {search.transaction === undefined ? (
        <TransactionPeriodView {...props} search={search} locate={Option.none()} />
      ) : (
        <TransactionDestination key={search.transaction} id={search.transaction}>
          {(transaction) => (
            <TransactionPeriodView
              {...props}
              search={{
                month: destinationMonth({ transaction, timeZone: props.currentUser.timeZone }),
              }}
              locate={Option.some(transaction.id)}
            />
          )}
        </TransactionDestination>
      )}
    </ManualCaptureProvider>
  );
};
const profileCurrent = ({
  waiting,
  refreshFailure,
}: Readonly<{
  waiting: boolean;
  refreshFailure: Option.Option<unknown>;
}>): boolean => !waiting && Option.isNone(refreshFailure);
const CurrentUserQuery = ({
  children,
}: Readonly<{
  children: ReactNode;
}>): JSX.Element => {
  const router = useRouter();
  const [currentUser] = useState(() => workspaceProfileQuery(router.options.context.apiClient));
  const result = useAtomValue(currentUser);
  const refresh = useAtomRefresh(currentUser);
  const state = presentCanonicalQuery(result);
  switch (state._tag) {
    case "Initial":
      return <TransactionListView state={{ _tag: state.waiting ? "Loading" : "Initial" }} />;
    case "Failure":
      return (
        <TransactionListView
          state={{
            _tag: state.failure._tag === "DeclaredFailure" ? "CanonicalError" : "BoundaryError",
            onRetry: refresh,
            period: Option.none(),
            waiting: state.waiting,
          }}
        />
      );
    case "Ready":
      return (
        <>
          {state.waiting ? (
            <p aria-live="polite" className="sr-only">
              Actualizando perfil de transacciones…
            </p>
          ) : null}
          {Option.isSome(state.refreshFailure) ? (
            <CanonicalQueryRetry
              description="Mostramos tus transacciones con el último perfil disponible."
              onRetry={refresh}
              retryLabel="Reintentar actualización del perfil"
              retryingLabel="Reintentando…"
              title="No pudimos actualizar tu perfil"
              waiting={state.waiting}
            />
          ) : null}
          <TransactionPeriod
            key={state.value.data.timeZone}
            currentUser={state.value.data}
            profileCurrent={profileCurrent(state)}
          >
            {children}
          </TransactionPeriod>
        </>
      );
  }
};
/** Optional composition mounts only once the displayed Transaction information is current. */
export const TransactionListFeature = ({
  children,
}: Readonly<{
  children: ReactNode;
}>): JSX.Element => <CurrentUserQuery>{children}</CurrentUserQuery>;
type TransactionPreparation = Readonly<{
  apiClient: FidyClient;
  destinationMode: "cached" | "fresh";
  registry: AtomRegistry.AtomRegistry;
  signal: AbortSignal;
  search: TransactionSearch;
}>;
/** Prepare the same first-page resource after entry authority, before the ordinary tree mounts. */
TransactionListFeature.preloadData = ({
  apiClient,
  destinationMode,
  registry,
  signal,
  search,
}: TransactionPreparation): Promise<void> =>
  Effect.runPromise(
    Effect.gen(function* () {
      const profile = workspaceProfileQuery(apiClient);
      yield* Effect.tryPromise(() =>
        prepareQuery({
          registry,
          query: profile,
          options: { mode: "cached", signal: Option.some(signal) },
        })
      );
      const current = presentCanonicalQuery(registry.get(profile));
      if (current._tag !== "Ready" || current.waiting || Option.isSome(current.refreshFailure)) {
        return;
      }
      let selected = search;
      if (search.transaction !== undefined) {
        const destination = transactionDestinationQuery({
          client: apiClient,
          id: search.transaction,
        });
        yield* Effect.tryPromise(() =>
          prepareQuery({
            registry,
            query: destination,
            options: { mode: destinationMode, signal: Option.some(signal) },
          })
        );
        const record = presentCanonicalQuery(registry.get(destination));
        if (record._tag !== "Ready" || record.waiting || Option.isSome(record.refreshFailure)) {
          return;
        }
        selected = {
          month: destinationMonth({
            transaction: record.value.data,
            timeZone: current.value.data.timeZone,
          }),
        };
      }
      const period = selectedTransactionPeriod({
        search: selected,
        now: DateTime.nowUnsafe(),
        timeZone: current.value.data.timeZone,
      });
      const query = transactionFirstPage({ client: apiClient, period });
      yield* Effect.tryPromise(() =>
        prepareQuery({ registry, query, options: { mode: "display", signal: Option.some(signal) } })
      );
    })
  );
/** Entry code can overlap live access checks without loading this workspace on other routes. */
TransactionListFeature.preload = (): Promise<void> =>
  TransactionWorkspace.preload?.() ?? Promise.resolve();
