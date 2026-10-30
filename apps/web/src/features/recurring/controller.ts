import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { Cause, type Context, Data, Effect, Exit, Option, Predicate } from "effect";
import { type AsyncResult, Atom, Reactivity } from "effect/reactivity";
import { useRef, useState } from "react";
import type { CanonicalInput, CanonicalSuccess, FidyClient } from "@/transport/client";
import { type CanonicalQueryState, presentCanonicalQuery } from "@/transport/canonical-query";
import {
  revalidateWorkspaceQuery,
  workspaceCategoriesQuery,
  workspaceQueryRetention,
} from "@/transport/workspace-query";
import type { Save } from "./model";

type Query = CanonicalInput<"recurringPlans.getRecurringWorkspace">["query"];
export type SaveState = "idle" | "saving" | "rejected" | "uncertain" | "refreshing";
type WriteOutcome = "saved" | "rejected" | "uncertain";
type PlanningState = Readonly<{
  state: CanonicalQueryState<CanonicalSuccess<"recurringPlans.getRecurringWorkspace">, unknown>;
  categoryState: CanonicalQueryState<CanonicalSuccess<"categories.listCategories">, unknown>;
  saveState: SaveState;
  stale: boolean;
  waiting: boolean;
  disabled: boolean;
  save: Save;
  retry: () => void;
}>;
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
  categories: QueryResource<CanonicalSuccess<"categories.listCategories">, unknown>;
}>;
const queryResource = <A, E>({
  source,
  apiClient,
  keys,
}: Readonly<{
  source: Atom.Atom<AsyncResult.AsyncResult<A, E>>;
  apiClient: FidyClient;
  keys: ReadonlyArray<string>;
}>): QueryResource<A, E> => ({
  source,
  // Keep the prepared observation alive through the loader-to-React subscription gap.
  view: source.pipe(
    apiClient.runtime.factory.withReactivity(keys),
    revalidateWorkspaceQuery,
    Atom.setIdleTTL("400 millis")
  ),
});
type Commands = Readonly<{
  queries: Queries;
  write: Atom.AtomResultFn<
    CanonicalInput<"recurringPlans.applyRecurringEdit">,
    WriteOutcome,
    never
  >;
  refresh: Atom.AtomResultFn<Query, boolean, never>;
}>;
class WorkspaceKey extends Data.Class<Query> {}

const workspaceKey = "recurring-plans";
const makeQueries = Atom.family((apiClient: FidyClient): Queries => {
  const workspace = Atom.family((query: Query) =>
    apiClient
      .query("recurringPlans", "getRecurringWorkspace", {
        query,
        ...workspaceQueryRetention,
      })
      .pipe((source) =>
        queryResource({ source, apiClient, keys: [workspaceKey, "recurring-resume"] })
      )
  );
  return {
    workspace: (query) => workspace(new WorkspaceKey(query)),
    categories: workspaceCategoriesQuery(apiClient),
  };
});
const makeCommands = (apiClient: FidyClient): Commands => {
  const queries = makeQueries(apiClient);
  return {
    queries,
    write: apiClient.runtime.fn<CanonicalInput<"recurringPlans.applyRecurringEdit">>()(
      (input) =>
        Effect.gen(function* () {
          const client = yield* apiClient;
          yield* client.recurringPlans.applyRecurringEdit(input);
          yield* Reactivity.invalidate([workspaceKey]);
          return "saved" as const;
        }).pipe(
          Effect.catch((failure) =>
            Effect.succeed(
              Predicate.isTagged(failure, "ValidationFailed")
                ? ("rejected" as const)
                : ("uncertain" as const)
            )
          ),
          Effect.catchCause((cause) =>
            Cause.hasInterruptsOnly(cause) ? Effect.interrupt : Effect.succeed("uncertain" as const)
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

/** Retains write uncertainty across month and filter changes until an explicit reread succeeds. */
export const useRecurringPlanning = ({
  apiClient,
  query,
  profileStale,
  profileWaiting,
  refreshProfile,
}: Readonly<{
  apiClient: FidyClient;
  query: Query;
  profileStale: boolean;
  profileWaiting: boolean;
  refreshProfile: () => void;
}>): PlanningState => {
  const [commands] = useState(() => makeCommands(apiClient));
  const state = useAtomValue(commands.queries.workspace(query).view).pipe(presentCanonicalQuery);
  const categoryState = useAtomValue(commands.queries.categories.view).pipe(presentCanonicalQuery);
  const submit = useAtomSet(commands.write, { mode: "promiseExit" });
  const reread = useAtomSet(commands.refresh, { mode: "promiseExit" });
  const admission = useRef(false);
  const [saveState, setSaveState] = useState<SaveState>("idle");
  const stale =
    profileStale ||
    (state._tag === "Ready" && Option.isSome(state.refreshFailure)) ||
    (categoryState._tag === "Ready" && Option.isSome(categoryState.refreshFailure));
  const waiting =
    profileWaiting || state.waiting || categoryState.waiting || saveState === "refreshing";
  const disabled = writesDisabled({ state, categoryState, waiting, stale, saveState });
  const complete = (outcome: WriteOutcome): void => {
    admission.current = false;
    setSaveState(outcome === "saved" ? "idle" : outcome);
  };
  const save: Save = (edit) => {
    if (disabled || admission.current || state._tag !== "Ready") return;
    admission.current = true;
    setSaveState("saving");
    submit({
      payload: { expectedRevision: state.value.data.document.revision, edit, view: "compact" },
    })
      .then((exit) => complete(Exit.isSuccess(exit) ? exit.value : "uncertain"))
      .catch(() => complete("uncertain"));
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
  return { state, categoryState, saveState, stale, waiting, disabled, save, retry };
};

export const recurringWorkspaceQuery = (
  apiClient: FidyClient,
  query: Query
): ReturnType<Queries["workspace"]> => makeQueries(apiClient).workspace(query);
