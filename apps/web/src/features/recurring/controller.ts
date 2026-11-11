import { RegistryContext, useAtomSet, useAtomValue } from "@effect/atom-react";
import {
  Cause,
  type Context,
  Data,
  Effect,
  Equal,
  Exit,
  Option,
  Predicate,
  Schema,
  Stream,
} from "effect";
import { AsyncResult, Atom, type AtomRegistry, Reactivity } from "effect/reactivity";
import { type RefCallback, useCallback, useContext, useState } from "react";
import {
  type CanonicalInput,
  type CanonicalSuccess,
  type FidyClient,
  RecurringEdit,
} from "@/transport/client";
import { type CanonicalQueryState, presentCanonicalQuery } from "@/transport/canonical-query";
import {
  revalidateWorkspaceQuery,
  workspaceCategoriesQuery,
  workspaceQueryRetention,
} from "@/transport/workspace-query";
import { preservedDates, restoredDates } from "./edit-scope";
import { type Edit, type Plan, type Save, type Workspace, currentPlan, planStatus } from "./model";

type Query = CanonicalInput<"recurringPlans.getRecurringWorkspace">["query"];
export type SaveState = "idle" | "saving" | "rejected" | "uncertain" | "refreshing";
type WriteOutcome =
  | Readonly<{
      state: "saved";
      input: CanonicalInput<"recurringPlans.applyRecurringEdit">;
      result: CanonicalSuccess<"recurringPlans.applyRecurringEdit">;
      revision: Workspace["document"]["revision"];
      confirmation: Option.Option<LifecycleConfirmation>;
      editConfirmation: Option.Option<string>;
    }>
  | Readonly<{ state: "rejected" | "uncertain" }>;
export type LifecycleConfirmation = Readonly<{
  name: string;
  planId: Plan["id"];
  revision: Workspace["document"]["revision"];
  action: Extract<Edit, { kind: "lifecycle" }>["action"];
  plan: Plan;
}>;
const lifecycleConfirmation = (
  document: Workspace["document"],
  edit: Edit
): Option.Option<LifecycleConfirmation> => {
  if (edit.kind !== "lifecycle") return Option.none();
  const plan = document.plans.find((entry) => entry.id === edit.planId);
  return plan === undefined
    ? Option.none()
    : Option.some({
        name: currentPlan(plan).name,
        plan,
        action: edit.action,
        planId: edit.planId,
        revision: document.revision,
      });
};
const editConfirmation = (document: Workspace["document"], edit: Edit): Option.Option<string> => {
  if (edit.kind !== "edit") return Option.none();
  if (edit.scope === "once") {
    return Option.some(
      `Se actualizó solo la expectativa de ${edit.date}. Las próximas fechas y las transacciones se conservan.`
    );
  }
  const restored = restoredDates({ document, planId: edit.planId, from: edit.date });
  const retained =
    restored.length === 0
      ? "Las fechas con ajustes individuales, seguimiento u omisión se conservan."
      : `Los ajustes individuales y las omisiones se conservan. Las fechas ${restored.join(", ")} se volvieron a incluir sin ajustes individuales y siguen el nuevo plan, aunque tengan seguimiento.`;
  const selected = preservedDates({ document, planId: edit.planId, from: edit.date }).includes(
    edit.date
  );
  return Option.some(
    `Se actualizó el plan desde ${edit.date}. ${selected ? `${edit.date} conserva sus ajustes.` : "Las fechas sin ajustes ni seguimiento siguen el calendario guardado y pueden dejar de generarse si cambió."} ${retained} Las transacciones no se modificaron.`
  );
};
type PlanningState = Readonly<{
  state: CanonicalQueryState<CanonicalSuccess<"recurringPlans.getRecurringWorkspace">, unknown>;
  categoryState: CanonicalQueryState<CanonicalSuccess<"categories.listCategories">, unknown>;
  saveState: SaveState;
  confirmation: Option.Option<LifecycleConfirmation>;
  editConfirmation: Option.Option<string>;
  statusFor: typeof planStatus;
  stale: boolean;
  waiting: boolean;
  disabled: boolean;
  save: Save;
  mounted: RefCallback<HTMLElement>;
  admit: RefCallback<HTMLElement>;
  retry: () => void;
}>;
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
    return planStatus(receipt.value.plan);
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
            input,
            result,
            revision: result.data.revision,
            confirmation: lifecycleConfirmation(result.data, input.payload.edit),
            editConfirmation: editConfirmation(result.data, input.payload.edit),
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
const useSaveFeedback = (): Pick<PlanningState, "confirmation" | "editConfirmation"> &
  Readonly<{
    clear: () => void;
    confirm: (outcome: Extract<WriteOutcome, { state: "saved" }>) => void;
  }> => {
  const [receipt, setReceipt] = useState<Option.Option<Extract<WriteOutcome, { state: "saved" }>>>(
    Option.none
  );
  return {
    confirmation: Option.flatMap(receipt, (value) => value.confirmation),
    editConfirmation: Option.flatMap(receipt, (value) => value.editConfirmation),
    clear: (): void => setReceipt(Option.none()),
    confirm: (outcome: Extract<WriteOutcome, { state: "saved" }>): void =>
      setReceipt(Option.some(outcome)),
  };
};
type PlanningOptions = Readonly<{
  apiClient: FidyClient;
  query: Query;
  profileStale: boolean;
  profileWaiting: boolean;
  refreshProfile: () => void;
}>;

class PlanningQuery extends Data.Class<Query> {}
type Interaction = Readonly<{
  active: () => boolean;
  generation: () => number;
  submission: () => number;
  nextSubmission: () => number;
  status: () => SaveState;
  transition: (next: SaveState) => void;
  admit: (query: Query, disabled: boolean) => void;
  permits: (query: Query) => boolean;
  matches: (query: Query) => boolean;
  mount: (interrupt: () => void) => () => void;
}>;
const makeInteraction = (): Interaction => {
  let active = false;
  let generation = 0;
  let submission = 0;
  let status: SaveState = "idle";
  let admission: Option.Option<Readonly<{ query: Query; disabled: boolean }>> = Option.none();
  return {
    active: (): boolean => active,
    generation: (): number => generation,
    submission: (): number => submission,
    nextSubmission: (): number => ++submission,
    status: (): SaveState => status,
    transition: (next: SaveState): void => {
      status = next;
    },
    admit: (query: Query, disabled: boolean): void => {
      admission = Option.some({ query: structuredClone(query), disabled });
    },
    matches: (query: Query): boolean =>
      Option.exists(admission, (value) =>
        Equal.equals(new PlanningQuery(value.query), new PlanningQuery(query))
      ),
    permits: (query: Query): boolean =>
      Option.exists(
        admission,
        (value) =>
          active &&
          Equal.equals(new PlanningQuery(value.query), new PlanningQuery(query)) &&
          !value.disabled
      ),
    mount: (interrupt: () => void): (() => void) => {
      active = true;
      return () => {
        active = false;
        generation += 1;
        interrupt();
      };
    },
  };
};
/** Retains write uncertainty across month and filter changes until an explicit reread succeeds. */
export const useRecurringPlanning = (options: PlanningOptions): PlanningState => {
  const { apiClient, query, profileStale, profileWaiting, refreshProfile } = options;
  const [commands] = useState(() => makeCommands(apiClient));
  const workspaceQuery = commands.queries.workspace(query);
  const state = useAtomValue(workspaceQuery.view).pipe(presentCanonicalQuery);
  const categoryState = useAtomValue(commands.queries.categories.view).pipe(presentCanonicalQuery);
  const submit = useAtomSet(commands.write, { mode: "promiseExit" });
  const reread = useAtomSet(commands.refresh, { mode: "promiseExit" });
  const registry = useContext(RegistryContext);
  const [owner] = useState(makeInteraction);
  const mounted = useCallback<RefCallback<HTMLElement>>(
    () => owner.mount(() => registry.set(commands.completion, Atom.Interrupt)),
    [commands, owner, registry]
  );
  const [saveState, setSaveState] = useState<SaveState>("idle");
  const feedback = useSaveFeedback();
  const stale = profileStale || queryStale(state) || queryStale(categoryState);
  const waiting =
    profileWaiting || state.waiting || categoryState.waiting || saveState === "refreshing";
  const complete = useAtomSet(commands.completion, { mode: "promiseExit" });
  const disabled = writesDisabled({ state, categoryState, waiting, stale, saveState });
  const admit: RefCallback<HTMLElement> = () => {
    owner.admit(query, disabled);
  };
  const { save, retry } = planningActions({
    commands,
    registry,
    owner,
    query,
    state,
    disabled,
    submit,
    complete,
    reread,
    feedback,
    setSaveState,
    refreshProfile,
  });
  return {
    state,
    categoryState,
    saveState,
    confirmation: feedback.confirmation,
    editConfirmation: feedback.editConfirmation,
    statusFor: confirmedPlanStatus(state, feedback.confirmation),
    stale,
    waiting,
    disabled,
    save,
    mounted,
    admit,
    retry,
  };
};
type Actions = Readonly<{
  commands: Commands;
  registry: AtomRegistry.AtomRegistry;
  owner: Interaction;
  query: Query;
  state: PlanningState["state"];
  disabled: boolean;
  submit: (
    input: CanonicalInput<"recurringPlans.applyRecurringEdit">
  ) => Promise<Exit.Exit<WriteOutcome>>;
  complete: (input: CompletionInput) => Promise<Exit.Exit<boolean>>;
  reread: (query: Query) => Promise<Exit.Exit<boolean>>;
  feedback: ReturnType<typeof useSaveFeedback>;
  setSaveState: (state: SaveState) => void;
  refreshProfile: () => void;
}>;
const planningActions = (options: Actions): Pick<PlanningState, "save" | "retry"> => ({
  save: (edit, onSaved = () => undefined) => saveEdit(options, edit, onSaved),
  retry: () => retryReads(options),
});
const freshQuery = (state: CanonicalQueryState<unknown, unknown>): boolean =>
  state._tag === "Ready" && !state.waiting && !queryStale(state);
const admittedRevision = ({
  commands,
  registry,
  owner,
  query,
  state,
  disabled,
}: Actions): Option.Option<number> => {
  const source = commands.queries.workspace(query).source;
  if (
    !owner.permits(query) ||
    disabled ||
    ["saving", "uncertain", "refreshing"].includes(owner.status())
  ) {
    return Option.none();
  }
  const freshState = presentCanonicalQuery(registry.get(source));
  const freshCategories = presentCanonicalQuery(registry.get(commands.queries.categories.source));
  if (state._tag !== "Ready" || freshState._tag !== "Ready") return Option.none();
  if (
    ![freshState, freshCategories].every(freshQuery) ||
    freshState.value.data.document.revision !== state.value.data.document.revision
  ) {
    return Option.none();
  }
  return Option.some(state.value.data.document.revision);
};
const editCodec = Schema.toCodecJson(RecurringEdit);
const snapshotEdit = (edit: Edit): Edit =>
  Schema.decodeSync(editCodec)(structuredClone(Schema.encodeSync(editCodec)(edit)));
const saveEdit = (options: Actions, edit: Edit, onSaved: () => void): void => {
  const { owner, query, setSaveState, feedback, complete, submit } = options;
  const revision = admittedRevision(options);
  if (Option.isNone(revision)) return;
  const savedEdit = snapshotEdit(edit);
  const originatingQuery = structuredClone(query);
  owner.transition("saving");
  const generation = owner.generation();
  const submission = owner.nextSubmission();
  const current = (): boolean =>
    owner.active() && owner.generation() === generation && owner.submission() === submission;
  setSaveState("saving");
  feedback.clear();
  const finish = (outcome: WriteOutcome): void => {
    if (!current()) return;
    owner.transition(outcome.state === "saved" ? "idle" : outcome.state);
    setSaveState(owner.status());
    if (outcome.state !== "saved") return;
    feedback.confirm(outcome);
    complete({ query: originatingQuery, revision: outcome.revision })
      .then((exit) => {
        if (current() && Exit.isSuccess(exit) && exit.value) onSaved();
      })
      .catch(() => undefined);
  };
  submit({
    payload: {
      expectedRevision: revision.value,
      edit: savedEdit,
      view: "compact",
    },
  })
    .then(
      (exit) => finish(Exit.isSuccess(exit) ? exit.value : { state: "uncertain" }),
      () => finish({ state: "uncertain" })
    )
    .catch(() => undefined);
};
const retryReads = ({ owner, setSaveState, refreshProfile, reread, query }: Actions): void => {
  if (
    !owner.active() ||
    !owner.matches(query) ||
    ["saving", "refreshing"].includes(owner.status())
  ) {
    return;
  }
  const prior = owner.status();
  const generation = owner.generation();
  owner.transition("refreshing");
  setSaveState("refreshing");
  refreshProfile();
  const finish = (succeeded: boolean): void => {
    if (!owner.active() || owner.generation() !== generation) return;
    owner.transition(succeeded ? "idle" : prior);
    setSaveState(owner.status());
  };
  reread(query)
    .then((exit) => finish(Exit.isSuccess(exit) && exit.value))
    .catch(() => finish(false));
};
export const recurringWorkspaceQuery = ({
  apiClient,
  query,
}: Readonly<{
  apiClient: FidyClient;
  query: Query;
}>): ReturnType<Queries["workspace"]> => makeQueries(apiClient).workspace(query);
