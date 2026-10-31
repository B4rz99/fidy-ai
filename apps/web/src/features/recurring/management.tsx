import { HistoricalSuggestionsSkeleton } from "@/ui/components/recurring-loading";
import { useAtomRefresh, useAtomValue } from "@effect/atom-react";
import { useRouter } from "@tanstack/react-router";
import { Option } from "effect";
import { type JSX, useState } from "react";
import type { CanonicalSuccess } from "@/transport/client";
import { presentCanonicalQuery } from "@/transport/canonical-query";
import { Button } from "@/ui/components/button";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  ArrowDown01Icon,
  Cancel01Icon,
  PauseCircleIcon,
  Tick02Icon,
} from "@hugeicons/core-free-icons";
import { Badge } from "@/ui/components/badge";
import { ChoiceDropdown } from "@/ui/components/choice-dropdown";
import { RecurringIdentity } from "./visuals";
import { ChoiceField } from "./fields";
import { type Filters, type Plan, type PlanInput, type Save, type Workspace } from "./model";

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
        contentLayout="wrap"
        focusAppearance="subtle"
        disabled={disabled}
        onClick={() => create(proposal(series, view.today, timeZone), series.id)}
      >
        Crear recurrente
      </Button>
      <Button
        contentLayout="wrap"
        focusAppearance="subtle"
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
type SuggestionsProps = Readonly<{
  view: Workspace;
  save: Save;
  create: (initial: PlanInput, seriesId: string) => void;
  disabled: boolean;
  timeZone: PlanInput["timeZone"];
  cursor: Option.Option<string>;
  next: (cursor: string) => void;
}>;

export const Suggestions = (props: SuggestionsProps): JSX.Element => {
  const [requested, setRequested] = useState(() => Option.isSome(props.cursor));
  return (
    <details
      data-recurring-slot="suggestions"
      className="group/review"
      open={Option.isSome(props.cursor)}
      onToggle={(event) => {
        if (event.currentTarget.open) setRequested(true);
      }}
    >
      <summary className="flex cursor-pointer list-none flex-wrap items-center justify-between gap-2 text-sm [&::-webkit-details-marker]:hidden">
        <span className="flex items-center gap-2 font-medium">
          <HugeiconsIcon
            icon={ArrowDown01Icon}
            className="size-4 -rotate-90 transition-transform group-open/review:rotate-0"
          />
          Patrones detectados
        </span>
        <span className="text-xs text-muted-foreground">Revisar historial</span>
      </summary>
      {requested ? <LoadedSuggestions {...props} /> : null}
    </details>
  );
};

const LoadedSuggestions = ({
  view,
  save,
  create,
  disabled,
  timeZone,
  cursor,
  next,
}: SuggestionsProps): JSX.Element => {
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
        <Button contentLayout="wrap" focusAppearance="subtle" variant="outline" onClick={refresh}>
          Reintentar sugerencias
        </Button>
      </div>
    );
  }
  if (state._tag !== "Ready") return <HistoricalSuggestionsSkeleton />;
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
    <section data-recurring-slot="plan-management">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b p-4">
        <h2 className="font-medium">Todos los recurrentes</h2>
        <ChoiceDropdown
          id="recurring-plan-status"
          label="Estado del plan"
          value={status}
          options={[
            { value: "all", label: "Todos" },
            { value: "active", label: "Activos" },
            { value: "paused", label: "Pausados" },
            { value: "stopped", label: "Dejados de seguir" },
          ]}
          disabled={false}
          width="auto"
          leading={null}
          triggerLabel={Option.none()}
          onChange={setStatus}
        />
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
        <ChoiceField
          name={`suggestion-${series.id}`}
          label={`Recurrente para ${series.counterparty}`}
          value={planId}
          onChange={setPlanId}
          options={[
            { value: "", label: "Vincular a uno existente" },
            ...view.document.plans.map((plan) => ({
              value: plan.id,
              label: plan.revisions.at(-1)?.plan.name ?? "Recurrente",
            })),
          ]}
        />
        <Button
          contentLayout="wrap"
          focusAppearance="subtle"
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
  <div className="mt-3 grid gap-3">
    <SuggestionStatus data={data} view={view} ready={ready} />
    <ReviewState
      ready={ready}
      hasSuggestions={data.series.some(
        (series) => !view.document.suggestions.some((decision) => decision.seriesId === series.id)
      )}
    />
    {data.evaluation.kind === "updating" ? (
      <output className="text-sm text-muted-foreground">
        La evaluación está actualizándose. Las sugerencias no forman parte de tus próximos pagos.
      </output>
    ) : null}
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
    <SuggestionNext cursor={data.cursor} next={next} />
    <RestoreSuggestions view={view} save={save} disabled={disabled} />
  </div>
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
              contentLayout="wrap"
              focusAppearance="subtle"
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
const statusVariants = { active: "success", paused: "warning", stopped: "destructive" } as const;
const statusIcons = { active: Tick02Icon, paused: PauseCircleIcon, stopped: Cancel01Icon } as const;
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
  if (input === undefined) return <></>;
  return (
    <div className="@container flex min-w-0 items-center gap-2 border-b pr-4 transition-colors last:border-b-0 hover:bg-muted/50">
      <button
        type="button"
        aria-label={`Editar ${input.name}`}
        onClick={() => open(plan)}
        className="grid min-h-16 min-w-0 flex-1 items-center gap-3 px-4 py-3 text-left outline-none focus-visible:bg-muted focus-visible:underline @min-xl:grid-cols-[minmax(0,1fr)_auto]"
      >
        <RecurringIdentity plan={input} />
        <span className="flex shrink-0 items-center gap-4">
          <Badge variant={statusVariants[status]}>
            <HugeiconsIcon icon={statusIcons[status]} aria-hidden="true" />
            {planStatusLabels[status]}
          </Badge>
        </span>
      </button>
      {status === "paused" ? (
        <Button
          contentLayout="wrap"
          focusAppearance="subtle"
          variant="outline"
          size="sm"
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

const SuggestionStatus = ({
  data,
  view,
  ready,
}: Readonly<{
  data: CanonicalSuccess<"recurring.listRecurringSeries">["data"];
  view: Workspace;
  ready: boolean;
}>): JSX.Element => {
  const count = data.series.filter(
    (series) => !view.document.suggestions.some((decision) => decision.seriesId === series.id)
  ).length;
  const message = ready
    ? `${count} sugerencias nuevas · Revisar`
    : "Sin evaluación completa · Ver estado";
  return <p className="text-xs text-muted-foreground">{message}</p>;
};
const ReviewState = ({
  ready,
  hasSuggestions,
}: Readonly<{ ready: boolean; hasSuggestions: boolean }>): JSX.Element => (
  <>
    <h2 className="text-sm font-medium">Revisión de patrones</h2>
    {ready && !hasSuggestions ? (
      <p className="text-sm text-muted-foreground">
        No hay patrones nuevos para revisar en esta página.
      </p>
    ) : null}
    {!ready ? (
      <p className="text-sm text-muted-foreground">
        Aún no hay una evaluación completa. Aquí podrás crear un recurrente desde un patrón,
        vincularlo a uno existente o descartarlo cuando haya sugerencias disponibles.
      </p>
    ) : null}
  </>
);

const SuggestionNext = ({
  cursor,
  next,
}: Readonly<{ cursor: Option.Option<string>; next: (cursor: string) => void }>): JSX.Element => (
  <>
    {Option.isSome(cursor) ? (
      <Button
        contentLayout="wrap"
        focusAppearance="subtle"
        variant="outline"
        onClick={() => next(cursor.value)}
      >
        Ver más sugerencias
      </Button>
    ) : null}
  </>
);
