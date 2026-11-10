import { RefreshButton } from "@/ui/components/refresh-button";
import { Option } from "effect";
import type { JSX } from "react";
import { useTransactionCorrections } from "./correction-context";
import { Button } from "@/ui/components/button";
import type { DeletionStatus } from "./panel-state";
import type { Transaction } from "./presentation";

const DeletionFeedback = ({ status }: Readonly<{ status: DeletionStatus }>): JSX.Element => {
  if (status === "saving") return <output>Eliminando transacción…</output>;
  if (status === "rejected") {
    return (
      <p role="alert">
        No pudimos eliminar la transacción. Actualiza el historial antes de continuar. Si el detalle
        muestra un vínculo, puedes revisarlo para desvincular las transacciones.
      </p>
    );
  }
  if (status === "uncertain") {
    return (
      <p role="alert">
        No pudimos confirmar si se eliminó. Actualiza el historial antes de intentar otra acción.
      </p>
    );
  }
  return <></>;
};

const deletionStatus = (
  status: ReturnType<typeof useTransactionCorrections>["status"]
): DeletionStatus => {
  if (status === "recovering" || status === "refreshing") return "saving";
  return status === "recovered" ? "idle" : status;
};
/** Confirms permanent visibility removal; uncertain outcomes require a fresh history read. */
export const TransactionDeletion = (
  props: Readonly<{
    transaction: Transaction;
    editable: boolean;
    onDeleted: () => void;
    onCancel: () => void;
    onRefresh: () => void;
  }>
): JSX.Element => {
  const owner = useTransactionCorrections();
  const status = deletionStatus(owner.status);
  const confirm = (): void => {
    if (!props.editable) return;
    owner.confirmDeletion(props.transaction.id, props.onDeleted);
  };
  const admitted = Option.contains(owner.reviewingDeletion, props.transaction.id);
  return (
    <section aria-label="Eliminar transacción" className="flex flex-col gap-4">
      <h3 className="sr-only">¿Eliminar esta transacción?</h3>
      <p className="text-sm text-muted-foreground">
        Dejará de aparecer en tu historial y en los cálculos. No puedes deshacer esta acción.
        Conservamos los registros de dónde se obtuvo.
      </p>
      <DeletionFeedback status={status} />
      {status === "rejected" || status === "uncertain" ? (
        <RefreshButton
          variant="outline"
          onClick={props.onRefresh}
          label="Actualizar transacciones"
        />
      ) : (
        <div data-transaction-slot="transaction-form-actions transaction-delete-actions">
          <Button
            variant="outline"
            disabled={status === "saving"}
            onClick={() => {
              owner.cancelDeletion();
              props.onCancel();
            }}
          >
            Cancelar
          </Button>
          <Button
            variant="outline"
            data-transaction-slot="transaction-danger"
            disabled={status !== "idle" || !props.editable || !admitted}
            onClick={confirm}
          >
            Eliminar
          </Button>
        </div>
      )}
    </section>
  );
};
