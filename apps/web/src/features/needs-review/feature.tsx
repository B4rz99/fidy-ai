import { useInboxControl } from "./inbox-controller";
import { ReviewToolbar } from "./toolbar";
import { useAtomRefresh, useAtomValue } from "@effect/atom-react";
import { Navigate, useNavigate, useRouter, useSearch } from "@tanstack/react-router";
import { Option } from "effect";
import { type JSX, useState } from "react";
import { presentCanonicalQuery } from "@/transport/canonical-query";
import { CanonicalQueryRetry } from "@/ui/canonical-query-feedback";
import { WorkspaceHeader } from "@/ui/components/workspace-layout";
import { ChoiceDropdown } from "@/ui/components/choice-dropdown";
import { ReviewEditor } from "./editor";
import { Inbox } from "./inbox";
import type { Workspace } from "./model";

type Filter = "pending" | "history" | "created" | "skipped" | "expired";
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
            Completa lo que recibiste y decide qué guardar.
          </p>
        }
      >
        <ChoiceDropdown
          id="review-status"
          label="Mostrar elementos"
          value={filter}
          options={filters}
          disabled={false}
          leading={null}
          triggerLabel={Option.none()}
          width="auto"
          onChange={(value) => {
            const selected = filters.find((option) => option.value === value);
            if (selected !== undefined) {
              select(selected.value, 0);
            }
          }}
        />
      </WorkspaceHeader>
      <ReviewResources
        key={`${filter}:${page}`}
        filter={filter}
        page={page}
        move={(offset) => select(filter, offset)}
      />
    </>
  );
};
const filters = [
  { value: "pending", label: "Pendientes" },
  { value: "history", label: "Historial" },
  { value: "created", label: "Creadas" },
  { value: "skipped", label: "Omitidas" },
  { value: "expired", label: "Vencidas" },
] as const;
const ReviewResources = ({
  filter,
  page,
  move,
}: Readonly<{ filter: Filter; page: number; move: (offset: number) => void }>): JSX.Element => {
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
  return <ReadyInbox view={state.value.data} page={page} move={move} refresh={refresh} />;
};
const ReadyInbox = ({
  view,
  page,
  move,
  refresh,
}: Readonly<{
  view: Workspace;
  page: number;
  move: (offset: number) => void;
  refresh: () => void;
}>): JSX.Element => {
  const control = useInboxControl({ view, refresh });
  const item = view.items.find((candidate) => Option.contains(control.selected, candidate.id));
  return (
    <>
      <ReviewToolbar view={view} control={control} />
      <div className="grid min-w-0 lg:grid-cols-[15rem_minmax(0,1fr)]">
        <Inbox
          view={view}
          selected={control.selected}
          checked={control.checked}
          choose={control.choose}
          toggle={control.toggle}
          page={page}
          move={move}
        />
        {item === undefined ? (
          <div className="p-10">
            <h2 className="text-xl font-medium">
              {view.pendingCount === 0 ? "Todo al día" : "Sin elementos en esta vista"}
            </h2>
            <p className="mt-2 text-sm text-muted-foreground">
              Los próximos elementos que necesiten tu ayuda aparecerán aquí.
            </p>
          </div>
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
    </>
  );
};
