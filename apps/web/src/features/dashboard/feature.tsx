import { DashboardHtmlFeature } from "./html-feature";
import { PendingRead } from "@/ui/components/pending-read";

import { useAtomRefresh, useAtomValue } from "@effect/atom-react";
import { Option } from "effect";
import type { AsyncResult, AtomRegistry } from "effect/reactivity";
import { type JSX, type ReactNode, Suspense, useState } from "react";
import { lazyRouteComponent } from "@tanstack/react-router";

import { Button } from "@/ui/components/button";
import { CanonicalQueryRetry } from "@/ui/canonical-query-feedback";
import { type CanonicalQueryState, presentCanonicalQuery } from "@/transport/canonical-query";
import type { FidyClient } from "@/transport/client";
import { workspaceDashboardCatalogQuery } from "@/transport/workspace-query";
import { type DashboardEditorError, useDashboardEditing } from "./editing";
import type { DashboardView } from "./presentation";
import { dashboardQuery } from "./query";
import { DashboardBudgetConfiguration } from "./budget-configuration";
import type { AnyRouter } from "@tanstack/react-router";

const DashboardRoutePresentation = lazyRouteComponent(
  () => import("./view"),
  "DashboardRouteContent"
);
const DashboardViewComponent = lazyRouteComponent(() => import("./view"), "DashboardViewComponent");
// Start the full view before the query finishes, including first-interaction controls.
DashboardRoutePresentation.preload?.()?.catch(() => undefined);
DashboardViewComponent.preload?.()?.catch(() => undefined);

export const DashboardFeature = ({
  apiClient,
  children,
}: Readonly<{ apiClient: FidyClient; children: ReactNode }>): JSX.Element => (
  <DashboardHtmlFeature apiClient={apiClient} editor={DashboardStructuredEditor}>
    {children}
  </DashboardHtmlFeature>
);

const DashboardStructuredEditor = ({
  apiClient,
  onRefreshHtml,
}: Readonly<{ apiClient: FidyClient; onRefreshHtml: () => void }>): JSX.Element => {
  const [dashboard] = useState(() => dashboardQuery(apiClient));
  const result = useAtomValue(dashboard);
  const refresh = useAtomRefresh(dashboard);
  const state = presentCanonicalQuery(result);
  const blocked = state._tag === "Ready" && (state.waiting || Option.isSome(state.refreshFailure));
  const onRefresh = (): void => {
    refresh();
    onRefreshHtml();
  };
  return (
    <Suspense fallback={<PendingRead label="Cargando personalización" />}>
      {blocked ? (
        <CanonicalQueryRetry
          title="No pudimos actualizar tu tablero"
          description="Conservamos tus cambios sin guardar."
          onRetry={onRefresh}
          retryLabel="Reintentar actualización del tablero"
          retryingLabel="Reintentando…"
          waiting={state.waiting}
        />
      ) : null}
      <div hidden={blocked}>
        <DashboardRouteContent apiClient={apiClient} result={result} onRefresh={onRefresh} />
      </div>
    </Suspense>
  );
};

DashboardFeature.preloadData = (
  _input: Readonly<{
    apiClient: FidyClient;
    registry: AtomRegistry.AtomRegistry;
    router: AnyRouter;
    signal: AbortSignal;
  }>
): Promise<void> => Promise.resolve();

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
      <p className="sr-only" aria-live="polite">
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

const catalogUnavailable = (
  state: CanonicalQueryState<Readonly<{ data: ReadonlyArray<unknown> }>, unknown>
): boolean =>
  state._tag === "Failure" || (state._tag === "Ready" && Option.isSome(state.refreshFailure));

const CatalogQueryNotice = <E,>({
  onRefresh,
  state,
}: Readonly<{
  onRefresh: () => void;
  state: CanonicalQueryState<Readonly<{ data: ReadonlyArray<unknown> }>, E>;
}>): JSX.Element => {
  const failed = catalogUnavailable(state);
  return (
    <>
      {state._tag === "Initial" ? <PendingRead label="Cargando catálogo del tablero" /> : null}
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

const dashboardReadState = (waiting: boolean, failed: boolean): "ready" | "pending" | "failed" => {
  if (failed) return "failed";
  return waiting ? "pending" : "ready";
};

export const DashboardRouteContent = ({
  apiClient,
  onRefresh,
  result,
}: Readonly<{
  apiClient: FidyClient;
  onRefresh: () => void;
  result: AsyncResult.AsyncResult<Readonly<{ data: DashboardView }>, unknown>;
}>): JSX.Element => {
  const [catalogAtom] = useState(() => workspaceDashboardCatalogQuery(apiClient));
  const catalogResult = useAtomValue(catalogAtom);
  const refreshCatalog = useAtomRefresh(catalogAtom);
  const dashboardState = presentCanonicalQuery(result);
  const { lifecycleRef, editError, ...editing } = useDashboardEditing({
    apiClient,
    onRefresh,
    dashboard: dashboardState,
  });
  if (dashboardState._tag !== "Ready") {
    return (
      <div className="contents" ref={lifecycleRef}>
        <DashboardRoutePresentation onRefresh={onRefresh} result={result} />
      </div>
    );
  }

  const catalogState = presentCanonicalQuery(catalogResult);
  const dashboardFailed = Option.isSome(dashboardState.refreshFailure);
  const error = resolveEditorError(editError, catalogUnavailable(catalogState), dashboardFailed);
  const readState = dashboardReadState(dashboardState.waiting, dashboardFailed);

  return (
    <DashboardBudgetConfiguration
      apiClient={apiClient}
      disabled={editing.disabled || dashboardState.waiting || dashboardFailed}
      view={dashboardState.value.data}
      onGesture={editing.onGesture}
    >
      <div className="contents" data-dashboard-read-state={readState} ref={lifecycleRef}>
        <DashboardQueryNotices
          catalog={catalogState}
          dashboard={dashboardState}
          onRefresh={onRefresh}
          refreshCatalog={refreshCatalog}
        />
        <DashboardViewComponent
          editor={Option.some({
            catalog: catalogState._tag === "Ready" ? catalogState.value.data : [],
            error,
            ...editing,
          })}
          view={dashboardState.value.data}
          initiallyEditing
        />
      </div>
    </DashboardBudgetConfiguration>
  );
};
