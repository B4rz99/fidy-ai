import { reviewNavigationQuery } from "./navigation-query";
import { useAtomValue } from "@effect/atom-react";
import { useMatch, useRouter } from "@tanstack/react-router";
import { type JSX } from "react";
import { Option } from "effect";
import { presentCanonicalQuery } from "@/transport/canonical-query";
import { Badge } from "@/ui/components/badge";

/** Mounted Review uses its own fresh count; other routes make the count-only observation. */
export const ReviewPendingCount = (): JSX.Element => {
  const client = useRouter().options.context.apiClient;
  const match = useMatch({ from: "/authenticated/app/needs-review", shouldThrow: false });
  const query = reviewNavigationQuery({
    client,
    selection:
      match === undefined
        ? Option.none()
        : Option.some({ filter: match.search.status ?? "pending", page: match.search.offset ?? 0 }),
  });
  const state = useAtomValue(query).pipe(presentCanonicalQuery);
  return (
    <span>
      {state._tag === "Ready" ? (
        <Badge variant="secondary" aria-label={`${state.value.data.pendingCount} pendientes`}>
          {state.value.data.pendingCount}
        </Badge>
      ) : null}
    </span>
  );
};
