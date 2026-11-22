import { ManualCaptureProvider } from "./manual-capture";
import { TransactionWorkspace } from "./workspace-component";
import { TransactionPeriodControls } from "./period-controls";
import { PendingRead } from "@/ui/components/pending-read";
import { TransactionDestinationFailure } from "./destination";
import { TransactionLocationNotice } from "./location-notice";
import { transactionDestinationQuery } from "./destination-query";
import { TransactionSearch, selectedTransactionPeriod, transactionMonth } from "./period";
import {
  matchesTransactionFilters,
  readTransactionView,
  rememberTransactionPages,
} from "./view-state";
import { prepareQuery } from "@/transport/query-preparation";
import type { AtomRegistry } from "effect/reactivity";
import type { FidyClient } from "@/transport/client";
import { workspaceCategoriesQuery, workspaceProfileQuery } from "@/transport/workspace-query";
import { useAtomRefresh, useAtomSet, useAtomValue } from "@effect/atom-react";
import { type RegisteredRouter, useNavigate, useRouter, useSearch } from "@tanstack/react-router";
import { Data, DateTime, Effect, Match, Option, Predicate, Schema } from "effect";
import { browserRuntime } from "@/transport/browser-runtime";
import { type RefCallback, Suspense, lazy, useState } from "react";
import { toast } from "sonner";
import { TransactionCorrectionContext } from "./correction-context";
import { type TransactionCorrections, transactionCorrections } from "./corrections";
import type { JSX, ReactNode } from "react";

import { CanonicalQueryRetry } from "@/ui/canonical-query-feedback";
import { type CanonicalQueryState, presentCanonicalQuery } from "@/transport/canonical-query";
import { type HistoryCommand, type HistoryState } from "./history";
import { type TransactionRouteHistory, transactionRouteHistory } from "./route-history";
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

type QueryActivity = Data.TaggedEnum<{
  Current: {};
  Refreshing: {};
  RefreshFailure: { readonly onRetry: () => void; readonly waiting: boolean };
}>;

const QueryActivity = Data.taggedEnum<QueryActivity>();

type FailedPage = {
  readonly period: Option.Option<FailurePeriod>;
  readonly onRetry: () => void;
  readonly waiting: boolean;
};

export type TransactionPageState = Data.TaggedEnum<{
  Initial: {};
  Loading: {};
  CanonicalError: FailedPage;
  BoundaryError: FailedPage;
}>;

const TransactionPageState = Data.taggedEnum<TransactionPageState>();

const pendingPage = (waiting: boolean): TransactionPageState =>
  waiting ? TransactionPageState.Loading() : TransactionPageState.Initial();

const failedPage = (boundary: boolean, page: FailedPage): TransactionPageState =>
  boundary ? TransactionPageState.BoundaryError(page) : TransactionPageState.CanonicalError(page);

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
}>): JSX.Element =>
  Match.valueTags(query, {
    Current: () => <></>,
    Refreshing: () => <></>,
    RefreshFailure: (failure) => (
      <CanonicalQueryRetry
        description={`Mostramos las últimas transacciones disponibles de ${monthLabel}.`}
        onRetry={failure.onRetry}
        retryLabel="Reintentar actualización"
        variant="default"
        retryingLabel="Reintentando…"
        title="No pudimos actualizar las transacciones"
        waiting={failure.waiting}
      />
    ),
  });

const PendingTransactionList = (): JSX.Element => (
  <main>
    <PendingRead label="Cargando transacciones" />
  </main>
);

const FailedTransactionList = ({
  state,
}: Readonly<{
  state: Data.TaggedEnum.Value<TransactionPageState, "CanonicalError" | "BoundaryError">;
}>): JSX.Element => (
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
    <QueryError
      boundary={Predicate.isTagged(state, "BoundaryError")}
      onRetry={state.onRetry}
      period={state.period}
      waiting={state.waiting}
    />
  </main>
);

export const TransactionListView = ({
  state,
}: Readonly<{
  state: TransactionPageState;
}>): JSX.Element =>
  Match.valueTags(state, {
    Initial: () => <PendingTransactionList />,
    Loading: () => <PendingTransactionList />,
    CanonicalError: (failure) => <FailedTransactionList state={failure} />,
    BoundaryError: (failure) => <FailedTransactionList state={failure} />,
  });

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
    state={failedPage(boundary, { onRetry, period: Option.some(period), waiting })}
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
    return QueryActivity.RefreshFailure({
      onRetry,
      waiting: categoryWaiting || transactionWaiting,
    });
  }

  if (categoryWaiting || transactionWaiting) return QueryActivity.Refreshing();

  return QueryActivity.Current();
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
  onRefresh: () => void;
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

  const search = Schema.decodeUnknownOption(TransactionSearch)(router.latestLocation.search);

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
  historyResource: TransactionRouteHistory
): TransactionQueries => {
  const router = useRouter();
  const client = router.options.context.apiClient;
  const scope = `${transactionMonth(period)}:${period.timeZone}`;
  const [categories] = useState(() => workspaceCategoriesQuery(client).view);
  const transactions = historyResource.firstPage;

  const [correctionOwner] = useState(() =>
    transactionCorrections({
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

      if (
        router.options.context.registry.get(historyResource.state).more.more !== history.more.more
      ) {
        return;
      }

      rememberTransactionPages({ router, scope, pages: history.loadedPages + 1 });
      dispatch(history.more);
    },
    onRefresh: () => {
      if (corrections.locked) return corrections.recover();
      corrections.resetWorkspace();
      dispatch("refresh");
      router.options.context.registry.refresh(categories);
    },
    onRetryMore: () => {
      if (
        router.options.context.registry.get(historyResource.state).retry.retry !==
        history.retry.retry
      ) {
        return;
      }

      if (corrections.locked) return corrections.recover();
      dispatch(history.retry);
    },
  };
};

const readyQueryActivity = (
  categoryState: Data.TaggedEnum.Value<TransactionQueries["categoryState"], "Ready">,
  transactionState: Data.TaggedEnum.Value<TransactionQueries["transactionState"], "Ready">,
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
  capture: boolean;
  locate: Option.Option<string>;
  historyResource: TransactionRouteHistory;
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
  const queries = useTransactionQueries(props.period, props.historyResource);
  useTransactionScrollRestoration(
    Option.isNone(props.locate) &&
      Predicate.isTagged(queries.categoryState, "Ready") &&
      Predicate.isTagged(queries.transactionState, "Ready") &&
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

const failedDestination = (queries: TransactionQueries): Option.Option<JSX.Element> =>
  queries.history.location === "LookupFailed" &&
  Predicate.isTagged(queries.transactionState, "Failure")
    ? Option.some(
        <TransactionDestinationFailure
          state={queries.transactionState}
          refresh={queries.onRetryMore}
        />
      )
    : Option.none();

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

  if (Predicate.isTagged(categoryState, "Failure")) {
    return (
      <FailedTransactionQuery
        boundary={!Predicate.isTagged(categoryState.failure, "DeclaredFailure")}
        period={failurePeriod}
        onRetry={retry}
        waiting={categoryState.waiting}
      />
    );
  }

  const destinationFailure = failedDestination(props.queries);

  if (Option.isSome(destinationFailure)) return destinationFailure.value;

  if (Predicate.isTagged(transactionState, "Failure")) {
    return (
      <FailedTransactionQuery
        boundary={!Predicate.isTagged(transactionState.failure, "DeclaredFailure")}
        period={failurePeriod}
        onRetry={retry}
        waiting={transactionState.waiting}
      />
    );
  }

  if (!Predicate.isTagged(categoryState, "Ready")) {
    return <TransactionListView state={pendingPage(categoryState.waiting)} />;
  }

  if (!Predicate.isTagged(transactionState, "Ready")) {
    return <TransactionListView state={pendingPage(transactionState.waiting)} />;
  }

  return (
    <ReadyTransactionResources
      {...props}
      queries={{ ...props.queries, categoryState, transactionState }}
    />
  );
};

const Workspace = import.meta.env.DEV
  ? lazy(() =>
      import("./dev-preview").then((module) => ({ default: module.TransactionsDataPreview }))
    )
  : TransactionWorkspace;

type ReadyQueries = Omit<TransactionQueries, "categoryState" | "transactionState"> &
  Readonly<{
    categoryState: Data.TaggedEnum.Value<TransactionQueries["categoryState"], "Ready">;
    transactionState: Data.TaggedEnum.Value<TransactionQueries["transactionState"], "Ready">;
  }>;

const ReadyTransactionResources = ({
  capture,
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
    <Suspense fallback={<TransactionListView state={TransactionPageState.Loading()} />}>
      <Workspace
        key={Option.getOrElse(locate, () => "browse")}
        generation={corrections.workspaceGeneration}
        locate={history.location === "Located" ? locate : Option.none()}
        captureHistoryVersion={Option.some({
          month: dateFilter.month,
          timeZone: currentUser.timeZone,
          generation: history.generation,
        })}
        readOnly={false}
        capture={capture}
        dateFilter={dateFilter}
        monthFilter={Option.some({ value: dateFilter.month, onChange: dateFilter.onMonth })}
        continuation={history.continuation}
        location={history.location}
        onMore={onMore}
        onRetryMore={onRetryMore}
        editable={profileCurrent && !corrections.locked && Predicate.isTagged(activity, "Current")}
        apiClient={router.options.context.apiClient}
        currentUser={currentUser}
        categories={categoryState.value.data}
        transactions={transactionState.value.data}
        period={presentation}
        queryNotice={
          <>
            <QueryActivityNotice query={activity} monthLabel={presentation.monthLabel} />
            <TransactionLocationNotice history={history} onMore={onMore} onRetry={onRetryMore} />
          </>
        }
        onRefresh={queries.onRefresh}
      />
      {profileCurrent && Predicate.isTagged(activity, "Current") ? children : null}
    </Suspense>
  );
};

const TransactionPeriodView = ({
  children,
  currentUser,
  profileCurrent,
  search,
}: Readonly<{
  currentUser: CurrentUser;
  profileCurrent: boolean;
  children: ReactNode;
  search: TransactionSearch;
}>): JSX.Element => {
  const navigate = useNavigate();
  const [now] = useState(() => DateTime.nowUnsafe());
  const router = useRouter();

  const [historyResource] = useState(() => {
    const selected = selectedTransactionPeriod({ search, now, timeZone: currentUser.timeZone });

    return transactionRouteHistory({
      client: router.options.context.apiClient,
      search,
      timeZone: currentUser.timeZone,
      now,
      initialPages:
        search.transaction === undefined
          ? readTransactionView({
              state: router.latestLocation.state,
              binding: router.options.context.sessionBinding,
              scope: `${transactionMonth(selected)}:${selected.timeZone}`,
            }).pages
          : 1,
    });
  });

  const { period, locate } = useAtomValue(historyResource.state);
  const month = transactionMonth(period);

  const change = (next: TransactionSearch): void => {
    navigate({ to: "/app/transactions", search: next, state: true }).catch(() => undefined);
  };

  return (
    <TransactionResources
      key={`${DateTime.toEpochMillis(period.from)}:${period.timeZone}:${Option.getOrElse(locate, () => "browse")}`}
      historyResource={historyResource}
      locate={locate}
      capture={search.capture === "manual"}
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
  const [now] = useState(() => DateTime.nowUnsafe());

  const month = transactionMonth(
    selectedTransactionPeriod({ search, now, timeZone: props.currentUser.timeZone })
  );

  return (
    <TransactionPeriodView
      key={`${search.transaction ?? month}:${props.currentUser.timeZone}`}
      {...props}
      search={search}
    />
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

  return Match.valueTags(state, {
    Initial: (initial) => <TransactionListView state={pendingPage(initial.waiting)} />,
    Failure: (failed) => (
      <TransactionListView
        state={failedPage(!Predicate.isTagged(failed.failure, "DeclaredFailure"), {
          onRetry: refresh,
          period: Option.none(),
          waiting: failed.waiting,
        })}
      />
    ),
    Ready: (ready) => (
      <>
        {ready.waiting ? (
          <p aria-live="polite" className="sr-only">
            Actualizando perfil de transacciones…
          </p>
        ) : null}
        {Option.isSome(ready.refreshFailure) ? (
          <CanonicalQueryRetry
            description="Mostramos tus transacciones con el último perfil disponible."
            onRetry={refresh}
            retryLabel="Reintentar actualización del perfil"
            retryingLabel="Reintentando…"
            title="No pudimos actualizar tu perfil"
            waiting={ready.waiting}
          />
        ) : null}
        <ManualCaptureProvider timeZone={ready.value.data.timeZone}>
          <TransactionPeriod
            key={ready.value.data.timeZone}
            currentUser={ready.value.data}
            profileCurrent={profileCurrent(ready)}
          >
            {children}
          </TransactionPeriod>
        </ManualCaptureProvider>
      </>
    ),
  });
};

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

TransactionListFeature.preloadData = ({
  apiClient,
  destinationMode,
  registry,
  signal,
  search,
}: TransactionPreparation): Promise<void> =>
  browserRuntime.runPromise(
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

      if (
        !Predicate.isTagged(current, "Ready") ||
        current.waiting ||
        Option.isSome(current.refreshFailure)
      ) {
        return;
      }

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
      }

      const query = transactionRouteHistory({
        client: apiClient,
        search,
        now: DateTime.nowUnsafe(),
        timeZone: current.value.data.timeZone,
        initialPages: 1,
      }).firstPage;

      yield* Effect.tryPromise(() =>
        prepareQuery({ registry, query, options: { mode: "display", signal: Option.some(signal) } })
      );
    })
  );

TransactionListFeature.preload = (): Promise<void> =>
  TransactionWorkspace.preload?.() ?? Promise.resolve();
