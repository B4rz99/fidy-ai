import { reviewPendingCountQuery } from "./navigation-query";
import { useAtomValue } from "@effect/atom-react";
import { useRouter } from "@tanstack/react-router";
import { type JSX, useState } from "react";
import { presentCanonicalQuery } from "@/transport/canonical-query";
import { Badge } from "@/ui/components/badge";

/** The navigation reads counts only; authentication registry replacement clears its query. */
export const ReviewPendingCount = (): JSX.Element => {
  const client = useRouter().options.context.apiClient;
  const [query] = useState(() => reviewPendingCountQuery(client));
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
