import { useAtomRefresh, useAtomValue } from "@effect/atom-react";
import { useRouter } from "@tanstack/react-router";
import { Option } from "effect";
import { type JSX, type RefCallback, useState } from "react";
import { presentCanonicalQuery } from "@/transport/canonical-query";
import { Button } from "@/ui/components/button";
import { recurringWorkspaceQuery } from "./controller";
import type { CreationReceipt } from "./create-plan";
import {
  type Category,
  type Occurrence,
  type Save,
  type Workspace,
  money,
  statuses,
} from "./model";
import { PlanForm } from "./plan-form";

type Props = Readonly<{
  receipt: CreationReceipt;
  minimumRevision: number;
  categories: ReadonlyArray<Category>;
  disabled: boolean;
  save: Save;
  close: () => void;
}>;
export const CreationResult = (props: Props): JSX.Element => {
  const apiClient = useRouter().options.context.apiClient;
  const [resource] = useState(() =>
    recurringWorkspaceQuery({
      apiClient,
      query: { month: props.receipt.date.slice(0, "2026-10".length), view: "compact" },
    })
  );
  const state = useAtomValue(resource.view).pipe(presentCanonicalQuery);
  const refresh = useAtomRefresh(resource.source);
  if (
    state._tag !== "Ready" ||
    state.waiting ||
    Option.isSome(state.refreshFailure) ||
    state.value.data.document.revision < props.minimumRevision
  ) {
    return (
      <div className="grid gap-3">
        <p>
          El recurrente se guardó. Falta verificar si la transacción completa la primera ocurrencia.
        </p>
        <Button variant="outline" disabled={state.waiting} onClick={refresh}>
          Verificar vínculo
        </Button>
      </div>
    );
  }
  return <VerifiedCreation {...props} view={state.value.data} />;
};

const VerifiedCreation = ({
  receipt,
  view,
  categories,
  disabled,
  save,
  close,
}: Props & Readonly<{ view: Workspace }>): JSX.Element => {
  const item = view.occurrences.find(
    (entry) => entry.planId === receipt.planId && entry.date === receipt.date
  );
  if (item === undefined) {
    return (
      <p>
        El recurrente se guardó. Su primera fecha ya no aparece en este mes; revisa el plan en Todos
        los recurrentes.
      </p>
    );
  }
  const linked = item.fulfillments.some((mark) => mark.transactionId === receipt.transactionId);
  return (
    <div className="grid gap-4">
      <h3 className="font-medium" tabIndex={-1} ref={focusResult}>
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

const focusResult: RefCallback<HTMLHeadingElement> = (element): void => {
  element?.focus();
  element?.closest('[role="dialog"]')?.scrollIntoView({ block: "start" });
};

const sourceOutcome = (item: Occurrence, linked: boolean): string => {
  if (!linked) {
    return "La transacción solo se usó para copiar los datos; no está vinculada a la primera ocurrencia.";
  }
  return item.status === "completed"
    ? "La transacción seleccionada completa la primera ocurrencia. No se espera otro pago o ingreso para esta fecha."
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
    <p>{sourceOutcome(item, linked)}</p>
    {!linked ? <SourceAssociation receipt={receipt} view={view} /> : null}
    <p>Primera ocurrencia: {statuses[item.status]}.</p>
    {item.status !== "completed" && item.status !== "skipped" ? (
      <PendingExpectation item={item} />
    ) : null}
  </output>
);
const CreationCorrection = ({
  item,
  categories,
  disabled,
  save,
}: Pick<Props, "categories" | "disabled" | "save"> &
  Readonly<{ item: Occurrence }>): JSX.Element => {
  const [editing, setEditing] = useState(false);
  return (
    <>
      <p className="text-sm text-muted-foreground">
        Si no esperas otro pago o ingreso para esta fecha, cambia la primera fecha del nuevo plan.
      </p>
      <Button variant="outline" disabled={disabled} onClick={() => setEditing(!editing)}>
        Cambiar primera fecha
      </Button>
      {editing ? (
        <PlanForm
          initial={{ ...item.plan, firstDate: item.expectedDate }}
          categories={categories}
          disabled={disabled}
          onSubmit={(plan) =>
            save({ kind: "edit", planId: item.planId, date: item.date, scope: "forward", plan })
          }
        />
      ) : null}
    </>
  );
};

const SourceAssociation = ({
  receipt,
  view,
}: Readonly<{ receipt: CreationReceipt; view: Workspace }>): JSX.Element => {
  const marks = [
    ...view.document.fulfillments,
    ...view.matches.map(({ item, fact }) => ({
      planId: item.planId,
      date: item.date,
      transactionId: fact.id,
    })),
  ];
  const association = marks.find(
    (mark) =>
      mark.transactionId === receipt.transactionId &&
      mark.planId !== receipt.planId &&
      !view.invalidFulfillmentIds.includes("id" in mark ? mark.id : "")
  );
  const name =
    association === undefined
      ? undefined
      : view.document.plans.find((plan) => plan.id === association.planId)?.revisions.at(-1)?.plan
          .name;
  if (association !== undefined && name !== undefined) {
    return (
      <p>
        La transacción ya está vinculada a {name} · {association.date}. No se usa para completar dos
        ocurrencias.
      </p>
    );
  }
  return (
    <p>
      {view.matchesComplete
        ? "No se encontró una coincidencia automática única para esta transacción con los datos guardados. Puedes revisar y vincular una transacción desde el detalle de la ocurrencia."
        : "La búsqueda de coincidencias está incompleta. Todavía no podemos confirmar el vínculo; revisa las transacciones de esta ocurrencia."}
    </p>
  );
};
const PendingExpectation = ({ item }: Readonly<{ item: Occurrence }>): JSX.Element => (
  <p>
    {item.remaining === undefined
      ? "Este plan conserva una expectativa separada con importe por confirmar."
      : `En este plan siguen previstos ${money(item.remaining)} adicionales para ${item.expectedDate}. Se incluyen en el pronóstico de ese mes.`}
  </p>
);
