import type { JSX } from "react";
import { Button } from "@/ui/components/button";
import {
  type CreationReceipt,
  type CreationResultProps,
  type Occurrence,
  type Workspace,
  statuses,
} from "./model";
import { CreationCorrection } from "./creation-correction";
import { PendingExpectation, SourceAssociation } from "./creation-association";
import { focusCreation } from "./creation-focus";

export const CreationStatus = ({
  receipt,
  view,
  categories,
  disabled,
  save,
  close,
  item,
}: CreationResultProps & Readonly<{ view: Workspace; item: Occurrence }>): JSX.Element => {
  const linked = item.fulfillments.some((mark) => mark.transactionId === receipt.transactionId);
  return (
    <div className="grid min-w-0 gap-4 [overflow-wrap:anywhere]">
      <h3 className="font-medium" tabIndex={-1} ref={focusCreation}>
        {item.plan.name} · {item.expectedDate}
      </h3>
      <CreationSummary {...{ item, linked, receipt, view }} />
      {!linked && item.fulfillments.length === 0 ? (
        <CreationCorrection {...{ item, categories, disabled, save }} />
      ) : null}
      <Button onClick={close}>Listo</Button>
    </div>
  );
};

const sourceOutcome = (item: Occurrence, linked: boolean): string => {
  if (!linked) {
    return "La transacción solo se usó para copiar los datos; no está vinculada a la primera ocurrencia.";
  }
  return item.status === "completed"
    ? "La transacción seleccionada completa la primera ocurrencia. En este plan no se espera otro pago o ingreso para esta fecha."
    : "La transacción seleccionada está vinculada a la primera ocurrencia.";
};
const CreationSummary = ({
  item,
  linked,
  receipt,
  view,
}: Readonly<{
  item: Occurrence;
  linked: boolean;
  receipt: CreationReceipt;
  view: Workspace;
}>): JSX.Element => (
  <output className="grid gap-3 text-sm">
    <span>{sourceOutcome(item, linked)}</span>
    {!linked ? <SourceAssociation receipt={receipt} view={view} /> : null}
    <span>Primera ocurrencia: {statuses[item.status]}.</span>
    {item.status !== "completed" && item.status !== "skipped" ? (
      <PendingExpectation item={item} />
    ) : null}
  </output>
);
