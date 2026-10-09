import { useAtomRefresh, useAtomValue } from "@effect/atom-react";
import { useRouter } from "@tanstack/react-router";
import { DateTime, Effect, Option } from "effect";
import { useState } from "react";
import type { JSX } from "react";
import { Skeleton } from "@/ui/components/skeleton";
import { CanonicalQueryRetry } from "@/ui/canonical-query-feedback";
import { type CanonicalQueryState, presentCanonicalQuery } from "@/transport/canonical-query";
import { TransactionWorkspace } from "./workspace";
import {
  type Category,
  type CurrentUser,
  type Transaction,
  deriveCurrentMonthPeriod,
  presentPeriod,
} from "./presentation";

type QueryActivity =
  | Readonly<{ _tag: "Current" }>
  | Readonly<{ _tag: "Refreshing" }>
  | Readonly<{ _tag: "RefreshFailure"; onRetry: () => void; waiting: boolean }>;

/** Exhaustive rendering state for the current-month Transaction list. */
export type TransactionPageState =
  | Readonly<{ _tag: "Initial" }>
  | Readonly<{ _tag: "Loading" }>
  | Readonly<{
      _tag: "CanonicalError" | "BoundaryError";
      onRetry: () => void;
      waiting: boolean;
    }>;

const LoadingTransactions = (): JSX.Element => (
  <section className="flex flex-col gap-3" aria-label="Cargando transacciones" aria-live="polite">
    <Skeleton className="h-20 w-full" />
    <Skeleton className="h-20 w-full" />
    <Skeleton className="h-20 w-full" />
  </section>
);

const QueryError = ({
  boundary,
  onRetry,
  waiting,
}: Readonly<{ boundary: boolean; onRetry: () => void; waiting: boolean }>): JSX.Element => (
  <CanonicalQueryRetry
    description="Intenta de nuevo en unos momentos."
    onRetry={onRetry}
    retryLabel="Reintentar carga"
    retryingLabel="Reintentando…"
    title={boundary ? "No pudimos comunicarnos con Fidy" : "No pudimos cargar tus transacciones"}
    waiting={waiting}
  />
);

const QueryActivityNotice = ({ query }: Readonly<{ query: QueryActivity }>): JSX.Element => {
  switch (query._tag) {
    case "Current":
    case "Refreshing":
      return <></>;
    case "RefreshFailure":
      return (
        <CanonicalQueryRetry
          description="Mostramos las últimas transacciones disponibles."
          onRetry={query.onRetry}
          retryLabel="Reintentar actualización"
          retryingLabel="Reintentando…"
          title="No pudimos actualizar las transacciones"
          waiting={query.waiting}
        />
      );
  }
};

const TransactionPageContent = ({
  state,
}: Readonly<{ state: TransactionPageState }>): JSX.Element => {
  switch (state._tag) {
    case "Initial":
      return <p className="text-muted-foreground">La consulta aún no se ha iniciado.</p>;
    case "Loading":
      return <LoadingTransactions />;
    case "CanonicalError":
    case "BoundaryError":
      return (
        <QueryError
          boundary={state._tag === "BoundaryError"}
          onRetry={state.onRetry}
          waiting={state.waiting}
        />
      );
  }
};

/** Renders the current-month Transaction list's presentation state. */
export const TransactionListView = ({
  state,
}: Readonly<{ state: TransactionPageState }>): JSX.Element => (
  <main className="mx-auto flex w-full max-w-6xl flex-col gap-6 px-4 py-8 sm:px-6 lg:px-8">
    <header className="flex flex-col gap-2">
      <h1 className="font-heading text-3xl font-semibold tracking-tight">Transacciones</h1>
      <p className="text-muted-foreground">Movimientos del mes actual.</p>
    </header>
    <TransactionPageContent state={state} />
  </main>
);

const FailedTransactionQuery = ({
  boundary,
  onRetry,
  waiting,
}: Readonly<{ boundary: boolean; onRetry: () => void; waiting: boolean }>): JSX.Element => (
  <TransactionListView
    state={{
      _tag: boundary ? "BoundaryError" : "CanonicalError",
      onRetry,
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
  categoryState: CanonicalQueryState<Readonly<{ data: ReadonlyArray<Category> }>, unknown>;
  period: ReturnType<typeof deriveCurrentMonthPeriod>;
  retry: () => void;
  transactionState: CanonicalQueryState<Readonly<{ data: ReadonlyArray<Transaction> }>, unknown>;
}>;

const useTransactionQueries = (currentUser: CurrentUser): TransactionQueries => {
  const router = useRouter();
  const [period] = useState(() =>
    deriveCurrentMonthPeriod({
      now: Effect.runSync(DateTime.now),
      timeZone: currentUser.timeZone,
    })
  );
  const [categories] = useState(() =>
    router.options.context.apiClient.query("categories", "listCategories", {})
  );
  const [transactions] = useState(() =>
    router.options.context.apiClient.query("transactions", "listTransactions", {
      query: { from: period.from, to: period.to },
    })
  );
  const categoryState = useAtomValue(categories).pipe(presentCanonicalQuery);
  const transactionState = useAtomValue(transactions).pipe(presentCanonicalQuery);
  const refreshCategories = useAtomRefresh(categories);
  const refreshTransactions = useAtomRefresh(transactions);
  const retry = (): void => {
    refreshCategories();
    refreshTransactions();
  };
  return { categoryState, period, retry, transactionState };
};

const readyQueryActivity = (
  categoryState: Extract<TransactionQueries["categoryState"], { readonly _tag: "Ready" }>,
  transactionState: Extract<TransactionQueries["transactionState"], { readonly _tag: "Ready" }>,
  retry: () => void
): QueryActivity =>
  queryActivity({
    categoryFailed: Option.isSome(categoryState.refreshFailure),
    categoryWaiting: categoryState.waiting,
    onRetry: retry,
    transactionFailed: Option.isSome(transactionState.refreshFailure),
    transactionWaiting: transactionState.waiting,
  });

const TransactionResources = ({
  currentUser,
  profileCurrent,
}: Readonly<{ currentUser: CurrentUser; profileCurrent: boolean }>): JSX.Element => {
  const router = useRouter();
  const { categoryState, period, retry, transactionState } = useTransactionQueries(currentUser);
  if (categoryState._tag === "Failure") {
    return (
      <FailedTransactionQuery
        boundary={categoryState.failure._tag !== "DeclaredFailure"}
        onRetry={retry}
        waiting={categoryState.waiting}
      />
    );
  }
  if (transactionState._tag === "Failure") {
    return (
      <FailedTransactionQuery
        boundary={transactionState.failure._tag !== "DeclaredFailure"}
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
    <TransactionWorkspace
      editable={
        profileCurrent &&
        readyQueryActivity(categoryState, transactionState, retry)._tag === "Current"
      }
      apiClient={router.options.context.apiClient}
      currentUser={currentUser}
      categories={categoryState.value.data}
      transactions={transactionState.value.data}
      period={presentPeriod({ locale: currentUser.locale, period })}
      queryNotice={
        <QueryActivityNotice query={readyQueryActivity(categoryState, transactionState, retry)} />
      }
      onRefresh={retry}
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

const CurrentUserQuery = (): JSX.Element => {
  const router = useRouter();
  const [currentUser] = useState(() =>
    router.options.context.apiClient.query("identity", "getCurrentUser", {})
  );
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
            waiting: state.waiting,
          }}
        />
      );
    case "Ready":
      return (
        <>
          {state.waiting ? (
            <p aria-live="polite" className="text-sm text-muted-foreground">
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
          <TransactionResources
            currentUser={state.value.data}
            profileCurrent={profileCurrent(state)}
          />
        </>
      );
  }
};

/** Transaction route whose canonical server state is owned exclusively by Effect Atom queries. */
export const TransactionListFeature = (): JSX.Element => <CurrentUserQuery />;
