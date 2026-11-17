import { Option } from "effect";
import { type RefCallback, useCallback } from "react";

const clearance = 8;

/** Reveals amount feedback within its local scroll region without changing keyboard focus. */
export const useReviewAmountVisibility = (
  error: Option.Option<string>
): RefCallback<HTMLDivElement> => {
  const message = Option.getOrElse(error, () => "");
  return useCallback<RefCallback<HTMLDivElement>>(
    (node) => {
      if (node === null || message === "") return;
      const form = node.closest<HTMLElement>('[data-review="form"]');
      const columns = node.closest<HTMLElement>('[data-review="columns"]');
      if (form === null || columns === null) return;
      const footer = columns.parentElement?.querySelector<HTMLElement>('[data-review="footer"]');
      if (footer === undefined || footer === null) return;
      const reveal = (): void => {
        const viewport = getComputedStyle(form).overflowY === "auto" ? form : columns;
        if (getComputedStyle(viewport).overflowY !== "auto") return;
        const bounds = viewport.getBoundingClientRect();
        if (bounds.height === 0) return;
        revealPage(bounds, footer, node.getBoundingClientRect().height);
        const visible = viewport.getBoundingClientRect();
        const top = Math.max(visible.top, 0) + clearance;
        const end =
          Math.min(visible.bottom, footer.getBoundingClientRect().top, window.innerHeight) -
          clearance;
        const target = node.getBoundingClientRect();
        if (target.bottom > end) {
          viewport.scrollBy({ top: target.bottom - end, behavior: "instant" });
        } else if (target.height <= end - top && target.top < top) {
          viewport.scrollBy({ top: target.top - top, behavior: "instant" });
        }
      };
      const observer = new ResizeObserver(reveal);
      observer.observe(node);
      observer.observe(form);
      observer.observe(columns);
      reveal();
      return (): void => observer.disconnect();
    },
    [message]
  );
};

const revealPage = (bounds: DOMRect, footer: HTMLElement, fieldHeight: number): void => {
  const bottom = Math.min(bounds.bottom, footer.getBoundingClientRect().top, window.innerHeight);
  const available = bottom - Math.max(bounds.top, 0);
  if (fieldHeight + clearance * 2 > available && bounds.top > clearance) {
    window.scrollBy({
      top: Math.min(fieldHeight + clearance * 2 - available, bounds.top - clearance),
      behavior: "instant",
    });
  }
};
