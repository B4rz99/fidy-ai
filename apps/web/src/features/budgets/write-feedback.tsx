import { type JSX } from "react";
import { Alert, AlertDescription } from "@/ui/components/alert";
import type { BudgetEditing } from "./model";

const writeMessages = {
  save: {
    saving: "Guardando presupuesto…",
    saved: "Presupuesto guardado.",
    failed:
      "No se pudo guardar. Usa un importe positivo con la precisión de su moneda y un nombre de grupo válido.",
    uncertain:
      "No pudimos confirmar el guardado. Actualiza para comprobar el plan antes de volver a editar.",
  },
  delete: {
    saving: "Eliminando presupuesto…",
    saved: "Presupuesto eliminado de todos los meses.",
    failed:
      "No se pudo eliminar el presupuesto. Actualiza para comprobar si todavía existe antes de intentarlo de nuevo.",
    uncertain:
      "No pudimos confirmar la eliminación. Actualiza para comprobar el plan antes de volver a editar.",
  },
};
const feedbackVariants = {
  saving: "pending",
  saved: "success",
  failed: "destructive",
  uncertain: "destructive",
} as const;
export const BudgetWriteFeedback = ({
  saveState,
  writeAction,
}: Pick<BudgetEditing, "saveState" | "writeAction">): JSX.Element => {
  if (saveState === "idle") return <></>;
  return (
    <Alert
      role={saveState === "saving" || saveState === "saved" ? "status" : "alert"}
      variant={feedbackVariants[saveState]}
    >
      <AlertDescription>{writeMessages[writeAction][saveState]}</AlertDescription>
    </Alert>
  );
};
