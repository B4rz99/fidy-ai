import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { Effect, Exit, Option, Result } from "effect";
import { AsyncResult } from "effect/unstable/reactivity";
import { type JSX, useRef, useState } from "react";
import { Button } from "@/ui/components/button";
import type { DashboardEdit, FidyClient } from "@/transport/client";
import { type DashboardGesture, compileDashboardGesture } from "./editor-model";
import type { DashboardView } from "./presentation";
import {
  type DashboardEditorError,
  DashboardRouteContent as DashboardRoutePresentation,
  DashboardViewComponent,
} from "./view";

const settledEditQueue = Promise.resolve();

const rejectedEditError: DashboardEditorError = {
  title: "No pudimos guardar el cambio",
  message: "El cambio fue rechazado. Revisa los valores e intenta de nuevo.",
};
const unavailableCatalogError: DashboardEditorError = {
  title: "No pudimos cargar el catálogo",
  message: "Los demás controles siguen disponibles.",
};
const staleDashboardError: DashboardEditorError = {
  title: "El cambio se guardó, pero no pudimos actualizar el tablero",
  message: "Mostramos el último tablero disponible. Intenta actualizarlo de nuevo.",
};

type CanonicalDashboardEdit = DashboardEdit;

const canonicalEditEffect = Effect.fn("dashboard.applyCanonicalEdit")(function* (
  apiClient: FidyClient,
  edit: CanonicalDashboardEdit
) {
  const client = yield* apiClient;
  // The generated client accepts each tagged payload member separately; narrowing here preserves
  // exhaustive operation coverage without weakening the canonical input type.
  switch (edit.op) {
    case "set-title":
      return yield* client.dashboard.applyDashboardEdit({ payload: edit });
    case "add-widget":
      return yield* client.dashboard.applyDashboardEdit({ payload: edit });
    case "remove-widget":
      return yield* client.dashboard.applyDashboardEdit({ payload: edit });
    case "move-widget":
      return yield* client.dashboard.applyDashboardEdit({ payload: edit });
    case "swap-widgets":
      return yield* client.dashboard.applyDashboardEdit({ payload: edit });
    case "resize-region":
      return yield* client.dashboard.applyDashboardEdit({ payload: edit });
    case "update-widget":
      return yield* client.dashboard.applyDashboardEdit({ payload: edit });
  }
});

const useQueuedDashboardEdits = (
  apiClient: FidyClient
): Readonly<{
  editError: Option.Option<DashboardEditorError>;
  onGesture: (gesture: DashboardGesture) => void;
  submitting: boolean;
}> => {
  const [editAtom] = useState(() =>
    apiClient.runtime.fn<CanonicalDashboardEdit>()((edit) => canonicalEditEffect(apiClient, edit), {
      concurrent: false,
      reactivityKeys: ["dashboard"],
    })
  );
  const applyEdit = useAtomSet(editAtom, { mode: "promiseExit" });
  const [pendingEdits, setPendingEdits] = useState(0);
  const [editError, setEditError] = useState(() => Option.none<DashboardEditorError>());
  const editQueue = useRef<Promise<void>>(settledEditQueue);
  const onGesture = (gesture: DashboardGesture): void => {
    const compiled = compileDashboardGesture(gesture);
    if (Result.isFailure(compiled)) {
      setEditError(Option.some(rejectedEditError));
      return;
    }
    setPendingEdits((pending) => pending + 1);
    const applyQueuedEdit = (): Promise<void> => {
      setEditError(Option.none());
      return applyEdit(compiled.success).then(
        (outcome) => {
          if (Exit.isFailure(outcome)) setEditError(Option.some(rejectedEditError));
        },
        () => setEditError(Option.some(rejectedEditError))
      );
    };
    editQueue.current = editQueue.current
      .then(applyQueuedEdit)
      .finally(() => setPendingEdits((pending) => pending - 1));
  };
  return { editError, onGesture, submitting: pendingEdits > 0 };
};

const resolveEditorError = (
  editError: Option.Option<DashboardEditorError>,
  catalogFailed: boolean,
  stale: boolean
): Option.Option<DashboardEditorError> => {
  if (Option.isSome(editError)) return editError;
  if (catalogFailed) return Option.some(unavailableCatalogError);
  return stale ? Option.some(staleDashboardError) : Option.none();
};

/** Coordinates canonical Dashboard queries and edits while preserving the last successful canvas. */
export const DashboardRouteContent = ({
  apiClient,
  onRefresh,
  result,
}: Readonly<{
  apiClient: FidyClient;
  onRefresh: () => void;
  result: AsyncResult.AsyncResult<Readonly<{ data: DashboardView }>, unknown>;
}>): JSX.Element => {
  const [catalogAtom] = useState(() => apiClient.query("dashboard", "listDashboardCatalog", {}));
  const catalogResult = useAtomValue(catalogAtom);
  const { editError, onGesture, submitting } = useQueuedDashboardEdits(apiClient);
  const displayedView = Option.map(AsyncResult.value(result), ({ data }) => data);
  if (Option.isNone(displayedView)) return <DashboardRoutePresentation result={result} />;

  const catalog = Option.getOrElse(
    AsyncResult.value(catalogResult),
    (): Readonly<{ data: readonly [] }> => ({ data: [] })
  );
  const stale = !AsyncResult.isSuccess(result);
  const error = resolveEditorError(editError, AsyncResult.isFailure(catalogResult), stale);

  return (
    <>
      {stale ? (
        <Button className="m-4" onClick={onRefresh} type="button" variant="outline">
          Reintentar actualización del tablero
        </Button>
      ) : null}
      <DashboardViewComponent
        editor={Option.some({
          catalog: catalog.data,
          error,
          onGesture,
          submitting,
        })}
        view={displayedView.value}
      />
    </>
  );
};
