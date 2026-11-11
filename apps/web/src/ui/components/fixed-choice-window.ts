import { Option } from "effect";
import { useCallback, useLayoutEffect, useRef, useState } from "react";
import type { Dispatch, RefCallback, RefObject, SetStateAction, UIEventHandler } from "react";

export const choiceRowRem = 2.75;
const overscan = 3;
type Viewport = Readonly<{ top: number; height: number; rowHeight: number }>;

const emptyNode: Option.Option<HTMLDivElement> = Option.none();
const useChoiceMeasurement = (
  highlighted: RefObject<number>
): Readonly<{
  node: RefObject<Option.Option<HTMLDivElement>>;
  measure: RefCallback<HTMLDivElement>;
  viewport: Viewport;
  setViewport: Dispatch<SetStateAction<Viewport>>;
  resetViewport: () => void;
}> => {
  const node = useRef(emptyNode);
  const [observed, setObserved] = useState(emptyNode);
  const [viewport, setViewport] = useState<Viewport>({ top: 0, height: 256, rowHeight: 44 });
  const measure = useCallback<RefCallback<HTMLDivElement>>((element) => {
    const next = Option.fromNullishOr(element);
    node.current = next;
    setObserved(next);
  }, []);
  useLayoutEffect(() => {
    if (Option.isNone(observed)) return;
    const element = observed.value;
    const update = (): void => {
      const rowHeight =
        Number.parseFloat(getComputedStyle(document.documentElement).fontSize) * choiceRowRem;
      revealChoice(element, highlighted.current, rowHeight);
      setViewport({ top: element.scrollTop, height: element.clientHeight, rowHeight });
    };
    const observer = new ResizeObserver(update);
    observer.observe(element);
    observer.observe(document.documentElement);
    if (element.firstElementChild !== null) observer.observe(element.firstElementChild);
    update();
    return (): void => observer.disconnect();
  }, [observed, highlighted]);
  const resetViewport = (): void => {
    if (Option.isSome(node.current)) node.current.value.scrollTop = 0;
    setViewport((current) => ({ ...current, top: 0 }));
  };
  return { node, measure, viewport, setViewport, resetViewport };
};

/** Owns fixed-row scrolling and text-scale observation; unmount releases the observer. */
export const useFixedChoiceWindow = (): Readonly<{
  measure: RefCallback<HTMLDivElement>;
  onScroll: UIEventHandler<HTMLDivElement>;
  highlight: (index: number, pointer: boolean) => void;
  reset: () => void;
  viewport: Viewport;
  activeIndex: number;
}> => {
  const highlighted = useRef(-1);
  const [activeIndex, setActiveIndex] = useState(-1);
  const { node, measure, viewport, setViewport, resetViewport } = useChoiceMeasurement(highlighted);
  const onScroll: UIEventHandler<HTMLDivElement> = (event) => {
    const element = event.currentTarget;
    const top = element.scrollTop;
    const height = element.clientHeight;
    setViewport((current) => ({ ...current, top, height }));
  };
  const highlight = (index: number, pointer: boolean): void => {
    highlighted.current = index;
    setActiveIndex(index);
    const element = node.current;
    if (Option.isNone(element) || index < 0 || pointer) return;
    revealChoice(
      element.value,
      index,
      Number.parseFloat(getComputedStyle(document.documentElement).fontSize) * choiceRowRem
    );
    const top = element.value.scrollTop;
    setViewport((current) => ({ ...current, top }));
  };
  const reset = (): void => {
    highlighted.current = -1;
    setActiveIndex(-1);
    resetViewport();
  };
  return { measure, onScroll, highlight, reset, viewport, activeIndex };
};

export const visibleChoiceIndexes = ({
  count,
  viewport,
  activeIndex,
}: Readonly<{ count: number; viewport: Viewport; activeIndex: number }>): ReadonlyArray<number> => {
  const visibleCount = Math.ceil(viewport.height / viewport.rowHeight) + overscan * 2;
  const start = Math.max(
    0,
    Math.min(Math.floor(viewport.top / viewport.rowHeight) - overscan, count - visibleCount)
  );
  const indexes = Array.from(
    { length: Math.min(visibleCount, count - start) },
    (_, offset) => start + offset
  );
  if (activeIndex >= 0 && activeIndex < count && !indexes.includes(activeIndex)) {
    indexes.push(activeIndex);
  }
  return indexes;
};

const revealChoice = (element: HTMLDivElement, index: number, rowHeight: number): void => {
  if (index < 0) return;
  const padding = Number.parseFloat(getComputedStyle(element).paddingTop);
  const top = padding + index * rowHeight;
  if (top < element.scrollTop) element.scrollTop = top;
  else if (top + rowHeight > element.scrollTop + element.clientHeight) {
    element.scrollTop = top + rowHeight - element.clientHeight;
  }
};
