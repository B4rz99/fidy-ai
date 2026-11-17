import { Option } from "effect";
import { type RefCallback, useCallback } from "react";

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
      const reveal = (): void => {
        const viewport = getComputedStyle(form).overflowY === "auto" ? form : columns;
        if (getComputedStyle(viewport).overflowY !== "auto") return;
        const bounds = viewport.getBoundingClientRect();
        if (bounds.height === 0) return;
        const field = node.getBoundingClientRect();
        const clearance = 8;
        if (field.bottom > bounds.bottom - clearance) {
          viewport.scrollBy({ top: field.bottom - bounds.bottom + clearance, behavior: "instant" });
        } else if (
          field.height <= bounds.height - clearance * 2 &&
          field.top < bounds.top + clearance
        ) {
          viewport.scrollBy({ top: field.top - bounds.top - clearance, behavior: "instant" });
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
