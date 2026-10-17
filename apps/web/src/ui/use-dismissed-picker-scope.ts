import { type RefCallback, useCallback, useState } from "react";

/** Dismiss open Base UI portals on departure while preserving closed retained controls. */
export const useDismissedPickerScope = (
  active: boolean
): Readonly<{ generation: number; scope: RefCallback<HTMLDivElement> }> => {
  const [generation, setGeneration] = useState(0);
  const scope = useCallback<RefCallback<HTMLDivElement>>(
    (node) => {
      if (node === null || active) return;
      queueMicrotask(() => {
        if (
          node.isConnected &&
          node.hidden === true &&
          node.querySelector('[aria-expanded="true"]') !== null
        ) {
          setGeneration((current) => current + 1);
        }
      });
    },
    [active]
  );
  return { generation, scope };
};
