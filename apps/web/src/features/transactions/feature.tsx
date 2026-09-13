import { useAtomRefresh, useAtomValue } from "@effect/atom-react";
import { useRouter } from "@tanstack/react-router";
import { DateTime, Effect, Array as EffectArray, Option } from "effect";
import { useState } from "react";
import type { JSX } from "react";
import { Badge } from "@/ui/components/badge";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/ui/components/card";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@/ui/components/empty";
import { Skeleton } from "@/ui/components/skeleton";
import { CanonicalQueryRetry } from "@/ui/canonical-query-feedback";
import { type CanonicalQueryState, presentCanonicalQuery } from "@/transport/canonical-query";
import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/ui/components/table";
import {
  type CurrentUser,
  type TransactionListRow,
  deriveCurrentMonthPeriod,
  presentPeriod,
  presentTransactionRows,
} from "./presentation";

type PeriodPresentation = Readonly<{
  monthLabel: string;
  timeZone: string;
}>;

type QueryActivity =
  | Readonly<{ _tag: "Current" }>
  | Readonly<{ _tag: "Refreshing" }>
  | Readonly<{ _tag: "RefreshFailure"; onRetry: () => void; waiting: boolean }>;

/** Exhaustive rendering state for the current-month Transaction list. */
export type TransactionPageState =
  | Readonly<{ _tag: "Initial" }>
  | Readonly<{ _tag: "Loading" }>
  | Readonly<{ _tag: "Empty"; period: PeriodPresentation; query: QueryActivity }>
  | Readonly<{
      _tag: "Ready";
      period: PeriodPresentation;
      query: QueryActivity;
      rows: EffectArray.NonEmptyReadonlyArray<TransactionListRow>;
    }>
  | Readonly<{
      _tag: "CanonicalError" | "BoundaryError";
      onRetry: () => void;
      waiting: boolean;
    }>;

const TransactionPeriod = ({ period }: Readonly<{ period: PeriodPresentation }>): JSX.Element => (
  <p className="text-muted-foreground">
    <span className="capitalize">{period.monthLabel}</span>
    {" · Zona horaria aplicada: "}
    <span className="font-medium text-foreground">{period.timeZone}</span>
  </p>
);

const LoadingTransactions = (): JSX.Element => (
  <section className="flex flex-col gap-3" aria-label="Cargando transacciones" aria-live="polite">
    <Skeleton className="h-20 w-full" />
    <Skeleton className="h-20 w-full" />
    <Skeleton className="h-20 w-full" />
  </section>
);

const DesktopTransactions = ({
  rows,
}: Readonly<{
  rows: EffectArray.NonEmptyReadonlyArray<TransactionListRow>;
}>): JSX.Element => (
  <div className="hidden md:block">
    <Table aria-label="Tabla de transacciones">
      <TableCaption>Transacciones del mes actual en la zona horaria indicada.</TableCaption>
      <TableHeader>
        <TableRow>
          <TableHead>Contraparte</TableHead>
          <TableHead>Categoría</TableHead>
          <TableHead>Tipo</TableHead>
          <TableHead>Fecha</TableHead>
          <TableHead className="text-right">Monto</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((row) => (
          <TableRow key={row.id}>
            <TableCell className="font-medium">{row.counterpartyLabel}</TableCell>
            <TableCell>{row.categoryLabel}</TableCell>
            <TableCell>
              <Badge variant={row.direction === "inflow" ? "secondary" : "outline"}>
                {row.transactionTypeLabel}
              </Badge>
            </TableCell>
            <TableCell>{row.occurredOnText}</TableCell>
            <TableCell className="text-right font-medium tabular-nums">{row.moneyText}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  </div>
);

const MobileTransactions = ({
  rows,
}: Readonly<{
  rows: EffectArray.NonEmptyReadonlyArray<TransactionListRow>;
}>): JSX.Element => (
  <ul className="flex flex-col gap-3 md:hidden" aria-label="Lista móvil de transacciones">
    {rows.map((row) => (
      <li key={row.id}>
        <Card>
          <CardHeader>
            <CardTitle>{row.counterpartyLabel}</CardTitle>
            <CardDescription>{row.categoryLabel}</CardDescription>
            <CardAction className="font-medium tabular-nums">{row.moneyText}</CardAction>
          </CardHeader>
          <CardContent className="flex items-center justify-between gap-3">
            <Badge variant={row.direction === "inflow" ? "secondary" : "outline"}>
              {row.transactionTypeLabel}
            </Badge>
            <span className="text-sm text-muted-foreground">{row.occurredOnText}</span>
          </CardContent>
        </Card>
      </li>
    ))}
  </ul>
);

const ReadyTransactions = ({
  rows,
}: Readonly<{
  rows: EffectArray.NonEmptyReadonlyArray<TransactionListRow>;
}>): JSX.Element => (
  <section aria-label="Transacciones del mes" className="flex flex-col gap-4">
    <DesktopTransactions rows={rows} />
    <MobileTransactions rows={rows} />
  </section>
);

const EmptyTransactions = (): JSX.Element => (
  <Empty className="border">
    <EmptyHeader>
      <EmptyTitle>Aún no hay transacciones este mes</EmptyTitle>
      <EmptyDescription>
        Cuando Fidy registre un movimiento de este periodo, aparecerá aquí.
      </EmptyDescription>
    </EmptyHeader>
  </Empty>
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
      return <></>;
    case "Refreshing":
      return (
        <p aria-live="polite" className="text-sm text-muted-foreground">
          Actualizando transacciones…
        </p>
      );
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
    case "Ready":
      return (
        <>
          <QueryActivityNotice query={state.query} />
          <ReadyTransactions rows={state.rows} />
        </>
      );
    case "Empty":
      return (
        <>
          <QueryActivityNotice query={state.query} />
          <EmptyTransactions />
        </>
      );
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
}: Readonly<{ state: TransactionPageState }>): JSX.Element => {
  const period =
    state._tag === "Ready" || state._tag === "Empty" ? Option.some(state.period) : Option.none();
  return (
    <main className="mx-auto flex w-full max-w-6xl flex-col gap-6 px-4 py-8 sm:px-6 lg:px-8">
      <header className="flex flex-col gap-2">
        <h1 className="font-heading text-3xl font-semibold tracking-tight">Transacciones</h1>
        {Option.match(period, {
          onNone: () => <p className="text-muted-foreground">Movimientos del mes actual.</p>,
          onSome: (availablePeriod) => <TransactionPeriod period={availablePeriod} />,
        })}
      </header>
      <TransactionPageContent state={state} />
    </main>
  );
};

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

const TransactionRows = ({
  currentUser,
  period,
  query,
  rows,
}: Readonly<{
  currentUser: CurrentUser;
  period: ReturnType<typeof deriveCurrentMonthPeriod>;
  query: QueryActivity;
  rows: ReturnType<typeof presentTransactionRows>;
}>): JSX.Element => {
  const periodPresentation = presentPeriod({ locale: currentUser.locale, period });
  return EffectArray.match(rows, {
    onEmpty: () => (
      <TransactionListView state={{ _tag: "Empty", period: periodPresentation, query }} />
    ),
    onNonEmpty: (nonEmptyRows) => (
      <TransactionListView
        state={{ _tag: "Ready", period: periodPresentation, query, rows: nonEmptyRows }}
      />
    ),
  });
};

type TransactionPresentationInput = Parameters<typeof presentTransactionRows>[0];
type TransactionQueries = Readonly<{
  categoryState: CanonicalQueryState<
    Readonly<{ data: TransactionPresentationInput["categories"] }>,
    unknown
  >;
  period: ReturnType<typeof deriveCurrentMonthPeriod>;
  retry: () => void;
  transactionState: CanonicalQueryState<
    Readonly<{ data: TransactionPresentationInput["transactions"] }>,
    unknown
  >;
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
  const categoryState = presentCanonicalQuery(useAtomValue(categories));
  const transactionState = presentCanonicalQuery(useAtomValue(transactions));
  const refreshCategories = useAtomRefresh(categories);
  const refreshTransactions = useAtomRefresh(transactions);
  const retry = (): void => {
    refreshCategories();
    refreshTransactions();
  };
  return { categoryState, period, retry, transactionState };
};

const TransactionResources = ({
  currentUser,
}: Readonly<{ currentUser: CurrentUser }>): JSX.Element => {
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

  const rows = presentTransactionRows({
    categories: categoryState.value.data,
    counterpartyFallback: "Contraparte no identificada",
    locale: currentUser.locale,
    timeZone: currentUser.timeZone,
    transactions: transactionState.value.data,
  });
  return (
    <TransactionRows
      currentUser={currentUser}
      period={period}
      query={queryActivity({
        categoryFailed: Option.isSome(categoryState.refreshFailure),
        categoryWaiting: categoryState.waiting,
        onRetry: retry,
        transactionFailed: Option.isSome(transactionState.refreshFailure),
        transactionWaiting: transactionState.waiting,
      })}
      rows={rows}
    />
  );
};

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
          <TransactionResources currentUser={state.value.data} />
        </>
      );
  }
};

/** Transaction route whose canonical server state is owned exclusively by Effect Atom queries. */
export const TransactionListFeature = (): JSX.Element => <CurrentUserQuery />;
