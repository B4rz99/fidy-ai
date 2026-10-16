import { type InboxControl, useInboxControl } from "./inbox-controller";
import { reviewTitle } from "./presentation";
import { ReviewToolbar } from "./toolbar";
import { useAtomRefresh, useAtomValue } from "@effect/atom-react";
import { Navigate, useNavigate, useRouter, useSearch } from "@tanstack/react-router";
import { Option } from "effect";
import { type JSX, useState } from "react";
import { presentCanonicalQuery } from "@/transport/canonical-query";
import { CanonicalQueryRetry } from "@/ui/canonical-query-feedback";
import { WorkspaceHeader } from "@/ui/components/workspace-layout";
import { ReviewEditor } from "./editor";
import { Inbox } from "./inbox";
import type { Workspace } from "./model";

import { type Filter, ReviewNavigation } from "./view-navigation";

export const NeedsReviewFeature = (): JSX.Element => {
  const search = useSearch({ from: "/authenticated/app/needs-review" });
  const navigate = useNavigate({ from: "/app/needs-review" });
  const filter = search.status ?? "pending";
  const page = search.offset ?? 0;
  const select = (status: Filter, offset: number): void => {
    navigate({ search: { status, offset } }).catch(() => {});
  };
  return (
    <>
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
      <ReviewResources
        key={`${filter}:${page}`}
        filter={filter}
        select={select}
        page={page}
        move={(offset) => select(filter, offset)}
      />
    </>
  );
};
const ReviewResources = ({
  filter,
  page,
  move,
  select,
}: Readonly<{
  filter: Filter;
  page: number;
  move: (offset: number) => void;
  select: (status: Filter, offset: number) => void;
}>): JSX.Element => {
  const apiClient = useRouter().options.context.apiClient;
  const [query] = useState(() =>
    apiClient.query("ingestion", "getReviewWorkspace", {
      query: { status: Option.some(filter), offset: Option.some(page) },
      reactivityKeys: ["ingestion-review"],
    })
  );
  const state = useAtomValue(query).pipe(presentCanonicalQuery);
  const refresh = useAtomRefresh(query);
  if (state._tag === "Failure") {
    return (
      <div className="p-5">
        <CanonicalQueryRetry
          title="No pudimos cargar los elementos"
          description="Actualiza para volver a consultar tus datos."
          retryLabel="Reintentar"
          retryingLabel="Reintentando…"
          waiting={state.waiting}
          onRetry={refresh}
        />
      </div>
    );
  }
  if (state._tag !== "Ready") {
    return <p className="p-5 text-muted-foreground">Cargando elementos…</p>;
  }
  if (state.value.data.items.length === 0 && page > 0 && state.value.data.total > 0) {
    return <Navigate to="/app/needs-review" search={{ status: filter, offset: 0 }} replace />;
  }
  return (
    <ReadyInbox
      view={state.value.data}
      page={page}
      move={move}
      refresh={refresh}
      filter={filter}
      select={select}
    />
  );
};
const ReadyInbox = ({
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
  page: number;
  move: (offset: number) => void;
  refresh: () => void;
}>): JSX.Element => {
  const [source, setSource] = useState("all");
  const [search, setSearch] = useState("");
  const visible = {
    ...view,
    items: view.items.filter(
      (item) =>
        (source === "all" || item.source === source) &&
        reviewTitle(item).toLocaleLowerCase("es-CO").includes(search.toLocaleLowerCase("es-CO"))
    ),
  };
  const control = useInboxControl({ view, refresh });
  return (
    <>
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
    <div className="grid min-w-0 lg:min-h-[calc(100svh-12rem)] lg:grid-cols-[minmax(16rem,0.75fr)_minmax(0,2fr)]">
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
