import { DateTime, Effect, Option } from "effect";
import { type AtomRegistry } from "effect/reactivity";
import type { FidyClient } from "@/transport/client";
import { type CanonicalQueryState, presentCanonicalQuery } from "@/transport/canonical-query";
import { type HistoryState, transactionHistory } from "./history";
import { type QuerySnapshot, initialQuery } from "./model";
import {
  type Category,
  type CurrentMonthPeriod,
  type CurrentUser,
  deriveCurrentMonthPeriod,
  presentPeriod,
} from "./presentation";

type ResourceOwner = Readonly<{
  dispose: () => void;
  refresh: () => void;
  more: () => void;
  retryMore: () => void;
  publish: () => void;
}>;
export type QueryOwner = Readonly<{
  dispose: () => void;
  refresh: () => void;
  more: () => void;
  retryMore: () => void;
}>;
type Configuration = Readonly<{
  client: FidyClient;
  registry: AtomRegistry.AtomRegistry;
  changed: (snapshot: QuerySnapshot) => void;
}>;
const failedRead = (tags: ReadonlyArray<string>): boolean => tags.includes("Failure");
const boundaryFailure = (state: CanonicalQueryState<unknown, unknown>): boolean =>
  state._tag === "Failure" && state.failure._tag !== "DeclaredFailure";
const profileStale = (
  profile: CanonicalQueryState<Readonly<{ data: CurrentUser }>, unknown>
): boolean => profile._tag !== "Ready" || Option.isSome(profile.refreshFailure);
const snapshot = (
  configuration: Readonly<{
    category: CanonicalQueryState<Readonly<{ data: ReadonlyArray<Category> }>, unknown>;
    history: HistoryState;
    profile: CanonicalQueryState<Readonly<{ data: CurrentUser }>, unknown>;
    user: CurrentUser;
    period: CurrentMonthPeriod;
  }>
): QuerySnapshot => {
  const { category, history, profile, user, period } = configuration;
  if (category._tag !== "Ready" || history.query._tag !== "Ready") {
    return {
      ...initialQuery,
      user: Option.some(user),
      status: failedRead([category._tag, history.query._tag]) ? "Failed" : "Loading",
      waiting: category.waiting || history.query.waiting || profile.waiting,
      boundaryFailure: boundaryFailure(category) || boundaryFailure(history.query),
    };
  }
  return {
    user: Option.some(user),
    categories: category.value.data,
    transactions: history.query.value.data,
    status: "Ready",
    boundaryFailure: false,
    stale: [
      Option.isSome(category.refreshFailure),
      Option.isSome(history.query.refreshFailure),
      profileStale(profile),
    ].some(Boolean),
    waiting: [category.waiting, history.query.waiting, profile.waiting].some(Boolean),
    continuation: history.continuation,
    generation: history.generation,
    ...presentPeriod({ locale: user.locale, period }),
  };
};
const makeResources = (configuration: Configuration, user: CurrentUser): ResourceOwner => {
  const { client, registry, changed } = configuration;
  const period = deriveCurrentMonthPeriod({
    now: Effect.runSync(DateTime.now),
    timeZone: user.timeZone,
  });
  const categories = client.query("categories", "listCategories", {});
  const first = client.query("transactions", "listTransactions", {
    query: { from: period.from, to: period.to },
  });
  const history = transactionHistory({ apiClient: client, firstPage: first, period });
  const profile = client.query("identity", "getCurrentUser", {});
  const publish = (): void =>
    changed(
      snapshot({
        category: presentCanonicalQuery(registry.get(categories)),
        history: registry.get(history.state),
        profile: presentCanonicalQuery(registry.get(profile)),
        user,
        period,
      })
    );
  const releases = [
    registry.subscribe(categories, publish),
    registry.subscribe(history.state, publish),
  ];
  publish();
  return {
    publish,
    dispose: () => {
      for (const release of releases) release();
    },
    refresh: () => {
      registry.refresh(categories);
      registry.set(history.action, "reset");
    },
    more: () => registry.set(history.action, "more"),
    retryMore: () => registry.set(history.action, "retry"),
  };
};
/** Reuses canonical query ownership and validated continuation paging, exposing only safe presentation state. */
export const makeTransactionQueryOwner = (configuration: Configuration): QueryOwner => {
  const { client, registry, changed } = configuration;
  const profile = client.query("identity", "getCurrentUser", {});
  let resources = Option.none<ResourceOwner>();
  let contextKey = Option.none<string>();
  let active = true;
  const publish = (): void => {
    if (!active) return;
    const state = presentCanonicalQuery(registry.get(profile));
    if (state._tag !== "Ready") {
      changed({
        ...initialQuery,
        status: state._tag === "Failure" ? "Failed" : "Loading",
        waiting: state.waiting,
        boundaryFailure: boundaryFailure(state),
      });
      return;
    }
    const key = `${state.value.data.id}|${state.value.data.timeZone}|${state.value.data.locale}`;
    if (!Option.contains(contextKey, key)) {
      Option.map(resources, (owner) => owner.dispose());
      contextKey = Option.some(key);
      resources = Option.some(
        makeResources(
          {
            ...configuration,
            changed: (snapshot) => {
              if (active && Option.contains(contextKey, key)) changed(snapshot);
            },
          },
          state.value.data
        )
      );
    } else Option.map(resources, (owner) => owner.publish());
  };
  const release = registry.subscribe(profile, publish);
  publish();
  return {
    dispose: () => {
      active = false;
      release();
      Option.map(resources, (owner) => owner.dispose());
    },
    refresh: () => {
      registry.refresh(profile);
      Option.map(resources, (owner) => owner.refresh());
    },
    more: () => {
      Option.map(resources, (owner) => owner.more());
    },
    retryMore: () => {
      Option.map(resources, (owner) => owner.retryMore());
    },
  };
};
