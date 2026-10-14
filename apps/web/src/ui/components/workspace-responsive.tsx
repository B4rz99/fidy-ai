import { Option } from "effect";
import { createContext, useCallback, useState } from "react";
import type { RefCallback } from "react";

const railBreakpoint = 75;
export const WorkspaceDesktop = createContext<Option.Option<boolean>>(Option.none());
/** Measures the available workspace, including the current text scale; cleans up on unmount. */
export const useWorkspaceSize = (): Readonly<{
  desktop: boolean;
  measure: RefCallback<HTMLDivElement>;
}> => {
  const [desktop, setDesktop] = useState(false);
  const measure = useCallback<RefCallback<HTMLDivElement>>((node) => {
    if (node === null) return;
    const update = (): void => {
      const textSize = Number.parseFloat(getComputedStyle(document.documentElement).fontSize);
      setDesktop(node.getBoundingClientRect().width >= railBreakpoint * textSize);
    };
    const observer = new ResizeObserver(update);
    observer.observe(node);
    update();
    return (): void => observer.disconnect();
  }, []);
  return { desktop, measure };
};
