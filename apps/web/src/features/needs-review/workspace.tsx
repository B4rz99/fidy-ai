import { type ReviewDecisions, type ReviewWorkspaceQuery, makeReviewDecisions } from "./decisions";
import { ReviewFullState, ReviewWorkspaceLayout } from "@/ui/components/review-workspace";
import { Button } from "@/ui/components/button";
import { type InboxControl, useInboxControl } from "./inbox-controller";
import { reviewTitle } from "./presentation";
import { ReviewToolbar } from "./toolbar";
import { useAtomRefresh, useAtomValue } from "@effect/atom-react";
import { Navigate, useRouter, useSearch } from "@tanstack/react-router";
import { Option } from "effect";
import { type JSX, type ReactNode, type RefCallback, useState } from "react";
import { presentCanonicalQuery } from "@/transport/canonical-query";
import { CanonicalQueryRetry } from "@/ui/canonical-query-feedback";
import { WorkspaceHeader } from "@/ui/components/workspace-layout";
import { ReviewEditor } from "./editor";
import { Inbox, ReviewPagination } from "./inbox";
import type { Workspace } from "./model";

import { type Filter, ReviewNavigation } from "./view-navigation";
import { reviewWorkspaceQueries } from "./query";

const { Toaster, toast } = await import("sonner");

/** The active route owns pagination repair; application composition retains the workspace. */
export const NeedsReviewRoute = (): JSX.Element => {
  const search = useSearch({ from: "/authenticated/app/needs-review" });
  const filter = search.status ?? "pending";
  const page = search.offset ?? 0;
  return (
    <>
      <Toaster position="bottom-right" richColors dir="ltr" />
      <ReviewPageRepair key={`${filter}:${page}`} filter={filter} page={page} />
    </>
  );
};

/** Pagination repair belongs to the active route, outside the retained presentation owner. */
const ReviewPageRepair = ({
  filter,
  page,
}: Readonly<{ filter: Filter; page: number }>): JSX.Element => {
  const client = useRouter().options.context.apiClient;
  const [query] = useState(() => reviewWorkspaceQueries(client, filter, page).source);
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
    <ReviewWorkspaceLayout>
      <WorkspaceHeader title="Por revisar" context={null}>
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
    </ReviewWorkspaceLayout>
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
}>): JSX.Element => {
  const [visited, setVisited] = useState(active);
  if (active && !visited) setVisited(true);
  if (!active && !visited) return <></>;
  return (
    <ReviewResources
      key={`${filter}:${page}`}
      active={active}
      filter={filter}
      select={select}
      page={page}
      move={(offset) => select(filter, offset)}
    />
  );
};
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
  const [queries] = useState(() => reviewWorkspaceQueries(apiClient, filter, page));
  const query = active ? queries.active : queries.source;
  const [decisionAtom] = useState(() =>
    makeReviewDecisions({
      client: apiClient,
      query: queries.source,
      created: () => toast.success("Transacción creada"),
    })
  );
  const decisions = useAtomValue(decisionAtom);
  const [lifetime] = useState(() => decisionLifetime(decisions));
  const state = useAtomValue(query).pipe(presentCanonicalQuery);
  const refresh = useAtomRefresh(query);
  return (
    <div ref={lifetime} hidden={!active} data-review="panel">
      {state._tag !== "Ready" ? (
        <ReviewUnavailable
          filter={filter}
          select={select}
          refresh={refresh}
          loading={state._tag !== "Failure"}
        />
      ) : (
        <ReadyInbox
          workspaceQuery={queries.source}
          decisions={decisions}
          view={state.value.data}
          notice={
            Option.isSome(state.refreshFailure) ? (
              <ReviewReadFailure refresh={refresh} waiting={state.waiting} />
            ) : null
          }
          disabled={state.waiting || Option.isSome(state.refreshFailure)}
          page={page}
          move={move}
          filter={filter}
          select={select}
        />
      )}
    </div>
  );
};
const ReviewUnavailable = ({
  filter,
  select,
  refresh,
  loading,
}: Readonly<{
  filter: Filter;
  select: (status: Filter, offset: number) => void;
  refresh: () => void;
  loading: boolean;
}>): JSX.Element => {
  const [source, setSource] = useState("all");
  const [search, setSearch] = useState("");
  return (
    <>
      <ReviewNavigation
        filter={filter}
        select={select}
        refresh={refresh}
        count={Option.none()}
        unavailable
        source={source}
        setSource={setSource}
        search={search}
        setSearch={setSearch}
      />
      <ReviewFullState
        state={loading ? "loading" : "error"}
        title={loading ? "Cargando elementos…" : "No pudimos cargar los elementos"}
        description={loading ? "" : "Intenta cargar la bandeja de nuevo."}
      >
        {loading ? null : <Button onClick={refresh}>Reintentar</Button>}
      </ReviewFullState>
    </>
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
type ReadyInboxProps = Readonly<{
  filter: Filter;
  select: (status: Filter, offset: number) => void;
  view: Workspace;
  disabled: boolean;
  notice: ReactNode;
  page: number;
  move: (offset: number) => void;
  decisions: ReviewDecisions;
  workspaceQuery: ReviewWorkspaceQuery;
}>;
const ReadyInbox = ({
  workspaceQuery,
  decisions,
  notice,
  disabled,
  view,
  page,
  move,
  filter,
  select,
}: ReadyInboxProps): JSX.Element => {
  const [source, setSource] = useState("all");
  const [search, setSearch] = useState("");
  const visible = filterReviewPage({ view, source, search });
  const inbox = useInboxControl({ view, visibleItems: visible.items, decisions });
  const control = { ...inbox, locked: inbox.locked || disabled };
  const checked = control.checked.filter((id) => visible.items.some((entry) => entry.id === id));
  return (
    <>
      {notice}
      <ReviewNavigation
        unavailable={false}
        filter={filter}
        select={select}
        count={Option.some(view.pendingCount)}
        refresh={control.recover}
        source={source}
        setSource={(value) => {
          control.clearChecked();
          setSource(value);
        }}
        search={search}
        setSearch={(value) => {
          control.clearChecked();
          setSearch(value);
        }}
      />
      <ReviewToolbar view={visible} control={{ ...control, checked }} />
      <InboxWorkspace
        workspaceQuery={workspaceQuery}
        caughtUp={
          filter === "pending" && source === "all" && search === "" && view.pendingCount === 0
        }
        view={visible}
        control={control}
        page={page}
        move={move}
        pageLength={view.items.length}
      />
    </>
  );
};

const EmptyInbox = ({ caughtUp }: Readonly<{ caughtUp: boolean }>): JSX.Element => (
  <ReviewFullState
    state="empty"
    title={caughtUp ? "Todo al día" : "Sin elementos en esta vista"}
    description={
      caughtUp
        ? "Cuando haya material por completar, aparecerá aquí."
        : "Prueba con otros filtros para encontrar elementos en esta página."
    }
  >
    {null}
  </ReviewFullState>
);

const InboxWorkspace = ({
  workspaceQuery,
  caughtUp,
  view,
  control,
  page,
  move,
  pageLength,
}: Readonly<{
  caughtUp: boolean;
  workspaceQuery: ReviewWorkspaceQuery;
  view: Workspace;
  control: InboxControl;
  page: number;
  move: (offset: number) => void;
  pageLength: number;
}>): JSX.Element => {
  const item =
    view.items.find((candidate) => Option.contains(control.selected, candidate.id)) ??
    view.items[0];
  if (item === undefined) {
    return (
      <>
        <EmptyInbox caughtUp={caughtUp} />
        {view.total > 0 ? (
          <ReviewPagination page={page} pageLength={pageLength} total={view.total} move={move} />
        ) : null}
      </>
    );
  }
  return (
    <div data-review="grid">
      <Inbox
        view={view}
        selected={Option.some(item.id)}
        checked={control.checked}
        choose={control.choose}
        toggle={control.toggle}
        page={page}
        pageLength={pageLength}
        move={move}
      />
      <ReviewEditor
        workspaceQuery={workspaceQuery}
        key={item.id}
        item={item}
        decisions={control.decisions}
        disabled={control.locked}
      />
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

const decisionLifetime =
  (decisions: ReviewDecisions): RefCallback<HTMLDivElement> =>
  (node) =>
    node === null ? undefined : decisions.mount();
