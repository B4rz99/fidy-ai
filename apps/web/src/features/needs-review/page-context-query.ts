import type { HttpApiEndpoint, HttpApiGroup } from "effect/http-api";
import { Option } from "effect";
import { AsyncResult, Atom } from "effect/reactivity";
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
export const reviewPageContextQuery = ({
  client,
  filter,
  page,
  ids,
}: Readonly<{
  client: FidyClient;
  filter: Filter;
  page: number;
  ids: ReadonlyArray<string>;
}>): ContextQuery => {
  if (ids.length === 0) return emptyContext;
  return client.query("ingestion", "getReviewPageContext", {
    query: {
      status: Option.some(filter),
      offset: page === 0 ? Option.none() : Option.some(page),
    },
    reactivityKeys: ["ingestion-review", reviewContextKey, `review-page:${ids.join(",")}`],
    timeToLive: "400 millis",
  });
};
