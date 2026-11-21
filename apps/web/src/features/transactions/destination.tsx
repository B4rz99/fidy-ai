import { Link, useSearch } from "@tanstack/react-router";
import { type Data, Option, Predicate } from "effect";
import type { JSX } from "react";
import type { presentCanonicalQuery } from "@/transport/canonical-query";
import { Button } from "@/ui/components/button";
import { CanonicalQueryRetry } from "@/ui/canonical-query-feedback";

export const TransactionDestinationRecovery = (): JSX.Element => {
  const search = useSearch({ from: "/independent-application/app/transactions" });

  return search.date === undefined ? (
    <Button
      variant="outline"
      render={<Link to="/app/needs-review" search={{ status: "history" }} />}
    >
      Volver al historial
    </Button>
  ) : (
    <Button
      variant="outline"
      render={<Link to="/app/transactions" search={{ date: search.date }} />}
    >
      Volver a las transacciones
    </Button>
  );
};

export const TransactionDestinationFailure = ({
  state,
  refresh,
}: Readonly<{
  state: Exclude<
    ReturnType<typeof presentCanonicalQuery>,
    Data.TaggedEnum.Value<ReturnType<typeof presentCanonicalQuery>, "Initial">
  >;
  refresh: () => void;
}>): JSX.Element => {
  const failure = Predicate.isTagged(state, "Failure")
    ? Option.some(state.failure)
    : state.refreshFailure;

  const unavailable = Option.exists(
    failure,
    (error) =>
      Predicate.isTagged(error, "DeclaredFailure") && Predicate.isTagged(error.error, "NotFound")
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
      <TransactionDestinationRecovery />
    </main>
  );
};
