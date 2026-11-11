import { forwardFreshQuery, makeFreshQuery } from "@/transport/fresh-query";
import { Data, DateTime, Effect, Option } from "effect";
import { AsyncResult, Atom } from "effect/reactivity";
import type { CanonicalSuccess, FidyClient } from "@/transport/client";
import { presentCanonicalQuery } from "@/transport/canonical-query";
import { destinationMonth, transactionDestinationQuery } from "./destination-query";
import { type HistoryCommand, type HistoryState, transactionHistory } from "./history";
import { type TransactionSearch, selectedTransactionPeriod } from "./period";
import { transactionFirstPage } from "./query";
import { revalidateWorkspaceQuery, workspaceQueryRetention } from "@/transport/workspace-query";
import type { CurrentMonthPeriod } from "./presentation";

class Generation extends Data.Class<{
  number: number;
  pages: number;
  period: CurrentMonthPeriod;
  locate: Option.Option<string>;
}> {}

class QueryIdentity extends Data.Class<{
  period: CurrentMonthPeriod;
  locate: Option.Option<string>;
}> {}

type Page = CanonicalSuccess<"transactions.listTransactions">;
type RouteHistoryState = HistoryState &
  Readonly<{
    period: CurrentMonthPeriod;
    locate: Option.Option<string>;
  }>;

type RouteHistoryInput = Readonly<{
  client: FidyClient;
  search: TransactionSearch;
  timeZone: string;
  now: DateTime.Utc;
  initialPages: number;
}>;
type HistoryResource = ReturnType<typeof transactionHistory>;
type PageAtom = Atom.Atom<AsyncResult.AsyncResult<Page, unknown>>;
type GenerationOwner = Readonly<{
  generation: Generation;
  destination: Option.Option<ReturnType<typeof transactionDestinationQuery>>;
  firstPage: PageAtom;
  period: Atom.Atom<CurrentMonthPeriod>;
  locate: Atom.Atom<Option.Option<string>>;
  resource: Atom.Atom<HistoryResource>;
}>;
export type TransactionRouteHistory = Readonly<{
  firstPage: PageAtom;
  state: Atom.Atom<RouteHistoryState>;
  action: HistoryResource["action"];
}>;
const destinationForGeneration = (
  client: FidyClient,
  addressed: TransactionSearch["transaction"],
  generation: number
): GenerationOwner["destination"] => {
  if (addressed === undefined) return Option.none();
  if (generation === 0) return Option.some(transactionDestinationQuery({ client, id: addressed }));
  return Option.some(
    client.runtime.atom(
      Effect.gen(function* () {
        const api = yield* client;
        return yield* api.transactions.getTransaction({ params: { id: addressed } });
      })
    )
  );
};
const generationSources = (
  client: FidyClient,
  generation: number
): ((selected: CurrentMonthPeriod) => PageAtom) =>
  Atom.family((selected: CurrentMonthPeriod) =>
    generation === 0
      ? transactionFirstPage({ client, period: selected })
      : makeFreshQuery({
          runtime: client.runtime,
          load: Effect.gen(function* () {
            const api = yield* client;
            return yield* api.transactions.listTransactions({
              query: { from: selected.from, to: selected.to, limit: 25 },
            });
          }),
          decorate: Atom.setIdleTTL(workspaceQueryRetention.timeToLive),
        })
  );

const generationFirstPage = ({
  destination,
  sources,
  period,
  generation,
}: Readonly<{
  destination: GenerationOwner["destination"];
  sources: (selected: CurrentMonthPeriod) => PageAtom;
  period: Atom.Atom<CurrentMonthPeriod>;
  generation: number;
}>): PageAtom => {
  const views = Atom.family((source: PageAtom) =>
    forwardFreshQuery({ query: source.pipe(revalidateWorkspaceQuery), sources: [source] })
  );
  const firstPage = Atom.make((get): AsyncResult.AsyncResult<Page, unknown> => {
    if (Option.isSome(destination)) {
      const result = get(destination.value);
      if (result._tag === "Initial") return AsyncResult.initial(result.waiting);
      if (result._tag === "Failure") {
        return AsyncResult.failure(result.cause, { waiting: result.waiting });
      }
      if (result.waiting) return AsyncResult.initial(true);
    }
    const source = sources(get(period));
    return get(generation === 0 ? source : views(source));
  });
  return forwardFreshQuery({
    query: firstPage,
    sources: (registry) => [sources(registry.get(period))],
  });
};

const makeGeneration = (
  { client, search, timeZone, now }: RouteHistoryInput,
  generation: Generation
): GenerationOwner => {
  const destination = destinationForGeneration(client, search.transaction, generation.number);
  const period = Atom.make((get) => {
    const result = Option.isNone(destination) ? undefined : get(destination.value);
    return result?._tag === "Success"
      ? selectedTransactionPeriod({
          search: { month: destinationMonth({ transaction: result.value.data, timeZone }) },
          now,
          timeZone,
        })
      : generation.period;
  });
  const locate = Atom.make((get) => {
    if (Option.isNone(destination)) return Option.none<string>();
    const result = get(destination.value);
    return result._tag === "Success" ? Option.some(result.value.data.id) : generation.locate;
  });
  const sources = generationSources(client, generation.number);
  const firstPage = generationFirstPage({
    destination,
    sources,
    period,
    generation: generation.number,
  });
  const histories = Atom.family((identity: QueryIdentity) =>
    Atom.make(
      transactionHistory({
        apiClient: client,
        firstPage,
        period: identity.period,
        locate: identity.locate,
        initialPages: generation.pages,
      })
    )
  );
  const resource = Atom.make((get) =>
    get(histories(new QueryIdentity({ period: get(period), locate: get(locate) })))
  );
  return {
    generation,
    destination,
    firstPage,
    period,
    locate,
    resource,
  };
};
/** Route staging and destination rereads share the history generation. Construction starts no reads. */
export const transactionRouteHistory = (input: RouteHistoryInput): TransactionRouteHistory => {
  const { search, now, timeZone, initialPages } = input;
  const navigation = Atom.make(
    makeGeneration(
      input,
      new Generation({
        number: 0,
        pages: initialPages,
        period: selectedTransactionPeriod({ search, now, timeZone }),
        locate: Option.fromUndefinedOr(search.transaction),
      })
    )
  );
  const firstPage = Atom.make((get) => get(get(navigation).firstPage));
  const state = Atom.make((get): RouteHistoryState => {
    const owner = get(navigation);
    const resource = get(owner.resource);
    const history = get(resource.state);
    const current: RouteHistoryState = {
      ...history,
      generation: owner.generation.number,
      period: get(owner.period),
      locate: get(owner.locate),
      location:
        Option.isSome(get(owner.locate)) &&
        Option.isSome(owner.destination) &&
        get(owner.destination.value)._tag === "Failure"
          ? "LookupFailed"
          : history.location,
    };
    return retainHistoryDisplay(current, get.self<RouteHistoryState>());
  });
  const action = routeActions({ input, navigation, state });
  return {
    firstPage: forwardFreshQuery({
      query: firstPage,
      sources: (registry) => [registry.get(navigation).firstPage],
    }),
    state,
    action,
  };
};

const resetPages = (command: string, loadedPages: number): number =>
  command === "refresh" ? Math.max(1, loadedPages) : 1;

const advanceContinuation = (owner: GenerationOwner): GenerationOwner => ({
  ...owner,
  generation: new Generation({
    number: owner.generation.number + 1,
    pages: owner.generation.pages,
    period: owner.generation.period,
    locate: owner.generation.locate,
  }),
});

const routeActions = ({
  input,
  navigation,
  state,
}: Readonly<{
  input: RouteHistoryInput;
  navigation: Atom.Writable<GenerationOwner>;
  state: Atom.Atom<RouteHistoryState>;
}>): HistoryResource["action"] =>
  Atom.fnSync<HistoryCommand>()((command, get): void => {
    const owner = get(navigation);
    const current = owner.generation;
    if (command === "refresh-pages") {
      const pages = Math.max(1, get(state).loadedPages);
      const resource = get(owner.resource);
      get.set(resource.action, { refreshPages: pages });
      get.set(navigation, advanceContinuation(owner));
      return;
    }
    if (typeof command === "string") {
      const previous = get(state);
      get.set(
        navigation,
        makeGeneration(
          input,
          new Generation({
            number: current.number + 1,
            pages: resetPages(command, previous.loadedPages),
            period: previous.period,
            locate: previous.locate,
          })
        )
      );
      return;
    }
    const resource = get(owner.resource);
    if ("more" in command) {
      if (command.more !== get(state).more.more) return;
      get.set(resource.action, command);
    } else if ("retry" in command) {
      if (command.retry !== get(state).retry.retry) return;
      if (!shouldRetryLookup(get(owner.firstPage))) return get.set(resource.action, command);
      get.set(
        navigation,
        makeGeneration(
          input,
          new Generation({
            number: current.number + 1,
            pages: current.pages,
            period: current.period,
            locate: current.locate,
          })
        )
      );
    } else get.set(resource.action, command);
  });

const shouldRetryLookup = (result: AsyncResult.AsyncResult<Page, unknown>): boolean =>
  presentCanonicalQuery(result)._tag === "Failure";

const retainHistoryDisplay = (
  current: RouteHistoryState,
  previous: Option.Option<RouteHistoryState>
): RouteHistoryState => {
  if (Option.isNone(previous)) return current;
  const prior = previous.value;
  if (prior.query._tag !== "Ready" || !samePeriod(prior.period, current.period)) return current;
  if (!needsRetainedDisplay(current, prior.loadedPages)) return current;
  return retainPendingDisplay(current, { ...prior, query: prior.query });
};
const samePeriod = (left: CurrentMonthPeriod, right: CurrentMonthPeriod): boolean =>
  left.timeZone === right.timeZone &&
  DateTime.toEpochMillis(left.from) === DateTime.toEpochMillis(right.from) &&
  DateTime.toEpochMillis(left.to) === DateTime.toEpochMillis(right.to);
const needsRetainedDisplay = (current: RouteHistoryState, loadedPages: number): boolean => {
  if (current.query._tag !== "Ready") return true;
  if (current.loadedPages >= loadedPages) return false;
  return (
    current.query.waiting ||
    current.continuation === "loading" ||
    current.continuation === "failure"
  );
};
const retainPendingDisplay = (
  current: RouteHistoryState,
  previous: RouteHistoryState & { query: Extract<RouteHistoryState["query"], { _tag: "Ready" }> }
): RouteHistoryState => {
  const failed = current.query._tag === "Failure" || current.continuation === "failure";
  const refreshFailure =
    current.query._tag === "Failure"
      ? Option.some(current.query.failure)
      : Option.some({ _tag: "BoundaryFailure" as const });
  const continuation = failed ? "failure" : "loading";
  return {
    ...current,
    loadedPages: previous.loadedPages,
    query: {
      ...previous.query,
      waiting: !failed,
      refreshFailure: failed ? refreshFailure : Option.none(),
    },
    continuation: current.query._tag === "Failure" ? "available" : continuation,
  };
};
