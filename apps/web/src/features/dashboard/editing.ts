import { useAtomSet } from "@effect/atom-react";
import { Cause, Effect, Exit, Option, Predicate, Result } from "effect";
import { type Dispatch, type RefCallback, type SetStateAction, useState } from "react";
import type { CanonicalQueryState } from "@/transport/canonical-query";
import type { CanonicalInput, DashboardEdit, FidyClient } from "@/transport/client";
import { type DashboardGesture, compileDashboardGesture } from "./editor-model";
import type { DashboardView } from "./presentation";
import { type PlacementLayout, previewDashboardPlacement } from "./placement-preview";

export type DashboardEditorError = Readonly<{
  message: string;
  title: string;
  onRefresh: Option.Option<() => void>;
}>;
type DashboardState = CanonicalQueryState<Readonly<{ data: DashboardView }>, unknown>;
type PendingPlacement = Readonly<{ edit: DashboardEdit; baseline: DashboardView }>;
type Recovery = Readonly<{ baseline: DashboardView; requested: boolean }>;

const rejectedEditError: DashboardEditorError = {
  title: "No pudimos guardar el cambio",
  message: "El cambio fue rechazado. Revisa los valores e intenta de nuevo.",
  onRefresh: Option.none(),
};
const uncertainEditError: DashboardEditorError = {
  title: "No pudimos confirmar el cambio",
  message:
    "El cambio podría haberse guardado. Actualiza el tablero y revísalo antes de intentar otro cambio.",
  onRefresh: Option.none(),
};
type CanonicalDashboardEdit = CanonicalInput<"dashboard.applyDashboardEdit">["payload"];

const canonicalEditEffect = Effect.fn("dashboard.applyCanonicalEdit")(function* (
  apiClient: FidyClient,
  edit: CanonicalDashboardEdit
) {
  const client = yield* apiClient;
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

const editOutcomeError = (
  outcome: Exit.Exit<unknown, unknown>,
  onRefresh: () => void
): Option.Option<DashboardEditorError> => {
  if (Exit.isSuccess(outcome)) return Option.none();
  const failure =
    Cause.hasDies(outcome.cause) || Cause.hasInterrupts(outcome.cause)
      ? Option.none()
      : Cause.findErrorOption(outcome.cause);
  const missing = Option.exists(failure, (error) => Predicate.isTagged(error, "NotFound"));
  const stale = Option.exists(failure, (error) =>
    Predicate.isTagged(error, "DashboardRevisionConflict")
  );
  if (stale) {
    return Option.some({
      title: "El tablero cambió en otra pestaña",
      message: "Actualiza el tablero y revisa tus cambios antes de volver a guardarlos.",
      onRefresh: Option.some(onRefresh),
    });
  }
  if (missing) {
    return Option.some({
      title: "Actualiza el tablero",
      message:
        "Este Widget ya no está disponible en tu tablero actual. Actualiza antes de intentar otro cambio.",
      onRefresh: Option.some(onRefresh),
    });
  }
  const refused = Option.exists(
    failure,
    (error) =>
      Predicate.isTagged(error, "NotFound") || Predicate.isTagged(error, "ValidationFailed")
  );
  return Option.some(
    refused ? rejectedEditError : { ...uncertainEditError, onRefresh: Option.some(onRefresh) }
  );
};

const awaitingCanonicalRead = (
  dashboard: CanonicalQueryState<Readonly<{ data: DashboardView }>, unknown>,
  baseline: DashboardView
): boolean =>
  dashboard._tag !== "Ready" ||
  (dashboard.value.data === baseline && Option.isNone(dashboard.refreshFailure));

type EditLifetime = Readonly<{
  owner: { active: boolean; generation: number; halted: boolean };
  lifecycleRef: RefCallback<HTMLDivElement>;
}>;
const makeEditLifetime = (): EditLifetime => {
  const owner = { active: false, generation: 0, halted: false };
  return {
    owner,
    lifecycleRef: (node) => {
      if (node === null) return;
      owner.active = true;
      return (): void => {
        owner.active = false;
        owner.generation += 1;
      };
    },
  };
};
type Submission = Readonly<{
  lifetime: EditLifetime;
  recovered: boolean;
  dashboard: DashboardState;
  setRecovery: Dispatch<SetStateAction<Option.Option<Recovery>>>;
  setEditError: Dispatch<SetStateAction<Option.Option<DashboardEditorError>>>;
  setPendingPlacement: Dispatch<SetStateAction<Option.Option<PendingPlacement>>>;
  setPendingEdits: Dispatch<SetStateAction<number>>;
  refresh: () => void;
  applyEdit: (edit: CanonicalDashboardEdit) => Promise<Exit.Exit<unknown, unknown>>;
}>;
const submitGesture = (
  {
    lifetime,
    recovered,
    dashboard,
    setRecovery,
    setEditError,
    setPendingPlacement,
    setPendingEdits,
    refresh,
    applyEdit,
  }: Submission,
  gesture: DashboardGesture
): void => {
  const owner = lifetime.owner;
  if (!owner.active || (owner.halted && !recovered) || dashboard._tag !== "Ready") return;
  if (recovered) {
    owner.halted = false;
    setRecovery(Option.none());
  }
  const compiled = compileDashboardGesture(gesture);
  if (Result.isFailure(compiled)) {
    setEditError(Option.some(rejectedEditError));
    return;
  }
  const generation = owner.generation;
  const baseline = dashboard.value.data;
  setPendingPlacement(Option.some({ edit: compiled.success, baseline }));
  setPendingEdits((pending) => pending + 1);
  const current = (): boolean => owner.active && owner.generation === generation;
  const complete = (outcome: Exit.Exit<unknown, unknown>): void => {
    if (!current()) return;
    const error = editOutcomeError(outcome, refresh);
    setEditError(error);
    if (Option.isSome(error) && Option.isSome(error.value.onRefresh)) {
      owner.halted = true;
      owner.generation += 1;
      setPendingEdits(0);
      setPendingPlacement(Option.none());
      setRecovery(Option.some({ baseline, requested: false }));
    }
  };
  setEditError(Option.none());
  applyEdit({
    ...compiled.success,
    expectedRevision: "expectedRevision" in gesture ? gesture.expectedRevision : baseline.revision,
  })
    .then(complete, () => complete(Exit.die("Dashboard edit acknowledgment unavailable")))
    .finally(() => {
      if (current()) setPendingEdits((pending) => pending - 1);
    });
};
type DashboardEditing = Readonly<{
  revision: number;
  lifecycleRef: RefCallback<HTMLDivElement>;
  editError: Option.Option<DashboardEditorError>;
  onGesture: (gesture: DashboardGesture) => void;
  submitting: boolean;
  disabled: boolean;
  pendingPlacement: Option.Option<PlacementLayout>;
}>;
const hasRecovered = (recovery: Option.Option<Recovery>, dashboard: DashboardState): boolean =>
  Option.exists(
    recovery,
    ({ baseline, requested }) =>
      requested &&
      dashboard._tag === "Ready" &&
      !dashboard.waiting &&
      Option.isNone(dashboard.refreshFailure) &&
      dashboard.value.data !== baseline
  );
/** Owns edit lifetimes, provisional geometry and recovery for one mounted Dashboard.
 * Uncertain outcomes require an explicit successful reread.
 * Unmount retires callbacks; an already-sent mutation may still have committed.
 */
export const useDashboardEditing = ({
  apiClient,
  onRefresh,
  dashboard,
}: Readonly<{
  apiClient: FidyClient;
  onRefresh: () => void;
  dashboard: DashboardState;
}>): DashboardEditing => {
  const [editAtom] = useState(() =>
    apiClient.runtime.fn<CanonicalDashboardEdit>()((edit) => canonicalEditEffect(apiClient, edit), {
      concurrent: true,
      reactivityKeys: ["dashboard"],
    })
  );
  const applyEdit = useAtomSet(editAtom, { mode: "promiseExit" });
  const [pendingEdits, setPendingEdits] = useState(0);
  const [editError, setEditError] = useState(() => Option.none<DashboardEditorError>());
  const [pendingPlacement, setPendingPlacement] = useState(() => Option.none<PendingPlacement>());
  const [recovery, setRecovery] = useState(() => Option.none<Recovery>());
  const [lifetime] = useState(makeEditLifetime);
  const recovered = hasRecovered(recovery, dashboard);
  const refresh = (): void => {
    if (dashboard._tag === "Ready") {
      setRecovery(Option.some({ baseline: dashboard.value.data, requested: true }));
    }
    onRefresh();
  };
  const onGesture = (gesture: DashboardGesture): void =>
    submitGesture(
      {
        lifetime,
        recovered,
        dashboard,
        setRecovery,
        setEditError,
        setPendingPlacement,
        setPendingEdits,
        refresh,
        applyEdit,
      },
      gesture
    );
  return projectEditing({
    pendingPlacement,
    editError,
    dashboard,
    pendingEdits,
    recovery,
    recovered,
    lifecycleRef: lifetime.lifecycleRef,
    onGesture,
    refresh,
  });
};
const projectEditing = ({
  pendingPlacement,
  editError,
  dashboard,
  pendingEdits,
  recovery,
  recovered,
  lifecycleRef,
  onGesture,
  refresh,
}: Readonly<{
  pendingPlacement: Option.Option<PendingPlacement>;
  editError: Option.Option<DashboardEditorError>;
  dashboard: DashboardState;
  pendingEdits: number;
  recovery: Option.Option<Recovery>;
  recovered: boolean;
  lifecycleRef: RefCallback<HTMLDivElement>;
  onGesture: (gesture: DashboardGesture) => void;
  refresh: () => void;
}>): DashboardEditing => {
  const pending = Option.filter(
    pendingPlacement,
    ({ baseline }) => Option.isNone(editError) && awaitingCanonicalRead(dashboard, baseline)
  );
  const submitting = pendingEdits > 0 || Option.isSome(pending);
  const blocked = Option.isSome(recovery) && !recovered;
  return {
    revision: dashboard._tag === "Ready" ? dashboard.value.data.revision : 0,
    lifecycleRef,
    editError: recovered
      ? Option.none()
      : Option.map(editError, (error) => ({
          ...error,
          onRefresh: Option.map(error.onRefresh, () => refresh),
        })),
    onGesture,
    submitting,
    disabled: submitting || blocked,
    pendingPlacement: Option.map(pending, ({ edit, baseline }) =>
      previewDashboardPlacement({ layout: baseline.layout, edit })
    ),
  };
};
