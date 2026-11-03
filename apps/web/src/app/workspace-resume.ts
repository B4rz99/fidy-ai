import { useAtomSet } from "@effect/atom-react";
import { useRouter } from "@tanstack/react-router";
import { Reactivity } from "effect/reactivity";
import { type RefCallback, useCallback, useRef, useState } from "react";

/** Every actual return observes canonical state independently of the browser clock. */
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
      const previous = visibility.current;
      const returning = active && previous.visited && !previous.active;
      visibility.current = { ...previous, active, visited: true };
      if (returning) {
        queueMicrotask(() => {
          if (node.isConnected && node.hidden === false) refresh();
        });
      }
    },
    [active, refresh]
  );
};
