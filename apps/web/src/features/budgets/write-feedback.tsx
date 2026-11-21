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

const inlineMessages = {
  saving: "Guardando presupuesto…",
  saved: "Presupuesto guardado.",
  failed:
    "No se pudo guardar. Tu importe se conserva. Revísalo o vuelve a elegir el mes para reintentar y continuar.",
  uncertain:
    "No pudimos confirmar el guardado. Tu importe se conserva. Usa Actualizar para comprobar el plan antes de continuar.",
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
  inline,
}: Pick<BudgetEditing, "saveState" | "writeAction"> &
  Readonly<{ inline: boolean }>): JSX.Element => {
  if (saveState === "idle") return <></>;

  return (
    <Alert
      role={saveState === "saving" || saveState === "saved" ? "status" : "alert"}
      variant={inline && saveState === "uncertain" ? "warning" : feedbackVariants[saveState]}
    >
      <AlertDescription>
        {inline ? inlineMessages[saveState] : writeMessages[writeAction][saveState]}
      </AlertDescription>
    </Alert>
  );
};
