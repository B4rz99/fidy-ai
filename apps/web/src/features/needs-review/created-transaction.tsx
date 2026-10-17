import { TransactionId } from "@/transport/client";
import { useAtomRefresh, useAtomValue } from "@effect/atom-react";
import { Link, useParams, useRouter } from "@tanstack/react-router";
import { DateTime, Option, Schema } from "effect";
import { type JSX, useState } from "react";
import { presentCanonicalQuery } from "@/transport/canonical-query";
import { formatMoneyWithCode } from "@/transport/money";
import { Button } from "@/ui/components/button";
import { WorkspaceHeader } from "@/ui/components/workspace-layout";

export const CreatedReviewTransaction = (): JSX.Element => {
  const { id } = useParams({ from: "/authenticated/app/needs-review/transactions/$id" });
  const apiClient = useRouter().options.context.apiClient;
  const [query] = useState(() =>
    apiClient.query("transactions", "getTransaction", {
      params: { id: Schema.decodeSync(TransactionId)(id) },
    })
  );
  const state = useAtomValue(query).pipe(presentCanonicalQuery);
  const refresh = useAtomRefresh(query);
  return (
    <>
      <WorkspaceHeader title="Transacción creada" context={null}>
        <Button variant="outline" render={<Link to="/app/needs-review" />}>
          Volver a Por revisar
        </Button>
      </WorkspaceHeader>
      {state._tag === "Ready" ? (
        <article className="grid max-w-xl gap-4 p-5">
          <h2 className="text-2xl font-medium">
            {formatMoneyWithCode({ money: state.value.data.money, locale: "es-CO" })}
          </h2>
          <p>{state.value.data.direction === "outflow" ? "Salida" : "Entrada"}</p>
          <p>
            {Option.getOrElse(state.value.data.counterparty, () => "Sin contraparte registrada")}
          </p>
          <p>
            {DateTime.format(state.value.data.occurredAt, {
              locale: "es-CO",
              timeZone: "America/Bogota",
              dateStyle: "long",
              timeStyle: "short",
            })}
          </p>
          <p className="text-sm text-muted-foreground">
            Datos confirmados por ti durante la revisión.
          </p>
        </article>
      ) : (
        <div className="p-5">
          <p>No pudimos mostrar la transacción.</p>
          <Button variant="outline" onClick={refresh}>
            Reintentar
          </Button>
        </div>
      )}
    </>
  );
};
