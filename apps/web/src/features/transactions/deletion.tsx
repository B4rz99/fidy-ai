import { useAtomSet } from "@effect/atom-react";
import { Cause, Effect, Predicate } from "effect";
import type * as Atom from "effect/reactivity/Atom";
import { useState } from "react";
import type { JSX } from "react";
import type { FidyClient } from "@/transport/client";
import { Button } from "@/ui/components/button";
import type { DeletionStatus } from "./panel-state";
import type { Transaction } from "./presentation";

type DeletionOutcome = Readonly<{
  onDeleted: () => void;
  onRejected: () => void;
  onUncertain: () => void;
}>;
const makeTransactionDeletion = (
  apiClient: FidyClient,
  id: Transaction["id"]
): Atom.AtomResultFn<DeletionOutcome, void, never> =>
  apiClient.runtime.fn<DeletionOutcome>()((command) =>
    Effect.gen(function* () {
      const client = yield* apiClient;
      yield* client.transactions.deleteTransaction({ params: { id } });
      yield* Effect.sync(command.onDeleted);
    }).pipe(
      Effect.catch((failure) =>
        Effect.sync(
          Predicate.isTagged(failure, "ValidationFailed") ||
            Predicate.isTagged(failure, "NotFound") ||
            Predicate.isTagged(failure, "ResourceLimited")
            ? command.onRejected
            : command.onUncertain
        )
      ),
      Effect.catchCause((cause) =>
        Cause.hasInterruptsOnly(cause) ? Effect.void : Effect.sync(command.onUncertain)
      )
    )
  );

const DeletionFeedback = ({ status }: Readonly<{ status: DeletionStatus }>): JSX.Element => {
  if (status === "saving") return <output>Eliminando transacción…</output>;
  if (status === "rejected") {
    return (
      <p role="alert">
        No pudimos eliminar la transacción. Si está vinculada a otra, primero debes desvincularlas.
        Actualiza el historial antes de continuar.
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

/** Confirms permanent visibility removal; uncertain outcomes require a fresh history read. */
export const TransactionDeletion = (
  props: Readonly<{
    apiClient: FidyClient;
    transaction: Transaction;
    status: DeletionStatus;
    editable: boolean;
    onStatus: (status: DeletionStatus) => void;
    onDeleted: () => void;
    onCancel: () => void;
    onRefresh: () => void;
  }>
): JSX.Element => {
  const [command] = useState(() => makeTransactionDeletion(props.apiClient, props.transaction.id));
  const submit = useAtomSet(command);
  const confirm = (): void => {
    if (props.status !== "idle" || !props.editable) return;
    props.onStatus("saving");
    submit({
      onDeleted: props.onDeleted,
      onRejected: () => props.onStatus("rejected"),
      onUncertain: () => props.onStatus("uncertain"),
    });
  };
  return (
    <section aria-label="Eliminar transacción" className="flex flex-col gap-4">
      <h3 className="text-xl font-semibold">¿Eliminar esta transacción?</h3>
      <p className="text-sm text-muted-foreground">
        Dejará de aparecer en tu historial y en los cálculos. No puedes deshacer esta acción.
        Conservamos los registros de dónde se obtuvo.
      </p>
      <DeletionFeedback status={props.status} />
      {props.status === "rejected" || props.status === "uncertain" ? (
        <Button variant="outline" onClick={props.onRefresh}>
          Actualizar transacciones
        </Button>
      ) : (
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" disabled={props.status === "saving"} onClick={props.onCancel}>
            Cancelar
          </Button>
          <Button
            variant="destructive"
            disabled={props.status !== "idle" || !props.editable}
            onClick={confirm}
          >
            Eliminar definitivamente
          </Button>
        </div>
      )}
    </section>
  );
};
