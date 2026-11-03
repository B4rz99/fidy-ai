import type { JSX } from "react";
import { type CreationReceipt, type Occurrence, type Workspace, money } from "./model";

export const SourceAssociation = ({
  receipt,
  view,
}: Readonly<{ receipt: CreationReceipt; view: Workspace }>): JSX.Element => {
  const invalidIds = new Set(view.invalidFulfillmentIds);
  const marks = [
    ...view.document.fulfillments.filter((mark) => !invalidIds.has(mark.id)),
    ...view.matches.map(({ item, fact }) => ({
      planId: item.planId,
      date: item.date,
      transactionId: fact.id,
    })),
  ];
  const association = marks.find(
    (mark) =>
      mark.transactionId === receipt.transactionId &&
      (mark.planId !== receipt.planId || mark.date !== receipt.date)
  );
  const name =
    association === undefined
      ? undefined
      : view.document.plans.find((plan) => plan.id === association.planId)?.revisions.at(-1)?.plan
          .name;
  if (association !== undefined && name !== undefined) {
    return (
      <span>
        La transacción ya está vinculada a {name} · {association.date}. No se usa para completar dos
        ocurrencias.
      </span>
    );
  }
  return (
    <span>
      {view.matchesComplete
        ? "No se encontró una coincidencia automática única para esta transacción con los datos guardados. Puedes revisar y vincular una transacción desde el detalle de la ocurrencia."
        : "La búsqueda de coincidencias está incompleta. Todavía no podemos confirmar el vínculo; revisa las transacciones de esta ocurrencia."}
    </span>
  );
};
export const PendingExpectation = ({ item }: Readonly<{ item: Occurrence }>): JSX.Element => (
  <span>
    {item.remaining === undefined
      ? "Este plan conserva una expectativa separada con importe por confirmar."
      : `En este plan siguen previstos ${money(item.remaining)} adicionales para ${item.expectedDate}. Se incluyen en el pronóstico de ese mes.`}
  </span>
);
