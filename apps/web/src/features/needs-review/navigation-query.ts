import { Option } from "effect";
import { Atom } from "effect/reactivity";
import type { FidyClient } from "@/transport/client";
import type { ReviewWorkspaceQuery } from "./decisions";
import { reviewCountKey } from "./query-keys";
import { observeReviewQuery } from "./query-observation";

/** Count-only freshness never mounts an editor or reads item rows. */
export const reviewPendingCountQuery: (client: FidyClient) => ReviewWorkspaceQuery = Atom.family(
  (client: FidyClient) => {
    const source = client.query("ingestion", "getReviewWorkspace", {
      query: { status: Option.some("pending" as const), offset: Option.none(), limit: 0 },
      reactivityKeys: ["ingestion-review", reviewCountKey],
      timeToLive: "400 millis",
    });
    return observeReviewQuery(source);
  }
);
