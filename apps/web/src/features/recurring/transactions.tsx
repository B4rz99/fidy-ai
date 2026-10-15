import { useAtomRefresh, useAtomValue } from "@effect/atom-react";
import { useRouter } from "@tanstack/react-router";
import { DateTime, Option, Schema } from "effect";
import { type JSX, useState } from "react";
import { type CanonicalSuccess, TransactionQueryValues } from "@/transport/client";
import { presentCanonicalQuery } from "@/transport/canonical-query";
import { Button } from "@/ui/components/button";
import { money } from "./model";

type Transaction = CanonicalSuccess<"transactions.listTransactions">["data"][number];
type Props = Readonly<{ choose: (transaction: Transaction) => void; disabled: boolean }>;
const continuation = (
  page: CanonicalSuccess<"transactions.listTransactions">
): Option.Option<string> => {
  const suggestion = page.next.find((entry) => entry.tool === "transactions.listTransactions");
  if (suggestion === undefined || !("args" in suggestion) || Option.isNone(suggestion.args)) {
    return Option.none();
  }
  return Schema.decodeUnknownOption(
    Schema.Struct({ query: Schema.Struct({ cursor: TransactionQueryValues.fields.cursor }) })
  )(suggestion.args.value).pipe(Option.map((value) => value.query.cursor));
};
/** Browse bounded canonical pages; no browser-local copy of financial history is authoritative. */
export const TransactionPicker = (props: Props): JSX.Element => {
  const [cursor, setCursor] = useState<Option.Option<string>>(Option.none());
  return (
    <TransactionPage
      key={Option.getOrElse(cursor, () => "first")}
      {...props}
      cursor={cursor}
      next={setCursor}
    />
  );
};
type PageProps = Props &
  Readonly<{
    cursor: Option.Option<string>;
    next: (cursor: Option.Option<string>) => void;
  }>;
const TransactionPage = ({ choose, disabled, cursor, next }: PageProps): JSX.Element => {
  const client = useRouter().options.context.apiClient;
  const [resource] = useState(() =>
    client.query("transactions", "listTransactions", {
      query: Option.isSome(cursor) ? { cursor: cursor.value } : {},
    })
  );
  const state = useAtomValue(resource).pipe(presentCanonicalQuery);
  const refresh = useAtomRefresh(resource);
  if (state._tag === "Failure") {
    return (
      <Button variant="outline" onClick={refresh}>
        Reintentar transacciones
      </Button>
    );
  }
  if (state._tag !== "Ready") return <output>Cargando transacciones…</output>;
  const blocked = disabled || state.waiting;
  return (
    <TransactionResults
      {...{ choose, cursor, next, refresh }}
      page={state.value}
      stale={Option.isSome(state.refreshFailure)}
      disabled={blocked}
    />
  );
};
const TransactionResults = ({
  choose,
  disabled,
  cursor,
  next,
  refresh,
  page,
  stale,
}: PageProps &
  Readonly<{
    refresh: () => void;
    page: CanonicalSuccess<"transactions.listTransactions">;
    stale: boolean;
  }>): JSX.Element => {
  const blocked = disabled || stale;
  const more = continuation(page);
  return (
    <div className="grid gap-2">
      {stale ? (
        <Button variant="outline" onClick={refresh}>
          Actualizar transacciones
        </Button>
      ) : null}
      {page.data.map((transaction) => (
        <Button
          key={transaction.id}
          variant="outline"
          disabled={blocked}
          onClick={() => choose(transaction)}
        >
          {Option.getOrElse(transaction.counterparty, () => "Transacción")} ·{" "}
          {money(transaction.money)} · {DateTime.formatIsoDateUtc(transaction.occurredAt)}
        </Button>
      ))}
      {page.data.length === 0 ? (
        <p className="text-sm text-muted-foreground">Sin transacciones en esta página.</p>
      ) : null}
      {Option.isSome(more) ? (
        <Button variant="ghost" disabled={blocked} onClick={() => next(more)}>
          Ver más transacciones
        </Button>
      ) : null}
      {Option.isSome(cursor) ? (
        <Button variant="ghost" onClick={() => next(Option.none())}>
          Volver a las más recientes
        </Button>
      ) : null}
    </div>
  );
};
