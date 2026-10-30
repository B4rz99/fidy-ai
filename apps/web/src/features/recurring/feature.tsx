import { RecurringSkeleton } from "@/ui/components/recurring-loading";
import { DateTime, Effect, Option } from "effect";
import { preparationActive, prepareQuery } from "@/transport/query-preparation";
import type { AtomRegistry } from "effect/reactivity";
import type { FidyClient } from "@/transport/client";
import { workspaceProfileQuery } from "@/transport/workspace-query";
import { RefreshButton } from "@/ui/components/refresh-button";
import { useAtomRefresh, useAtomValue } from "@effect/atom-react";
import { useRouter } from "@tanstack/react-router";
import { Atom } from "effect/reactivity";
import { type JSX, Suspense, lazy, useState } from "react";
import { presentCanonicalQuery } from "@/transport/canonical-query";
import { RecurringQueryFailure } from "./query-failure";
import { Button } from "@/ui/components/button";
import { RecurringWorkspace } from "./workspace";
import { type SaveState, recurringWorkspaceQuery, useRecurringPlanning } from "./controller";
import { type Filters, type PlanInput, shiftMonth } from "./model";

const PreviewWorkspace = import.meta.env.DEV
  ? lazy(() => import("./dev-preview").then((module) => ({ default: module.RecurringDataPreview })))
  : RecurringWorkspace;
type Props = Readonly<{
  profileStale: boolean;
  profileWaiting: boolean;
  refreshProfile: () => void;
  month: string;
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
      view: "compact",
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
    return <RecurringSkeleton />;
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
    <Suspense fallback={<RecurringSkeleton />}>
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
        earlier={props.earlier}
        timeZone={props.timeZone}
      />
    </Suspense>
  );
};
export const RecurringFeature = ({
  month: selectedMonth,
}: Readonly<{
  month: Option.Option<string>;
}>): JSX.Element => {
  const router = useRouter();
  const [profile] = useState(() => workspaceProfileQuery(router.options.context.apiClient));
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
  if (state._tag !== "Ready") {
    return <RecurringSkeleton />;
  }
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
/** Application composition owns the retained workspace. This route retains code preloading. */
export const RecurringRoute = (): JSX.Element => <></>;
const preparedClients = Atom.family((_client: FidyClient) => Atom.make(false).pipe(Atom.keepAlive));
/** First-entry preparation uses the same compact query as the retained planning owner. */
const monthLabelLength = 7;
RecurringRoute.preloadData = ({
  apiClient,
  registry,
  month: selectedMonth,
  signal,
  intent,
}: Readonly<{
  apiClient: FidyClient;
  registry: AtomRegistry.AtomRegistry;
  month: Option.Option<string>;
  signal: AbortSignal;
  intent: boolean;
}>): Promise<void> =>
  Effect.runPromise(
    Effect.gen(function* () {
      if (!preparationActive(signal) || registry.get(preparedClients(apiClient))) {
        return;
      }
      yield* Effect.tryPromise(() =>
        prepareQuery({
          registry,
          query: workspaceProfileQuery(apiClient),
          options: {
            mode: "cached",
            signal: Option.some(signal),
          },
        })
      );
      const profile = presentCanonicalQuery(registry.get(workspaceProfileQuery(apiClient)));
      if (profile._tag !== "Ready" || profile.waiting || Option.isSome(profile.refreshFailure)) {
        return;
      }
      const month = Option.getOrElse(selectedMonth, () =>
        DateTime.formatIsoDate(
          DateTime.makeZonedUnsafe(DateTime.nowUnsafe(), { timeZone: profile.value.data.timeZone })
        ).slice(0, monthLabelLength)
      );
      yield* Effect.tryPromise(() =>
        prepareQuery({
          registry,
          query: recurringWorkspaceQuery({
            apiClient,
            query: { month, view: "compact" },
          }).view,
          options: { mode: "display", signal: Option.some(signal) },
        })
      );
      if (!intent && preparationActive(signal)) {
        registry.set(preparedClients(apiClient), true);
      }
    })
  );
