import { PendingRead } from "@/ui/components/pending-read";

import type { FidyClient } from "@/transport/client";
import {
  type ReviewDecisions,
  type ReviewWorkspaceQuery,
  createReviewDecisions,
} from "./decisions";
import { ReviewFullState, ReviewWorkspaceLayout } from "@/ui/components/review-workspace";
import { SelectionScopeDialog } from "@/ui/components/selection-scope-dialog";
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
import { Option, Predicate } from "effect";
import {
  type JSX,
  type ReactNode,
  type Ref,
  type RefCallback,
  useContext,
  useId,
  useState,
} from "react";
import { Toaster, toast } from "sonner";
import { type CanonicalQueryState, presentCanonicalQuery } from "@/transport/canonical-query";
import { CanonicalQueryRetry } from "@/ui/canonical-query-feedback";
import { WorkspaceHeader } from "@/ui/components/workspace-layout";
import { ReviewEditor } from "./editor";
import { Inbox, type InboxProps, ReviewPagination } from "./inbox";
import { type Item, type Workspace, sources } from "./model";
import { MobileReviewDetail } from "./mobile-detail";
import { useMobileReviewDetail } from "./mobile-detail-state";
import { WorkspacePreviewContext } from "./fixture-context";
import { type Filter, ReviewNavigation } from "./view-navigation";
import { reviewWorkspaceQueries } from "./query";

type SelectionScope = Readonly<{
  select: ReadyInboxProps["select"];
  move: ReadyInboxProps["move"];
  confirmation: JSX.Element;
  sourceId: string;
}>;

type ReviewFilters = Readonly<{
  source: string;
  search: string;
  setSource: (value: string) => void;
  setSearch: (value: string) => void;
}>;

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

  return Predicate.isTagged(state, "Ready") &&
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
    createReviewDecisions({ client, query, created: () => toast.success("Transacción creada") })
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
  const preview = useWorkspacePreview(filter);

  return (
    <div ref={lifetime} hidden={!active} data-review="panel">
      {!Predicate.isTagged(state, "Ready") ? (
        <ReviewUnavailable
          filter={filter}
          select={select}
          refresh={decisions.recover}
          loading={!Predicate.isTagged(state, "Failure")}
        />
      ) : (
        <ReadyInbox
          active={active}
          workspaceQuery={queries.source}
          decisions={decisions}
          view={preview(state.value.data)}
          notice={
            Option.isSome(state.refreshFailure) ? (
              <ReviewReadFailure refresh={decisions.recover} waiting={state.waiting} />
            ) : null
          }
          freshness={reviewFreshness(state)}
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

const reviewFreshness = (
  state: CanonicalQueryState<Readonly<{ data: Workspace }>, unknown>
): ReadyInboxProps["freshness"] => {
  if (Predicate.isTagged(state, "Ready") && Option.isSome(state.refreshFailure)) {
    return "stale";
  }

  return state.waiting ? "refreshing" : "current";
};

const useWorkspacePreview = (filter: Filter): ((view: Workspace) => Workspace) => {
  const preview = useContext(WorkspacePreviewContext);
  const scope = filter === "pending" ? "pending" : "history";

  return (view) => preview(view, scope);
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
  const sourceId = useId();
  const { source, setSource, search, setSearch } = useReviewFilters();

  return (
    <>
      <ReviewNavigation
        sourceId={sourceId}
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
  active: boolean;
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

type ReviewScope = Readonly<{ filter: Filter; page: number }>;

const useSelectionScope = (
  props: Pick<ReadyInboxProps, "filter" | "page" | "select">,
  control: InboxControl
): SelectionScope => {
  const sourceId = useId();
  const [pending, setPending] = useState<Option.Option<ReviewScope>>(Option.none);

  const select = (filter: Filter, page: number): void => {
    const changed = filter !== props.filter || page !== props.page;

    const retainsPanel =
      (filter === "pending") !== (props.filter === "pending") &&
      props.page === 0 &&
      ["pending", "history"].includes(props.filter);

    if (control.checked.length > 0 && changed && !retainsPanel) {
      setPending(Option.some({ filter, page }));
    } else props.select(filter, page);
  };

  return {
    sourceId,
    select,
    move: (page) => select(props.filter, page),
    confirmation: (
      <SelectionScopeDialog
        returnFocusId={sourceId}
        open={Option.isSome(pending)}
        count={control.checked.length}
        onKeep={() => setPending(Option.none())}
        onDiscard={() => {
          if (Option.isNone(pending)) return;
          control.clearChecked();
          props.select(pending.value.filter, pending.value.page);
          setPending(Option.none());
        }}
      />
    ),
  };
};

const ReadyInbox = (props: ReadyInboxProps): JSX.Element => {
  const { active } = props;
  const [displayed, setDisplayed] = useState(active);

  if (active && !displayed) setDisplayed(true);

  return displayed ? <ReadyInboxView {...props} /> : <></>;
};

const inboxCaughtUp = (
  view: Workspace,
  filters: Readonly<{ filter: Filter; source: string; search: string }>
): boolean =>
  filters.filter === "pending" &&
  filters.source === "all" &&
  filters.search === "" &&
  view.pendingCount === 0;

const useReviewFilters = (): ReviewFilters => {
  const [source, setSource] = useState("all");
  const [search, setSearch] = useState("");

  return { source, setSource, search, setSearch };
};

const ReadyInboxView = ({
  active,
  children,
  workspaceQuery,
  decisions,
  notice,
  freshness,
  view,
  page,
  filter,
  select,
}: ReadyInboxProps): JSX.Element => {
  const reviewFilters = useReviewFilters();
  const { source, search } = reviewFilters;
  const context = useReviewPageContext({ filter, page, items: view.items });
  const visible = filterReviewPage({ view, source, search, page, contexts: context.contexts });
  const inbox = useInboxControl({ view, visibleItems: visible.items, decisions });
  const control = { ...inbox, locked: inbox.locked || freshness !== "current" };
  const scope = useSelectionScope({ filter, page, select }, control);

  return (
    <>
      {scope.confirmation}
      {view.items.length === 0 || !context.loading ? children : null}
      {notice}
      <ReviewNavigation
        {...reviewFilters}
        sourceId={scope.sourceId}
        contextFeedback={<SourceContextFeedback context={context} />}
        unavailable={false}
        filter={filter}
        select={scope.select}
        count={Option.some(view.pendingCount)}
        refresh={control.recover}
      />
      <ReviewToolbar
        sourceId={scope.sourceId}
        view={view}
        visibleItems={visible.items}
        contexts={context.contexts}
        page={page}
        control={control}
      />
      <InboxWorkspace
        active={active}
        unfilteredItems={view.items}
        contexts={context.contexts}
        originalDeadlines={context.deadlines}
        contextLoading={context.loading}
        workspaceQuery={workspaceQuery}
        freshness={freshness}
        filters={{ filter, source, search }}
        view={visible}
        control={control}
        page={page}
        scope={scope}
        pageLength={view.items.length}
      />
    </>
  );
};

const emptyView = (filter: Filter): Readonly<{ title: string; description: string }> =>
  filter === "pending"
    ? {
        title: "Sin pendientes en esta página",
        description:
          "Prueba con otros filtros o búsquedas para encontrar pendientes en esta página.",
      }
    : {
        title: "Sin elementos del historial en esta página",
        description:
          "Prueba con otros filtros o búsquedas para encontrar elementos del historial en esta página.",
      };

const EmptyInbox = ({
  filter,
  caughtUp,
  freshness,
}: Readonly<{
  filter: Filter;
  caughtUp: boolean;
  freshness: ReadyInboxProps["freshness"];
}>): JSX.Element =>
  freshness === "stale" ? (
    <></>
  ) : (
    <ReviewFullState
      state={freshness === "refreshing" ? "loading" : "empty"}
      title={caughtUp ? "Todo al día" : emptyView(filter).title}
      description={
        caughtUp
          ? "Cuando haya material por completar, aparecerá aquí."
          : emptyView(filter).description
      }
    >
      {null}
    </ReviewFullState>
  );

type InboxWorkspaceProps = Readonly<{
  active: boolean;
  originalDeadlines: ReadonlyMap<string, Workspace["items"][number]["expiresAt"]>;
  unfilteredItems: ReadonlyArray<Workspace["items"][number]>;
  contexts: PageContexts;
  contextLoading: boolean;
  filters: Readonly<{ filter: Filter; source: string; search: string }>;
  freshness: ReadyInboxProps["freshness"];
  workspaceQuery: ReviewWorkspaceQuery;
  view: Workspace;
  control: InboxControl;
  page: number;
  scope: Pick<SelectionScope, "move" | "sourceId">;
  pageLength: number;
}>;

const InboxWorkspace = (props: InboxWorkspaceProps): JSX.Element => {
  const { view, control } = props;

  const item = Option.fromUndefinedOr(
    view.items.find(({ id }) => Option.contains(control.selected, id)) ?? view.items[0]
  );

  const detail = useMobileReviewDetail({
    available: props.active && Option.isSome(item),
    select: control.choose,
    returnFocusId: props.scope.sourceId,
  });

  const editor = Option.match(item, {
    onNone: () => null,
    onSome: (selected) => (
      <ReviewEditor
        workspaceQuery={props.workspaceQuery}
        key={selected.id}
        item={selected}
        originalExpiresAt={props.originalDeadlines.get(selected.id) ?? selected.expiresAt}
        decisions={control.decisions}
        disabled={control.locked}
      />
    ),
  });

  return (
    <>
      <InboxContent {...props} item={item} choose={detail.choose} grid={detail.grid}>
        {detail.mobile ? null : editor}
      </InboxContent>
      {detail.mobile ? (
        <MobileReviewDetail
          item={item}
          open={detail.open}
          onClose={detail.close}
          returnFocus={props.active ? detail.returnFocus : Option.none}
        >
          {editor}
        </MobileReviewDetail>
      ) : null}
    </>
  );
};

const InboxContent = ({
  children,
  grid,
  item,
  choose,
  unfilteredItems,
  contexts,
  contextLoading,
  filters,
  freshness,
  view,
  control,
  page,
  scope: { move },
  pageLength,
}: InboxWorkspaceProps &
  Pick<InboxProps, "choose"> &
  Readonly<{
    children: ReactNode;
    grid: Ref<HTMLDivElement>;
    item: Option.Option<Item>;
  }>): JSX.Element => {
  if (Option.isNone(item)) {
    return (
      <>
        <EmptyInbox
          filter={filters.filter}
          caughtUp={inboxCaughtUp(view, filters)}
          freshness={freshness}
        />
        {view.total > 0 ? (
          <ReviewPagination page={page} pageLength={pageLength} total={view.total} move={move} />
        ) : null}
      </>
    );
  }

  return (
    <div ref={grid} data-review="grid">
      <Inbox
        unfilteredItems={unfilteredItems}
        contexts={contexts}
        contextLoading={contextLoading}
        view={view}
        filter={filters.filter}
        selected={Option.some(item.value.id)}
        checked={control.checked}
        choose={choose}
        toggle={control.toggle}
        page={page}
        pageLength={pageLength}
        move={move}
      />
      {children}
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
