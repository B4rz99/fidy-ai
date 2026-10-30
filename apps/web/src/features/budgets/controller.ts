import { budgetStatusQuery } from "./queries";
import { workspaceCategoriesQuery } from "@/transport/workspace-query";
import { useAtomRefresh, useAtomSet, useAtomValue } from "@effect/atom-react";
import { BigDecimal, Cause, Effect, Exit, Option, Predicate, Schema } from "effect";
import type { Atom } from "effect/reactivity";
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
type ValidWrite =
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
): Atom.AtomResultFn<ValidWrite, WriteOutcome, never> =>
  apiClient.runtime.fn<ValidWrite>()(
    (command) =>
      Effect.gen(function* () {
        const client = yield* apiClient;
        if (command.type === "create") yield* client.budgets.createBudget(command.input);
        else yield* client.budgets.updateBudget(command.input);
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
  "saveState" | "disabled" | "draft" | "write" | "refresh" | "closeEditor"
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
  draft: Option.Option<BudgetDraft>;
  refreshVersion: number;
}>;
const initialInteraction: BudgetInteraction = {
  saveState: "idle",
  draft: Option.none(),
  refreshVersion: 0,
};

const useBudgetWrites = ({
  apiClient,
  month,
  editable,
  refreshQueries,
}: Readonly<{
  apiClient: FidyClient;
  month: string;
  editable: boolean;
  refreshQueries: () => void;
}>): BudgetWrites => {
  const [save] = useState(() => makeBudgetWrite(apiClient));
  const submit = useAtomSet(save, { mode: "promiseExit" });
  const admission = useRef(false);
  const [interaction, setInteraction] = useState(initialInteraction);
  const update = (patch: Partial<typeof interaction>): void =>
    setInteraction((current) => ({ ...current, ...patch }));
  const { saveState, refreshVersion } = interaction;
  const disabled = !editable || saveState === "saving" || saveState === "uncertain";
  const refresh = (): void => {
    if (admission.current) return;
    update({ refreshVersion: refreshVersion + 1, saveState: "idle", draft: Option.none() });
    refreshQueries();
  };
  const complete = (outcome: WriteOutcome): void => {
    admission.current = false;
    update(
      outcome === "saved" ? { saveState: outcome, draft: Option.none() } : { saveState: outcome }
    );
    if (outcome === "saved") refreshQueries();
  };
  const write = (edit: BudgetEdit): void => {
    if (disabled || admission.current) return;
    const parsed = validatedWrite({ edit, month });
    if (Option.isNone(parsed)) {
      update({ saveState: "failed" });
      return;
    }
    admission.current = true;
    update({ saveState: "saving" });
    submit(parsed.value)
      .then((exit) => {
        admission.current = false;
        Option.match(writeOutcome(exit), { onNone: () => undefined, onSome: complete });
      })
      .catch(() => complete("uncertain"));
  };
  return {
    ...interaction,
    disabled,
    write,
    refresh,
    openEditor: (value) => {
      if (!disabled && !admission.current) update({ draft: Option.some(value) });
    },
    closeEditor: () => {
      if (!admission.current && saveState !== "uncertain") update({ draft: Option.none() });
    },
  };
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
    disabled: writes.disabled,
    draft: writes.draft,
    write: writes.write,
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
  });
  if (reads._tag !== "Ready") return { ...reads, refresh: writes.refresh };
  return {
    _tag: "Ready",
    stale: reads.stale,
    waiting: reads.waiting,
    workspace: { ...reads.data, editing: budgetEditing(reads.data, writes) },
  };
};
