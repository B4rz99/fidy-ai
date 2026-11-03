import { PendingRead } from "@/ui/components/pending-read";
import { useAtomRefresh, useAtomValue } from "@effect/atom-react";
import { Link, useRouter } from "@tanstack/react-router";
import { Option, Predicate } from "effect";
import { type JSX, type ReactNode, useState } from "react";
import { presentCanonicalQuery } from "@/transport/canonical-query";
import { type CanonicalInput } from "@/transport/client";
import { Button } from "@/ui/components/button";
import { CanonicalQueryRetry } from "@/ui/canonical-query-feedback";

import type { Transaction } from "./presentation";
import { transactionDestinationQuery } from "./destination-query";

export const TransactionDestination = ({
  id,
  children,
}: Readonly<{
  id: CanonicalInput<"transactions.getTransaction">["params"]["id"];
  children: (transaction: Transaction) => ReactNode;
}>): JSX.Element => {
  const client = useRouter().options.context.apiClient;
  const [query] = useState(() => transactionDestinationQuery({ client, id }));
  const state = useAtomValue(query).pipe(presentCanonicalQuery);
  const refresh = useAtomRefresh(query);
  if (state._tag === "Initial" || (state._tag === "Ready" && state.waiting)) {
    return <PendingRead label="Cargando transacciones" />;
  }
  if (state._tag === "Ready" && Option.isNone(state.refreshFailure)) {
    return <>{children(state.value.data)}</>;
  }
  return <DestinationFailure state={state} refresh={refresh} />;
};
const DestinationFailure = ({
  state,
  refresh,
}: Readonly<{
  state: Exclude<ReturnType<typeof presentCanonicalQuery>, { _tag: "Initial" }>;
  refresh: () => void;
}>): JSX.Element => {
  const failure = state._tag === "Failure" ? Option.some(state.failure) : state.refreshFailure;
  const unavailable = Option.exists(
    failure,
    (error) => error._tag === "DeclaredFailure" && Predicate.isTagged(error.error, "NotFound")
  );
  return (
    <main className="p-5">
      <h1 className="mb-6 text-3xl font-semibold">Transacciones</h1>
      <CanonicalQueryRetry
        title={unavailable ? "Transacción no disponible" : "No pudimos cargar la transacción"}
        description={
          unavailable
            ? "No encontramos esta transacción o ya no tienes acceso a ella."
            : "Intenta de nuevo en unos momentos."
        }
        onRetry={refresh}
        retryLabel="Reintentar"
        retryingLabel="Reintentando…"
        waiting={state.waiting}
      />
      <Button
        variant="outline"
        render={<Link to="/app/needs-review" search={{ status: "history" }} />}
      >
        Volver al historial
      </Button>
    </main>
  );
};
