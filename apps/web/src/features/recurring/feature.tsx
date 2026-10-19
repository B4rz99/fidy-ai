import { revalidateWorkspaceQuery, workspaceQueryRetention } from "@/transport/workspace-query";
import { RefreshButton } from "@/ui/components/refresh-button";
import { useAtomRefresh, useAtomValue } from "@effect/atom-react";
import { useRouter } from "@tanstack/react-router";
import { DateTime, Option } from "effect";
import { Atom } from "effect/reactivity";
import { type JSX, Suspense, lazy, useState } from "react";
import { presentCanonicalQuery } from "@/transport/canonical-query";
import { RecurringQueryFailure } from "./query-failure";
import { Button } from "@/ui/components/button";
import { Skeleton } from "@/ui/components/skeleton";
import { RecurringWorkspace } from "./workspace";
import { type SaveState, useRecurringPlanning } from "./controller";
import { type Filters, type PlanInput, shiftMonth } from "./model";

const PreviewWorkspace = import.meta.env.DEV
  ? lazy(() => import("./dev-preview").then((module) => ({ default: module.RecurringDataPreview })))
  : RecurringWorkspace;

type Props = Readonly<{
  profileStale: boolean;
  profileWaiting: boolean;
  refreshProfile: () => void;
  month: string;
  currentMonth: string;
  timeZone: PlanInput["timeZone"];
  filters: Filters;
  applyFilters: (filters: Filters) => void;
  previous: Option.Option<string>;
  earlier: (month: string) => void;
}>;
const Resources = (props: Props): JSX.Element => {
  const router = useRouter();
  const apiClient = router.options.context.apiClient;
  const planning = useRecurringPlanning({
    apiClient,
    profileStale: props.profileStale,
    profileWaiting: props.profileWaiting,
    refreshProfile: props.refreshProfile,
    query: {
      month: props.month,
      ...props.filters,
      ...(Option.isSome(props.previous) ? { previousMonth: props.previous.value } : {}),
    },
  });
  const { state, categoryState, waiting, retry } = planning;
  if (state._tag === "Failure" || categoryState._tag === "Failure") {
    return (
      <RecurringQueryFailure states={[state, categoryState]} waiting={waiting} retry={retry} />
    );
  }
  if (state._tag !== "Ready" || categoryState._tag !== "Ready") {
    return <LoadingRecurring />;
  }
  const navigate = (month: string): void => {
    router.navigate({ to: "/app/recurring", search: { month } }).catch(() => undefined);
  };
  const view = state.value.data;
  const notice = (
    <SaveNotice
      stale={planning.stale}
      saveState={planning.saveState}
      waiting={waiting}
      retry={retry}
    />
  );
  return (
    <Suspense fallback={<LoadingRecurring />}>
      {notice}
      <PreviewWorkspace
        key={`${props.month}:${JSON.stringify(props.filters)}:${Option.getOrElse(props.previous, () => "")}:${view.document.revision}`}
        notice={notice}
        view={view}
        categories={categoryState.value.data}
        save={planning.save}
        disabled={planning.disabled}
        filters={props.filters}
        applyFilters={props.applyFilters}
        month={(step) => navigate(shiftMonth({ month: props.month, step }))}
        today={() => navigate(props.currentMonth)}
        earlier={props.earlier}
        timeZone={props.timeZone}
      />
    </Suspense>
  );
};

export const RecurringFeature = ({
  month: selectedMonth,
}: Readonly<{ month: Option.Option<string> }>): JSX.Element => {
  const router = useRouter();
  const [profile] = useState(() =>
    router.options.context.apiClient
      .query("identity", "getCurrentUser", {
        ...workspaceQueryRetention,
        reactivityKeys: ["recurring-resume"],
      })
      .pipe(revalidateWorkspaceQuery)
  );
  const state = useAtomValue(profile).pipe(presentCanonicalQuery);
  const refresh = useAtomRefresh(profile);
  const [clock] = useState(() =>
    Atom.make(() => DateTime.nowUnsafe()).pipe(
      router.options.context.apiClient.runtime.factory.withReactivity(["recurring-resume"])
    )
  );
  const now = useAtomValue(clock);
  const [filters, setFilters] = useState<Filters>({});
  const [previous, setPrevious] = useState<Option.Option<string>>(() => Option.none());
  if (state._tag === "Failure") {
    return (
      <Button contentLayout="wrap" focusAppearance="subtle" onClick={refresh}>
        Reintentar recurrentes
      </Button>
    );
  }
  if (state._tag !== "Ready") return <output>Cargando recurrentes…</output>;
  const user = state.value.data;
  const currentMonth = DateTime.formatIsoDate(
    DateTime.makeZonedUnsafe(now, { timeZone: user.timeZone })
  ).slice(0, "2026-01".length);
  const month = Option.getOrElse(selectedMonth, () => currentMonth);
  return (
    <Resources
      profileStale={Option.isSome(state.refreshFailure)}
      profileWaiting={state.waiting}
      refreshProfile={refresh}
      key={user.id}
      month={month}
      currentMonth={currentMonth}
      timeZone={user.timeZone}
      filters={filters}
      applyFilters={setFilters}
      previous={Option.filter(previous, (value) => value < month)}
      earlier={(value) => setPrevious(Option.some(value))}
    />
  );
};

const SaveNotice = ({
  stale,
  saveState,
  waiting,
  retry,
}: Readonly<{
  stale: boolean;
  saveState: SaveState;
  waiting: boolean;
  retry: () => void;
}>): JSX.Element => (
  <>
    {stale ||
    saveState === "uncertain" ||
    saveState === "rejected" ||
    saveState === "refreshing" ? (
      <div role="alert" className="flex flex-wrap items-center gap-3 border-b p-4">
        <p>
          {saveState === "uncertain"
            ? "No pudimos confirmar si se guardó. Actualiza y revisa el resultado antes de volver a guardar."
            : "Actualiza los recurrentes y revisa los datos antes de guardar."}
        </p>
        <RefreshButton
          focusAppearance="subtle"
          variant="outline"
          disabled={waiting}
          onClick={retry}
          label="Actualizar recurrentes"
        />
      </div>
    ) : null}
  </>
);

const LoadingRecurring = (): JSX.Element => (
  <div className="p-5" aria-label="Cargando recurrentes">
    <Skeleton className="h-24" />
    <Skeleton className="mt-5 h-64" />
  </div>
);

/** Application composition owns the retained workspace. This route retains code preloading. */
export const RecurringRoute = (): JSX.Element => <></>;
