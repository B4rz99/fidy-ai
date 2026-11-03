import { useAtomRefresh, useAtomValue } from "@effect/atom-react";
import { useRouter } from "@tanstack/react-router";
import { Option } from "effect";
import type { JSX } from "react";
import { presentCanonicalQuery } from "@/transport/canonical-query";
import { Button } from "@/ui/components/button";
import { recurringWorkspaceQuery } from "./controller";
import { CreationStatus } from "./creation-status";
import { VerificationPending } from "./creation-verification";
import { focusCreation } from "./creation-focus";
import { type CreationResultProps, type Workspace, shiftMonth } from "./model";

type Props = CreationResultProps & Readonly<{ month: Option.Option<string> }>;
type MonthProps = CreationResultProps & Readonly<{ month: string }>;
export const CreationResult = (props: Props): JSX.Element => {
  const month = Option.getOrElse(props.month, () => props.receipt.date.slice(0, "2026-10".length));
  const apiClient = useRouter().options.context.apiClient;
  const resource = recurringWorkspaceQuery({
    apiClient,
    query: { month, view: "compact" },
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
  const view = state.value.data;
  const item = view.occurrences.find(
    (entry) => entry.planId === props.receipt.planId && entry.date >= props.receipt.date
  );
  if (item === undefined) {
    return (
      <MissingCreation
        {...props}
        month={month}
        view={view}
        fresh={fresh}
        waiting={state.waiting}
        refresh={refresh}
      />
    );
  }
  return (
    <div className="grid min-w-0 gap-4 [overflow-wrap:anywhere]">
      {!fresh ? (
        <VerificationPending waiting={state.waiting} refresh={refresh} focus={false} />
      ) : null}
      <CreationStatus {...props} view={view} item={item} disabled={props.disabled || !fresh} />
    </div>
  );
};
type ObservedProps = MonthProps &
  Readonly<{ view: Workspace; fresh: boolean; waiting: boolean; refresh: () => void }>;
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
        <CreationResult
          {...props}
          disabled={props.disabled || !fresh}
          month={Option.some(shiftMonth({ month, step: 1 }))}
        />
      </div>
    );
  }
  if (!fresh) {
    return <VerificationPending waiting={waiting} refresh={refresh} focus />;
  }
  return (
    <div className="grid gap-3">
      <p tabIndex={-1} ref={focusCreation}>
        El recurrente se guardó, pero no pudimos verificar su primera ocurrencia en este periodo.
        Revisa el plan en Todos los recurrentes para comprobar el vínculo y las fechas esperadas.
      </p>
      <Button onClick={props.close}>Listo</Button>
    </div>
  );
};
