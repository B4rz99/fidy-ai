import { useAtomRefresh, useAtomValue } from "@effect/atom-react";
import { useRouter, useSearch } from "@tanstack/react-router";
import { Option } from "effect";
import { type JSX, Suspense, lazy, useState } from "react";
import type { CanonicalSuccess, FidyClient } from "@/transport/client";
import { type CanonicalQueryState, presentCanonicalQuery } from "@/transport/canonical-query";
import { CanonicalQueryRetry } from "@/ui/canonical-query-feedback";
import { Skeleton } from "@/ui/components/skeleton";
import { WorkspaceHeader } from "@/ui/components/workspace-layout";
import { currentBudgetMonth } from "./model";
import { BudgetWorkspace } from "./workspace";
import type { CurrentUser } from "./presentation";

const Workspace = import.meta.env.DEV
  ? lazy(() => import("./dev-preview").then((module) => ({ default: module.BudgetDataPreview })))
  : BudgetWorkspace;

const Loading = (): JSX.Element => (
  <div className="p-5" aria-label="Cargando presupuestos">
    <Skeleton className="h-20 w-full" />
    <Skeleton className="mt-4 h-64 w-full" />
  </div>
);
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

type MonthResources = Readonly<{
  apiClient: FidyClient;
  reportState: CanonicalQueryState<CanonicalSuccess<"budgets.getBudgetStatus">, unknown>;
  categoryState: CanonicalQueryState<CanonicalSuccess<"categories.listCategories">, unknown>;
  budgetState: CanonicalQueryState<CanonicalSuccess<"budgets.listBudgets">, unknown>;
  refresh: () => void;
}>;
const useMonthResources = ({
  user,
  month,
}: Readonly<{ user: CurrentUser; month: string }>): MonthResources => {
  const router = useRouter();
  const [report] = useState(() =>
    router.options.context.apiClient.query("budgets", "getBudgetStatus", {
      query: { timeZone: user.timeZone, month },
    })
  );
  const [categories] = useState(() =>
    router.options.context.apiClient.query("categories", "listCategories", {})
  );
  const [budgets] = useState(() =>
    router.options.context.apiClient.query("budgets", "listBudgets", {})
  );
  const reportState = useAtomValue(report).pipe(presentCanonicalQuery);
  const categoryState = useAtomValue(categories).pipe(presentCanonicalQuery);
  const budgetState = useAtomValue(budgets).pipe(presentCanonicalQuery);
  const refreshReport = useAtomRefresh(report);
  const refreshCategories = useAtomRefresh(categories);
  const refreshBudgets = useAtomRefresh(budgets);
  const refresh = (): void => {
    refreshReport();
    refreshCategories();
    refreshBudgets();
  };
  return {
    apiClient: router.options.context.apiClient,
    reportState,
    categoryState,
    budgetState,
    refresh,
  };
};
const MonthlyBudgets = ({
  user,
  month,
}: Readonly<{ user: CurrentUser; month: string }>): JSX.Element => {
  const { apiClient, reportState, categoryState, budgetState, refresh } = useMonthResources({
    user,
    month,
  });
  const states = [reportState, categoryState, budgetState];
  const waiting = states.some((state) => state.waiting);
  if (states.some((state) => state._tag === "Failure")) {
    return <Failure retry={refresh} waiting={waiting} />;
  }
  if (
    reportState._tag !== "Ready" ||
    categoryState._tag !== "Ready" ||
    budgetState._tag !== "Ready"
  ) {
    return <Loading />;
  }
  const stale = [
    reportState.refreshFailure,
    categoryState.refreshFailure,
    budgetState.refreshFailure,
  ].some(Option.isSome);
  return (
    <>
      {stale ? <Failure retry={refresh} waiting={waiting} /> : null}
      <Suspense fallback={<Loading />}>
        <Workspace
          apiClient={apiClient}
          user={user}
          month={month}
          report={reportState.value.data}
          categories={categoryState.value.data}
          budgets={budgetState.value.data}
          onRefresh={refresh}
          editable={!stale && !waiting}
        />
      </Suspense>
    </>
  );
};

const UserBudgets = ({ user }: Readonly<{ user: CurrentUser }>): JSX.Element => {
  const search = useSearch({ strict: false });
  const currentMonth = currentBudgetMonth(user);
  const month = "month" in search && typeof search.month === "string" ? search.month : currentMonth;
  return <MonthlyBudgets key={`${user.id}:${user.timeZone}:${month}`} user={user} month={month} />;
};

export const BudgetsFeature = (): JSX.Element => {
  const router = useRouter();
  const [profile] = useState(() =>
    router.options.context.apiClient.query("identity", "getCurrentUser", {})
  );
  const state = useAtomValue(profile).pipe(presentCanonicalQuery);
  const refresh = useAtomRefresh(profile);
  if (state._tag === "Failure") return <Failure retry={refresh} waiting={state.waiting} />;
  if (state._tag !== "Ready") {
    return (
      <>
        <WorkspaceHeader title="Presupuestos" context={null}>
          {null}
        </WorkspaceHeader>
        <Loading />
      </>
    );
  }
  if (state.waiting || Option.isSome(state.refreshFailure)) {
    return <Failure retry={refresh} waiting={state.waiting} />;
  }
  return <UserBudgets user={state.value.data} />;
};
