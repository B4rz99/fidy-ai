import type { HttpApiEndpoint, HttpApiGroup } from "effect/http-api";
import { Data, Option } from "effect";
import { prepareQuery } from "@/transport/query-preparation";
import { originalDeadlineQuery } from "./original-deadline";
import { AsyncResult, Atom, type AtomRegistry } from "effect/reactivity";
import type { CanonicalSuccess, FidyApiGroups, FidyClient } from "@/transport/client";
import { reviewContextKey } from "./query-keys";
import type { Filter } from "./view-navigation";

type ContextEndpoint = HttpApiEndpoint.WithIdentifier<
  HttpApiGroup.Endpoints<HttpApiGroup.WithIdentifier<FidyApiGroups, "ingestion">>,
  "getReviewPageContext"
>;
type ContextQuery = Atom.Atom<
  AsyncResult.AsyncResult<
    CanonicalSuccess<"ingestion.getReviewPageContext">,
    HttpApiEndpoint.Errors<ContextEndpoint>
  >
>;
const emptyContext: ContextQuery = Atom.make(
  AsyncResult.success<CanonicalSuccess<"ingestion.getReviewPageContext">>({
    data: { items: [] },
    next: [],
  })
);
type Selection = Readonly<{ client: FidyClient; filter: Filter; page: number }>;
const contextRequest = (
  { client, filter, page }: Selection,
  keys: ReadonlyArray<string>
): ContextQuery =>
  client.query("ingestion", "getReviewPageContext", {
    query: {
      status: Option.some(filter),
      offset: page === 0 ? Option.none() : Option.some(page),
    },
    reactivityKeys: ["ingestion-review", reviewContextKey, ...keys],
    timeToLive: "400 millis",
  });

/** Explicit navigation to a populated page can start its browser-only read alongside the summary. */
export const prepareKnownReviewPage = (
  input: Selection & Readonly<{ registry: AtomRegistry.AtomRegistry }>
): Promise<void> =>
  prepareQuery({
    registry: input.registry,
    query: contextRequest(input, []),
    options: { mode: "cached", signal: Option.none() },
  });

class PageKey extends Data.Class<Selection & Readonly<{ membership: string }>> {}
const emptyPage = Atom.make(() => emptyContext);
const selectedPage = Atom.family((key: PageKey) =>
  Atom.make((get): ContextQuery => {
    const activated = contextRequest(key, []);
    const state = get(activated);
    if (!AsyncResult.isSuccess(state)) return activated;
    const entries = state.value.data.items;
    if (entries.map((item) => item.id).join(",") === key.membership) return activated;
    // A remote decision can move the page between the two reads. Retain observed
    // deadlines and request fresh context for the summary's ordered membership.
    for (const item of entries) get(originalDeadlineQuery(item));
    return contextRequest(key, [`review-page:${key.membership}`]);
  })
);

export const reviewPageContextSource = ({
  ids,
  ...selection
}: Selection & Readonly<{ ids: ReadonlyArray<string> }>): Atom.Atom<ContextQuery> =>
  ids.length === 0
    ? emptyPage
    : selectedPage(new PageKey({ ...selection, membership: ids.join(",") }));
