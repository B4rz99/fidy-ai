import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { Cause, type Context, Data, Effect, Exit, Option, Predicate, Stream } from "effect";
import { AsyncResult, Atom, Reactivity } from "effect/reactivity";
import { useRef, useState } from "react";
import type { CanonicalInput, CanonicalSuccess, FidyClient } from "@/transport/client";
import { type CanonicalQueryState, presentCanonicalQuery } from "@/transport/canonical-query";
import {
  revalidateWorkspaceQuery,
  workspaceCategoriesQuery,
  workspaceQueryRetention,
} from "@/transport/workspace-query";
import { type Edit, type Plan, type Save, type Workspace, planStatus } from "./model";

type Query = CanonicalInput<"recurringPlans.getRecurringWorkspace">["query"];
export type SaveState = "idle" | "saving" | "rejected" | "uncertain" | "refreshing";
type WriteOutcome =
  | Readonly<{
      state: "saved";
      revision: Workspace["document"]["revision"];
      confirmation: Option.Option<LifecycleConfirmation>;
    }>
  | Readonly<{ state: "rejected" | "uncertain" }>;
export type LifecycleConfirmation = Readonly<{
  name: string;
  planId: Plan["id"];
  revision: Workspace["document"]["revision"];
  action: Extract<Edit, { kind: "lifecycle" }>["action"];
}>;
type ConfirmedLifecycle = Option.Option<LifecycleConfirmation>;
const lifecycleConfirmation = (
  document: Workspace["document"],
  edit: Edit
): Option.Option<LifecycleConfirmation> => {
  if (edit.kind !== "lifecycle") return Option.none();
  const name = document.plans.find((plan) => plan.id === edit.planId)?.revisions.at(-1)?.plan.name;
  return name === undefined
    ? Option.none()
    : Option.some({ name, action: edit.action, planId: edit.planId, revision: document.revision });
};
type PlanningState = Readonly<{
  state: CanonicalQueryState<CanonicalSuccess<"recurringPlans.getRecurringWorkspace">, unknown>;
  categoryState: CanonicalQueryState<CanonicalSuccess<"categories.listCategories">, unknown>;
  saveState: SaveState;
  confirmation: Option.Option<LifecycleConfirmation>;
  statusFor: typeof planStatus;
  stale: boolean;
  waiting: boolean;
  disabled: boolean;
  save: Save;
  retry: () => void;
}>;
const lifecycleStates = { pause: "paused", resume: "active", stop: "stopped" } as const;
const confirmedPlanStatus =
  (
    state: PlanningState["state"],
    receipt: Option.Option<LifecycleConfirmation>
  ): typeof planStatus =>
  (plan) => {
    if (Option.isNone(receipt) || state._tag !== "Ready") return planStatus(plan);
    if (
      receipt.value.planId !== plan.id ||
      receipt.value.revision <= state.value.data.document.revision
    ) {
      return planStatus(plan);
    }
    return lifecycleStates[receipt.value.action];
  };
type Client = Context.Service.Shape<FidyClient>;
type WorkspaceError = Effect.Error<ReturnType<Client["recurringPlans"]["getRecurringWorkspace"]>>;
type QueryResource<A, E> = Readonly<{
  source: Atom.Atom<AsyncResult.AsyncResult<A, E>>;
  view: Atom.Atom<AsyncResult.AsyncResult<A, E>>;
}>;
type Queries = Readonly<{
  workspace: (
    query: Query
  ) => QueryResource<CanonicalSuccess<"recurringPlans.getRecurringWorkspace">, WorkspaceError>;
  categories: ReturnType<typeof workspaceCategoriesQuery>;
}>;
type CompletionInput = Readonly<{ query: Query; revision: Workspace["document"]["revision"] }>;
type Commands = Readonly<{
  completion: Atom.AtomResultFn<CompletionInput, boolean, never>;
  queries: Queries;
  write: Atom.AtomResultFn<
    CanonicalInput<"recurringPlans.applyRecurringEdit">,
    WriteOutcome,
    never
  >;
  refresh: Atom.AtomResultFn<Query, boolean, never>;
}>;
class WorkspaceKey extends Data.Class<Query & Readonly<{ apiClient: FidyClient }>> {}
export const recurringWorkspaceKey = "recurring-plans";
const workspaceSources = Atom.family(({ apiClient, ...query }: WorkspaceKey) =>
  apiClient.query("recurringPlans", "getRecurringWorkspace", { query, ...workspaceQueryRetention })
);
const workspaceViews = Atom.family((key: WorkspaceKey) =>
  workspaceSources(key).pipe(
    key.apiClient.runtime.factory.withReactivity([recurringWorkspaceKey, "recurring-resume"]),
    revalidateWorkspaceQuery,
    Atom.setIdleTTL("400 millis")
  )
);
const makeQueries = (apiClient: FidyClient): Queries => ({
  workspace: (query) => {
    const key = new WorkspaceKey({ ...query, apiClient });
    return { source: workspaceSources(key), view: workspaceViews(key) };
  },
  categories: workspaceCategoriesQuery(apiClient),
});
const completionCommand = (apiClient: FidyClient, queries: Queries): Commands["completion"] =>
  apiClient.runtime.fn<CompletionInput>()(({ query, revision }, get) =>
    get.stream(queries.workspace(query).source).pipe(
      Stream.filter(
        (result) => AsyncResult.isSuccess(result) && result.value.data.document.revision >= revision
      ),
      Stream.take(1),
      Stream.runDrain,
      Effect.as(true),
      Effect.catchCause(() => Effect.succeed(false))
    )
  );
const makeCommands = (apiClient: FidyClient): Commands => {
  const queries = makeQueries(apiClient);
  return {
    queries,
    completion: completionCommand(apiClient, queries),
    write: apiClient.runtime.fn<CanonicalInput<"recurringPlans.applyRecurringEdit">>()(
      (input) =>
        Effect.gen(function* () {
          const client = yield* apiClient;
          const result = yield* client.recurringPlans.applyRecurringEdit(input);
          yield* Reactivity.invalidate([recurringWorkspaceKey]);
          return {
            state: "saved",
            revision: result.data.revision,
            confirmation: lifecycleConfirmation(result.data, input.payload.edit),
          } as const;
        }).pipe(
          Effect.catch((failure) =>
            Effect.succeed(
              Predicate.isTagged(failure, "ValidationFailed")
                ? ({ state: "rejected" } as const)
                : ({ state: "uncertain" } as const)
            )
          ),
          Effect.catchCause((cause) =>
            Cause.hasInterruptsOnly(cause)
              ? Effect.interrupt
              : Effect.succeed({ state: "uncertain" } as const)
          )
        ),
      { concurrent: false }
    ),
    refresh: apiClient.runtime.fn<Query>()((query, get) =>
      Effect.gen(function* () {
        // Reactive display atoms may retain success until the source refresh notification arrives.
        const workspace = queries.workspace(query).source;
        const categories = queries.categories.source;
        get.mount(workspace);
        get.mount(categories);
        get.refresh(workspace);
        get.refresh(categories);
        const workspaceResult = yield* Effect.exit(
          get.result(workspace, { suspendOnWaiting: true })
        );
        const categoryResult = yield* Effect.exit(
          get.result(categories, { suspendOnWaiting: true })
        );
        return Exit.isSuccess(workspaceResult) && Exit.isSuccess(categoryResult);
      })
    ),
  };
};
const writesDisabled = ({
  state,
  categoryState,
  waiting,
  stale,
  saveState,
}: Pick<PlanningState, "state" | "categoryState" | "waiting" | "stale" | "saveState">): boolean =>
  state._tag !== "Ready" ||
  categoryState._tag !== "Ready" ||
  waiting ||
  stale ||
  saveState === "saving" ||
  saveState === "uncertain";
const queryStale = (state: CanonicalQueryState<unknown, unknown>): boolean =>
  state._tag === "Ready" && Option.isSome(state.refreshFailure);
/** Editor completion waits for the acknowledged document, preventing stale drafts on reopen. */
const useSaveCompletion = (
  command: Commands["completion"],
  query: Query
): ((revision: CompletionInput["revision"], onSaved: () => void) => void) => {
  const complete = useAtomSet(command, { mode: "promiseExit" });
  return (revision, onSaved) => {
    complete({ query, revision })
      .then((exit) => {
        if (Exit.isSuccess(exit) && exit.value) onSaved();
      })
      .catch(() => undefined);
  };
};
type PlanningOptions = Readonly<{
  apiClient: FidyClient;
  query: Query;
  profileStale: boolean;
  profileWaiting: boolean;
  refreshProfile: () => void;
}>;
/** Retains write uncertainty across month and filter changes until an explicit reread succeeds. */
export const useRecurringPlanning = (options: PlanningOptions): PlanningState => {
  const { apiClient, query, profileStale, profileWaiting, refreshProfile } = options;
  const [commands] = useState(() => makeCommands(apiClient));
  const state = useAtomValue(commands.queries.workspace(query).view).pipe(presentCanonicalQuery);
  const categoryState = useAtomValue(commands.queries.categories.view).pipe(presentCanonicalQuery);
  const submit = useAtomSet(commands.write, { mode: "promiseExit" });
  const reread = useAtomSet(commands.refresh, { mode: "promiseExit" });
  const admission = useRef(false);
  const [saveState, setSaveState] = useState<SaveState>("idle");
  const [confirmation, setConfirmation] = useState<ConfirmedLifecycle>(Option.none);
  const stale = profileStale || queryStale(state) || queryStale(categoryState);
  const waiting =
    profileWaiting || state.waiting || categoryState.waiting || saveState === "refreshing";
  const complete = useSaveCompletion(commands.completion, query);
  const disabled = writesDisabled({ state, categoryState, waiting, stale, saveState });
  const save: Save = (edit, onSaved = () => undefined) => {
    if (disabled || admission.current || state._tag !== "Ready") return;
    admission.current = true;
    setSaveState("saving");
    setConfirmation(Option.none());
    const finish = (outcome: WriteOutcome): void => {
      admission.current = false;
      setSaveState(outcome.state === "saved" ? "idle" : outcome.state);
      if (outcome.state !== "saved") return;
      setConfirmation(outcome.confirmation);
      complete(outcome.revision, onSaved);
    };
    submit({
      payload: { expectedRevision: state.value.data.document.revision, edit, view: "compact" },
    })
      .then((exit) => finish(Exit.isSuccess(exit) ? exit.value : { state: "uncertain" }))
      .catch(() => finish({ state: "uncertain" }));
  };
  const retry = (): void => {
    if (admission.current) return;
    admission.current = true;
    const previous = saveState;
    setSaveState("refreshing");
    refreshProfile();
    const finish = (succeeded: boolean): void => {
      admission.current = false;
      setSaveState(succeeded ? "idle" : previous);
    };
    reread(query)
      .then((exit) => finish(Exit.isSuccess(exit) && exit.value))
      .catch(() => finish(false));
  };
  return {
    state,
    categoryState,
    saveState,
    confirmation,
    statusFor: confirmedPlanStatus(state, confirmation),
    stale,
    waiting,
    disabled,
    save,
    retry,
  };
};
export const recurringWorkspaceQuery = ({
  apiClient,
  query,
}: Readonly<{
  apiClient: FidyClient;
  query: Query;
}>): ReturnType<Queries["workspace"]> => makeQueries(apiClient).workspace(query);
