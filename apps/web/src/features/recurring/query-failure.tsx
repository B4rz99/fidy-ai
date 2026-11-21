import { type JSX, useState } from "react";
import { Predicate } from "effect";
import type { CanonicalQueryState } from "@/transport/canonical-query";
import { CanonicalQueryRetry } from "@/ui/canonical-query-feedback";

const failureCopy = (
  limited: boolean,
  retried: boolean
): Readonly<{ title: string; description: string }> => {
  if (limited) {
    return {
      title: "Alcanzaste el límite de solicitudes",
      description: "Inténtalo de nuevo más tarde. Tus datos siguen guardados.",
    };
  }
  return retried
    ? {
        title: "El reintento no funcionó",
        description: "Vuelve a intentarlo en unos minutos.",
      }
    : {
        title: "No pudimos cargar tus recurrentes",
        description: "Vuelve a intentarlo.",
      };
};

export const RecurringQueryFailure = ({
  states,
  waiting,
  retry,
}: Readonly<{
  states: ReadonlyArray<CanonicalQueryState<unknown, unknown>>;
  waiting: boolean;
  retry: () => void;
}>): JSX.Element => {
  const [retried, setRetried] = useState(false);
  const limited = states.some(
    (state) =>
      state._tag === "Failure" &&
      state.failure._tag === "DeclaredFailure" &&
      Predicate.isTagged(state.failure.error, "ResourceLimited")
  );
  const copy = failureCopy(limited, retried && !waiting);
  return (
    <div className="p-5">
      <CanonicalQueryRetry
        title={copy.title}
        description={copy.description}
        retryLabel="Reintentar"
        retryingLabel="Reintentando…"
        waiting={waiting}
        onRetry={() => {
          setRetried(true);
          retry();
        }}
      />
    </div>
  );
};
