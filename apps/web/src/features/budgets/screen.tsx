import { PendingRead } from "@/ui/components/pending-read";

import { workspaceProfileQuery } from "@/transport/workspace-query";
import { useAtomRefresh, useAtomValue } from "@effect/atom-react";
import { useRouter, useSearch } from "@tanstack/react-router";
import { Option, Predicate, Schema } from "effect";
import { type JSX, type ReactNode, Suspense, lazy, useState } from "react";
import { presentCanonicalQuery } from "@/transport/canonical-query";
import { CanonicalQueryRetry } from "@/ui/canonical-query-feedback";
import { currentBudgetMonth } from "./model";
import { BudgetMonth, useMonthlyBudgets } from "./controller";
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
  children,
}: Readonly<{
  user: CurrentUser;
  month: string;
  profileCurrent: boolean;
  children: ReactNode;
}>): JSX.Element => {
  const router = useRouter();

  const state = useMonthlyBudgets({
    apiClient: router.options.context.apiClient,
    user,
    month,
    profileCurrent,
  });

  return BudgetMonth.$match(state, {
    Failure: ({ refresh, waiting }) => <Failure retry={refresh} waiting={waiting} />,
    Loading: () => <PendingRead label="Cargando presupuestos" />,
    Ready: ({ stale, waiting, workspace }) => (
      <>
        {stale ? <Failure retry={workspace.editing.refresh} waiting={waiting} /> : null}
        <Suspense fallback={<PendingRead label="Cargando presupuestos" />}>
          <Workspace {...workspace} />
          {children}
        </Suspense>
      </>
    ),
  });
};

const MonthSearch = Schema.Struct({ month: Schema.String });

const UserBudgets = ({
  user,
  profileCurrent,
  children,
}: Readonly<{ user: CurrentUser; profileCurrent: boolean; children: ReactNode }>): JSX.Element => {
  const search = useSearch({ strict: false });
  const currentMonth = currentBudgetMonth(user);

  const month = Option.match(Schema.decodeUnknownOption(MonthSearch)(search), {
    onNone: () => currentMonth,
    onSome: (value) => value.month,
  });

  return (
    <MonthlyBudgets
      key={`${user.id}:${user.timeZone}:${month}`}
      user={user}
      month={month}
      profileCurrent={profileCurrent}
    >
      {children}
    </MonthlyBudgets>
  );
};

export const BudgetScreen = ({ children }: Readonly<{ children: ReactNode }>): JSX.Element => {
  const router = useRouter();
  const [profile] = useState(() => workspaceProfileQuery(router.options.context.apiClient));
  const state = useAtomValue(profile).pipe(presentCanonicalQuery);
  const refresh = useAtomRefresh(profile);

  if (Predicate.isTagged(state, "Failure")) {
    return <Failure retry={refresh} waiting={state.waiting} />;
  }

  if (!Predicate.isTagged(state, "Ready")) {
    return <PendingRead label="Cargando presupuestos" />;
  }

  return (
    <>
      {Option.isSome(state.refreshFailure) ? (
        <Failure retry={refresh} waiting={state.waiting} />
      ) : null}
      <UserBudgets
        user={state.value.data}
        profileCurrent={!state.waiting && Option.isNone(state.refreshFailure)}
      >
        {children}
      </UserBudgets>
    </>
  );
};
