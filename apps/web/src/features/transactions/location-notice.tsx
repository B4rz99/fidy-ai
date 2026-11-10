import { Link } from "@tanstack/react-router";
import type { JSX } from "react";
import { Button } from "@/ui/components/button";
import type { HistoryState } from "./history";

export const TransactionLocationNotice = ({
  history,
  onMore,
  onRetry,
}: Readonly<{
  history: HistoryState;
  onMore: () => void;
  onRetry: () => void;
}>): JSX.Element => {
  if (history.location === "None" || history.location === "Located") return <></>;
  return (
    <output className="flex flex-wrap items-center gap-3 px-4 py-3">
      <LocationProgress location={history.location} onMore={onMore} onRetry={onRetry} />
    </output>
  );
};
const LocationProgress = ({
  location,
  onMore,
  onRetry,
}: Readonly<{
  location: HistoryState["location"];
  onMore: () => void;
  onRetry: () => void;
}>): JSX.Element => {
  switch (location) {
    case "NotFound":
      return (
        <>
          <p>La transacción ya no aparece en este periodo.</p>
          <Button
            variant="outline"
            render={<Link to="/app/needs-review" search={{ status: "history" }} />}
          >
            Volver al historial
          </Button>
        </>
      );
    case "BoundReached":
      return (
        <>
          <p>La transacción aún no aparece entre los registros cargados.</p>
          <Button variant="outline" onClick={onMore}>
            Seguir buscando
          </Button>
        </>
      );
    case "LookupFailed":
    case "ContinuationFailed":
      return (
        <>
          <p>No pudimos terminar de localizar la transacción.</p>
          <Button variant="outline" onClick={onRetry}>
            Reintentar búsqueda
          </Button>
        </>
      );
    case "None":
    case "Located":
      return <></>;
    case "Locating":
      return <p>Buscando la transacción en este periodo…</p>;
  }
};
