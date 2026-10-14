import { Option } from "effect";
import { createContext, useCallback, useState } from "react";
import type { RefCallback } from "react";

const railBreakpoint = 75;
export const WorkspaceDesktop = createContext<Option.Option<boolean>>(Option.none());
/** Measures workspace width at the current text scale; unmount ends observation. */
export const useWorkspaceSize = (): Readonly<{
  desktop: boolean;
  measure: RefCallback<HTMLDivElement>;
}> => {
  const [desktop, setDesktop] = useState(false);
  const measure = useCallback<RefCallback<HTMLDivElement>>((node) => {
    if (node === null) return;
    return observeWorkspace(node, setDesktop);
  }, []);
  return { desktop, measure };
};

const observeWorkspace = (
  node: HTMLDivElement,
  onSize: (desktop: boolean) => void
): (() => void) => {
  const update = (): void => {
    const textSize = Number.parseFloat(getComputedStyle(document.documentElement).fontSize);
    onSize(node.getBoundingClientRect().width >= railBreakpoint * textSize);
  };
  const observer = new ResizeObserver(update);
  observer.observe(node);
  update();
  return (): void => {
    observer.disconnect();
  };
};
