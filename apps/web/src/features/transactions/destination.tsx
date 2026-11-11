import { Link } from "@tanstack/react-router";
import { Option, Predicate } from "effect";
import type { JSX } from "react";
import type { presentCanonicalQuery } from "@/transport/canonical-query";
import { Button } from "@/ui/components/button";
import { CanonicalQueryRetry } from "@/ui/canonical-query-feedback";

export const TransactionDestinationFailure = ({
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
