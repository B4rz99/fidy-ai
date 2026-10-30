import { useAtomValue } from "@effect/atom-react";
import { useRouter } from "@tanstack/react-router";
import { type JSX, useState } from "react";
import { presentCanonicalQuery } from "@/transport/canonical-query";
import { Badge } from "@/ui/components/badge";
import { reviewWorkspaceQueries } from "./query";

/** The mounted navigation owns polling; authentication registry replacement clears its queries. */
export const ReviewPendingCount = (): JSX.Element => {
  const client = useRouter().options.context.apiClient;
  const [query] = useState(() => reviewWorkspaceQueries(client, "pending", 0).active);
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
