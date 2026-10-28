import { useAtomSet } from "@effect/atom-react";
import { useRouter } from "@tanstack/react-router";
import { DateTime } from "effect";
import { Reactivity } from "effect/reactivity";
import { type RefCallback, useCallback, useRef, useState } from "react";

const recentResumeMilliseconds = 5000;

/** Revalidate retained display data on return without repeating a recent refresh. */
export const useWorkspaceResume = ({
  active,
  key,
}: Readonly<{ active: boolean; key: string }>): RefCallback<HTMLDivElement> => {
  const apiClient = useRouter().options.context.apiClient;
  const [operation] = useState(() =>
    apiClient.runtime.fn<void>()(() => Reactivity.invalidate([key]))
  );
  const refresh = useAtomSet(operation);
  const visibility = useRef({ active, visited: false, refreshedAt: 0 });
  return useCallback(
    (node) => {
      if (node === null) return;
      const previous = visibility.current;
      if (!previous.visited) previous.refreshedAt = DateTime.nowUnsafe().epochMilliseconds;
      const returning = active && previous.visited && !previous.active;
      const expired =
        DateTime.nowUnsafe().epochMilliseconds - previous.refreshedAt >= recentResumeMilliseconds;
      visibility.current = { ...previous, active, visited: true };
      if (returning && (key === "ingestion-review" || expired)) {
        visibility.current.refreshedAt = DateTime.nowUnsafe().epochMilliseconds;
        queueMicrotask(() => {
          if (node.isConnected && node.hidden === false) refresh();
        });
      }
    },
    [active, key, refresh]
  );
};
