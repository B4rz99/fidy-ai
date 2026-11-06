import { PendingRead } from "@/ui/components/pending-read";

import type { FidyClient } from "@/transport/client";
import { type ReviewDecisions, type ReviewWorkspaceQuery, makeReviewDecisions } from "./decisions";
import { ReviewFullState, ReviewWorkspaceLayout } from "@/ui/components/review-workspace";
import { Button } from "@/ui/components/button";
import { type InboxControl, useInboxControl } from "./inbox-controller";
import {
  type PageContexts,
  sourceExcerpt,
  sourceReference,
  useReviewPageContext,
} from "./source-context";
import { reviewAmount, reviewTitle } from "./presentation";
import { ReviewToolbar } from "./toolbar";
import { useAtomValue } from "@effect/atom-react";
import { Navigate, useRouter, useSearch } from "@tanstack/react-router";
import { Option } from "effect";
import { type JSX, type ReactNode, type RefCallback, useState } from "react";
import { Toaster, toast } from "sonner";
import { presentCanonicalQuery } from "@/transport/canonical-query";
import { CanonicalQueryRetry } from "@/ui/canonical-query-feedback";
import { WorkspaceHeader } from "@/ui/components/workspace-layout";
import { ReviewEditor } from "./editor";
import { Inbox, ReviewPagination } from "./inbox";
import { type Workspace, sources } from "./model";
import { type Filter, ReviewNavigation } from "./view-navigation";
import { reviewWorkspaceQueries } from "./query";

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
}: Readonly<{
  filter: Filter;
  page: number;
}>): JSX.Element => {
  const client = useRouter().options.context.apiClient;
  const [query] = useState(
    () =>
      reviewWorkspaceQueries({
        client,
        filter,
        page,
      }).source
  );
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
  children,
}: Readonly<{
  filter: Filter;
  page: number;
  active: boolean;
  children: ReactNode;
}>): JSX.Element => {
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
      >
        {children}
      </ReviewPanel>
      <ReviewPanel
        active={active && filter !== "pending"}
        filter={filter === "pending" ? "history" : filter}
        page={filter === "pending" ? 0 : page}
        select={select}
      >
        {children}
      </ReviewPanel>
    </ReviewWorkspaceLayout>
  );
};
const ReviewPanel = ({
  active,
  filter,
  page,
  select,
  children,
}: Readonly<{
  active: boolean;
  filter: Filter;
  page: number;
  select: (status: Filter, offset: number) => void;
  children: ReactNode;
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
    >
      {children}
    </ReviewResources>
  );
};
const useReviewDecisions = ({
  client,
  query,
}: Readonly<{ client: FidyClient; query: ReviewWorkspaceQuery }>): ReviewDecisions => {
  const [decisionAtom] = useState(() =>
    makeReviewDecisions({ client, query, created: () => toast.success("Transacción creada") })
  );
  return useAtomValue(decisionAtom);
};
const ReviewResources = ({
  active,
  filter,
  page,
  move,
  select,
  children,
}: Readonly<{
  active: boolean;
  filter: Filter;
  page: number;
  move: (offset: number) => void;
  select: (status: Filter, offset: number) => void;
  children: ReactNode;
}>): JSX.Element => {
  const apiClient = useRouter().options.context.apiClient;
  const [queries] = useState(() =>
    reviewWorkspaceQueries({
      client: apiClient,
      filter,
      page,
    })
  );
  const query = active ? queries.active : queries.source;
  const decisions = useReviewDecisions({ client: apiClient, query: queries.source });
  const [lifetime] = useState(() => decisionLifetime(decisions));
  const state = useAtomValue(query).pipe(presentCanonicalQuery);
  const waitingFreshness = state.waiting ? "refreshing" : "current";
  return (
    <div ref={lifetime} hidden={!active} data-review="panel">
      {state._tag !== "Ready" ? (
        <ReviewUnavailable
          filter={filter}
          select={select}
          refresh={decisions.recover}
          loading={state._tag !== "Failure"}
        />
      ) : (
        <ReadyInbox
          active={active}
          workspaceQuery={queries.source}
          decisions={decisions}
          view={state.value.data}
          notice={
            Option.isSome(state.refreshFailure) ? (
              <ReviewReadFailure refresh={decisions.recover} waiting={state.waiting} />
            ) : null
          }
          freshness={Option.isSome(state.refreshFailure) ? "stale" : waitingFreshness}
          page={page}
          move={move}
          filter={filter}
          select={select}
        >
          {active ? children : null}
        </ReadyInbox>
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
        contextFeedback={null}
        unavailable
        source={source}
        setSource={setSource}
        search={search}
        setSearch={setSearch}
      />
      {loading ? (
        <PendingRead label="Cargando elementos" />
      ) : (
        <ReviewFullState
          state="error"
          title="No pudimos cargar los elementos"
          description="Intenta cargar la bandeja de nuevo."
        >
          <Button onClick={refresh}>Reintentar</Button>
        </ReviewFullState>
      )}
    </>
  );
};
const ReviewReadFailure = ({
  refresh,
  waiting,
}: Readonly<{
  refresh: () => void;
  waiting: boolean;
}>): JSX.Element => (
  <div className="p-5">
    <CanonicalQueryRetry
      title="No pudimos cargar los elementos"
      description="La información anterior puede estar desactualizada. Reintenta para consultar los datos actuales."
      retryLabel="Reintentar"
      retryingLabel="Reintentando…"
      waiting={waiting}
      onRetry={refresh}
    />
  </div>
);
type ReadyInboxProps = Readonly<{
  children: ReactNode;
  filter: Filter;
  select: (status: Filter, offset: number) => void;
  view: Workspace;
  freshness: "current" | "refreshing" | "stale";
  notice: ReactNode;
  page: number;
  move: (offset: number) => void;
  decisions: ReviewDecisions;
  workspaceQuery: ReviewWorkspaceQuery;
}>;
const ReadyInbox = ({
  active,
  ...props
}: ReadyInboxProps &
  Readonly<{
    active: boolean;
  }>): JSX.Element => {
  const [displayed, setDisplayed] = useState(active);
  if (active && !displayed) setDisplayed(true);
  return displayed ? <ReadyInboxView {...props} /> : <></>;
};
const ReadyInboxView = ({
  children,
  workspaceQuery,
  decisions,
  notice,
  freshness,
  view,
  page,
  move,
  filter,
  select,
}: ReadyInboxProps): JSX.Element => {
  const [source, setSource] = useState("all");
  const [search, setSearch] = useState("");
  const context = useReviewPageContext({ filter, page, items: view.items });
  const visible = filterReviewPage({ view, source, search, page, contexts: context.contexts });
  const inbox = useInboxControl({ view, visibleItems: visible.items, decisions });
  const control = { ...inbox, locked: inbox.locked || freshness !== "current" };
  const checked = control.checked.filter((id) => visible.items.some((entry) => entry.id === id));
  return (
    <>
      {view.items.length === 0 || !context.loading ? children : null}
      {notice}
      <ReviewNavigation
        contextFeedback={<SourceContextFeedback context={context} />}
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
        unfilteredItems={view.items}
        contexts={context.contexts}
        contextLoading={context.loading}
        workspaceQuery={workspaceQuery}
        freshness={freshness}
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
const EmptyInbox = ({
  caughtUp,
  freshness,
}: Readonly<{
  caughtUp: boolean;
  freshness: ReadyInboxProps["freshness"];
}>): JSX.Element =>
  freshness === "stale" ? (
    <></>
  ) : (
    <ReviewFullState
      state={freshness === "refreshing" ? "loading" : "empty"}
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
type InboxWorkspaceProps = Readonly<{
  unfilteredItems: ReadonlyArray<Workspace["items"][number]>;
  contexts: PageContexts;
  contextLoading: boolean;
  caughtUp: boolean;
  freshness: ReadyInboxProps["freshness"];
  workspaceQuery: ReviewWorkspaceQuery;
  view: Workspace;
  control: InboxControl;
  page: number;
  move: (offset: number) => void;
  pageLength: number;
}>;
const InboxWorkspace = ({
  unfilteredItems,
  contexts,
  contextLoading,
  workspaceQuery,
  caughtUp,
  freshness,
  view,
  control,
  page,
  move,
  pageLength,
}: InboxWorkspaceProps): JSX.Element => {
  const item = view.items.find(({ id }) => Option.contains(control.selected, id)) ?? view.items[0];
  if (item === undefined) {
    return (
      <>
        <EmptyInbox caughtUp={caughtUp} freshness={freshness} />
        {view.total > 0 ? (
          <ReviewPagination page={page} pageLength={pageLength} total={view.total} move={move} />
        ) : null}
      </>
    );
  }
  return (
    <div data-review="grid">
      <Inbox
        unfilteredItems={unfilteredItems}
        contexts={contexts}
        contextLoading={contextLoading}
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
  contexts,
  page,
}: Readonly<{
  page: number;
  contexts: PageContexts;
  view: Workspace;
  source: string;
  search: string;
}>): Workspace => ({
  ...view,
  items: view.items.filter(
    (item, index) =>
      (source === "all" || item.source === source) &&
      [
        reviewTitle(item),
        reviewAmount(item),
        sources[item.source],
        sourceReference({
          item,
          context: Option.fromUndefinedOr(contexts.get(item.id)),
          position: page + index + 1,
        }),
        Option.getOrElse(
          sourceExcerpt({ item, context: Option.fromUndefinedOr(contexts.get(item.id)) }),
          () => ""
        ),
      ]
        .join(" ")
        .toLocaleLowerCase("es-CO")
        .includes(search.trim().toLocaleLowerCase("es-CO"))
  ),
});
const decisionLifetime =
  (decisions: ReviewDecisions): RefCallback<HTMLDivElement> =>
  (node) =>
    node === null ? undefined : decisions.mount();

const SourceContextFeedback = ({
  context,
}: Readonly<{ context: ReturnType<typeof useReviewPageContext> }>): JSX.Element => (
  <>
    {context.loading ? " Cargando fragmentos…" : null}
    {context.failed ? (
      <>
        {" "}
        No pudimos cargar los fragmentos.{" "}
        <Button variant="link" onClick={context.refresh}>
          Reintentar fragmentos
        </Button>
      </>
    ) : null}
  </>
);
