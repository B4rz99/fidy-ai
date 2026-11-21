import { type RefCallback, useCallback, useState } from "react";

type DismissedPickerScope = Readonly<{ generation: number; scope: RefCallback<HTMLDivElement> }>;

export const useDismissedPickerScope = (active: boolean): DismissedPickerScope => {
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
