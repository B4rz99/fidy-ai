import { type JSX, type RefCallback } from "react";
import { RefreshButton } from "@/ui/components/refresh-button";
import { Button } from "@/ui/components/button";
import type { BudgetDraft, SaveState } from "./model";
import { BudgetWriteFeedback } from "./write-feedback";

const focusCancel: RefCallback<HTMLButtonElement> = (button): void => {
  button?.focus();
};

export const BudgetDeletion = ({
  draft,
  month,
  disabled,
  onCancel,
  onRemove,
  onRefresh,
  saveState,
}: Readonly<{
  draft: BudgetDraft;
  month: string;
  disabled: boolean;
  onCancel: () => void;
  onRemove: () => void;
  onRefresh: () => void;
  saveState: SaveState;
}>): JSX.Element => (
  <section
    aria-label={`Eliminar presupuesto de ${draft.category.label}`}
    className="flex flex-col gap-5"
  >
    <h2 className="text-lg font-semibold">Eliminar presupuesto de {draft.category.label}</h2>
    <p className="text-sm text-muted-foreground">
      Se eliminará de forma permanente el presupuesto de {draft.category.label} en todos los meses:
      el mes seleccionado ({month}), los meses anteriores y los meses posteriores guardados. Los
      planes futuros dejarán de heredarlo. También se eliminarán sus marcas de alerta mensuales.
    </p>
    <p className="text-sm text-muted-foreground">
      Tus transacciones se conservan y siguen contando en los resúmenes de gastos. Las alertas ya
      registradas en tu historial se conservan. Esta acción no se puede deshacer.
    </p>
    <BudgetWriteFeedback saveState={saveState} writeAction="delete" />
    {saveState === "uncertain" || saveState === "failed" ? (
      <RefreshButton variant="outline" onClick={onRefresh} label="Actualizar presupuestos" />
    ) : null}
    <Button
      ref={focusCancel}
      type="button"
      variant="outline"
      disabled={disabled}
      onClick={onCancel}
    >
      Cancelar
    </Button>
    <Button
      type="button"
      variant="destructive"
      contentLayout="wrap"
      disabled={disabled}
      onClick={onRemove}
    >
      Eliminar de todos los meses
    </Button>
  </section>
);
