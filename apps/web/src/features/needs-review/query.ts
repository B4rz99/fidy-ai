import { preparationActive, prepareQuery } from "@/transport/query-preparation";
import { reviewMaterialQuery } from "./material-query";
import { Data, DateTime, Option } from "effect";
import { AsyncResult, Atom, type AtomRegistry, Reactivity } from "effect/reactivity";
import type { CanonicalSuccess, FidyClient } from "@/transport/client";
import type { ReviewWorkspaceQuery } from "./decisions";
import type { Filter } from "./view-navigation";

const focusSignal = Atom.readable((get) => {
  if (typeof window === "undefined") return 0;
  let version = 0;
  const visible = (): void => {
    if (document.visibilityState === "visible") get.setSelf(++version);
  };
  window.addEventListener("focus", visible);
  window.addEventListener("visibilitychange", visible);
  get.addFinalizer(() => {
    window.removeEventListener("focus", visible);
    window.removeEventListener("visibilitychange", visible);
  });
  return version;
});

const pollMilliseconds = 60_000;
// Bridge React's render-to-subscription gap without retaining abandoned reads indefinitely.
const renderCommitRetention = "400 millis";
const observeReviewQuery = (source: ReviewWorkspaceQuery): ReviewWorkspaceQuery =>
  Atom.transform(source, (get) => {
    const refresh = (): void => {
      if (!get.once(source).waiting) get.refresh(source);
    };
    get.once(focusSignal);
    get.subscribe(focusSignal, refresh);
    get.subscribe(source, (value) => get.setSelf(value));
    const timer = setInterval(refresh, pollMilliseconds);
    get.addFinalizer(() => clearInterval(timer));
    return get.once(source);
  });

class WorkspaceKey extends Data.Class<Readonly<{ filter: Filter; page: number }>> {}

const queries = Atom.family((client: FidyClient) =>
  Atom.family(({ filter, page }: Readonly<{ filter: Filter; page: number }>) => {
    const source = client.query("ingestion", "getReviewWorkspace", {
      query: {
        status: Option.some(filter),
        offset: page === 0 ? Option.none() : Option.some(page),
      },
      reactivityKeys: ["ingestion-review", "ingestion-review-workspace"],
      timeToLive: renderCommitRetention,
    });
    const active = observeReviewQuery(source);
    return { source, active };
  })
);

/** The badge and first pending page share one refresh owner in the authentication registry. */
export const reviewWorkspaceQueries = (
  client: FidyClient,
  filter: Filter,
  page: number
): Readonly<{ source: ReviewWorkspaceQuery; active: ReviewWorkspaceQuery }> =>
  queries(client)(new WorkspaceKey({ filter, page }));

/** Read the inbox's selected revision directly; other selections retain their own canonical read. */
export const reviewItemQuery = (
  client: FidyClient,
  workspace: ReviewWorkspaceQuery,
  id: CanonicalSuccess<"ingestion.getReviewItem">["data"]["item"]["id"]
): Atom.Atom<AsyncResult.AsyncResult<CanonicalSuccess<"ingestion.getReviewItem">, unknown>> => {
  const individual = client.query("ingestion", "getReviewItem", {
    params: { id },
    reactivityKeys: ["ingestion-review", `ingestion-review-item:${id}`],
    timeToLive: renderCommitRetention,
  });
  return Atom.readable(
    (get) => {
      const state = get(workspace);
      const selected = Option.flatMap(AsyncResult.value(state), ({ data }) =>
        Option.filter(data.selectedDetail, (detail) => detail.item.id === id)
      );
      return Option.isSome(selected)
        ? AsyncResult.map(state, () => ({ data: selected.value, next: [] }))
        : get(individual);
    },
    (refresh) => {
      refresh(workspace);
      refresh(individual);
    }
  );
};

const invalidateItemReads = Atom.family((client: FidyClient) =>
  client.runtime.fn<ReadonlyArray<string>>()((keys) => Reactivity.invalidate(keys))
);

const visited = Atom.family((_client: FidyClient) => Atom.make(false).pipe(Atom.keepAlive));

/** Return reads complete before reveal; preloading code does not consume another data generation. */
const recentSnapshotMilliseconds = 5000;
type ReviewPreparation = Readonly<{
  apiClient: FidyClient;
  registry: AtomRegistry.AtomRegistry;
  filter: Filter;
  page: number;
  signal: AbortSignal;
}>;
const invalidateSelectedReads = (
  { apiClient, registry }: ReviewPreparation,
  state: ReturnType<ReviewWorkspaceQuery["read"]>
): void => {
  const old = AsyncResult.value(state);
  if (Option.isSome(old)) {
    registry.set(
      invalidateItemReads(apiClient),
      old.value.data.items.map((item) => `ingestion-review-item:${item.id}`)
    );
  }
};
const prepareFirstMaterial = async (
  {
    apiClient,
    registry,
    signal,
  }: Pick<ReviewPreparation, "apiClient" | "registry"> &
    Readonly<{ signal: Option.Option<AbortSignal> }>,
  source: ReviewWorkspaceQuery
): Promise<void> => {
  const snapshot = AsyncResult.value(registry.get(source));
  const selected = Option.flatMap(snapshot, ({ data }) => data.selectedDetail);
  if (
    Option.isSome(selected) &&
    DateTime.toEpochMillis(selected.value.item.expiresAt) > Date.now()
  ) {
    await prepareQuery(registry, reviewMaterialQuery(apiClient, selected.value.item.id), {
      mode: "cached",
      signal,
    });
  }
};
const firstReviewRead = (
  seen: boolean,
  before: ReturnType<ReviewWorkspaceQuery["read"]>
): boolean => !seen || AsyncResult.isInitial(before);
const refreshReviewRead = (
  first: boolean,
  before: ReturnType<ReviewWorkspaceQuery["read"]>
): boolean =>
  !first ||
  !AsyncResult.isSuccess(before) ||
  Date.now() - before.timestamp >= recentSnapshotMilliseconds;
export const prepareReviewWorkspace = async (input: ReviewPreparation): Promise<void> => {
  const { apiClient, registry, filter, page, signal } = input;
  if (!preparationActive(signal)) return;
  const source = reviewWorkspaceQueries(apiClient, filter, page).source;
  const before = registry.get(source);
  const first = firstReviewRead(registry.get(visited(apiClient)), before);
  const fresh = refreshReviewRead(first, before);
  if (fresh && !before.waiting) invalidateSelectedReads(input, before);
  await prepareQuery(registry, source, {
    mode: fresh ? "refresh-display" : "display",
    signal: Option.some(signal),
  });
  if (!preparationActive(signal)) return;
  registry.set(visited(apiClient), true);
  if (first) await prepareFirstMaterial({ ...input, signal: Option.some(signal) }, source);
};

/** Only explicit first-entry intent warms immutable material; returns reuse the retained selection. */
export const preloadReviewMaterial = async (
  client: FidyClient,
  registry: AtomRegistry.AtomRegistry
): Promise<void> => {
  if (registry.get(visited(client))) return;
  const source = reviewWorkspaceQueries(client, "pending", 0).source;
  await prepareQuery(registry, source);
  await prepareFirstMaterial({ apiClient: client, registry, signal: Option.none() }, source);
};
