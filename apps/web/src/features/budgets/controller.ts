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
  | "draft"
  | "write"
  | "remove"
  | "refresh"
  | "closeEditor"
> &
  Readonly<{
    refreshVersion: number;
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
}>;
const initialInteraction: BudgetInteraction = {
  saveState: "idle",
  writeAction: "save",
  draft: Option.none(),
  refreshVersion: 0,
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

const useBudgetWrites = ({
  apiClient,
  month,
  editable,
  refreshQueries,
  data,
}: Readonly<{
  apiClient: FidyClient;
  month: string;
  editable: boolean;
  data: Option.Option<MonthData>;
  refreshQueries: () => void;
}>): BudgetWrites => {
  const { pending, submit, refreshProjections, reset } = useBudgetSubmission(apiClient);
  const [interaction, setInteraction] = useState(initialInteraction);
  const update = (patch: Partial<typeof interaction>): void =>
    setInteraction((current) => ({ ...current, ...patch }));
  const lifetime = useBudgetWriteLifetime({ ...interaction, editable, data, refreshQueries });
  const { saveState, refreshVersion } = interaction;
  const current = (): Option.Option<BudgetWriteContext> =>
    Option.filter(lifetime.current(), eligibleContext);
  const refresh = (): void => {
    const context = lifetime.current();
    if (Option.isNone(context) || (pending() && context.value.saveState !== "uncertain")) return;
    lifetime.reset();
    reset();
    if (context.value.writeAction === "delete") refreshProjections();
    update({ refreshVersion: refreshVersion + 1, saveState: "idle", draft: Option.none() });
    context.value.refreshQueries();
  };
  const execute = (command: ValidWrite): void => {
    if (Option.isNone(current()) || pending()) return;
    update({ saveState: "saving", writeAction: command.type === "delete" ? "delete" : "save" });
    submit({ command, isCurrent: lifetime.isCurrent }, (outcome) => {
      const context = lifetime.current();
      if (Option.isNone(context)) return;
      if (outcome === "saved") lifetime.reset();
      update(
        outcome === "saved" ? { saveState: outcome, draft: Option.none() } : { saveState: outcome }
      );
      if (outcome === "saved" && command.type !== "delete") {
        context.value.refreshQueries();
      }
    });
  };
  return {
    ...interaction,
    disabled: !editable || saveState === "saving" || saveState === "uncertain",
    refresh,
    ...budgetEditActions({
      current,
      pending,
      execute,
      update,
      month,
      isCurrent: lifetime.isCurrent,
      retire: lifetime.reset,
    }),
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
const budgetEditActions = ({
  current,
  pending,
  execute,
  update,
  month,
  isCurrent,
  retire,
}: EditActionsInput): Pick<BudgetWrites, "write" | "remove" | "openEditor" | "closeEditor"> => {
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
    write,
    remove,
    openEditor: (value) => {
      const context = current();
      if (Option.isNone(context) || pending()) return;
      const target = Option.flatMap(context.value.data, (valueData) =>
        currentTarget(value, valueData)
      );
      if (Option.isSome(target)) {
        retire();
        update({ draft: target });
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

const budgetEditing = (data: MonthData, writes: BudgetWrites): BudgetEditing => {
  const saveRow = (status: BudgetStatus, amount: string): void =>
    writes.write({
      target: rowDraft({ status, categories: data.categories }),
      amount,
      currency: status.budget.cap.currency,
      groupCurrency: Option.none(),
      groupName: groupFor({ status, categories: data.categories }),
    });
  return {
    saveState: writes.saveState,
    writeAction: writes.writeAction,
    disabled: writes.disabled,
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
    saveRow,
    freezePlan: () => {
      const first = data.report.statuses[0];
      if (first !== undefined) saveRow(first, BigDecimal.format(first.budget.cap.amount));
    },
    rowKey: (status: BudgetStatus) =>
      `${status.budget.id}:${BigDecimal.format(status.budget.cap.amount)}:${writes.refreshVersion}`,
  };
};

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
