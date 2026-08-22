import { useAtomValue } from "@effect/atom-react";
import { useRouter } from "@tanstack/react-router";
import { DateTime, Effect, Array as EffectArray } from "effect";
import { AsyncResult } from "effect/unstable/reactivity";
import { useState } from "react";
import type { JSX } from "react";
import { Alert, AlertDescription, AlertTitle } from "@/ui/components/alert";
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

/** Exhaustive rendering state for the current-month Transaction list. */
export type TransactionPageState =
  | Readonly<{ _tag: "Loading" }>
  | Readonly<{ _tag: "Empty"; period: PeriodPresentation }>
  | Readonly<{
      _tag: "Ready";
      period: PeriodPresentation;
      rows: EffectArray.NonEmptyReadonlyArray<TransactionListRow>;
    }>
  | Readonly<{ _tag: "CanonicalError" }>;

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

const CanonicalError = (): JSX.Element => (
  <Alert variant="destructive">
    <AlertTitle>No pudimos cargar tus transacciones</AlertTitle>
    <AlertDescription>Intenta de nuevo en unos momentos.</AlertDescription>
  </Alert>
);

/** Renders the current-month Transaction list's presentation state. */
export const TransactionListView = ({
  state,
}: Readonly<{ state: TransactionPageState }>): JSX.Element => (
  <main className="mx-auto flex w-full max-w-6xl flex-col gap-6 px-4 py-8 sm:px-6 lg:px-8">
    <header className="flex flex-col gap-2">
      <h1 className="font-heading text-3xl font-semibold tracking-tight">Transacciones</h1>
      {state._tag === "Ready" || state._tag === "Empty" ? (
        <TransactionPeriod period={state.period} />
      ) : (
        <p className="text-muted-foreground">Movimientos del mes actual.</p>
      )}
    </header>
    {state._tag === "Loading" ? <LoadingTransactions /> : null}
    {state._tag === "Ready" ? <ReadyTransactions rows={state.rows} /> : null}
    {state._tag === "Empty" ? <EmptyTransactions /> : null}
    {state._tag === "CanonicalError" ? <CanonicalError /> : null}
  </main>
);

const TransactionResources = ({
  currentUser,
}: Readonly<{ currentUser: CurrentUser }>): JSX.Element => {
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
  const categoryResult = useAtomValue(categories);
  const transactionResult = useAtomValue(transactions);
  const periodPresentation = presentPeriod({ locale: currentUser.locale, period });

  if (AsyncResult.isFailure(categoryResult) || AsyncResult.isFailure(transactionResult)) {
    return <TransactionListView state={{ _tag: "CanonicalError" }} />;
  }
  if (!AsyncResult.isSuccess(categoryResult) || !AsyncResult.isSuccess(transactionResult)) {
    return <TransactionListView state={{ _tag: "Loading" }} />;
  }

  const rows = presentTransactionRows({
    categories: categoryResult.value.data,
    counterpartyFallback: "Contraparte no identificada",
    locale: currentUser.locale,
    timeZone: currentUser.timeZone,
    transactions: transactionResult.value.data,
  });
  return EffectArray.match(rows, {
    onEmpty: () => <TransactionListView state={{ _tag: "Empty", period: periodPresentation }} />,
    onNonEmpty: (nonEmptyRows) => (
      <TransactionListView
        state={{ _tag: "Ready", period: periodPresentation, rows: nonEmptyRows }}
      />
    ),
  });
};

const CurrentUserQuery = (): JSX.Element => {
  const router = useRouter();
  const [currentUser] = useState(() =>
    router.options.context.apiClient.query("identity", "getCurrentUser", {})
  );
  const result = useAtomValue(currentUser);
  if (AsyncResult.isFailure(result)) {
    return <TransactionListView state={{ _tag: "CanonicalError" }} />;
  }
  return AsyncResult.isSuccess(result) ? (
    <TransactionResources currentUser={result.value.data} />
  ) : (
    <TransactionListView state={{ _tag: "Loading" }} />
  );
};

/** Transaction route whose canonical server state is owned exclusively by Effect Atom queries. */
export const TransactionListFeature = (): JSX.Element => <CurrentUserQuery />;
