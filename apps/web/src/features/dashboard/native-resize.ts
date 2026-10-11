import { Option } from "effect";
import { maximumSplitWeight, minimumSplitWeight } from "@/transport/client";

const minimumRegionPixels = 32;
const maximumMinimumShare = 0.49;
const resizeWeightPrecision = 1000;
const keyboardResizeSteps = 20;
/** Bounds a pair while preserving the sibling sum and canonical precision. */
export const dashboardResizeWeight = ({
  weight,
  pairWeight,
}: Readonly<{ weight: number; pairWeight: number }>): number =>
  Math.round(
    Math.min(
      maximumSplitWeight,
      pairWeight - minimumSplitWeight,
      Math.max(minimumSplitWeight, pairWeight - maximumSplitWeight, weight)
    ) * resizeWeightPrecision
  ) / resizeWeightPrecision;
type Configuration = Readonly<{
  element: HTMLElement;
  axis: "row" | "column";
  weight: number;
  adjacentWeight: number;
  enabled: () => boolean;
  resize: (weight: number) => void;
}>;
const preview = (
  { element, axis, weight, adjacentWeight }: Configuration,
  event: PointerEvent
): Option.Option<number> => {
  const child = element.previousElementSibling;
  const adjacent = element.nextElementSibling;
  if (!(child instanceof HTMLElement) || !(adjacent instanceof HTMLElement)) return Option.none();
  const first = child.getBoundingClientRect();
  const second = adjacent.getBoundingClientRect();
  const start = axis === "row" ? first.left : first.top;
  const extent = (axis === "row" ? second.right : second.bottom) - start;
  if (extent <= 0) return Option.none();
  const coordinate = (axis === "row" ? event.clientX : event.clientY) - start;
  const minimumShare = Math.min(maximumMinimumShare, minimumRegionPixels / extent);
  const share = Math.min(1 - minimumShare, Math.max(minimumShare, coordinate / extent));
  const pairWeight = weight + adjacentWeight;
  const next = dashboardResizeWeight({ weight: pairWeight * share, pairWeight });
  child.style.setProperty("--dashboard-weight", String(next));
  adjacent.style.setProperty("--dashboard-weight", String(pairWeight - next));
  return Option.some(next);
};
const restore = ({ element, weight, adjacentWeight }: Configuration): void => {
  const child = element.previousElementSibling;
  const adjacent = element.nextElementSibling;
  if (child instanceof HTMLElement) child.style.setProperty("--dashboard-weight", String(weight));
  if (adjacent instanceof HTMLElement) {
    adjacent.style.setProperty("--dashboard-weight", String(adjacentWeight));
  }
};
/** Keeps pointer previews private and emits one canonical resize only on completion. */
export const bindDashboardResize = (configuration: Configuration): (() => void) => {
  const { element, axis, weight, adjacentWeight, enabled, resize } = configuration;
  let pointer = Option.none<number>();
  const reset = (): void => {
    const id = pointer;
    pointer = Option.none();
    restore(configuration);
    if (Option.isSome(id) && element.hasPointerCapture(id.value)) {
      element.releasePointerCapture(id.value);
    }
  };
  const down = (event: PointerEvent): void => {
    if (!enabled() || event.button !== 0) return;
    pointer = Option.some(event.pointerId);
    element.setPointerCapture(event.pointerId);
    preview(configuration, event);
  };
  const move = (event: PointerEvent): void => {
    if (!Option.contains(pointer, event.pointerId)) return;
    if (!enabled() || event.buttons === 0) {
      reset();
      return;
    }
    preview(configuration, event);
  };
  const up = (event: PointerEvent): void => {
    if (!Option.contains(pointer, event.pointerId)) return;
    const next = enabled() ? preview(configuration, event) : Option.none();
    reset();
    if (Option.isSome(next) && next.value !== weight) resize(next.value);
  };
  const key = (event: KeyboardEvent): void => {
    const decrement = axis === "row" ? "ArrowLeft" : "ArrowUp";
    const increment = axis === "row" ? "ArrowRight" : "ArrowDown";
    if (!enabled() || ![decrement, increment].includes(event.key)) return;
    event.preventDefault();
    const pairWeight = weight + adjacentWeight;
    resize(
      dashboardResizeWeight({
        weight: weight + ((event.key === increment ? 1 : -1) * pairWeight) / keyboardResizeSteps,
        pairWeight,
      })
    );
  };
  element.addEventListener("pointerdown", down);
  element.addEventListener("pointermove", move);
  element.addEventListener("pointerup", up);
  element.addEventListener("pointercancel", reset);
  element.addEventListener("lostpointercapture", reset);
  element.addEventListener("keydown", key);
  return (): void => {
    reset();
    element.removeEventListener("pointerdown", down);
    element.removeEventListener("pointermove", move);
    element.removeEventListener("pointerup", up);
    element.removeEventListener("pointercancel", reset);
    element.removeEventListener("lostpointercapture", reset);
    element.removeEventListener("keydown", key);
  };
};
