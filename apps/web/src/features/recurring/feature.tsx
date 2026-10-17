import { revalidateWorkspaceQuery, workspaceQueryRetention } from "@/transport/workspace-query";
import { RefreshButton } from "@/ui/components/refresh-button";
import { useAtomRefresh, useAtomSet, useAtomValue } from "@effect/atom-react";
import { useRouter, useSearch } from "@tanstack/react-router";
import { DateTime, Option } from "effect";
import type { AsyncResult, Atom } from "effect/reactivity";
import type { CanonicalSuccess, FidyClient } from "@/transport/client";
import { type JSX, Suspense, lazy, useState } from "react";
import { presentCanonicalQuery } from "@/transport/canonical-query";
import { RecurringQueryFailure } from "./query-failure";
import { Button } from "@/ui/components/button";
import { Skeleton } from "@/ui/components/skeleton";
import { RecurringWorkspace } from "./workspace";
import { type RecurringWrite, makeRecurringWrite } from "./command";
import {
  type Category,
  type Filters,
  type PlanInput,
  type Save,
  type Workspace,
  shiftMonth,
} from "./model";

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
const recurringQuery = (
  apiClient: FidyClient,
  props: Props
): Atom.Atom<
  AsyncResult.AsyncResult<CanonicalSuccess<"recurringPlans.getRecurringWorkspace">, unknown>
> =>
  apiClient
    .query("recurringPlans", "getRecurringWorkspace", {
      ...workspaceQueryRetention,
      query: {
        month: props.month,
        ...props.filters,
        ...(Option.isSome(props.previous) ? { previousMonth: props.previous.value } : {}),
      },
    })
    .pipe(revalidateWorkspaceQuery);
const Resources = (props: Props): JSX.Element => {
  const router = useRouter();
  const apiClient = router.options.context.apiClient;
  const [resource] = useState(() => recurringQuery(apiClient, props));
  const [categories] = useState(() =>
    apiClient
      .query("categories", "listCategories", workspaceQueryRetention)
      .pipe(revalidateWorkspaceQuery)
  );
  const [command] = useState(() => makeRecurringWrite(apiClient));
  const execute = useAtomSet(command);
  const [saveState, setSaveState] = useState("idle");
  const state = useAtomValue(resource).pipe(presentCanonicalQuery);
  const categoryState = useAtomValue(categories).pipe(presentCanonicalQuery);
  const refresh = useAtomRefresh(resource);
  const refreshCategories = useAtomRefresh(categories);
  const retry = (): void => {
    refresh();
    refreshCategories();
    props.refreshProfile();
    setSaveState("idle");
  };
  const waiting = props.profileWaiting || state.waiting || categoryState.waiting;
  if (state._tag === "Failure" || categoryState._tag === "Failure") {
    return (
      <RecurringQueryFailure states={[state, categoryState]} waiting={waiting} retry={retry} />
    );
  }
  if (state._tag !== "Ready" || categoryState._tag !== "Ready") {
    return <LoadingRecurring />;
  }
  return (
    <ReadyResources
      props={props}
      view={state.value.data}
      categories={categoryState.value.data}
      stale={
        props.profileStale ||
        [state.refreshFailure, categoryState.refreshFailure].some(Option.isSome)
      }
      waiting={waiting}
      saveState={saveState}
      setSaveState={setSaveState}
      execute={execute}
      refresh={refresh}
      retry={retry}
    />
  );
};

export const RecurringFeature = (): JSX.Element => {
  const router = useRouter();
  const [profile] = useState(() =>
    router.options.context.apiClient
      .query("identity", "getCurrentUser", workspaceQueryRetention)
      .pipe(revalidateWorkspaceQuery)
  );
  const state = useAtomValue(profile).pipe(presentCanonicalQuery);
  const refresh = useAtomRefresh(profile);
  const search = useSearch({ strict: false });
  const [now] = useState(() => DateTime.nowUnsafe());
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
  const month = "month" in search && typeof search.month === "string" ? search.month : currentMonth;
  return (
    <Resources
      profileStale={Option.isSome(state.refreshFailure)}
      profileWaiting={state.waiting}
      refreshProfile={refresh}
      key={`${user.id}:${month}:${JSON.stringify(filters)}:${Option.getOrElse(previous, () => "")}`}
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

type ReadyProps = Readonly<{
  props: Props;
  view: Workspace;
  categories: ReadonlyArray<Category>;
  stale: boolean;
  waiting: boolean;
  saveState: string;
  setSaveState: (value: string) => void;
  execute: (command: RecurringWrite) => void;
  refresh: () => void;
  retry: () => void;
}>;
const ReadyResources = ({
  props,
  view,
  categories,
  stale,
  waiting,
  saveState,
  setSaveState,
  execute,
  refresh,
  retry,
}: ReadyProps): JSX.Element => {
  const router = useRouter();
  const disabled = waiting || stale || saveState === "saving" || saveState === "uncertain";
  const save: Save = (edit) => {
    if (disabled) return;
    setSaveState("saving");
    execute({
      input: { payload: { expectedRevision: view.document.revision, edit } },
      onSaved: () => {
        setSaveState("idle");
        refresh();
      },
      onRejected: () => {
        setSaveState("rejected");
        refresh();
      },
      onUncertain: () => setSaveState("uncertain"),
    });
  };
  const navigate = (month: string): void => {
    router.navigate({ to: "/app/recurring", search: { month } }).catch(() => undefined);
  };
  return (
    <Suspense fallback={<LoadingRecurring />}>
      <SaveNotice stale={stale} saveState={saveState} waiting={waiting} retry={retry} />
      <PreviewWorkspace
        key={view.document.revision}
        notice={<SaveNotice stale={stale} saveState={saveState} waiting={waiting} retry={retry} />}
        view={view}
        categories={categories}
        save={save}
        disabled={disabled}
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
const SaveNotice = ({
  stale,
  saveState,
  waiting,
  retry,
}: Readonly<{
  stale: boolean;
  saveState: string;
  waiting: boolean;
  retry: () => void;
}>): JSX.Element => (
  <>
    {stale || saveState === "uncertain" || saveState === "rejected" ? (
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
