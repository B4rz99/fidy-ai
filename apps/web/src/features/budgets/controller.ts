import { type BudgetWriteContext, useBudgetWriteLifetime } from "./write-lifetime";
import { budgetStatusQuery } from "./queries";
import { workspaceCategoriesQuery } from "@/transport/workspace-query";
import { useAtomRefresh, useAtomSet, useAtomValue } from "@effect/atom-react";
import { BigDecimal, Cause, Effect, Exit, Option, Predicate, Schema } from "effect";
import { type Atom, Reactivity } from "effect/reactivity";
import { useRef, useState } from "react";
import { type CanonicalInput, Currency, type FidyClient } from "@/transport/client";
import { isCanonicalInput } from "@/transport/canonical-input";
import { presentCanonicalQuery } from "@/transport/canonical-query";
import {
  type BudgetDraft,
  type BudgetEdit,
  type BudgetEditing,
  type SaveState,
  type WorkspaceProps,
  groupFor,
  rowDraft,
} from "./model";
import type { BudgetStatus, Category, CurrentUser } from "./presentation";

type BudgetMonth =
  | Readonly<{ _tag: "Loading" | "Failure"; waiting: boolean; refresh: () => void }>
  | Readonly<{ _tag: "Ready"; stale: boolean; waiting: boolean; workspace: WorkspaceProps }>;
type WriteOutcome = "saved" | "failed" | "uncertain";
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
        Effect.catch((failure) =>
          Effect.succeed(
            Predicate.isTagged(failure, "ValidationFailed") ||
              Predicate.isTagged(failure, "NotFound") ||
              Predicate.isTagged(failure, "ResourceLimited")
              ? ("failed" as const)
              : ("uncertain" as const)
          )
        ),
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
type MonthRead =
  | Readonly<{ _tag: "Loading" | "Failure"; waiting: boolean; refresh: () => void }>
  | Readonly<{
      _tag: "Ready";
      stale: boolean;
      waiting: boolean;
      refresh: () => void;
      data: MonthData;
    }>;
const useMonthQueries = ({ apiClient, user, month }: MonthInput): MonthRead => {
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
  if (states.some((state) => state._tag === "Failure")) {
    return { _tag: "Failure", waiting, refresh };
  }
  if (reportState._tag !== "Ready" || categoryState._tag !== "Ready") {
    return { _tag: "Loading", waiting, refresh };
  }
  const stale = [reportState.refreshFailure, categoryState.refreshFailure].some(Option.isSome);
  return {
    _tag: "Ready",
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
  };
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
  writeAction: "save" | "delete";
  draft: Option.Option<BudgetDraft>;
  refreshVersion: number;
  inlineDraft: Option.Option<BudgetEdit>;
}>;
const initialInteraction: BudgetInteraction = {
  saveState: "idle",
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

const eligibleContext = (context: BudgetWriteContext): boolean =>
  context.editable && context.saveState !== "saving" && context.saveState !== "uncertain";

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
}>;
const useBudgetWrites = (input: BudgetWritesInput): BudgetWrites => {
  const { apiClient, month, editable, refreshQueries, data } = input;
  const { pending, submit, refreshProjections, reset } = useBudgetSubmission(apiClient);
  const [interaction, setInteraction] = useState(initialInteraction);
  const [navigation] = useState(makeMonthNavigation);
  const update = (patch: Partial<typeof interaction>): void =>
    setInteraction((current) => ({ ...current, ...patch }));
  const lifetime = useBudgetWriteLifetime({ ...interaction, editable, data, refreshQueries });
  const { saveState, refreshVersion } = interaction;
  const current = (): Option.Option<BudgetWriteContext> =>
    Option.filter(lifetime.current(), eligibleContext);
  const execute = (command: ValidWrite): void => {
    if (Option.isNone(current()) || pending()) return;
    update({ saveState: "saving", writeAction: command.type === "delete" ? "delete" : "save" });
    submit({ command, isCurrent: lifetime.isCurrent }, (outcome) => {
      const context = lifetime.current();
      if (Option.isNone(context)) return;
      if (outcome === "saved") lifetime.reset();
      update(
        outcome === "saved"
          ? { saveState: outcome, draft: Option.none(), inlineDraft: Option.none() }
          : { saveState: outcome }
      );
      if (outcome === "saved" && command.type !== "delete") {
        context.value.refreshQueries();
        navigation.finish();
      } else navigation.reset();
    });
  };
  const actions = budgetEditActions({
    current,
    pending,
    execute,
    update,
    month,
    isCurrent: lifetime.isCurrent,
    retire: lifetime.reset,
  });
  return {
    ...interaction,
    disabled: !editable || saveState === "saving" || saveState === "uncertain",
    navigationDisabled:
      !editable ||
      saveState === "uncertain" ||
      (saveState === "saving" && Option.isSome(interaction.draft)),
    ...budgetMonthNavigation({ lifetime, current, pending, navigation, write: actions.write }),
    refresh: budgetWriteRefresh({
      lifetime,
      pending,
      reset,
      refreshProjections,
      navigation,
      update,
      refreshVersion,
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
  isCurrent: () => boolean;
  retire: () => void;
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
  const { current, pending, execute, update, isCurrent, retire } = input;
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
          writeAction: "save",
        });
      }
    },
    closeEditor: () => {
      if (isCurrent() && !pending()) {
        retire();
        update({ draft: Option.none() });
      }
    },
  };
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

const inlineRowEdit = (data: MonthData, status: BudgetStatus, amount: string): BudgetEdit => ({
  target: rowDraft({ status, categories: data.categories }),
  amount,
  currency: status.budget.cap.currency,
  groupCurrency: Option.none(),
  groupName: groupFor({ status, categories: data.categories }),
});

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
    rowDisabled: (status) => writes.disabled || (inlinePending && !isInlineRow(status)),
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
    changeRow: (status, amount) => writes.changeRow(inlineRowEdit(data, status, amount)),
    saveRow: (status, amount) => {
      const edit = inlineRowEdit(data, status, amount);
      if (!inlineMatchesSaved({ inlineDraft: Option.some(edit), data: Option.some(data) })) {
        writes.write(edit);
      }
    },
  };
};

const budgetEditing = (data: MonthData, writes: BudgetWrites): BudgetEditing => ({
  saveState: writes.saveState,
  writeAction: writes.writeAction,
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
    writes.openEditor(rowDraft({ status, categories: data.categories })),
  configureGroup: (group: string) => {
    const statuses = data.report.statuses.filter(
      (status) => groupFor({ status, categories: data.categories }) === group
    );
    const first = statuses[0];
    if (first !== undefined) {
      writes.openEditor({
        ...rowDraft({ status: first, categories: data.categories }),
        groupCategoryIds: Option.some(statuses.map((status) => status.budget.categoryId)),
      });
    }
  },
  freezePlan: () => {
    const first = data.report.statuses[0];
    if (first !== undefined) {
      writes.write(inlineRowEdit(data, first, BigDecimal.format(first.budget.cap.amount)));
    }
  },
  rowKey: (status: BudgetStatus) =>
    `${status.budget.id}:${BigDecimal.format(status.budget.cap.amount)}:${writes.refreshVersion}`,
});

/** Owns one User's monthly reads, write admission and explicit reread recovery.
 * Query atoms retain canonical facts; local state retains only edit interaction and feedback.
 */
export const useMonthlyBudgets = (input: MonthInput): BudgetMonth => {
  const reads = useMonthQueries(input);
  const writes = useBudgetWrites({
    ...input,
    editable: input.profileCurrent && reads._tag === "Ready" && !reads.stale && !reads.waiting,
    refreshQueries: reads.refresh,
    data: reads._tag === "Ready" ? Option.some(reads.data) : Option.none(),
  });
  if (reads._tag !== "Ready") return { ...reads, refresh: writes.refresh };
  return {
    _tag: "Ready",
    stale: reads.stale,
    waiting: reads.waiting,
    workspace: { ...reads.data, editing: budgetEditing(reads.data, writes) },
  };
};
