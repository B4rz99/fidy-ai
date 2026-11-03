import { PendingRead } from "@/ui/components/pending-read";

import { DateTime, Effect, Option } from "effect";
import { preparationActive, prepareQuery } from "@/transport/query-preparation";
import type { AtomRegistry } from "effect/reactivity";
import type { FidyClient } from "@/transport/client";
import { workspaceProfileQuery } from "@/transport/workspace-query";
import { RefreshButton } from "@/ui/components/refresh-button";
import { useAtomRefresh, useAtomValue } from "@effect/atom-react";
import { useRouter } from "@tanstack/react-router";
import { Atom } from "effect/reactivity";
import { type ComponentType, type JSX, type ReactNode, Suspense, lazy, useState } from "react";
import { CaptureEditorContext, type CaptureEditorProps } from "./capture-context";
import { presentCanonicalQuery } from "@/transport/canonical-query";
import { RecurringQueryFailure } from "./query-failure";
import { Button } from "@/ui/components/button";
import { Alert, AlertDescription } from "@/ui/components/alert";
import { RecurringWorkspace } from "./workspace";
import {
  type LifecycleConfirmation,
  type SaveState,
  recurringWorkspaceQuery,
  useRecurringPlanning,
} from "./controller";
import { type Filters, type PlanInput, shiftMonth } from "./model";

export type { CaptureEditorProps } from "./capture-context";

const PreviewWorkspace = import.meta.env.DEV
  ? lazy(() => import("./dev-preview").then((module) => ({ default: module.RecurringDataPreview })))
  : RecurringWorkspace;
type Props = Readonly<{
  children: ReactNode;
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
  const [calendar, setCalendar] = useState(false);
  const [tab, setTab] = useState("monthly");
  const planning = useRecurringPlanning({
    apiClient: router.options.context.apiClient,
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
    return <PendingRead label="Cargando recurrentes" />;
  }
  const navigate = (month: string): void => {
    router.navigate({ to: "/app/recurring", search: { month } }).catch(() => undefined);
  };
  const readState = planning.stale ? "stale" : "current";

  return (
    <Suspense fallback={<PendingRead label="Cargando recurrentes" />}>
      <PreviewWorkspace
        key={`${props.month}:${JSON.stringify(props.filters)}:${Option.getOrElse(props.previous, () => "")}`}
        calendar={calendar}
        setCalendar={setCalendar}
        notice={<SaveNotice {...planning} />}
        tab={tab}
        setTab={setTab}
        readState={waiting ? "refreshing" : readState}
        view={state.value.data}
        categories={categoryState.value.data}
        save={planning.save}
        statusFor={planning.statusFor}
        disabled={planning.disabled}
        filters={props.filters}
        applyFilters={props.applyFilters}
        month={(step) => navigate(shiftMonth({ month: props.month, step }))}
        earlier={props.earlier}
        timeZone={props.timeZone}
      />
      {props.children}
    </Suspense>
  );
};
export const RecurringFeature = ({
  month: selectedMonth,
  captureEditor,
  children,
}: Readonly<{
  month: Option.Option<string>;
  captureEditor: ComponentType<CaptureEditorProps>;
  children: ReactNode;
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
    return <PendingRead label="Cargando recurrentes" />;
  }
  const user = state.value.data;
  const currentMonth = DateTime.formatIsoDate(
    DateTime.makeZonedUnsafe(now, { timeZone: user.timeZone })
  ).slice(0, "2026-01".length);
  const month = Option.getOrElse(selectedMonth, () => currentMonth);
  return (
    <CaptureEditorContext value={Option.some(captureEditor)}>
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
      >
        {children}
      </Resources>
    </CaptureEditorContext>
  );
};
const lifecycleMessages = {
  pause:
    "está pausado. No aparecerán nuevas fechas de este plan mientras esté pausado. Los registros existentes se conservan.",
  resume:
    "está activo. Fidy volverá a mostrar las próximas fechas de este plan. Los registros existentes se conservan.",
  stop: "dejó de seguirse. No aparecerán nuevas fechas de este plan. Los registros existentes se conservan.",
};
const failureMessage = (state: SaveState): string => {
  if (state === "uncertain") {
    return "No pudimos confirmar si se guardó. Actualiza y revisa el resultado antes de volver a guardar.";
  }
  if (state === "rejected") {
    return "No se guardó el cambio. Actualiza los recurrentes y revisa los datos antes de intentarlo de nuevo.";
  }
  return "Actualiza los recurrentes y revisa los datos antes de guardar.";
};
const SaveNotice = ({
  stale,
  saveState,
  waiting,
  retry,
  confirmation,
  editConfirmation,
}: Readonly<{
  stale: boolean;
  saveState: SaveState;
  waiting: boolean;
  retry: () => void;
  confirmation: Option.Option<LifecycleConfirmation>;
  editConfirmation: Option.Option<string>;
}>): JSX.Element => (
  <>
    {saveState === "saving" ? <output>Guardando cambio…</output> : null}
    {Option.isSome(editConfirmation) ? (
      <output>
        <Alert variant="success" role="presentation">
          <AlertDescription>{editConfirmation.value}</AlertDescription>
        </Alert>
      </output>
    ) : null}
    {Option.isSome(confirmation) ? (
      <output>
        <Alert variant="success" role="presentation">
          <AlertDescription>
            {confirmation.value.name} {lifecycleMessages[confirmation.value.action]}
          </AlertDescription>
        </Alert>
      </output>
    ) : null}
    {stale ||
    saveState === "uncertain" ||
    saveState === "rejected" ||
    saveState === "refreshing" ? (
      <div role="alert" className="flex flex-wrap items-center gap-3 border-b p-4">
        <p>{failureMessage(saveState)}</p>
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
