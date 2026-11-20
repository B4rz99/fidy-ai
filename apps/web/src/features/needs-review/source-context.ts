import { reviewPageContextSource } from "./page-context-query";
import { useAtomRefresh, useAtomValue } from "@effect/atom-react";
import { useRouter } from "@tanstack/react-router";
import { DateTime, Option } from "effect";
import { Atom } from "effect/reactivity";
import type { CanonicalSuccess } from "@/transport/client";
import { presentCanonicalQuery } from "@/transport/canonical-query";
import { useReviewPageExpiry } from "./expiry";
import { originalDeadlineQuery } from "./original-deadline";
import { type Item, received } from "./model";
import type { Filter } from "./view-navigation";

export type SourceContext =
  CanonicalSuccess<"ingestion.getReviewPageContext">["data"]["items"][number];
export type PageContexts = ReadonlyMap<string, SourceContext>;

const evidenceProjection = Atom.family(
  (query: Atom.Type<ReturnType<typeof reviewPageContextSource>>) =>
    Atom.make((get) => {
      const state = get(query).pipe(presentCanonicalQuery);
      const deadlines = new Map<string, Item["expiresAt"]>();
      if (state._tag === "Ready") {
        for (const entry of state.value.data.items) {
          deadlines.set(entry.id, get(originalDeadlineQuery(entry)));
        }
      }
      return { state, deadlines };
    })
);

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
  deadlines: ReadonlyMap<string, Item["expiresAt"]>;
  loading: boolean;
  failed: boolean;
  refresh: () => void;
}> => {
  const client = useRouter().options.context.apiClient;
  const query = useAtomValue(
    reviewPageContextSource({ client, filter, page, ids: items.map((item) => item.id) })
  );
  const projectionQuery = evidenceProjection(query);
  const projection = useAtomValue(projectionQuery);
  const state = projection.state;
  const refresh = useAtomRefresh(query);
  const entries = state._tag === "Ready" ? state.value.data.items : [];
  const deadlines = projection.deadlines;
  useReviewPageExpiry([...items, ...[...deadlines.values()].map((expiresAt) => ({ expiresAt }))]);
  const current = DateTime.toEpochMillis(DateTime.nowUnsafe());
  const pageIds = new Set(items.map((item) => item.id));
  return {
    deadlines,
    contexts: new Map(
      entries.flatMap((entry) =>
        pageIds.has(entry.id)
          ? [
              [
                entry.id,
                {
                  ...entry,
                  expiresAt: deadlines.get(entry.id) ?? entry.expiresAt,
                  excerpt:
                    DateTime.toEpochMillis(deadlines.get(entry.id) ?? entry.expiresAt) > current
                      ? entry.excerpt
                      : Option.none(),
                },
              ] as const,
            ]
          : []
      )
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
      entry.id === item.id &&
      DateTime.toEpochMillis(item.expiresAt) > DateTime.toEpochMillis(DateTime.nowUnsafe()) &&
      DateTime.toEpochMillis(entry.expiresAt) > DateTime.toEpochMillis(DateTime.nowUnsafe())
  ).pipe(
    Option.flatMap((entry) => entry.excerpt),
    Option.filter((text) => text.trim() !== "")
  );

export const sourceReference = ({
  item,
  context,
  position,
}: Readonly<{
  item: Item;
  context: Option.Option<SourceContext>;
  position: number;
}>): string => {
  const reference = Option.match(context, {
    onNone: () => `Elemento ${position}`,
    onSome: (entry) => entry.reference,
  });
  if (item.source !== "email") return reference;
  return Option.match(
    Option.flatMap(context, (entry) => entry.receivedAt),
    {
      onNone: () => reference,
      onSome: (time) => `${reference} · Recibido ${received({ item, time })}`,
    }
  );
};
