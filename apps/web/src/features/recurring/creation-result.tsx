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
  shiftMonth,
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
export const CreationResult = (props: Props): JSX.Element => (
  <CreationMonth {...props} month={props.receipt.date.slice(0, "2026-10".length)} />
);
type MonthProps = Props & Readonly<{ month: string }>;
const CreationMonth = (props: MonthProps): JSX.Element => {
  const apiClient = useRouter().options.context.apiClient;
  const resource = recurringWorkspaceQuery({
    apiClient,
    query: { month: props.month, view: "compact" },
  });
  const state = useAtomValue(resource.view).pipe(presentCanonicalQuery);
  const refresh = useAtomRefresh(resource.source);
  if (state._tag !== "Ready") {
    return <VerificationPending waiting={state.waiting} refresh={refresh} focus />;
  }
  const fresh =
    !state.waiting &&
    Option.isNone(state.refreshFailure) &&
    state.value.data.document.revision >= props.minimumRevision;
  return (
    <ObservedCreation
      {...props}
      view={state.value.data}
      fresh={fresh}
      waiting={state.waiting}
      refresh={refresh}
    />
  );
};
type ObservedProps = MonthProps &
  Readonly<{ view: Workspace; fresh: boolean; waiting: boolean; refresh: () => void }>;
const ObservedCreation = (props: ObservedProps): JSX.Element => {
  const { view, fresh, receipt, waiting, refresh } = props;
  const item = view.occurrences.find(
    (entry) => entry.planId === receipt.planId && entry.date >= receipt.date
  );
  if (item === undefined) {
    return <MissingCreation {...props} />;
  }
  return (
    <div className="grid min-w-0 gap-4 [overflow-wrap:anywhere]">
      {!fresh ? <VerificationPending waiting={waiting} refresh={refresh} focus={false} /> : null}
      <VerifiedCreation {...props} item={item} disabled={props.disabled || !fresh} />
    </div>
  );
};
const MissingCreation = (props: ObservedProps): JSX.Element => {
  const { view, fresh, receipt, month, waiting, refresh } = props;
  const twiceMonthly = view.document.plans.some(
    (plan) =>
      plan.id === receipt.planId && plan.revisions.at(-1)?.plan.frequency === "twice-monthly"
  );
  if (month === receipt.date.slice(0, "2026-10".length) && twiceMonthly) {
    return (
      <div className="grid gap-4">
        {!fresh ? <VerificationPending waiting={waiting} refresh={refresh} focus={false} /> : null}
        <CreationMonth
          {...props}
          disabled={props.disabled || !fresh}
          month={shiftMonth({ month, step: 1 })}
        />
      </div>
    );
  }
  if (!fresh) {
    return <VerificationPending waiting={waiting} refresh={refresh} focus />;
  }
  return (
    <div className="grid gap-3">
      <p tabIndex={-1} ref={focusResult}>
        El recurrente se guardó, pero no pudimos verificar su primera ocurrencia en este periodo.
        Revisa el plan en Todos los recurrentes para comprobar el vínculo y las fechas esperadas.
      </p>
      <Button onClick={props.close}>Listo</Button>
    </div>
  );
};
const VerificationPending = ({
  waiting,
  refresh,
  focus,
}: Readonly<{ waiting: boolean; refresh: () => void; focus: boolean }>): JSX.Element => (
  <div className="grid gap-3" aria-live="polite">
    <p tabIndex={-1} ref={focus ? focusResult : undefined}>
      El recurrente se guardó. Falta verificar si la transacción completa la primera ocurrencia.
    </p>
    <Button variant="outline" disabled={waiting} onClick={refresh}>
      Verificar vínculo
    </Button>
  </div>
);

const VerifiedCreation = ({
  receipt,
  view,
  categories,
  disabled,
  save,
  close,
  item,
}: Props & Readonly<{ view: Workspace; item: Occurrence }>): JSX.Element => {
  const linked = item.fulfillments.some((mark) => mark.transactionId === receipt.transactionId);
  return (
    <div className="grid min-w-0 gap-4 [overflow-wrap:anywhere]">
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

const focusResult: RefCallback<HTMLElement> = (element): void => {
  element?.focus();
  element?.closest('[role="dialog"]')?.scrollIntoView({ block: "start" });
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
          key={JSON.stringify(item.plan)}
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
    ...view.document.fulfillments.filter((mark) => !view.invalidFulfillmentIds.includes(mark.id)),
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
const PendingExpectation = ({ item }: Readonly<{ item: Occurrence }>): JSX.Element => (
  <span>
    {item.remaining === undefined
      ? "Este plan conserva una expectativa separada con importe por confirmar."
      : `En este plan siguen previstos ${money(item.remaining)} adicionales para ${item.expectedDate}. Se incluyen en el pronóstico de ese mes.`}
  </span>
);
