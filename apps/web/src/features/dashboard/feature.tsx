import { useAtomRefresh, useAtomValue } from "@effect/atom-react";
import { Option } from "effect";
import type { AsyncResult } from "effect/reactivity";
import { type JSX, useState } from "react";
import { Button } from "@/ui/components/button";
import { CanonicalQueryRetry } from "@/ui/canonical-query-feedback";
import { type CanonicalQueryState, presentCanonicalQuery } from "@/transport/canonical-query";
import type { FidyClient } from "@/transport/client";
import { type DashboardEditorError, useDashboardEditing } from "./editing";
import type { DashboardView } from "./presentation";
import { type DashboardLoadPhase, dashboardQuery } from "./query";
import {
  DashboardRouteContent as DashboardRoutePresentation,
  DashboardViewComponent,
} from "./view";

export const DashboardFeature = ({
  apiClient,
}: Readonly<{ apiClient: FidyClient }>): JSX.Element => {
  const [dashboard] = useState(() => dashboardQuery(apiClient));
  const result = useAtomValue(dashboard.result);
  const phase = useAtomValue(dashboard.phase);
  const refresh = useAtomRefresh(dashboard.result);
  return (
    <DashboardRouteContent
      apiClient={apiClient}
      result={result}
      phase={phase}
      onRefresh={refresh}
    />
  );
};

const unavailableCatalogError: DashboardEditorError = {
  title: "No pudimos cargar el catálogo",
  message: "Los demás controles siguen disponibles.",
  onRefresh: Option.none(),
};
const staleDashboardError: DashboardEditorError = {
  title: "El cambio se guardó, pero no pudimos actualizar el tablero",
  message: "Mostramos el último tablero disponible. Intenta actualizarlo de nuevo.",
  onRefresh: Option.none(),
};

const resolveEditorError = (
  editError: Option.Option<DashboardEditorError>,
  catalogFailed: boolean,
  dashboardFailed: boolean
): Option.Option<DashboardEditorError> => {
  if (Option.isSome(editError)) return editError;
  if (catalogFailed) return Option.some(unavailableCatalogError);
  return dashboardFailed ? Option.some(staleDashboardError) : Option.none();
};

const DashboardQueryNotice = <E,>({
  onRefresh,
  state,
}: Readonly<{
  onRefresh: () => void;
  state: CanonicalQueryState<Readonly<{ data: DashboardView }>, E>;
}>): JSX.Element => (
  <>
    {state.waiting ? (
      <p className="m-4 text-sm text-muted-foreground" aria-live="polite">
        Actualizando tablero…
      </p>
    ) : null}
    {state._tag === "Ready" && Option.isSome(state.refreshFailure) ? (
      <div className="m-4">
        <CanonicalQueryRetry
          description="Mostramos el último tablero disponible."
          onRetry={onRefresh}
          retryLabel="Reintentar actualización del tablero"
          retryingLabel="Reintentando…"
          title="No pudimos actualizar el tablero"
          waiting={state.waiting}
        />
      </div>
    ) : null}
  </>
);

const CatalogQueryNotice = <E,>({
  onRefresh,
  state,
}: Readonly<{
  onRefresh: () => void;
  state: CanonicalQueryState<Readonly<{ data: ReadonlyArray<unknown> }>, E>;
}>): JSX.Element => {
  const failed =
    state._tag === "Failure" || (state._tag === "Ready" && Option.isSome(state.refreshFailure));
  return (
    <>
      {state._tag === "Initial" && !state.waiting ? (
        <p className="m-4 text-sm text-muted-foreground">
          El catálogo del tablero aún no se ha solicitado.
        </p>
      ) : null}
      {state.waiting ? (
        <p className="m-4 text-sm text-muted-foreground" aria-live="polite">
          Cargando catálogo del tablero…
        </p>
      ) : null}
      {failed ? (
        <Button
          className="m-4"
          disabled={state.waiting}
          onClick={onRefresh}
          type="button"
          variant="outline"
        >
          {state.waiting ? "Reintentando catálogo…" : "Reintentar carga del catálogo"}
        </Button>
      ) : null}
    </>
  );
};

const DashboardQueryNotices = <CatalogError, DashboardError>({
  catalog,
  dashboard,
  onRefresh,
  refreshCatalog,
}: Readonly<{
  catalog: CanonicalQueryState<Readonly<{ data: ReadonlyArray<unknown> }>, CatalogError>;
  dashboard: CanonicalQueryState<Readonly<{ data: DashboardView }>, DashboardError>;
  onRefresh: () => void;
  refreshCatalog: () => void;
}>): JSX.Element => (
  <>
    <DashboardQueryNotice onRefresh={onRefresh} state={dashboard} />
    <CatalogQueryNotice onRefresh={refreshCatalog} state={catalog} />
  </>
);

const DashboardLoadNotice = ({
  phase,
  waiting,
}: Readonly<{ phase: DashboardLoadPhase; waiting: boolean }>): JSX.Element => {
  switch (phase) {
    case "reading":
      return <></>;
    case "initializing":
      return (
        <p aria-live="polite">
          {waiting ? "Inicializando tablero…" : "No pudimos inicializar el tablero."}
        </p>
      );
    case "reading-initialized":
      return (
        <p aria-live="polite">
          {waiting
            ? "Leyendo el tablero inicializado…"
            : "El tablero se inicializó, pero no pudimos leerlo."}
        </p>
      );
  }
};

export const DashboardRouteContent = ({
  apiClient,
  onRefresh,
  result,
  phase,
}: Readonly<{
  apiClient: FidyClient;
  onRefresh: () => void;
  result: AsyncResult.AsyncResult<Readonly<{ data: DashboardView }>, unknown>;
  phase: DashboardLoadPhase;
}>): JSX.Element => {
  const [catalogAtom] = useState(() => apiClient.query("dashboard", "listDashboardCatalog", {}));
  const catalogResult = useAtomValue(catalogAtom);
  const refreshCatalog = useAtomRefresh(catalogAtom);
  const dashboardState = presentCanonicalQuery(result);
  const { lifecycleRef, editError, onGesture, submitting, disabled, pendingPlacement } =
    useDashboardEditing({ apiClient, onRefresh, dashboard: dashboardState });
  if (dashboardState._tag !== "Ready") {
    return (
      <div className="contents" ref={lifecycleRef}>
        <DashboardLoadNotice phase={phase} waiting={dashboardState.waiting} />
        <DashboardRoutePresentation onRefresh={onRefresh} result={result} />
      </div>
    );
  }

  const catalogState = presentCanonicalQuery(catalogResult);
  const catalog = catalogState._tag === "Ready" ? catalogState.value : { data: [] };
  const dashboardFailed = Option.isSome(dashboardState.refreshFailure);
  const catalogFailed =
    catalogState._tag === "Failure" ||
    (catalogState._tag === "Ready" && Option.isSome(catalogState.refreshFailure));
  const error = resolveEditorError(editError, catalogFailed, dashboardFailed);

  return (
    <div className="contents" ref={lifecycleRef}>
      <DashboardQueryNotices
        catalog={catalogState}
        dashboard={dashboardState}
        onRefresh={onRefresh}
        refreshCatalog={refreshCatalog}
      />
      <DashboardViewComponent
        editor={Option.some({
          catalog: catalog.data,
          error,
          onGesture,
          submitting,
          disabled,
          pendingPlacement,
        })}
        view={dashboardState.value.data}
      />
    </div>
  );
};
