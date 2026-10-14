import { Data, Effect, Option } from "effect";
import { type AsyncResult, Atom } from "effect/reactivity";
import type { PrivacyTransactionPage, WebAuthClient } from "@/transport/client";
import { type CanonicalQueryState, presentCanonicalQuery } from "@/transport/canonical-query";
import type { HistoryState } from "./history";

type PageAtom = Atom.Atom<AsyncResult.AsyncResult<PrivacyTransactionPage, unknown>>;
type PrivacyHistoryState = Readonly<{
  generation: number;
  query: CanonicalQueryState<PrivacyTransactionPage, unknown>;
  continuation: HistoryState["continuation"];
  retryPage: Option.Option<PageAtom>;
}>;
type PrivacyHistory = Readonly<{
  state: Atom.Atom<PrivacyHistoryState>;
  action: Atom.Writable<Option.Option<void>, "more" | "retry" | "reset">;
}>;
class PageKey extends Data.Class<{ generation: number; cursor: PrivacyTransactionPage["next"] }> {}
type ReadyPage = Extract<PrivacyHistoryState["query"], { _tag: "Ready" }>;
const pagePending = (query: PrivacyHistoryState["query"]): boolean =>
  query._tag !== "Ready" || query.waiting || Option.isSome(query.refreshFailure);
const pageFailed = (query: PrivacyHistoryState["query"]): boolean =>
  query._tag === "Failure" || (query._tag === "Ready" && Option.isSome(query.refreshFailure));

const pendingStatus = (query: PrivacyHistoryState["query"]): PrivacyHistoryState["continuation"] =>
  pageFailed(query) ? "failure" : "loading";
const appendPage = (
  data: Array<PrivacyTransactionPage["data"][number]>,
  ids: Set<string>,
  page: PrivacyTransactionPage
): void => {
  for (const transaction of page.data) {
    if (ids.has(transaction.id)) continue;
    ids.add(transaction.id);
    data.push(transaction);
  }
};

const browse = ({
  first,
  generation,
  count,
  read,
}: Readonly<{
  first: ReadyPage;
  generation: number;
  count: number;
  read: (
    cursor: PrivacyTransactionPage["next"]
  ) => Readonly<{ atom: PageAtom; query: PrivacyHistoryState["query"] }>;
}>): PrivacyHistoryState => {
  let page = first.value;
  const data = [...page.data];
  const ids = new Set(data.map((value) => value.id));
  const cursors = new Set<string>();
  const result = (continuation: PrivacyHistoryState["continuation"]): PrivacyHistoryState => ({
    generation,
    retryPage: Option.none(),
    continuation,
    query: { ...first, value: { ...page, data } },
  });
  if (pagePending(first)) return result(pendingStatus(first));
  for (let index = 1; page.next !== null; index += 1) {
    if (cursors.has(page.next.id)) return result("failure");
    cursors.add(page.next.id);
    if (index >= count) return result("available");
    const next = read(page.next);
    if (pagePending(next.query)) {
      return {
        ...result(pendingStatus(next.query)),
        retryPage: Option.some(next.atom),
      };
    }
    if (next.query._tag !== "Ready") return result("failure");
    page = next.query.value;
    appendPage(data, ids, page);
  }
  return result("complete");
};

/** Fresh privacy reads own each page in the authentication registry; no receipt or financial data enters local storage. */
export const privacyTransactionHistory = (client: WebAuthClient): PrivacyHistory => {
  const navigation = Atom.make({ generation: 0, pages: 1 });
  const pages = Atom.family((key: PageKey): PageAtom =>
    client.runtime.atom(
      client.pipe(
        Effect.flatMap((api) =>
          api.processingConsent.transactions({ payload: { cursor: key.cursor } })
        )
      )
    )
  );
  const state = Atom.make((get): PrivacyHistoryState => {
    const current = get(navigation);
    const query = presentCanonicalQuery(
      get(pages(new PageKey({ generation: current.generation, cursor: null })))
    );
    if (query._tag !== "Ready") {
      return {
        generation: current.generation,
        continuation: "loading",
        retryPage: Option.none(),
        query,
      };
    }
    return browse({
      first: query,
      generation: current.generation,
      count: current.pages,
      read: (cursor) => {
        const atom = pages(new PageKey({ generation: current.generation, cursor }));
        return { atom, query: presentCanonicalQuery(get(atom)) };
      },
    });
  });
  const action = Atom.fnSync<"more" | "retry" | "reset">()((command, get): void => {
    const current = get(navigation);
    const first = pages(new PageKey({ generation: current.generation, cursor: null }));
    if (command === "reset") {
      get.set(navigation, { generation: current.generation + 1, pages: 1 });
    } else if (command === "retry") {
      get.refresh(Option.getOrElse(get(state).retryPage, () => first));
    } else if (get(state).continuation === "available") {
      get.set(navigation, { ...current, pages: current.pages + 1 });
    }
  });
  return { state, action };
};
