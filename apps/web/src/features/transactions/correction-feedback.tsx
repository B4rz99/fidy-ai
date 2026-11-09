import type { JSX } from "react";
import { RefreshButton } from "@/ui/components/refresh-button";
import { useTransactionCorrections } from "./correction-context";

const retainedCopy = {
  single: "Conservamos tus cambios.",
  bulk: "Conservamos tus cambios y la selección.",
};
export const CorrectionRecoveryFeedback = ({
  kind,
}: Readonly<{ kind: "single" | "bulk" }>): JSX.Element => {
  const corrections = useTransactionCorrections();
  const retained = retainedCopy[kind];
  switch (corrections.status) {
    case "refreshing":
      return (
        <output className="text-sm">
          No se guardaron los cambios. Actualizando el historial automáticamente. {retained}
        </output>
      );
    case "recovered":
      return (
        <output className="text-sm">
          No se guardaron los cambios. Ya actualizamos el historial. {retained} Puedes volver a
          guardar.
        </output>
      );
    case "rejected":
      return (
        <div role="alert" className="text-sm">
          <p>No se guardaron los cambios. No pudimos actualizar el historial. {retained}</p>
          <RefreshButton variant="outline" onClick={corrections.recover} label="Reintentar" />
        </div>
      );
    case "uncertain":
      return (
        <div role="alert" className="text-sm">
          <p>
            No pudimos confirmar los cambios. Actualiza el historial y revisa las transacciones
            antes de volver a editar.
          </p>
          <RefreshButton
            variant="outline"
            onClick={corrections.recover}
            label="Actualizar historial"
          />
        </div>
      );
    case "idle":
    case "saving":
    case "recovering":
      return <></>;
  }
};
