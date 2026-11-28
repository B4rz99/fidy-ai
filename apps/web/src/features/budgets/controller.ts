import { type BudgetWriteContext, useBudgetWriteLifetime } from "./write-lifetime";
import { budgetStatusQuery } from "./queries";
import { workspaceCategoriesQuery } from "@/transport/workspace-query";
import { RegistryContext, useAtomRefresh, useAtomSet, useAtomValue } from "@effect/atom-react";
import { BigDecimal, Cause, Data, Effect, Exit, Option, Predicate, Schema } from "effect";
import { type Atom, type AtomRegistry, Reactivity } from "effect/reactivity";
import { useContext, useRef, useState } from "react";
import { type CanonicalInput, Currency, type FidyClient } from "@/transport/client";
import { isCanonicalInput } from "@/transport/canonical-input";
import { prepareQuery } from "@/transport/query-preparation";
import { presentCanonicalQuery } from "@/transport/canonical-query";
import {
  type BudgetDraft,
  type BudgetEdit,
  type BudgetEditing,
  type GroupRecovery,
  type SaveState,
  type WorkspaceProps,
  groupFor,
  rowDraft,
} from "./model";
import type { BudgetStatus, Category, CurrentUser } from "./presentation";

type PendingMonth = { readonly waiting: boolean; readonly refresh: () => void };

export type BudgetMonth = Data.TaggedEnum<{
  Loading: PendingMonth;
  Failure: PendingMonth;
  Ready: { readonly stale: boolean; readonly waiting: boolean; readonly workspace: WorkspaceProps };
}>;

export const BudgetMonth = Data.taggedEnum<BudgetMonth>();

type WriteOutcome = "saved" | "failed" | "uncertain" | "currencyChanged";

const deletionProjectionKeys = ["budgets", "dashboard"];

type OwnedWrite = Readonly<{ command: ValidWrite; isCurrent: () => boolean }>;

type ValidWrite =
  | Readonly<{ type: "delete"; input: CanonicalInput<"budgets.deleteBudget"> }>
  | Readonly<{ type: "create"; input: CanonicalInput<"budgets.createBudget"> }>
  | Readonly<{ type: "update"; input: CanonicalInput<"budgets.updateBudget"> }>;

const validatedWrite = ({
  edit,
  month,
}: Readonly<{ edit: BudgetEdit; month: string }>): Option.Option<ValidWrite> => {
  const amount = BigDecimal.fromString(edit.amount.trim().replace(",", "."));
  const currency = Schema.decodeUnknownOption(Currency)(edit.currency);

  if (Option.isNone(amount) || Option.isNone(currency)) {
    return Option.none();
  }

  const payload = {
    categoryId: edit.target.category.id,
    cap: {
      amount: amount.value,
      currency:
        Option.isSome(edit.groupCurrency) && Option.isSome(edit.target.budget)
          ? edit.target.budget.value.cap.currency
          : currency.value,
    },
    month,
    groupName: edit.groupName,
    ...Option.match(edit.groupCurrency, {
      onNone: () => ({}),
      onSome: () => ({ groupCurrency: currency.value }),
    }),
    ...Option.match(edit.target.groupCategoryIds, {
      onNone: () => ({}),
      onSome: (groupCategoryIds) => ({ groupCategoryIds }),
    }),
  };

  if (Option.isSome(edit.target.budget)) {
    const input: CanonicalInput<"budgets.updateBudget"> = {
      params: { id: edit.target.budget.value.id },
      payload,
    };

    return isCanonicalInput("budgets.updateBudget", input)
      ? Option.some({ type: "update", input })
      : Option.none();
  }

  const input: CanonicalInput<"budgets.createBudget"> = { payload };

  return isCanonicalInput("budgets.createBudget", input)
    ? Option.some({ type: "create", input })
    : Option.none();
};

const makeBudgetWrite = (
  apiClient: FidyClient
): Atom.AtomResultFn<OwnedWrite, WriteOutcome, never> =>
  apiClient.runtime.fn<OwnedWrite>()(
    ({ command, isCurrent }) =>
      Effect.gen(function* () {
        const client = yield* apiClient;

        if (!isCurrent()) return yield* Effect.interrupt;

        if (command.type === "create") yield* client.budgets.createBudget(command.input);
        else if (command.type === "update") yield* client.budgets.updateBudget(command.input);
        else yield* client.budgets.deleteBudget(command.input);

        return "saved" as const;
      }).pipe(
        Effect.catchTag("ValidationFailed", (failure) =>
          Effect.succeed(
            command.type === "update" &&
              command.input.payload.groupCurrency !== undefined &&
              failure.error.fields.some((field) => field.path === "cap.currency")
              ? ("currencyChanged" as const)
              : ("failed" as const)
          )
        ),
        Effect.catchTag(["NotFound", "ResourceLimited"], () => Effect.succeed("failed" as const)),
        Effect.orElseSucceed(() => "uncertain" as const),
        Effect.catchCause((cause) =>
          Cause.hasInterruptsOnly(cause) ? Effect.interrupt : Effect.succeed("uncertain" as const)
        ),
        Effect.tap((outcome) =>
          command.type === "delete" && outcome !== "failed"
            ? Reactivity.invalidate(deletionProjectionKeys)
            : Effect.void
        )
      ),
    { concurrent: false }
  );

type MonthInput = Readonly<{
  apiClient: FidyClient;
  user: CurrentUser;
  month: string;
  profileCurrent: boolean;
}>;

type MonthData = Omit<WorkspaceProps, "editing">;

type MonthRead = Data.TaggedEnum<{
  Loading: PendingMonth;
  Failure: PendingMonth;
  Ready: {
    readonly stale: boolean;
    readonly waiting: boolean;
    readonly refresh: () => void;
    readonly data: MonthData;
    readonly reread: () => Promise<Option.Option<MonthData>>;
  };
}>;

const MonthRead = Data.taggedEnum<MonthRead>();

const rereadMonth = ({
  registry,
  report,
  categories,
  user,
  month,
}: Pick<MonthInput, "user" | "month"> &
  Readonly<{
    registry: AtomRegistry.AtomRegistry;
    report: ReturnType<typeof budgetStatusQuery>;
    categories: ReturnType<typeof workspaceCategoriesQuery>["view"];
  }>): Promise<Option.Option<MonthData>> => {
  const options = { mode: "fresh", signal: Option.none() } as const;

  return Promise.all([
    prepareQuery({ registry, query: report, options }),
    prepareQuery({ registry, query: categories, options }),
  ]).then(() => {
    const nextReport = presentCanonicalQuery(registry.get(report));
    const nextCategories = presentCanonicalQuery(registry.get(categories));

    if (
      !Predicate.isTagged(nextReport, "Ready") ||
      !Predicate.isTagged(nextCategories, "Ready") ||
      nextReport.waiting ||
      nextCategories.waiting ||
      Option.isSome(nextReport.refreshFailure) ||
      Option.isSome(nextCategories.refreshFailure)
    ) {
      return Option.none();
    }

    return Option.some({
      user,
      month,
      report: nextReport.value.data,
      categories: nextCategories.value.data,
      budgets: nextReport.value.data.budgets,
    });
  });
};

const useMonthQueries = ({ apiClient, user, month }: MonthInput): MonthRead => {
  const registry = useContext(RegistryContext);
  const [report] = useState(() => budgetStatusQuery({ apiClient, user, month }));
  const [categories] = useState(() => workspaceCategoriesQuery(apiClient).view);
  const reportState = useAtomValue(report).pipe(presentCanonicalQuery);
  const categoryState = useAtomValue(categories).pipe(presentCanonicalQuery);
  const refreshReport = useAtomRefresh(report);
  const refreshCategories = useAtomRefresh(categories);

  const refresh = (): void => {
    refreshReport();
    refreshCategories();
  };

  const states = [reportState, categoryState];
  const waiting = states.some((state) => state.waiting);

  if (states.some(Predicate.isTagged("Failure"))) {
    return MonthRead.Failure({ waiting, refresh });
  }

  if (!Predicate.isTagged(reportState, "Ready") || !Predicate.isTagged(categoryState, "Ready")) {
    return MonthRead.Loading({ waiting, refresh });
  }

  const stale = [reportState.refreshFailure, categoryState.refreshFailure].some(Option.isSome);

  return MonthRead.Ready({
    reread: () => rereadMonth({ registry, report, categories, user, month }),
    stale,
    waiting,
    refresh,
    data: {
      user,
      month,
      report: reportState.value.data,
      categories: categoryState.value.data,
      budgets: reportState.value.data.budgets,
    },
  });
};

type BudgetWrites = Pick<
  BudgetEditing,
  | "saveState"
  | "writeAction"
  | "disabled"
  | "navigationDisabled"
  | "moveMonth"
  | "discardInline"
  | "draft"
  | "write"
  | "remove"
  | "refresh"
  | "groupRecovery"
  | "closeEditor"
> &
  Readonly<{
    refreshVersion: number;
    inlineDraft: Option.Option<BudgetEdit>;
    changeRow: (edit: BudgetEdit) => void;
    openEditor: (draft: BudgetDraft) => void;
  }>;

const writeOutcome = (exit: Exit.Exit<WriteOutcome, never>): Option.Option<WriteOutcome> => {
  if (Exit.isSuccess(exit)) return Option.some(exit.value);

  return Cause.hasInterruptsOnly(exit.cause) ? Option.none() : Option.some("uncertain");
};

type BudgetInteraction = Readonly<{
  saveState: SaveState;
  groupRecovery: GroupRecovery;
  writeAction: "save" | "delete";
  draft: Option.Option<BudgetDraft>;
  refreshVersion: number;
  inlineDraft: Option.Option<BudgetEdit>;
}>;

const initialInteraction: BudgetInteraction = {
  saveState: "idle",
  groupRecovery: "idle",
  writeAction: "save",
  draft: Option.none(),
  refreshVersion: 0,
  inlineDraft: Option.none(),
};

const deletionWrite = (draft: Option.Option<BudgetDraft>): Option.Option<ValidWrite> => {
  if (
    Option.isNone(draft) ||
    Option.isSome(draft.value.groupCategoryIds) ||
    Option.isNone(draft.value.budget)
  ) {
    return Option.none();
  }

  return Option.some({ type: "delete", input: { params: { id: draft.value.budget.value.id } } });
};

type BudgetSubmission = Readonly<{
  refreshProjections: () => void;
  pending: () => boolean;
  reset: () => void;
  submit: (write: OwnedWrite, complete: (outcome: WriteOutcome) => void) => void;
}>;

const useBudgetSubmission = (apiClient: FidyClient): BudgetSubmission => {
  const [command] = useState(() => makeBudgetWrite(apiClient));

  const [refresh] = useState(() =>
    apiClient.runtime.fn<void>()(() => Reactivity.invalidate(deletionProjectionKeys))
  );

  const refreshProjections = useAtomSet(refresh);
  const submit = useAtomSet(command, { mode: "promiseExit" });
  const admission = useRef(false);

  return {
    refreshProjections,
    pending: () => admission.current,
    reset: () => {
      admission.current = false;
    },
    submit: (write: OwnedWrite, complete: (outcome: WriteOutcome) => void): void => {
      admission.current = true;
      submit(write)
        .then((exit) => {
          const outcome = writeOutcome(exit);
          admission.current = Option.isSome(outcome) && outcome.value === "uncertain";
          Option.match(outcome, { onNone: () => undefined, onSome: complete });
        })
        .catch(() => {
          admission.current = true;
          complete("uncertain");
        });
    },
  };
};

const groupNeedsRefresh = (recovery: GroupRecovery): boolean =>
  recovery !== "idle" && recovery !== "review";

const eligibleContext = (context: BudgetWriteContext): boolean =>
  context.editable &&
  context.saveState !== "saving" &&
  context.saveState !== "uncertain" &&
  !groupNeedsRefresh(context.groupRecovery);

type MonthNavigation = Readonly<{
  defer: (navigate: () => void) => void;
  finish: () => void;
  reset: () => void;
}>;

const makeMonthNavigation = (): MonthNavigation => {
  let destination = Option.none<() => void>();

  const reset = (): void => {
    destination = Option.none();
  };

  return {
    defer: (navigate) => {
      destination = Option.some(navigate);
    },
    finish: () => {
      const next = destination;
      reset();
      Option.match(next, { onNone: () => undefined, onSome: (navigate) => navigate() });
    },
    reset,
  };
};

const inlineMatchesSaved = (context: Pick<BudgetWriteContext, "inlineDraft" | "data">): boolean => {
  if (Option.isNone(context.inlineDraft) || Option.isNone(context.data)) return false;
  const edit = context.inlineDraft.value;
  const target = currentTarget(edit.target, context.data.value);
  const amount = BigDecimal.fromString(edit.amount.trim().replace(",", "."));

  return (
    Option.isSome(target) &&
    Option.isSome(target.value.budget) &&
    Option.isSome(amount) &&
    target.value.budget.value.cap.currency === edit.currency &&
    BigDecimal.equals(target.value.budget.value.cap.amount, amount.value)
  );
};

const budgetMonthNavigation = ({
  lifetime,
  current,
  pending,
  navigation,
  write,
}: Readonly<{
  write: (edit: BudgetEdit) => void;
  lifetime: ReturnType<typeof useBudgetWriteLifetime>;
  current: () => Option.Option<BudgetWriteContext>;
  pending: () => boolean;
  navigation: MonthNavigation;
}>): Pick<BudgetEditing, "moveMonth"> => ({
  moveMonth: (navigate) => {
    const context = lifetime.current();

    if (Option.isNone(context) || context.value.saveState === "uncertain") return;

    if (pending()) {
      if (Option.isNone(context.value.draft)) navigation.defer(navigate);

      return;
    }

    if (Option.isNone(current())) return;

    if (inlineMatchesSaved(context.value)) return navigate();
    Option.match(context.value.inlineDraft, {
      onNone: navigate,
      onSome: (edit) => {
        write(edit);

        if (pending()) navigation.defer(navigate);
      },
    });
  },
});

const budgetWriteRefresh =
  ({
    lifetime,
    pending,
    reset,
    refreshProjections,
    navigation,
    update,
    refreshVersion,
  }: Readonly<{
    lifetime: ReturnType<typeof useBudgetWriteLifetime>;
    pending: () => boolean;
    reset: () => void;
    refreshProjections: () => void;
    navigation: MonthNavigation;
    update: (patch: Partial<BudgetInteraction>) => void;
    refreshVersion: number;
  }>): (() => void) =>
  () => {
    const context = lifetime.current();

    if (Option.isNone(context) || (pending() && context.value.saveState !== "uncertain")) return;
    lifetime.reset();
    navigation.reset();
    reset();

    if (context.value.writeAction === "delete") refreshProjections();
    update({
      refreshVersion: refreshVersion + 1,
      saveState: "idle",
      draft: Option.none(),
      groupRecovery: "idle",
      inlineDraft: inlineMatchesSaved(context.value) ? Option.none() : context.value.inlineDraft,
    });
    context.value.refreshQueries();
  };

type BudgetWritesInput = Readonly<{
  apiClient: FidyClient;
  month: string;
  editable: boolean;
  data: Option.Option<MonthData>;
  refreshQueries: () => void;
  reread: () => Promise<Option.Option<MonthData>>;
}>;

type BudgetInteractionUpdate = (patch: Partial<BudgetInteraction>) => void;

const budgetFailurePatch = (
  context: BudgetWriteContext,
  outcome: Exclude<WriteOutcome, "saved">
): Partial<BudgetInteraction> => {
  const saveState = outcome === "currencyChanged" ? "failed" : outcome;

  if (!Option.exists(context.draft, (draft) => Option.isSome(draft.groupCategoryIds))) {
    return { saveState };
  }

  return { saveState, groupRecovery: outcome === "currencyChanged" ? "conflict" : "required" };
};

const budgetExecute =
  ({
    lifetime,
    current,
    pending,
    submit,
    update,
    navigation,
  }: Readonly<{
    lifetime: ReturnType<typeof useBudgetWriteLifetime>;
    current: () => Option.Option<BudgetWriteContext>;
    pending: () => boolean;
    submit: BudgetSubmission["submit"];
    update: BudgetInteractionUpdate;
    navigation: MonthNavigation;
  }>) =>
  (command: ValidWrite): void => {
    if (Option.isNone(current()) || pending()) return;

    update({
      saveState: "saving",
      groupRecovery: "idle",
      writeAction: command.type === "delete" ? "delete" : "save",
    });
    submit({ command, isCurrent: lifetime.isCurrent }, (outcome) => {
      const context = lifetime.current();

      if (Option.isNone(context)) return;

      if (outcome !== "saved") {
        update(budgetFailurePatch(context.value, outcome));
        navigation.reset();

        return;
      }

      lifetime.reset();
      update({ saveState: outcome, draft: Option.none(), inlineDraft: Option.none() });

      if (command.type !== "delete") {
        context.value.refreshQueries();
        navigation.finish();
      } else navigation.reset();
    });
  };

type GroupRead = Readonly<{
  pending: () => boolean;
  start: () => void;
  finish: () => void;
}>;

const makeGroupRead = (): GroupRead => {
  let pending = false;

  return {
    pending: (): boolean => pending,
    start: (): void => {
      pending = true;
    },
    finish: (): void => {
      pending = false;
    },
  };
};

const budgetGroupRefresh =
  ({
    lifetime,
    read,
    reread,
    reset,
    update,
  }: Readonly<{
    lifetime: ReturnType<typeof useBudgetWriteLifetime>;
    read: ReturnType<typeof makeGroupRead>;
    reread: BudgetWritesInput["reread"];
    reset: () => void;
    update: BudgetInteractionUpdate;
  }>) =>
  (): void => {
    const context = lifetime.current();

    if (Option.isNone(context) || read.pending()) return;

    const { draft, groupRecovery } = context.value;

    if (Option.isNone(draft) || !groupNeedsRefresh(groupRecovery)) return;

    read.start();
    update({ groupRecovery: "refreshing" });

    const finish = (latest: Option.Option<MonthData>): void => {
      read.finish();

      if (!lifetime.isCurrent()) return;

      if (Option.isNone(latest)) {
        update({ groupRecovery: "retry" });

        return;
      }

      const refreshed = refreshedGroupTarget(draft.value, latest.value);
      lifetime.reset();
      reset();
      update(
        Option.isSome(refreshed)
          ? { draft: refreshed, groupRecovery: "review", saveState: "idle" }
          : { groupRecovery: "unavailable", saveState: "idle" }
      );
    };

    reread().then(finish, () => finish(Option.none()));
  };

const useBudgetWrites = (input: BudgetWritesInput): BudgetWrites => {
  const { apiClient, month, editable, refreshQueries, data, reread } = input;

  const {
    submit,
    refreshProjections,
    reset,
    pending: writePending,
  } = useBudgetSubmission(apiClient);

  const [read] = useState(makeGroupRead);
  const pending = (): boolean => read.pending() || writePending();
  const [interaction, setInteraction] = useState(initialInteraction);
  const [navigation] = useState(makeMonthNavigation);

  const update = (patch: Partial<typeof interaction>): void =>
    setInteraction((current) => ({ ...current, ...patch }));

  const lifetime = useBudgetWriteLifetime({ ...interaction, editable, data, refreshQueries });
  const { saveState, groupRecovery } = interaction;

  const current = (): Option.Option<BudgetWriteContext> =>
    Option.filter(lifetime.current(), eligibleContext);

  const execute = budgetExecute({ lifetime, current, pending, submit, update, navigation });
  const refreshGroup = budgetGroupRefresh({ lifetime, read, reread, reset, update });

  const actions = budgetEditActions({
    current,
    pending,
    execute,
    update,
    month,
    lifetime,
    retire: lifetime.reset,
    refreshQueries,
  });

  return {
    ...interaction,
    disabled: !editable || saveState === "saving" || saveState === "uncertain",
    navigationDisabled:
      !editable ||
      groupNeedsRefresh(groupRecovery) ||
      saveState === "uncertain" ||
      (saveState === "saving" && Option.isSome(interaction.draft)),
    ...budgetMonthNavigation({ lifetime, current, pending, navigation, write: actions.write }),
    refresh: groupNeedsRefresh(groupRecovery)
      ? refreshGroup
      : budgetWriteRefresh({
          lifetime,
          pending: () => read.pending() || writePending(),
          reset,
          refreshProjections,
          navigation,
          update,
          refreshVersion: interaction.refreshVersion,
        }),
    ...actions,
  };
};

type EditActionsInput = Readonly<{
  current: () => Option.Option<BudgetWriteContext>;
  pending: () => boolean;
  execute: (command: ValidWrite) => void;
  update: (patch: Partial<BudgetInteraction>) => void;
  month: string;
  lifetime: ReturnType<typeof useBudgetWriteLifetime>;
  retire: () => void;
  refreshQueries: () => void;
}>;

const budgetEditWrite = ({
  current,
  pending,
  update,
  execute,
  month,
}: EditActionsInput): BudgetWrites["write"] => {
  const write = (edit: BudgetEdit): void => {
    if (Option.isNone(current()) || pending()) return;
    const context = current();

    if (Option.isNone(context) || Option.isNone(context.value.data)) return;
    const target = currentTarget(edit.target, context.value.data.value);

    if (Option.isNone(target) && Option.isSome(edit.target.groupCategoryIds)) {
      update({ saveState: "failed", writeAction: "save", groupRecovery: "conflict" });

      return;
    }

    Option.match(
      Option.flatMap(target, (value) =>
        validatedWrite({ edit: { ...edit, target: value }, month })
      ),
      {
        onNone: () => update({ saveState: "failed", writeAction: "save" }),
        onSome: execute,
      }
    );
  };

  return write;
};

const budgetInlineChange =
  ({ current, pending, update }: EditActionsInput): BudgetWrites["changeRow"] =>
  (edit) => {
    const context = current();

    if (Option.isNone(context) || pending()) return;

    if (
      Option.isSome(context.value.inlineDraft) &&
      !inlineMatchesSaved(context.value) &&
      context.value.inlineDraft.value.target.category.id !== edit.target.category.id
    ) {
      return;
    }

    const inlineDraft = inlineMatchesSaved({ ...context.value, inlineDraft: Option.some(edit) })
      ? Option.none<BudgetEdit>()
      : Option.some(edit);

    update({ inlineDraft, saveState: "idle" });
  };

const budgetEditActions = (
  input: EditActionsInput
): Pick<
  BudgetWrites,
  "write" | "remove" | "openEditor" | "closeEditor" | "changeRow" | "discardInline"
> => {
  const { current, pending, execute, update, retire } = input;

  const remove = (): void =>
    Option.match(
      Option.flatMap(current(), (context) =>
        Option.flatMap(context.data, (value) =>
          Option.flatMap(context.draft, (draft) => currentTarget(draft, value))
        )
      ).pipe(deletionWrite),
      {
        onNone: () => undefined,
        onSome: execute,
      }
    );

  return {
    write: budgetEditWrite(input),
    remove,
    changeRow: budgetInlineChange(input),
    discardInline: () => {
      if (Option.isNone(current()) || pending()) return;
      retire();
      update({ inlineDraft: Option.none(), saveState: "idle" });
    },
    openEditor: (value) => {
      const context = current();

      if (
        Option.isNone(context) ||
        pending() ||
        (Option.isSome(context.value.inlineDraft) && !inlineMatchesSaved(context.value))
      ) {
        return;
      }

      const target = Option.flatMap(context.value.data, (valueData) =>
        currentTarget(value, valueData)
      );

      if (Option.isSome(target)) {
        retire();
        update({
          draft: target,
          inlineDraft: Option.none(),
          saveState: "idle",
          groupRecovery: "idle",
          writeAction: "save",
        });
      }
    },
    closeEditor: closeBudgetEditor(input),
  };
};

const closeBudgetEditor =
  ({ lifetime, pending, retire, refreshQueries, update }: EditActionsInput): (() => void) =>
  () => {
    const context = lifetime.current();

    if (Option.isNone(context) || pending()) return;

    retire();
    const { groupRecovery } = context.value;

    if (groupNeedsRefresh(groupRecovery) && groupRecovery !== "unavailable") refreshQueries();
    update({ draft: Option.none(), groupRecovery: "idle", saveState: "idle" });
  };

const currentGroup = (draft: BudgetDraft, data: MonthData): boolean => {
  if (Option.isNone(draft.groupCategoryIds)) return true;
  const ids = draft.groupCategoryIds.value;

  const status = data.report.statuses.find(
    (value) => value.budget.categoryId === draft.category.id
  );

  if (status === undefined) return false;
  const group = groupFor({ status, categories: data.categories });

  const members = data.report.statuses.filter(
    (value) => groupFor({ status: value, categories: data.categories }) === group
  );

  return (
    members.length === ids.length && members.every((value) => ids.includes(value.budget.categoryId))
  );
};

const currentTarget = (draft: BudgetDraft, data: MonthData): Option.Option<BudgetDraft> => {
  const category = data.categories.find((value) => value.id === draft.category.id);

  if (category === undefined) return Option.none();
  const budget = data.budgets.find((value) => value.categoryId === category.id);

  const matches = Option.match(draft.budget, {
    onNone: () => budget === undefined,
    onSome: (previous) =>
      budget?.id === previous.id &&
      budget.cap.currency === previous.cap.currency &&
      budget.groupName === previous.groupName,
  });

  if (!matches) return Option.none();

  if (!currentGroup(draft, data)) return Option.none();

  return Option.some({
    category,
    budget: Option.fromUndefinedOr(budget),
    groupCategoryIds: draft.groupCategoryIds,
  });
};

const refreshedGroupTarget = (draft: BudgetDraft, data: MonthData): Option.Option<BudgetDraft> => {
  const category = data.categories.find((item) => item.id === draft.category.id);

  const budget = data.budgets.find(
    (item) =>
      item.categoryId === draft.category.id &&
      Option.exists(draft.budget, (previous) => previous.id === item.id)
  );

  if (category === undefined || budget === undefined || !currentGroup(draft, data)) {
    return Option.none();
  }

  return Option.some({ ...draft, category, budget: Option.some(budget) });
};

const inlineRowEdit = (
  data: MonthData,
  status: BudgetStatus,
  amount: string
): Option.Option<BudgetEdit> =>
  Option.map(rowDraft({ status, categories: data.categories }), (target) => ({
    target,
    amount,
    currency: status.budget.cap.currency,
    groupCurrency: Option.none(),
    groupName: groupFor({ status, categories: data.categories }),
  }));

const budgetRowEditing = (
  data: MonthData,
  writes: BudgetWrites
): Pick<BudgetEditing, "disabled" | "rowDisabled" | "rowAmount" | "changeRow" | "saveRow"> => {
  const inlinePending =
    Option.isSome(writes.inlineDraft) &&
    !inlineMatchesSaved({ inlineDraft: writes.inlineDraft, data: Option.some(data) });

  const isInlineRow = (status: BudgetStatus): boolean =>
    Option.exists(
      writes.inlineDraft,
      (edit) =>
        edit.target.category.id === status.budget.categoryId &&
        Option.isSome(currentTarget(edit.target, data))
    );

  return {
    disabled: writes.disabled || inlinePending,
    rowDisabled: (status) =>
      writes.disabled ||
      groupNeedsRefresh(writes.groupRecovery) ||
      (inlinePending && !isInlineRow(status)),
    rowAmount: (status) =>
      Option.match(writes.inlineDraft, {
        onNone: () => BigDecimal.format(status.budget.cap.amount),
        onSome: (edit) =>
          Option.isSome(edit.target.budget) &&
          edit.target.budget.value.id === status.budget.id &&
          Option.isSome(currentTarget(edit.target, data))
            ? edit.amount
            : BigDecimal.format(status.budget.cap.amount),
      }),
    changeRow: (status, amount) =>
      Option.map(inlineRowEdit(data, status, amount), writes.changeRow),
    saveRow: (status, amount) =>
      inlineRowEdit(data, status, amount).pipe(
        Option.filter(
          (edit) => !inlineMatchesSaved({ inlineDraft: Option.some(edit), data: Option.some(data) })
        ),
        Option.map(writes.write)
      ),
  };
};

const budgetEditing = (data: MonthData, writes: BudgetWrites): BudgetEditing => ({
  saveState: writes.saveState,
  writeAction: writes.writeAction,
  groupRecovery: writes.groupRecovery,
  ...budgetRowEditing(data, writes),
  navigationDisabled: writes.navigationDisabled,
  hasInlineDraft: Option.isSome(writes.inlineDraft),
  inlineRecovery: Option.filter(writes.inlineDraft, (edit) =>
    Option.isNone(currentTarget(edit.target, data))
  ),
  discardInline: writes.discardInline,
  moveMonth: writes.moveMonth,
  draft: writes.draft,
  write: writes.write,
  remove: writes.remove,
  refresh: writes.refresh,
  closeEditor: writes.closeEditor,
  assignCategory: (category: Category) =>
    writes.openEditor({
      category,
      budget: Option.fromUndefinedOr(
        data.budgets.find((budget) => budget.categoryId === category.id)
      ),
      groupCategoryIds: Option.none(),
    }),
  configureCategory: (status: BudgetStatus) =>
    Option.map(rowDraft({ status, categories: data.categories }), writes.openEditor),
  configureGroup: (group: string) => {
    const statuses = data.report.statuses.filter(
      (status) => groupFor({ status, categories: data.categories }) === group
    );

    Option.fromUndefinedOr(statuses[0]).pipe(
      Option.flatMap((first) => rowDraft({ status: first, categories: data.categories })),
      Option.map((draft) =>
        writes.openEditor({
          ...draft,
          groupCategoryIds: Option.some(statuses.map((status) => status.budget.categoryId)),
        })
      )
    );
  },
  freezePlan: () => {
    const first = data.report.statuses[0];

    Option.fromUndefinedOr(first).pipe(
      Option.flatMap((status) =>
        inlineRowEdit(data, status, BigDecimal.format(status.budget.cap.amount))
      ),
      Option.map(writes.write)
    );
  },
  rowKey: (status: BudgetStatus) =>
    `${status.budget.id}:${BigDecimal.format(status.budget.cap.amount)}:${writes.refreshVersion}`,
});

export const useMonthlyBudgets = (input: MonthInput): BudgetMonth => {
  const reads = useMonthQueries(input);

  const ready = Option.liftPredicate(reads, MonthRead.$is("Ready"));

  const writes = useBudgetWrites({
    ...input,
    editable: input.profileCurrent && Option.exists(ready, (read) => !read.stale && !read.waiting),
    refreshQueries: reads.refresh,
    reread: () => (MonthRead.$is("Ready")(reads) ? reads.reread() : Promise.resolve(Option.none())),
    data: Option.map(ready, (read) => read.data),
  });

  return MonthRead.$match(reads, {
    Loading: ({ waiting }) => BudgetMonth.Loading({ waiting, refresh: writes.refresh }),
    Failure: ({ waiting }) => BudgetMonth.Failure({ waiting, refresh: writes.refresh }),
    Ready: (read) =>
      BudgetMonth.Ready({
        stale: read.stale,
        waiting: read.waiting,
        workspace: { ...read.data, editing: budgetEditing(read.data, writes) },
      }),
  });
};
