import { BudgetSkeleton } from "@/ui/components/budget-loading";
import { workspaceProfileQuery } from "@/transport/workspace-query";
import { useAtomRefresh, useAtomValue } from "@effect/atom-react";
import { useRouter, useSearch } from "@tanstack/react-router";
import { Option } from "effect";
import { type JSX, Suspense, lazy, useState } from "react";
import { presentCanonicalQuery } from "@/transport/canonical-query";
import { CanonicalQueryRetry } from "@/ui/canonical-query-feedback";
import { currentBudgetMonth } from "./model";
import { useMonthlyBudgets } from "./controller";
import { BudgetWorkspace } from "./workspace";
import type { CurrentUser } from "./presentation";

const Workspace = import.meta.env.DEV
  ? lazy(() => import("./dev-preview").then((module) => ({ default: module.BudgetDataPreview })))
  : BudgetWorkspace;

const Failure = ({
  retry,
  waiting,
}: Readonly<{ retry: () => void; waiting: boolean }>): JSX.Element => (
  <div className="p-5">
    <CanonicalQueryRetry
      title="No pudimos cargar tus presupuestos"
      description="Intenta de nuevo en unos momentos."
      retryLabel="Reintentar"
      retryingLabel="Reintentando…"
      onRetry={retry}
      waiting={waiting}
    />
  </div>
);

const MonthlyBudgets = ({
  user,
  month,
  profileCurrent,
}: Readonly<{ user: CurrentUser; month: string; profileCurrent: boolean }>): JSX.Element => {
  const router = useRouter();
  const state = useMonthlyBudgets({
    apiClient: router.options.context.apiClient,
    user,
    month,
    profileCurrent,
  });
  if (state._tag === "Failure") return <Failure retry={state.refresh} waiting={state.waiting} />;
  if (state._tag !== "Ready") return <BudgetSkeleton />;
  return (
    <>
      {state.stale ? (
        <Failure retry={state.workspace.editing.refresh} waiting={state.waiting} />
      ) : null}
      <Suspense fallback={<BudgetSkeleton />}>
        <Workspace {...state.workspace} />
      </Suspense>
    </>
  );
};

const UserBudgets = ({
  user,
  profileCurrent,
}: Readonly<{ user: CurrentUser; profileCurrent: boolean }>): JSX.Element => {
  const search = useSearch({ strict: false });
  const currentMonth = currentBudgetMonth(user);
  const month = "month" in search && typeof search.month === "string" ? search.month : currentMonth;
  return (
    <MonthlyBudgets
      key={`${user.id}:${user.timeZone}:${month}`}
      user={user}
      month={month}
      profileCurrent={profileCurrent}
    />
  );
};

export const BudgetScreen = (): JSX.Element => {
  const router = useRouter();
  const [profile] = useState(() => workspaceProfileQuery(router.options.context.apiClient));
  const state = useAtomValue(profile).pipe(presentCanonicalQuery);
  const refresh = useAtomRefresh(profile);
  if (state._tag === "Failure") return <Failure retry={refresh} waiting={state.waiting} />;
  if (state._tag !== "Ready") {
    return <BudgetSkeleton />;
  }
  return (
    <>
      {Option.isSome(state.refreshFailure) ? (
        <Failure retry={refresh} waiting={state.waiting} />
      ) : null}
      <UserBudgets
        user={state.value.data}
        profileCurrent={!state.waiting && Option.isNone(state.refreshFailure)}
      />
    </>
  );
};
