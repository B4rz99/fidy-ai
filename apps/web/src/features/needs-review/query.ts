import { browserRuntime } from "@/transport/browser-runtime";
import { observeReviewQuery } from "./query-observation";
import { reviewItemKey, reviewWorkspaceKey } from "./query-keys";
import { Data, DateTime, Effect, Option } from "effect";
import { preparationActive, prepareQuery } from "@/transport/query-preparation";
import { observeOriginalDeadline } from "./original-deadline";
import { reviewMaterialQuery } from "./material-query";
import { AsyncResult, Atom, type AtomRegistry, Reactivity } from "effect/reactivity";
import type { CanonicalSuccess, FidyClient } from "@/transport/client";
import type { ReviewWorkspaceQuery } from "./decisions";
import type { Filter } from "./view-navigation";

type ReviewWorkspaceQueries = Readonly<{
  source: ReviewWorkspaceQuery;
  active: ReviewWorkspaceQuery;
}>;

const renderCommitRetention = "400 millis";

class WorkspaceKey extends Data.Class<
  Readonly<{
    client: FidyClient;
    filter: Filter;
    page: number;
  }>
> {}

const sources = Atom.family(({ client, filter, page }: WorkspaceKey) =>
  client.query("ingestion", "getReviewWorkspace", {
    query: {
      status: Option.some(filter),
      offset: page === 0 ? Option.none() : Option.some(page),
    },
    reactivityKeys: ["ingestion-review", reviewWorkspaceKey],
    timeToLive: renderCommitRetention,
  })
);

const activeQueries = Atom.family((key: WorkspaceKey) => {
  const source = sources(key);

  return observeReviewQuery(source);
});

export const reviewWorkspaceQueries = (
  input: Readonly<{
    client: FidyClient;
    filter: Filter;
    page: number;
  }>
): ReviewWorkspaceQueries => {
  const key = new WorkspaceKey(input);

  return { source: sources(key), active: activeQueries(key) };
};

export const reviewItemQuery = ({
  client,
  workspace,
  id,
}: Readonly<{
  client: FidyClient;
  workspace: ReviewWorkspaceQuery;
  id: CanonicalSuccess<"ingestion.getReviewItem">["data"]["item"]["id"];
}>): Atom.Atom<AsyncResult.AsyncResult<CanonicalSuccess<"ingestion.getReviewItem">, unknown>> => {
  const individual = client.query("ingestion", "getReviewItem", {
    params: { id },
    reactivityKeys: ["ingestion-review", reviewItemKey(id)],
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
      old.value.data.items.map((item) => reviewItemKey(item.id))
    );
  }
};

const prepareFirstMaterial = (
  {
    apiClient,
    registry,
    signal,
  }: Pick<ReviewPreparation, "apiClient" | "registry"> &
    Readonly<{
      signal: Option.Option<AbortSignal>;
    }>,
  source: ReviewWorkspaceQuery
): Promise<void> =>
  browserRuntime.runPromise(
    Effect.gen(function* () {
      const snapshot = AsyncResult.value(registry.get(source));
      const selected = Option.flatMap(snapshot, ({ data }) => data.selectedDetail);

      if (
        Option.isSome(selected) &&
        DateTime.toEpochMillis(observeOriginalDeadline({ registry, item: selected.value.item })) >
          DateTime.toEpochMillis(DateTime.nowUnsafe())
      ) {
        yield* Effect.tryPromise(() =>
          prepareQuery({
            registry,
            query: reviewMaterialQuery({
              client: apiClient,
              item: selected.value.item,
            }),
            options: {
              mode: "cached",
              signal,
            },
          })
        );
      }
    })
  );

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
  DateTime.toEpochMillis(DateTime.nowUnsafe()) - before.timestamp >= recentSnapshotMilliseconds;

export const prepareReviewWorkspace = (input: ReviewPreparation): Promise<void> =>
  browserRuntime.runPromise(
    Effect.gen(function* () {
      const { apiClient, registry, filter, page, signal } = input;

      if (!preparationActive(signal)) {
        return;
      }

      const source = reviewWorkspaceQueries({
        client: apiClient,
        filter,
        page,
      }).source;

      const before = registry.get(source);
      const first = firstReviewRead(registry.get(visited(apiClient)), before);
      const fresh = refreshReviewRead(first, before);

      if (fresh && !before.waiting) {
        invalidateSelectedReads(input, before);
      }

      yield* Effect.tryPromise(() =>
        prepareQuery({
          registry,
          query: source,
          options: {
            mode: fresh ? "refresh-display" : "display",
            signal: Option.some(signal),
          },
        })
      );

      if (!preparationActive(signal)) {
        return;
      }

      registry.set(visited(apiClient), true);

      if (first) {
        yield* Effect.tryPromise(() =>
          prepareFirstMaterial({ ...input, signal: Option.some(signal) }, source)
        );
      }
    })
  );

export const preloadReviewMaterial = ({
  client,
  registry,
}: Readonly<{
  client: FidyClient;
  registry: AtomRegistry.AtomRegistry;
}>): Promise<void> =>
  browserRuntime.runPromise(
    Effect.gen(function* () {
      if (registry.get(visited(client))) {
        return;
      }

      const source = reviewWorkspaceQueries({
        client,
        filter: "pending",
        page: 0,
      }).source;

      yield* Effect.tryPromise(() =>
        prepareQuery({
          registry,
          query: source,
          options: { mode: "cached", signal: Option.none() },
        })
      );
      yield* Effect.tryPromise(() =>
        prepareFirstMaterial({ apiClient: client, registry, signal: Option.none() }, source)
      );
    })
  );
