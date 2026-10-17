import { useAtomSet } from "@effect/atom-react";
import { useRouter } from "@tanstack/react-router";
import { Reactivity } from "effect/reactivity";
import { type RefCallback, useCallback, useRef, useState } from "react";

/** A retained display refreshes its authority before its editing controls resume. */
export const useWorkspaceResume = ({
  active,
  key,
}: Readonly<{ active: boolean; key: string }>): RefCallback<HTMLDivElement> => {
  const apiClient = useRouter().options.context.apiClient;
  const [operation] = useState(() =>
    apiClient.runtime.fn<void>()(() => Reactivity.invalidate([key]))
  );
  const refresh = useAtomSet(operation);
  const visibility = useRef({ active, visited: false });
  return useCallback(
    (node) => {
      if (node === null) return;
      const returning = active && visibility.current.visited && !visibility.current.active;
      visibility.current = { active, visited: true };
      if (returning) {
        queueMicrotask(() => {
          if (node.isConnected && node.hidden === false) refresh();
        });
      }
    },
    [active, refresh]
  );
};
