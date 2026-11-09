import { Data, DateTime, Effect, Option, Schema } from "effect";
import { HttpClientError } from "effect/http";
import { type AsyncResult, Atom } from "effect/reactivity";
import {
  type CanonicalInput,
  type CanonicalSuccess,
  type FidyClient,
  TransactionQueryValues,
} from "@/transport/client";
import { type CanonicalQueryState, presentCanonicalQuery } from "@/transport/canonical-query";

type TransactionPage = CanonicalSuccess<"transactions.listTransactions">;
type HistoryInput = Required<
  Pick<CanonicalInput<"transactions.listTransactions">["query"], "from" | "to">
>;
type PageAtom = Atom.Atom<AsyncResult.AsyncResult<TransactionPage, unknown>>;
class PageKey extends Data.Class<{ generation: number; cursor: string }> {}
type HistoryNavigation = Readonly<{ generation: number; pages: number }>;
export type HistoryState = Readonly<{
  query: CanonicalQueryState<Pick<TransactionPage, "data">, unknown>;
  generation: number;
  loadedPages: number;
  continuation: "complete" | "available" | "loading" | "failure";
  retryPage: Option.Option<PageAtom>;
}>;
export type HistoryCommand =
  | "more"
  | "retry"
  | "reset"
  | "refresh"
  | Readonly<{ restorePages: number }>;
type History = Readonly<{
  state: Atom.Atom<HistoryState>;
  action: Atom.Writable<Option.Option<void>, HistoryCommand>;
}>;
type ReadyPage = Extract<CanonicalQueryState<TransactionPage, unknown>, { _tag: "Ready" }>;
const continuationInput = Schema.Struct({
  query: Schema.Struct({
    from: TransactionQueryValues.fields.from,
    to: TransactionQueryValues.fields.to,
    cursor: TransactionQueryValues.fields.cursor,
  }),
});
const nextCursor = (page: TransactionPage, period: HistoryInput): Option.Option<string> => {
  const next = page.next.find((suggestion) => suggestion.tool === "transactions.listTransactions");
  if (next === undefined) return Option.none();
  const input =
    "args" in next && Option.isSome(next.args)
      ? Schema.decodeUnknownSync(Schema.toType(continuationInput))(next.args.value)
      : undefined;
  if (
    input === undefined ||
    DateTime.toEpochMillis(input.query.from) !== DateTime.toEpochMillis(period.from) ||
    DateTime.toEpochMillis(input.query.to) !== DateTime.toEpochMillis(period.to)
  ) {
    throw new Error("Invalid Transaction continuation");
  }
  return Option.some(input.query.cursor);
};
const pendingContinuation = (
  current: CanonicalQueryState<TransactionPage, unknown>
): HistoryState["continuation"] => {
  if (current._tag === "Failure") return "failure";
  if (current._tag !== "Ready") return "loading";
  if (Option.isSome(current.refreshFailure)) return "failure";
  return current.waiting ? "loading" : "complete";
};
type BrowsedHistory = HistoryState & Readonly<{ loadedPages: number }>;
type Browse = Readonly<{
  first: ReadyPage;
  navigation: HistoryNavigation;
  period: HistoryInput;
  locate: Option.Option<string>;
  read: (
    cursor: string
  ) => Readonly<{ atom: PageAtom; query: CanonicalQueryState<TransactionPage, unknown> }>;
}>;
const stopBrowsing = (index: number, navigation: HistoryNavigation, first: ReadyPage): boolean =>
  index >= navigation.pages || first.waiting || Option.isSome(first.refreshFailure);
const rememberCursor = (cursors: Set<string>, cursor: string): void => {
  if (cursors.has(cursor)) throw new Error("Repeated Transaction continuation");
  cursors.add(cursor);
};
const maximumLocatePages = 20;
const browse = ({ first, navigation, period, locate, read }: Browse): BrowsedHistory => {
  const base = { generation: navigation.generation, retryPage: Option.none<PageAtom>() };
  let page = first.value;
  const data = [...page.data];
  const ids = new Set<string>(data.map((transaction) => transaction.id));
  let loadedPages = 1;
  const cursors = new Set<string>();
  const result = (continuation: HistoryState["continuation"]): BrowsedHistory => ({
    loadedPages,
    ...base,
    continuation,
    query: { ...first, value: { data } },
  });
  try {
    for (let index = 1; ; index += 1) {
      const cursor = nextCursor(page, period);
      if (Option.isNone(cursor)) return result("complete");
      const pages = Option.exists(locate, (id) => !ids.has(id))
        ? Math.max(navigation.pages, maximumLocatePages)
        : navigation.pages;
      if (stopBrowsing(index, { ...navigation, pages }, first)) return result("available");
      rememberCursor(cursors, cursor.value);
      const current = read(cursor.value);
      const continuation = pendingContinuation(current.query);
      if (continuation !== "complete") {
        return { ...result(continuation), retryPage: Option.some(current.atom) };
      }
      if (current.query._tag !== "Ready") throw new Error("Missing Transaction page");
      current.query.value.data.forEach((transaction) => {
        if (ids.has(transaction.id)) return;
        ids.add(transaction.id);
        data.push(transaction);
      });
      loadedPages = index + 1;
      page = current.query.value;
    }
  } catch {
    return {
      ...result("failure"),
      query: {
        ...first,
        value: { data },
        refreshFailure: Option.some({ _tag: "BoundaryFailure" }),
      },
    };
  }
};
const pageQuery = (apiClient: FidyClient, period: HistoryInput, cursor: string): PageAtom =>
  apiClient.runtime.atom(
    Effect.gen(function* () {
      const client = yield* apiClient;
      return yield* client.transactions.listTransactions({ query: { ...period, cursor } });
    }).pipe(
      Effect.catchIf(
        (error) => Schema.isSchemaError(error) || HttpClientError.isHttpClientError(error),
        Effect.die
      )
    )
  );

const isHistoryFailed = (current: BrowsedHistory): boolean =>
  current.continuation === "failure" ||
  (current.query._tag === "Ready" && Option.isSome(current.query.refreshFailure));
const isHistoryPending = (current: BrowsedHistory): boolean =>
  current.continuation === "loading" ||
  isHistoryFailed(current) ||
  (current.query._tag === "Ready" && current.query.waiting);

const retainLoadedHistory = (
  current: BrowsedHistory,
  previous: Option.Option<BrowsedHistory>,
  requestedPages: number
): BrowsedHistory => {
  if (
    current.query._tag !== "Ready" ||
    Option.isNone(previous) ||
    previous.value.query._tag !== "Ready" ||
    Math.min(requestedPages, previous.value.loadedPages) <= current.loadedPages ||
    !isHistoryPending(current)
  ) {
    return current;
  }
  const failed = isHistoryFailed(current);
  return {
    ...current,
    loadedPages: previous.value.loadedPages,
    continuation: failed ? current.continuation : "loading",
    query: {
      ...current.query,
      value: previous.value.query.value,
      waiting: !failed,
      refreshFailure: failed
        ? Option.some({ _tag: "BoundaryFailure" })
        : current.query.refreshFailure,
    },
  };
};

/** Canonical query atoms own records; this projection joins explicitly requested pages.
 * Reset replaces continuation identities so old responses cannot join refreshed history.
 */
export const transactionHistory = ({
  apiClient,
  firstPage,
  period,
  locate,
  initialPages,
}: Readonly<{
  apiClient: FidyClient;
  firstPage: PageAtom;
  period: HistoryInput;
  locate: Option.Option<string>;
  initialPages: number;
}>): History => {
  const navigation = Atom.make<HistoryNavigation>({ generation: 0, pages: initialPages });
  const pages = Atom.family((key: PageKey) => pageQuery(apiClient, period, key.cursor));
  const state = Atom.make((get): BrowsedHistory => {
    const current = get(navigation);
    const first = presentCanonicalQuery(get(firstPage));
    if (first._tag !== "Ready") {
      return {
        generation: current.generation,
        loadedPages: 0,
        continuation: "complete",
        retryPage: Option.none(),
        query: first,
      };
    }
    const browsed = browse({
      first,
      navigation: current,
      period,
      locate,
      read: (cursor) => {
        const atom = pages(new PageKey({ generation: current.generation, cursor }));
        return { atom, query: presentCanonicalQuery(get(atom)) };
      },
    });
    return retainLoadedHistory(browsed, get.self<BrowsedHistory>(), current.pages);
  });
  const action = Atom.fnSync<HistoryCommand>()((command, get): void => {
    const changePages = (pages: number): void => get.set(navigation, { ...get(navigation), pages });
    if (typeof command !== "string") return changePages(command.restorePages);
    if (command === "reset" || command === "refresh") {
      get.set(navigation, {
        generation: get(navigation).generation + 1,
        pages: command === "refresh" ? Math.max(1, get(state).loadedPages) : 1,
      });
      get.refresh(firstPage);
    } else if (command === "retry") {
      Option.match(get(state).retryPage, {
        onNone: () => get.refresh(firstPage),
        onSome: (atom) => get.refresh(atom),
      });
    } else if (get(state).continuation === "available") {
      const current = get(navigation);
      get.set(navigation, { ...current, pages: get(state).loadedPages + 1 });
    }
  });
  return { state, action };
};
