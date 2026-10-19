import type { JSX } from "react";
import { Predicate } from "effect";
import type { CanonicalQueryState } from "@/transport/canonical-query";
import { CanonicalQueryRetry } from "@/ui/canonical-query-feedback";

export const RecurringQueryFailure = ({
  states,
  waiting,
  retry,
}: Readonly<{
  states: ReadonlyArray<CanonicalQueryState<unknown, unknown>>;
  waiting: boolean;
  retry: () => void;
}>): JSX.Element => {
  const limited = states.some(
    (state) =>
      state._tag === "Failure" &&
      state.failure._tag === "DeclaredFailure" &&
      Predicate.isTagged(state.failure.error, "ResourceLimited")
  );
  return (
    <div className="p-5">
      <CanonicalQueryRetry
        title={
          limited ? "Alcanzaste el límite de solicitudes" : "No pudimos cargar tus recurrentes"
        }
        description={
          limited
            ? "Inténtalo de nuevo más tarde. Tus datos siguen guardados."
            : "Tus datos no se han reemplazado por una lista vacía."
        }
        retryLabel="Reintentar"
        retryingLabel="Reintentando…"
        waiting={waiting}
        onRetry={retry}
      />
    </div>
  );
};
