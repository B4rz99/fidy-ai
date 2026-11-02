import { useAtomRefresh, useAtomValue } from "@effect/atom-react";
import { useRouter } from "@tanstack/react-router";
import { DateTime, Option, Schema } from "effect";
import { type JSX, useMemo, useState } from "react";
import { type CanonicalSuccess, TransactionQueryValues } from "@/transport/client";
import { presentCanonicalQuery } from "@/transport/canonical-query";
import { formatMoney } from "@/transport/money";
import { Button } from "@/ui/components/button";
import { SelectionListSkeleton } from "@/ui/components/loading-skeletons";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/ui/components/sheet";
import type { BudgetReport, BudgetStatus, Category, CurrentUser } from "./presentation";

type Props = Readonly<{
  category: Category;
  spent: BudgetStatus["spent"];
  period: BudgetReport["period"];
  user: CurrentUser;
}>;
type Page = CanonicalSuccess<"transactions.listTransactions">;
const continuation = (page: Page): Option.Option<string> => {
  const suggestion = page.next.find((entry) => entry.tool === "transactions.listTransactions");
  if (suggestion === undefined || !("args" in suggestion) || Option.isNone(suggestion.args)) {
    return Option.none();
  }
  return Option.some(
    Schema.decodeUnknownSync(
      Schema.Struct({ query: Schema.Struct({ cursor: TransactionQueryValues.fields.cursor }) })
    )(suggestion.args.value).query.cursor
  );
};

/** Opening a spending amount mounts a bounded, read-only canonical history query. */
export const BudgetSpending = (props: Props): JSX.Element => {
  const [open, setOpen] = useState(false);
  const amount = formatMoney({ locale: props.user.locale, money: props.spent });
  const month = useMemo(
    () =>
      new Intl.DateTimeFormat(props.user.locale, {
        month: "long",
        year: "numeric",
        timeZone: props.period.timeZone,
      }).format(props.period.from.epochMilliseconds),
    [props.user.locale, props.period.timeZone, props.period.from.epochMilliseconds]
  );
  return (
    <>
      <Button
        variant="link"
        size="label"
        aria-label={`Ver movimientos de ${props.category.label} en ${props.spent.currency}: ${amount}`}
        onClick={() => setOpen(true)}
      >
        {amount}
      </Button>
      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent side="right" showCloseButton appearance="application">
          <SheetHeader>
            <SheetTitle>Movimientos de {props.category.label}</SheetTitle>
            <SheetDescription>
              Gastos en {props.spent.currency} · {month}
            </SheetDescription>
          </SheetHeader>
          <div className="min-h-0 overflow-y-auto px-4 pb-4">
            {open ? <SpendingHistory {...props} /> : null}
          </div>
        </SheetContent>
      </Sheet>
    </>
  );
};
const SpendingHistory = (props: Props): JSX.Element => {
  const [cursor, setCursor] = useState<Option.Option<string>>(() => Option.none());
  return (
    <SpendingPage
      key={Option.getOrElse(cursor, () => "first")}
      {...props}
      cursor={cursor}
      next={setCursor}
    />
  );
};
type PageProps = Props &
  Readonly<{ cursor: Option.Option<string>; next: (cursor: Option.Option<string>) => void }>;
const SpendingPage = ({ category, spent, period, user, cursor, next }: PageProps): JSX.Element => {
  const client = useRouter().options.context.apiClient;
  const [resource] = useState(() =>
    client.query("transactions", "listTransactions", {
      query: {
        from: period.from,
        to: period.to,
        categoryId: category.id,
        currency: spent.currency,
        direction: "outflow",
        ...(Option.isSome(cursor) ? { cursor: cursor.value } : {}),
      },
    })
  );
  const state = useAtomValue(resource).pipe(presentCanonicalQuery);
  const refresh = useAtomRefresh(resource);
  if (state._tag === "Failure") return <SpendingRetry retry={refresh} waiting={state.waiting} />;
  if (state._tag !== "Ready") return <SelectionListSkeleton label="Cargando movimientos" />;
  return (
    <div className="grid gap-3">
      {Option.isSome(state.refreshFailure) ? (
        <SpendingRetry retry={refresh} waiting={state.waiting} />
      ) : null}
      <SpendingResults page={state.value} user={user} timeZone={period.timeZone} />
      <SpendingNavigation
        page={state.value}
        cursor={cursor}
        next={next}
        disabled={state.waiting || Option.isSome(state.refreshFailure)}
      />
    </div>
  );
};
const SpendingRetry = ({
  retry,
  waiting,
}: Readonly<{ retry: () => void; waiting: boolean }>): JSX.Element => (
  <div role="alert" className="grid gap-2">
    <p>No pudimos cargar los movimientos.</p>
    <Button variant="outline" disabled={waiting} onClick={retry}>
      Reintentar movimientos
    </Button>
  </div>
);
const SpendingResults = ({
  page,
  user,
  timeZone,
}: Readonly<{ page: Page; user: CurrentUser; timeZone: string }>): JSX.Element => (
  <ul className="grid gap-3">
    {page.data.map((transaction) => (
      <li key={transaction.id} className="grid gap-1 border-b pb-3 text-sm">
        <span>
          {Option.getOrElse(transaction.counterparty, () => "Contraparte no identificada")}
        </span>
        <span className="tabular-nums">
          {formatMoney({ locale: user.locale, money: transaction.money })}
        </span>
        <span className="text-muted-foreground">
          {DateTime.formatIsoDate(
            DateTime.setZone(transaction.occurredAt, DateTime.zoneMakeNamedUnsafe(timeZone))
          )}
        </span>
        {Option.isSome(transaction.notes) ? <p>{transaction.notes.value}</p> : null}
      </li>
    ))}
    {page.data.length === 0 ? <li>Sin movimientos en esta página.</li> : null}
  </ul>
);
const SpendingNavigation = ({
  page,
  cursor,
  next,
  disabled,
}: Readonly<{
  page: Page;
  cursor: Option.Option<string>;
  next: (cursor: Option.Option<string>) => void;
  disabled: boolean;
}>): JSX.Element => {
  const more = continuation(page);
  return (
    <>
      {Option.isSome(more) ? (
        <Button variant="outline" disabled={disabled} onClick={() => next(more)}>
          Ver más movimientos
        </Button>
      ) : null}
      {Option.isSome(cursor) ? (
        <Button variant="ghost" disabled={disabled} onClick={() => next(Option.none())}>
          Volver a los más recientes
        </Button>
      ) : null}
    </>
  );
};
