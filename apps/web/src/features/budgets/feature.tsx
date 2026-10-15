import { useAtomRefresh, useAtomValue } from "@effect/atom-react";
import { useRouter, useSearch } from "@tanstack/react-router";
import { Option } from "effect";
import { type JSX, Suspense, lazy, useState } from "react";
import { presentCanonicalQuery } from "@/transport/canonical-query";
import { CanonicalQueryRetry } from "@/ui/canonical-query-feedback";
import { Skeleton } from "@/ui/components/skeleton";
import { WorkspaceHeader } from "@/ui/components/workspace-layout";
import { currentBudgetMonth } from "./model";
import { useMonthlyBudgets } from "./controller";
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

const MonthlyBudgets = ({
  user,
  month,
}: Readonly<{ user: CurrentUser; month: string }>): JSX.Element => {
  const router = useRouter();
  const state = useMonthlyBudgets({ apiClient: router.options.context.apiClient, user, month });
  if (state._tag === "Failure") return <Failure retry={state.refresh} waiting={state.waiting} />;
  if (state._tag !== "Ready") return <Loading />;
  return (
    <>
      {state.stale ? (
        <Failure retry={state.workspace.editing.refresh} waiting={state.waiting} />
      ) : null}
      <Suspense fallback={<Loading />}>
        <Workspace {...state.workspace} />
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
