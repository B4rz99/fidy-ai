import { Link } from "@tanstack/react-router";
import { Option } from "effect";
import type { JSX } from "react";
import { Button } from "@/ui/components/button";
import type { HistoryState } from "./history";

export const TransactionLocationNotice = ({
  locate,
  history,
  onMore,
  onRetry,
}: Readonly<{
  locate: Option.Option<string>;
  history: HistoryState;
  onMore: () => void;
  onRetry: () => void;
}>): JSX.Element => {
  const query = history.query;
  if (Option.isNone(locate) || query._tag !== "Ready" || query.waiting) return <></>;
  if (query.value.data.some((transaction) => transaction.id === locate.value)) return <></>;
  return (
    <output className="flex flex-wrap items-center gap-3 px-4 py-3">
      <LocationProgress continuation={history.continuation} onMore={onMore} onRetry={onRetry} />
    </output>
  );
};
const LocationProgress = ({
  continuation,
  onMore,
  onRetry,
}: Readonly<{
  continuation: HistoryState["continuation"];
  onMore: () => void;
  onRetry: () => void;
}>): JSX.Element => {
  switch (continuation) {
    case "complete":
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
    case "available":
      return (
        <>
          <p>La transacción aún no aparece entre los registros cargados.</p>
          <Button variant="outline" onClick={onMore}>
            Seguir buscando
          </Button>
        </>
      );
    case "failure":
      return (
        <>
          <p>No pudimos terminar de localizar la transacción.</p>
          <Button variant="outline" onClick={onRetry}>
            Reintentar búsqueda
          </Button>
        </>
      );
    case "loading":
      return <p>Buscando la transacción en este periodo…</p>;
  }
};
