import { type AsyncResult, Atom } from "effect/reactivity";
import { cn } from "@/ui/class-names";
import { type InboxControl, useInboxControl } from "./inbox-controller";
import { reviewTitle } from "./presentation";
import { ReviewToolbar } from "./toolbar";
import { useAtomRefresh, useAtomValue } from "@effect/atom-react";
import { Navigate, useRouter, useSearch } from "@tanstack/react-router";
import { Option } from "effect";
import { type JSX, type ReactNode, useState } from "react";
import { presentCanonicalQuery } from "@/transport/canonical-query";
import type { CanonicalSuccess, FidyClient } from "@/transport/client";
import { CanonicalQueryRetry } from "@/ui/canonical-query-feedback";
import { WorkspaceHeader } from "@/ui/components/workspace-layout";
import { ReviewEditor } from "./editor";
import { Inbox } from "./inbox";
import type { Workspace } from "./model";

import { type Filter, ReviewNavigation } from "./view-navigation";

const makeReviewQuery = (
  client: FidyClient,
  filter: Filter,
  page: number
): Atom.Atom<AsyncResult.AsyncResult<CanonicalSuccess<"ingestion.getReviewWorkspace">, unknown>> =>
  client.query("ingestion", "getReviewWorkspace", {
    query: { status: Option.some(filter), offset: page === 0 ? Option.none() : Option.some(page) },
    reactivityKeys: ["ingestion-review"],
  });

/** The active route owns pagination repair; application composition retains the workspace. */
export const NeedsReviewRoute = (): JSX.Element => {
  const search = useSearch({ from: "/authenticated/app/needs-review" });
  const filter = search.status ?? "pending";
  const page = search.offset ?? 0;
  return <ReviewPageRepair key={`${filter}:${page}`} filter={filter} page={page} />;
};

/** Pagination repair belongs to the active route, outside the retained presentation owner. */
const ReviewPageRepair = ({
  filter,
  page,
}: Readonly<{ filter: Filter; page: number }>): JSX.Element => {
  const client = useRouter().options.context.apiClient;
  const [query] = useState(() => makeReviewQuery(client, filter, page));
  const state = useAtomValue(query).pipe(presentCanonicalQuery);
  return state._tag === "Ready" &&
    state.value.data.items.length === 0 &&
    page > 0 &&
    state.value.data.total > 0 ? (
    <Navigate to="/app/needs-review" search={{ status: filter, offset: 0 }} replace />
  ) : (
    <></>
  );
};

export const NeedsReviewFeature = ({
  filter,
  page,
  active,
}: Readonly<{ filter: Filter; page: number; active: boolean }>): JSX.Element => {
  const router = useRouter();
  const select = (status: Filter, offset: number): void => {
    router.navigate({ to: "/app/needs-review", search: { status, offset } }).catch(() => {});
  };
  return (
    <div className="flex min-w-0 flex-col lg:h-dvh lg:overflow-hidden">
      <WorkspaceHeader
        title="Por revisar"
        context={
          <p className="mt-1 text-sm text-muted-foreground">
            Completa lo que falta para crear tus transacciones.
          </p>
        }
      >
        {null}
      </WorkspaceHeader>
      <ReviewPanel
        active={active && filter === "pending"}
        filter="pending"
        page={filter === "pending" ? page : 0}
        select={select}
      />
      <ReviewPanel
        active={active && filter !== "pending"}
        filter={filter === "pending" ? "history" : filter}
        page={filter === "pending" ? 0 : page}
        select={select}
      />
    </div>
  );
};
const ReviewPanel = ({
  active,
  filter,
  page,
  select,
}: Readonly<{
  active: boolean;
  filter: Filter;
  page: number;
  select: (status: Filter, offset: number) => void;
}>): JSX.Element => (
  <div hidden={!active} className={cn("min-h-0 flex-1 flex-col", active ? "flex" : "hidden")}>
    <ReviewResources
      key={`${filter}:${page}`}
      active={active}
      filter={filter}
      select={select}
      page={page}
      move={(offset) => select(filter, offset)}
    />
  </div>
);
const ReviewResources = ({
  active,
  filter,
  page,
  move,
  select,
}: Readonly<{
  active: boolean;
  filter: Filter;
  page: number;
  move: (offset: number) => void;
  select: (status: Filter, offset: number) => void;
}>): JSX.Element => {
  const apiClient = useRouter().options.context.apiClient;
  const [query] = useState(() =>
    makeReviewQuery(apiClient, filter, page).pipe(
      Atom.withRefresh("60 seconds"),
      Atom.refreshOnWindowFocus
    )
  );
  const state = useAtomValue(query).pipe(presentCanonicalQuery);
  const refresh = useAtomRefresh(query);
  if (state._tag === "Failure") {
    return <ReviewReadFailure refresh={refresh} waiting={state.waiting} />;
  }
  if (state._tag !== "Ready") {
    return <p className="p-5 text-muted-foreground">Cargando elementos…</p>;
  }
  return (
    <ReadyInbox
      view={state.value.data}
      notice={
        Option.isSome(state.refreshFailure) ? (
          <ReviewReadFailure refresh={refresh} waiting={state.waiting} />
        ) : null
      }
      disabled={[!active, state.waiting, Option.isSome(state.refreshFailure)].some(Boolean)}
      page={page}
      move={move}
      refresh={refresh}
      filter={filter}
      select={select}
    />
  );
};
const ReviewReadFailure = ({
  refresh,
  waiting,
}: Readonly<{ refresh: () => void; waiting: boolean }>): JSX.Element => (
  <div className="p-5">
    <CanonicalQueryRetry
      title="No pudimos cargar los elementos"
      description="Actualiza para volver a consultar tus datos."
      retryLabel="Reintentar"
      retryingLabel="Reintentando…"
      waiting={waiting}
      onRetry={refresh}
    />
  </div>
);
const ReadyInbox = ({
  notice,
  disabled,
  view,
  page,
  move,
  refresh,
  filter,
  select,
}: Readonly<{
  filter: Filter;
  select: (status: Filter, offset: number) => void;
  view: Workspace;
  disabled: boolean;
  notice: ReactNode;
  page: number;
  move: (offset: number) => void;
  refresh: () => void;
}>): JSX.Element => {
  const [source, setSource] = useState("all");
  const [search, setSearch] = useState("");
  const visible = filterReviewPage({ view, source, search });
  const inbox = useInboxControl({ view, visibleItems: visible.items, refresh });
  const control = { ...inbox, locked: inbox.locked || disabled };
  return (
    <>
      {notice}
      <ReviewNavigation
        filter={filter}
        select={select}
        count={view.pendingCount}
        refresh={control.recover}
        source={source}
        setSource={setSource}
        search={search}
        setSearch={setSearch}
      />
      <ReviewToolbar
        view={visible}
        control={{
          ...control,
          checked: control.checked.filter((id) => visible.items.some((entry) => entry.id === id)),
        }}
      />
      <InboxWorkspace
        view={visible}
        control={control}
        page={page}
        move={move}
        pageLength={view.items.length}
      />
    </>
  );
};

const EmptyInbox = ({ pendingCount }: Readonly<{ pendingCount: number }>): JSX.Element => (
  <div className="p-10">
    <h2 className="text-xl font-medium">
      {pendingCount === 0 ? "Todo al día" : "Sin elementos en esta vista"}
    </h2>
    <p className="mt-2 text-sm text-muted-foreground">
      Los próximos elementos que necesiten tu ayuda aparecerán aquí.
    </p>
  </div>
);

const InboxWorkspace = ({
  view,
  control,
  page,
  move,
  pageLength,
}: Readonly<{
  view: Workspace;
  control: InboxControl;
  page: number;
  move: (offset: number) => void;
  pageLength: number;
}>): JSX.Element => {
  const item =
    view.items.find((candidate) => Option.contains(control.selected, candidate.id)) ??
    view.items[0];
  return (
    <div className="grid min-h-0 min-w-0 flex-1 lg:grid-cols-[minmax(16rem,0.75fr)_minmax(0,2fr)]">
      <Inbox
        view={view}
        selected={Option.fromUndefinedOr(item?.id)}
        checked={control.checked}
        choose={control.choose}
        toggle={control.toggle}
        page={page}
        pageLength={pageLength}
        move={move}
      />
      {item === undefined ? (
        <EmptyInbox pendingCount={view.pendingCount} />
      ) : (
        <ReviewEditor
          key={item.id}
          item={item}
          finished={control.finished}
          barrier={control.barrier}
          disabled={control.locked}
        />
      )}
    </div>
  );
};

const filterReviewPage = ({
  view,
  source,
  search,
}: Readonly<{ view: Workspace; source: string; search: string }>): Workspace => ({
  ...view,
  items: view.items.filter(
    (item) =>
      (source === "all" || item.source === source) &&
      reviewTitle(item).toLocaleLowerCase("es-CO").includes(search.toLocaleLowerCase("es-CO"))
  ),
});

export { ReviewPendingCount } from "./navigation";
export { CreatedReviewTransaction } from "./created-transaction";
