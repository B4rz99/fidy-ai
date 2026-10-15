import { useAtomRefresh, useAtomValue } from "@effect/atom-react";
import { useRouter } from "@tanstack/react-router";
import { Option } from "effect";
import { type JSX, useState } from "react";
import type { CanonicalSuccess } from "@/transport/client";
import { presentCanonicalQuery } from "@/transport/canonical-query";
import { Button } from "@/ui/components/button";
import { NativeSelect } from "@/ui/components/native-select";
import {
  type Filters,
  type Plan,
  type PlanInput,
  type Save,
  type Workspace,
  frequencies,
} from "./model";

type Series = CanonicalSuccess<"recurring.listRecurringSeries">["data"]["series"][number];
const proposal = (series: Series, today: string, timeZone: PlanInput["timeZone"]): PlanInput => ({
  name: series.counterparty,
  kind: "expense",
  currency: series.money.currency,
  amountMode: "fixed",
  money: series.money,
  frequency: "monthly",
  firstDate: today,
  timeZone,
  counterparty: series.counterparty,
});
const SuggestionRow = ({
  series,
  view,
  save,
  create,
  disabled,
  timeZone,
}: Readonly<{
  series: Series;
  view: Workspace;
  save: Save;
  create: (initial: PlanInput, seriesId: string) => void;
  disabled: boolean;
  timeZone: PlanInput["timeZone"];
}>): JSX.Element => (
  <article className="grid gap-3 border-t py-4">
    <h3 className="font-medium">{series.counterparty}</h3>
    <p className="text-sm text-muted-foreground">
      Patrón histórico mensual. Confirma si quieres seguirlo. La fecha inicial propuesta es hoy;
      revísala al crear el recurrente.
    </p>
    <div className="flex flex-wrap gap-2">
      <Button
        disabled={disabled}
        onClick={() => create(proposal(series, view.today, timeZone), series.id)}
      >
        Crear recurrente
      </Button>
      <Button
        variant="ghost"
        disabled={disabled}
        onClick={() => save({ kind: "suggestion", seriesId: series.id, action: "dismiss" })}
      >
        Descartar sugerencia
      </Button>
    </div>
    <SuggestionLink series={series} view={view} save={save} disabled={disabled} />
  </article>
);
export const Suggestions = ({
  view,
  save,
  create,
  disabled,
  timeZone,
  cursor,
  next,
}: Readonly<{
  view: Workspace;
  save: Save;
  create: (initial: PlanInput, seriesId: string) => void;
  disabled: boolean;
  timeZone: PlanInput["timeZone"];
  cursor: Option.Option<string>;
  next: (cursor: string) => void;
}>): JSX.Element => {
  const client = useRouter().options.context.apiClient;
  const [resource] = useState(() =>
    client.query("recurring", "listRecurringSeries", {
      query: Option.isSome(cursor) ? { cursor: cursor.value } : {},
    })
  );
  const state = useAtomValue(resource).pipe(presentCanonicalQuery);
  const refresh = useAtomRefresh(resource);
  if (state._tag === "Failure") {
    return (
      <div role="alert">
        No pudimos leer las sugerencias.{" "}
        <Button variant="outline" onClick={refresh}>
          Reintentar sugerencias
        </Button>
      </div>
    );
  }
  if (state._tag !== "Ready") return <output>Buscando patrones históricos…</output>;
  return (
    <SuggestionResults
      data={state.value.data}
      view={view}
      save={save}
      create={create}
      disabled={disabled}
      timeZone={timeZone}
      next={next}
      ready={
        state.value.data.evaluation.kind === "current" &&
        Option.isNone(state.refreshFailure) &&
        !state.waiting
      }
    />
  );
};

export const PlanManagement = ({
  view,
  open,
  disabled,
  save,
  filters,
}: Readonly<{
  filters: Filters;
  view: Workspace;
  open: (plan: Workspace["document"]["plans"][number]) => void;
  disabled: boolean;
  save: Save;
}>): JSX.Element => {
  const [status, setStatus] = useState("all");
  return (
    <section className="rounded-xl border bg-card">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b p-4">
        <h2 className="font-medium">Todos los recurrentes</h2>
        <NativeSelect
          aria-label="Estado del plan"
          size="default"
          value={status}
          onChange={(event) => setStatus(event.target.value)}
        >
          <option value="all">Todos</option>
          <option value="active">Activos</option>
          <option value="paused">Pausados</option>
          <option value="stopped">Dejados de seguir</option>
        </NativeSelect>
      </div>
      {view.document.plans.flatMap((plan) =>
        (status === "all" || planStatus(plan) === status) && matchesPlanFilters(plan, filters)
          ? [
              <PlanRow
                key={plan.id}
                plan={plan}
                open={open}
                disabled={disabled}
                save={save}
                today={view.today}
              />,
            ]
          : []
      )}
    </section>
  );
};

const SuggestionLink = ({
  series,
  view,
  save,
  disabled,
}: Readonly<{ series: Series; view: Workspace; save: Save; disabled: boolean }>): JSX.Element => {
  const [planId, setPlanId] = useState("");
  return (
    <>
      <div className="flex flex-wrap gap-2">
        <NativeSelect
          aria-label={`Recurrente para ${series.counterparty}`}
          size="default"
          value={planId}
          onChange={(event) => setPlanId(event.target.value)}
        >
          <option value="">Vincular a uno existente</option>
          {view.document.plans.map((plan) => (
            <option key={plan.id} value={plan.id}>
              {plan.revisions.at(-1)?.plan.name}
            </option>
          ))}
        </NativeSelect>
        <Button
          variant="outline"
          disabled={disabled || planId === ""}
          onClick={() => {
            const plan = view.document.plans.find((entry) => entry.id === planId);
            if (plan !== undefined) {
              save({ kind: "suggestion", seriesId: series.id, action: "link", planId: plan.id });
            }
          }}
        >
          Vincular
        </Button>
      </div>
    </>
  );
};

const SuggestionResults = ({
  data,
  view,
  save,
  create,
  disabled,
  timeZone,
  next,
  ready,
}: Readonly<{
  data: CanonicalSuccess<"recurring.listRecurringSeries">["data"];
  view: Workspace;
  save: Save;
  create: (initial: PlanInput, seriesId: string) => void;
  disabled: boolean;
  timeZone: PlanInput["timeZone"];
  next: (cursor: string) => void;
  ready: boolean;
}>): JSX.Element => (
  <section className="rounded-xl border p-4">
    <h2 className="font-medium">Revisar patrones detectados</h2>
    {ready ? null : (
      <output>
        {data.evaluation.kind === "not-evaluated"
          ? "Aún no hay una evaluación completa."
          : "La evaluación está actualizándose."}{" "}
        Las sugerencias no forman parte de tus próximos pagos.
      </output>
    )}
    {data.series.flatMap((series) =>
      view.document.suggestions.some((decision) => decision.seriesId === series.id)
        ? []
        : [
            <SuggestionRow
              key={series.id}
              series={series}
              view={view}
              save={save}
              create={create}
              disabled={disabled || !ready}
              timeZone={timeZone}
            />,
          ]
    )}
    {Option.isSome(data.cursor) ? (
      <Button
        variant="outline"
        onClick={() => {
          if (Option.isSome(data.cursor)) next(data.cursor.value);
        }}
      >
        Ver más sugerencias
      </Button>
    ) : null}
    <RestoreSuggestions view={view} save={save} disabled={disabled} />
  </section>
);
const RestoreSuggestions = ({
  view,
  save,
  disabled,
}: Readonly<{ view: Workspace; save: Save; disabled: boolean }>): JSX.Element => (
  <>
    {view.document.suggestions.flatMap((decision) =>
      decision.disposition === "dismissed"
        ? [
            <Button
              key={decision.seriesId}
              variant="ghost"
              disabled={disabled}
              onClick={() =>
                save({ kind: "suggestion", seriesId: decision.seriesId, action: "restore" })
              }
            >
              Restaurar sugerencia descartada
            </Button>,
          ]
        : []
    )}
  </>
);

const planStatus = (plan: Plan): "stopped" | "paused" | "active" => {
  if (plan.stoppedOn !== undefined) return "stopped";
  return plan.pauses.some((pause) => pause.through === undefined) ? "paused" : "active";
};
const matchesPlanFilters = (plan: Plan, filters: Filters): boolean => {
  const input = plan.revisions.at(-1)?.plan;
  if (input === undefined) return false;
  return Object.entries(filters).every(([key, value]) => {
    if (key === "search") return input.name.toLowerCase().includes(value.toLowerCase());
    if (key === "kind") return input.kind === value;
    if (key === "frequency") return input.frequency === value;
    if (key === "currency") return input.currency === value;
    if (key === "categoryId") return input.categoryId === value;
    return true;
  });
};
const planStatusLabels = { active: "Activo", paused: "Pausado", stopped: "Dejado de seguir" };
const PlanRow = ({
  plan,
  open,
  save,
  disabled,
  today,
}: Readonly<{
  plan: Plan;
  open: (plan: Plan) => void;
  save: Save;
  disabled: boolean;
  today: string;
}>): JSX.Element => {
  const input = plan.revisions.at(-1)?.plan;
  const status = planStatus(plan);
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 border-b p-4">
      <Button variant="ghost" onClick={() => open(plan)}>
        {input?.name} · {frequencies.find(([frequency]) => frequency === input?.frequency)?.[1]}
      </Button>
      <span className="text-xs text-muted-foreground">{planStatusLabels[status]}</span>
      {status === "paused" ? (
        <Button
          variant="outline"
          disabled={disabled}
          onClick={() =>
            save({ kind: "lifecycle", planId: plan.id, date: today, action: "resume" })
          }
        >
          Reanudar
        </Button>
      ) : null}
    </div>
  );
};
