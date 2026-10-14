import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { DateTime, Effect, Option } from "effect";
import { type JSX, useState } from "react";
import type { PrivacyTransactionPage, WebAuthClient } from "@/transport/client";
import { formatMoney } from "@/transport/money";
import { Alert, AlertDescription, AlertTitle } from "@/ui/components/alert";
import { Button } from "@/ui/components/button";

const TransactionPage = ({
  value,
  next,
  busy,
}: Readonly<{
  value: PrivacyTransactionPage;
  next: () => void;
  busy: boolean;
}>): JSX.Element => (
  <section aria-label="Copia de transacciones" className="flex flex-col gap-3">
    <p className="break-words">Referencia de consulta: {value.reference}</p>
    {value.data.length === 0 ? (
      <p>No hay transacciones en esta página.</p>
    ) : (
      <ul className="flex flex-col gap-3">
        {value.data.map((transaction) => (
          <li key={transaction.id} className="border-b pb-3">
            <p>
              {DateTime.formatIso(transaction.occurredAt)} ·{" "}
              {transaction.direction === "inflow" ? "Ingreso" : "Salida"} ·{" "}
              {formatMoney({ locale: "es-CO", money: transaction.money })}
            </p>
            <p className="break-words">{transaction.id}</p>
            {Option.isSome(transaction.counterparty) ? (
              <p>{transaction.counterparty.value}</p>
            ) : null}
            {Option.isSome(transaction.notes) ? (
              <p className="whitespace-pre-wrap">{transaction.notes.value}</p>
            ) : null}
          </li>
        ))}
      </ul>
    )}
    <p>
      {value.next === null
        ? "Fin de las transacciones disponibles."
        : "Hay más transacciones. Consulta la siguiente página para continuar."}
    </p>
    {value.next !== null ? (
      <div>
        <Button variant="outline" disabled={busy} onClick={next}>
          Siguiente página
        </Button>
      </div>
    ) : null}
  </section>
);

/** Explicit authenticated delivery of the Transactions scope; only one bounded page remains mounted. */
export const TransactionCopy = ({ client }: Readonly<{ client: WebAuthClient }>): JSX.Element => {
  const [operation] = useState(() =>
    client.runtime.fn<PrivacyTransactionPage["next"]>()((cursor) =>
      client.pipe(
        Effect.flatMap((api) => api.processingConsent.transactions({ payload: { cursor } })),
        Effect.asSome,
        Effect.catchCause(() => Effect.succeedNone)
      )
    )
  );
  const result = useAtomValue(operation);
  const load = useAtomSet(operation);
  const page = result._tag === "Success" ? result.value : Option.none<PrivacyTransactionPage>();
  return (
    <section className="flex flex-col gap-4 border-t pt-6">
      <h2 className="text-xl font-semibold">Acceso a tus transacciones</h2>
      <p>
        Consulta tus transacciones guardadas, incluso si retiraste tu autorización. Necesitas un
        inicio de sesión reciente. Esta consulta no reactiva el tratamiento ni requiere un plan de
        pago.
      </p>
      <p>
        Cada página muestra hasta 100 transacciones disponibles al momento de consultarla. Para
        solicitar otros datos o una corrección, usa el contacto de esta página.
      </p>
      <div>
        <Button variant="outline" disabled={result.waiting} onClick={() => load(null)}>
          {result.waiting ? "Consultando transacciones…" : "Consultar mis transacciones"}
        </Button>
      </div>
      {Option.isSome(page) ? (
        <TransactionPage
          value={page.value}
          busy={result.waiting}
          next={() => load(page.value.next)}
        />
      ) : null}
      {result._tag === "Success" && Option.isNone(page) ? (
        <Alert variant="destructive" role="alert">
          <AlertTitle>No pudimos consultar tus transacciones</AlertTitle>
          <AlertDescription>
            Inicia sesión de nuevo e intenta otra vez. No se cambió tu autorización ni se confirmó
            la entrega de datos.
          </AlertDescription>
        </Alert>
      ) : null}
    </section>
  );
};
