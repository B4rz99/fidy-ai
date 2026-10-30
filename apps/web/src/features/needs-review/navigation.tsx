import { useAtomRefresh, useAtomValue } from "@effect/atom-react";
import { useRouter } from "@tanstack/react-router";
import { Option } from "effect";
import { type JSX, useState } from "react";
import { presentCanonicalQuery } from "@/transport/canonical-query";
import { Badge } from "@/ui/components/badge";

const pollMilliseconds = 60_000;
/** The mounted navigation owns polling; authentication registry replacement clears its queries. */
export const ReviewPendingCount = (): JSX.Element => {
  const client = useRouter().options.context.apiClient;
  const [query] = useState(() =>
    client.query("ingestion", "getReviewWorkspace", {
      query: { status: Option.some("pending" as const), offset: Option.none(), limit: 0 },
      reactivityKeys: ["ingestion-review"],
    })
  );
  const state = useAtomValue(query).pipe(presentCanonicalQuery);
  const refresh = useAtomRefresh(query);
  return (
    <span
      ref={(node) => {
        if (node === null) return;
        const timer = window.setInterval(refresh, pollMilliseconds);
        window.addEventListener("focus", refresh);
        return (): void => {
          window.clearInterval(timer);
          window.removeEventListener("focus", refresh);
        };
      }}
    >
      {state._tag === "Ready" ? (
        <Badge variant="secondary" aria-label={`${state.value.data.pendingCount} pendientes`}>
          {state.value.data.pendingCount}
        </Badge>
      ) : null}
    </span>
  );
};
