import { useAtomRefresh, useAtomValue } from "@effect/atom-react";
import { useRouter } from "@tanstack/react-router";
import { DateTime, Option } from "effect";
import { useState } from "react";
import type { CanonicalSuccess } from "@/transport/client";
import { presentCanonicalQuery } from "@/transport/canonical-query";
import { useReviewPageExpiry } from "./expiry";
import { reviewWorkspaceKey } from "./query-keys";
import type { Item } from "./model";
import type { Filter } from "./view-navigation";

export type SourceContext =
  CanonicalSuccess<"ingestion.getReviewPageContext">["data"]["items"][number];
export type PageContexts = ReadonlyMap<string, SourceContext>;

/** Page-local source evidence stays in the authentication registry and expires independently of drafts. */
export const useReviewPageContext = ({
  filter,
  page,
  items,
}: Readonly<{
  filter: Filter;
  page: number;
  items: ReadonlyArray<Item>;
}>): Readonly<{
  contexts: PageContexts;
  loading: boolean;
  failed: boolean;
  refresh: () => void;
}> => {
  const client = useRouter().options.context.apiClient;
  const [query] = useState(() =>
    client.query("ingestion", "getReviewPageContext", {
      query: {
        status: Option.some(filter),
        offset: page === 0 ? Option.none() : Option.some(page),
      },
      reactivityKeys: ["ingestion-review", reviewWorkspaceKey],
      timeToLive: "400 millis",
    })
  );
  const state = useAtomValue(query).pipe(presentCanonicalQuery);
  const refresh = useAtomRefresh(query);
  const entries = state._tag === "Ready" ? state.value.data.items : [];
  useReviewPageExpiry([...items, ...entries]);
  const current = DateTime.toEpochMillis(DateTime.nowUnsafe());
  return {
    contexts: new Map(
      entries.map((entry) => [
        entry.id,
        {
          ...entry,
          excerpt:
            DateTime.toEpochMillis(entry.expiresAt) > current ? entry.excerpt : Option.none(),
        },
      ])
    ),
    loading: state._tag === "Initial",
    failed:
      state._tag === "Failure" || (state._tag === "Ready" && Option.isSome(state.refreshFailure)),
    refresh,
  };
};

export const sourceExcerpt = ({
  item,
  context,
}: Readonly<{ item: Item; context: Option.Option<SourceContext> }>): Option.Option<string> =>
  Option.filter(
    context,
    (entry) =>
      DateTime.toEpochMillis(item.expiresAt) > DateTime.toEpochMillis(DateTime.nowUnsafe()) &&
      DateTime.toEpochMillis(entry.expiresAt) > DateTime.toEpochMillis(DateTime.nowUnsafe())
  ).pipe(
    Option.flatMap((entry) => entry.excerpt),
    Option.filter((text) => text.trim() !== "")
  );
